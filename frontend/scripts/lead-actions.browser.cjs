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
const dbFile = path.join(os.tmpdir(), 'leadium-lead-actions-browser-' + process.pid + '.json');
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
const auth=require(root+'/backend/dist/services/api-gateway/auth-store.js');
auth.listUsers=async()=>[{id:'marta',username:'marta',name:'Marta',role:'operatore'},{id:'giuseppe',username:'giuseppe',name:'Giuseppe',role:'operatore'}];
const mailer=require(root+'/backend/dist/services/common/mailer.js');
process.env.SMTP_HOST='smtp.example.test';process.env.SMTP_USER='service@example.test';process.env.SMTP_PASSWORD='test-only';
mailer.setMailTransportFactory(()=>({sendMail:async()=>({messageId:'local-test'})}));
const gateway=require(root+'/backend/dist/services/api-gateway/server.js');
const user={id:'lead-actions-browser-user',username:'lead-actions-browser',name:'Payment Browser',role:'admin'};
gateway.__setTestSession('lead-actions-browser-session',user);
const gatewayUrl=await listen(gateway.server);
const ids={};
for(const [key,statuses,amounts]of [['editable',['pending','pending'],[0,0]],['legacy',['verified','received'],[300,900]],['zero',['pending','pending'],[0,0]]]){
const id='lead-actions-browser-'+key,now=new Date().toISOString();ids[key]=id;
await store.createLead({id,fullName:'Cliente '+key,phone:'+39333'+(key==='editable'?'1111111':key==='legacy'?'2222222':'3333333'),email:'customer@example.test',assignedTo:'marta',closingOutcome:'open',status:'Contatto interessato',createdAt:now,updatedAt:now,documents:{items:[]},payments:{items:['payment_deposit','payment_balance'].map((id,i)=>({id,amount:amounts[i],status:statuses[i]}))}});
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
    const headers = { Authorization: 'Bearer lead-actions-browser-session' };
    const read = async id => {
      const response = await fetch(fixture.gatewayUrl + '/api/leads/' + id, { headers });
      assert.equal(response.status, 200);
      return response.json();
    };
    for (const [width, id] of [[1440, fixture.ids.editable], [390, fixture.ids.zero]]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.addInitScript(user => {
        localStorage.setItem('crm.auth.token', 'lead-actions-browser-session');
        localStorage.setItem('crm.auth.user', JSON.stringify(user));
      }, fixture.user);
      await page.route('**/api/whatsapp/**', route => route.fulfill({ json: { state: null, suggestions: [], templates: {} } }));
      await page.goto(fixture.frontUrl + '/pratiche/' + id);
      await page.getByRole('button', { name: 'Segna come lavorata', exact: true }).click();
      let dialog = page.getByRole('dialog', { name: 'Segna come lavorata', exact: true });
      assert.equal(await dialog.getByRole('button', { name: 'Segna come lavorata', exact: true }).isDisabled(), true);
      await dialog.getByLabel('Cosa hai fatto con il cliente').fill('Cliente seguito, preventivo spiegato.');
      let failOnce = true;
      await page.route('**/api/leads/' + id + '/worked', route => {
        if (failOnce) { failOnce = false; return route.fulfill({ status: 503, json: { error: 'Errore temporaneo simulato' } }); }
        return route.continue();
      });
      await dialog.getByRole('button', { name: 'Segna come lavorata', exact: true }).click();
      await dialog.getByRole('alert').waitFor();
      assert.equal(await dialog.getByLabel('Cosa hai fatto con il cliente').inputValue(), 'Cliente seguito, preventivo spiegato.');
      await dialog.getByRole('button', { name: 'Segna come lavorata', exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
      assert.ok((await read(id)).lead.workedAt);
      await page.goto(fixture.frontUrl + '/pratiche');
      await page.getByRole('tab', { name: /Lavorate/ }).click();
      await page.getByText(width === 1440 ? 'Cliente editable' : 'Cliente zero', { exact: true }).first().waitFor();
      await page.goto(fixture.frontUrl + '/pratiche/' + id);
      await page.getByRole('button', { name: 'Rimetti tra le attive', exact: true }).click();
      dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: 'Rimetti tra le attive', exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
      assert.equal((await read(id)).lead.workedAt, null);
      await page.getByRole('button', { name: 'Invia email', exact: true }).click();
      dialog = page.getByRole('dialog');
      await dialog.getByLabel('Oggetto').fill('Preventivo crociera');
      await dialog.getByLabel('Messaggio').fill('Buongiorno, ecco il riepilogo concordato.');
      await dialog.getByRole('button', { name: 'Invia email', exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
      assert.ok((await read(id)).timeline.some(row => row.type === 'email_sent'));
      await page.goto(fixture.frontUrl + '/tasks');
      await page.getByRole('button', { name: /^Marta/ }).click();
      const row = page.getByRole('listitem').filter({ hasText: width === 1440 ? 'Cliente editable' : 'Cliente zero' });
      await row.getByRole('checkbox').check();
      await page.getByLabel('Operatore predefinito').selectOption('giuseppe');
      await page.getByRole('button', { name: 'Assegna 1 lead', exact: true }).click();
      await row.waitFor({ state: 'detached' });
      assert.equal((await read(id)).lead.assignedTo, 'giuseppe');
      await page.getByRole('button', { name: /^Giuseppe/ }).click();
      await row.getByRole('button', { name: 'Archivia', exact: true }).click();
      dialog = page.getByRole('dialog');
      await dialog.getByLabel('Motivo obbligatorio').fill('Contatto non necessario, test locale.');
      await dialog.getByRole('button', { name: 'Archivia contatto', exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
      await page.getByRole('button', { name: 'Archiviate', exact: true }).click();
      await row.getByRole('button', { name: 'Ripristina', exact: true }).click();
      dialog = page.getByRole('dialog');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await dialog.getByRole('button', { name: 'Ripristina contatto', exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
      const restored = await read(id);
      assert.equal(restored.lead.archivedAt, null);
      for (const type of ['lead_worked', 'lead_worked_undone', 'email_sent', 'lead_archived', 'lead_restored']) {
        assert.ok(restored.timeline.some(row => row.type === type), type);
      }
      assert.deepEqual(errors, []);
      console.log('PASS lead actions browser ' + width + 'px: worked/undo, queue, retained error, email, reassign, archive/restore and audit');
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
