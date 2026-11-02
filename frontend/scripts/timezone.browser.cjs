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
const dbFile = path.join(os.tmpdir(), 'leadium-timezone-browser-' + process.pid + '.json');
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
    for (const [zone, id] of [['UTC', fixture.ids.editable], ['America/New_York', fixture.ids.zero]]) {
      const page = await browser.newPage({ timezoneId: zone });
      await page.clock.install({ time: new Date('2026-11-02T09:30:00Z') });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(user => {
        localStorage.setItem('crm.auth.token', 'lead-actions-browser-session');
        localStorage.setItem('crm.auth.user', JSON.stringify(user));
      }, fixture.user);
      await page.route('**/api/whatsapp/**', route => route.fulfill({ json: { state: null, suggestions: [], templates: {} } }));
      await page.goto(fixture.frontUrl + '/pratiche/' + id);
      await page.getByRole('button', { name: 'Registra esito', exact: true }).click();
      await page.getByRole('button', { name: 'Da richiamare', exact: true }).click();
      const input = page.getByLabel('Data e ora richiamo', { exact: true });
      assert.equal(await input.inputValue(), '2026-11-03T10:30');
      await input.fill('2030-07-02T10:30');
      await page.getByLabel('Motivo del richiamo', { exact: true }).fill('Verifica timezone locale');
      // Clock updates must not reset the open form.
      await page.clock.runFor(31000);
      assert.equal(await input.inputValue(), '2030-07-02T10:30');
      await page.getByRole('button', { name: 'Salva esito', exact: true }).click();
      await input.waitFor({ state: 'detached' });
      const headers = { Authorization: 'Bearer lead-actions-browser-session', 'Content-Type': 'application/json' };
      const detail = await (await fetch(fixture.gatewayUrl + '/api/leads/' + id, { headers })).json();
      assert.equal(detail.lead.nextActionAt, '2030-07-02T08:30:00.000Z');
      await page.reload();
      await page.goto(fixture.frontUrl + '/pratiche');
      await page.getByText(/10:30/).first().waitFor();
      // Dashboard deadlines advance without interaction; data refreshes every minute.
      const dueAt = '2026-11-02T09:31:15.000Z';
      const created = await fetch(fixture.gatewayUrl + '/api/tasks', { method: 'POST', headers, body: JSON.stringify({
        leadId: id, kind: 'manual', title: 'Scadenza orologio ' + zone, priority: 80, dueAt, assignedTo: 'marta'
      }) });
      assert.equal(created.status, 201);
      let reads = 0;
      await page.route('**/api/tasks/board', route => { reads++; return route.continue(); });
      await page.goto(fixture.frontUrl + '/dashboard');
      const taskRow = page.locator('.cd-task').filter({ hasText: 'Scadenza orologio ' + zone });
      await taskRow.waitFor();
      assert.equal(await taskRow.locator('.cd-badge').innerText(), 'Oggi');
      const readsBefore = reads;
      await page.clock.runFor(90000);
      await taskRow.getByText('In ritardo', { exact: true }).waitFor();
      assert.ok(reads > readsBefore, 'background refresh requested new data');
      assert.deepEqual(errors, []);
      console.log('PASS timezone UI ' + zone + ': Rome default/input, UTC persistence, reload, ticking overdue state, automatic data refresh, form preserved');
      await page.close();
    }
  } finally {
    if (browser) await browser.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited;
    }
    if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
