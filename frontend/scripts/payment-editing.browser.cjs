/* Local-only regression harness. Build backend first, then run with Playwright installed.
 * Optional PLAYWRIGHT_MODULE / PLAYWRIGHT_CHROMIUM_EXECUTABLE select an existing test runtime.
 * No live database, Meta credentials, screenshots or deployed services are used. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
const dbFile = path.join(os.tmpdir(), 'leadium-payment-browser-' + process.pid + '.json');
const fixtureSource = `
const fs=require('fs'),http=require('http');
const root=${JSON.stringify(root)};
const listen=async server=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));return 'http://127.0.0.1:'+server.address().port};
(async()=>{
fs.writeFileSync(process.env.JSON_DB_FILE,JSON.stringify({leads:[],activities:[],tasks:[],customers:[],purchases:[],callLogs:[]}));
const store=require(root+'/backend/dist/services/common/leadStore.js');
const leadService=require(root+'/backend/dist/services/lead-service/server.js');
const workflow=require(root+'/backend/dist/services/common/workflow.js');
const workflowServer=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url.startsWith('/internal/validate-transition')?{valid:workflow.isValidTransition(new URL(req.url,'http://localhost').searchParams.get('from'),new URL(req.url,'http://localhost').searchParams.get('to'))}:workflow.getWorkflowView()))});
process.env.WORKFLOW_SERVICE_URL=await listen(workflowServer);
process.env.LEAD_SERVICE_URL=await listen(leadService.server);
const gateway=require(root+'/backend/dist/services/api-gateway/server.js');
const user={id:'payment-browser-user',username:'payment-browser',name:'Payment Browser',role:'operatore'};
gateway.__setTestSession('payment-browser-session',user);
const gatewayUrl=await listen(gateway.server);
const ids={};
for(const [key,statuses,amounts]of [['editable',['pending','pending'],[0,0]],['legacy',['verified','received'],[300,900]],['zero',['pending','pending'],[0,0]]]){
const id='payment-browser-'+key,now=new Date().toISOString();ids[key]=id;
await store.createLead({id,fullName:'Cliente '+key,phone:'+393331234567',status:'In contatto',createdAt:now,updatedAt:now,documents:{items:[]},payments:{items:['payment_deposit','payment_balance'].map((id,i)=>({id,amount:amounts[i],status:statuses[i]}))}});
}
process.env.API_TARGET=gatewayUrl;
const {createServer}=await import(require('url').pathToFileURL(root+'/frontend/node_modules/vite/dist/node/index.js').href);
const vite=await createServer({root:root+'/frontend',configFile:root+'/frontend/vite.config.ts',server:{host:'127.0.0.1',port:0,strictPort:false}});
await vite.listen();const frontUrl='http://127.0.0.1:'+vite.httpServer.address().port;
process.send({frontUrl,gatewayUrl,ids,user});
})().catch(error=>{console.error(error);process.exit(1)});
`;
const child = spawn(process.execPath, ['-e', fixtureSource], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  env: { ...process.env, NODE_ENV: 'test', JSON_DB_FILE: dbFile, MONGODB_URI: '', MONGO_URL: '', WHATSAPP_ACCESS_TOKEN: '', WHATSAPP_PHONE_NUMBER_ID: '', WHATSAPP_AUTOMATION_ENABLED: 'false', META_CRM_SYNC_ENABLED: 'false' }
});
let logs = '';
child.stdout.on('data', chunk => { logs += chunk; });
child.stderr.on('data', chunk => { logs += chunk; });
const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Fixture startup timeout\n' + logs)), 30000);
  child.once('message', message => { clearTimeout(timer); resolve(message); });
  child.once('exit', code => { clearTimeout(timer); reject(new Error('Fixture exited ' + code + '\n' + logs)); });
});
(async () => {
  let browser;
  try {
    const fixture = await ready;
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
    const api = async id => {
      const response = await fetch(fixture.gatewayUrl + '/api/leads/' + id, { headers: { Authorization: 'Bearer payment-browser-session' } });
      assert.equal(response.status, 200); return (await response.json()).lead;
    };
    for (const width of [1440, 1100, 390]) {
      const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1000 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(user => { localStorage.setItem('crm.auth.token', 'payment-browser-session'); localStorage.setItem('crm.auth.user', JSON.stringify(user)); }, fixture.user);
      await page.route('**/api/whatsapp/automation/state?*', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"state":null,"suggestions":[],"templates":{}}' }));
      const id = fixture.ids.editable;
      // Reset only this isolated fixture between viewport runs through its real API.
      // The following pages use a fresh pending plan for the first run; subsequent runs keep
      // the already-received deposit and validate its lock while testing another pending plan.
      let targetId = id;
      if (width !== 1440) {
        const created = await fetch(fixture.gatewayUrl + '/api/leads', { method: 'POST', headers: { Authorization: 'Bearer payment-browser-session', 'Content-Type': 'application/json' }, body: JSON.stringify({ fullName: 'Viewport ' + width, phone: '+39333' + width + '123' }) });
        assert.equal(created.status, 201); targetId = (await created.json()).id;
      }
      await page.goto(fixture.frontUrl + '/pratiche/' + targetId);
      await page.locator('.pd-payments-edit').waitFor();
      let writes = 0, failOnce = false;
      await page.route('**/api/leads/' + targetId, async route => {
        if (route.request().method() === 'PATCH' && route.request().postDataJSON()?.payments) {
          writes++;
          if (failOnce) { failOnce = false; return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Errore API simulato"}' }); }
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        return route.continue();
      });
      await page.locator('.pd-payments-edit').click();
      const form = page.getByRole('form', { name: 'Modifica importi pratica' });
      const total = form.getByLabel('Totale pratica');
      const deposit = form.getByLabel('Acconto (');
      await total.fill('1.250,50'); await deposit.fill('250,25');
      await form.getByRole('button', { name: 'Annulla', exact: true }).click();
      assert.equal(writes, 0);
      await page.locator('.pd-payments-edit').click();
      await total.fill('1.250,50'); await deposit.fill('2000');
      await form.getByRole('button', { name: 'Salva importi', exact: true }).click();
      await form.getByRole('alert').waitFor(); assert.equal(writes, 0);
      await deposit.fill('250,25'); failOnce = true;
      await form.getByRole('button', { name: 'Salva importi', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'Errore API simulato' }).waitFor();
      assert.equal(await form.isVisible(), true); assert.equal(await total.inputValue(), '1.250,50');
      assert.equal((await api(targetId)).payments.items[0].amount, 0);
      for (const control of await form.locator('input,button').all()) {
        await control.scrollIntoViewIfNeeded();
        const geometry = await control.evaluate(el => { const r = el.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return { fits: r.x >= 0 && r.right <= innerWidth && r.width > 0, uncovered: !!hit && (hit === el || el.contains(hit)) }; });
        assert.ok(geometry.fits && geometry.uncovered, JSON.stringify({ width, geometry }));
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await form.getByLabel('Motivo modifica').fill('Test viewport ' + width);
      const before = writes;
      await form.evaluate(el => { el.requestSubmit(); el.requestSubmit(); });
      await form.getByRole('button', { name: 'Salva importi', exact: true }).waitFor({ state: 'visible' });
      assert.equal(await form.getByRole('button', { name: 'Salva importi', exact: true }).isDisabled(), true);
      await form.waitFor({ state: 'detached' }); assert.equal(writes - before, 1);
      await page.reload(); await page.locator('.pd-payments-edit').waitFor();
      const saved = await api(targetId);
      assert.equal(saved.payments.items[0].amount, 250.25); assert.equal(saved.payments.items[1].amount, 1000.25);
      const row = page.locator('.pd-payment-row').filter({ hasText: 'Acconto' });
      await row.getByRole('button', { name: 'Segna pagato', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.pd-payment-row')?.textContent.includes('Ricevuto'));
      await page.locator('.pd-payments-edit').click();
      assert.equal(await deposit.isDisabled(), true); assert.equal(await total.isEnabled(), true);
      await form.getByText('Acconto bloccato:', { exact: false }).waitFor();
      await total.fill('1.500,50'); await form.getByRole('button', { name: 'Salva importi', exact: true }).click();
      await form.waitFor({ state: 'detached' });
      const received = await api(targetId);
      assert.equal(received.payments.items[0].receivedAmount, 250.25);
      assert.equal(received.payments.audit[1].reason, "");
      assert.equal(received.payments.items[1].amount, 1250.25);
      assert.ok((await page.locator('.pd-payments-summary article').filter({ hasText: 'Pagato' }).locator('strong').innerText()).includes('250,25'));
      assert.ok((await page.locator('.pd-payments-summary article').filter({ hasText: 'Residuo' }).locator('strong').innerText()).replace(/\./g, '').includes('1250,25'));
      await page.goto(fixture.frontUrl + '/pratiche/' + fixture.ids.legacy);
      await page.locator('.pd-payments-edit').click();
      assert.equal(await total.isDisabled(), true); assert.equal(await deposit.isDisabled(), true);
      await form.getByText('Saldo bloccato:', { exact: false }).waitFor();
      assert.equal((await api(fixture.ids.legacy)).payments.items[0].receivedAmount, 300);
      await page.goto(fixture.frontUrl + '/pratiche/' + fixture.ids.zero);
      await page.locator('.pd-payments-edit').waitFor();
      await page.locator('#payments-section').getByText('Importi da definire', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Segna pagato', exact: true }).count(), 0);
      await page.locator('.pd-payment-menu-trigger').first().click();
      assert.equal(await page.getByRole('button', { name: 'Verifica', exact: true }).count(), 0);
      assert.deepEqual(errors, []);
      console.log('PASS payment UI ' + width + 'px: totals/cents, cancel, API error retention, double submit, reload, receipts, locks, zero, responsive');
      await page.close();
    }
  } finally {
    if (browser) await browser.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
