/* Local workflow regression: real CRM/gateway, isolated JSON data, synthetic call transport.
 * Never connects to production, 3CX, Meta or a live database. */
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
const dbFile = path.join(os.tmpdir(), 'leadium-follow-up-' + process.pid + '.json');
const source = `
const fs=require('fs'),http=require('http');
const root=${JSON.stringify(root)};
const listen=async server=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));return 'http://127.0.0.1:'+server.address().port};
(async()=>{
fs.writeFileSync(process.env.JSON_DB_FILE,JSON.stringify({leads:[],activities:[],tasks:[],customers:[],purchases:[],callLogs:[]}));
const store=require(root+'/backend/dist/services/common/leadStore.js');
const leads=require(root+'/backend/dist/services/lead-service/server.js');process.env.LEAD_SERVICE_URL=await listen(leads.server);
const workflow=require(root+'/backend/dist/services/common/workflow.js');
const workflowServer=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url.startsWith('/internal/validate-transition')?{valid:workflow.isValidTransition(new URL(req.url,'http://localhost').searchParams.get('from'),new URL(req.url,'http://localhost').searchParams.get('to'))}:workflow.getWorkflowView()))});
process.env.WORKFLOW_SERVICE_URL=await listen(workflowServer);
const mock=http.createServer(async(req,res)=>{for await(const chunk of req){}res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url.startsWith('/3cx/live')?{available:true,calls:[]}:{ok:true,callId:'12345'}))});
process.env.CALL_SERVICE_URL=await listen(mock);process.env.WHATSAPP_SERVICE_URL=process.env.CALL_SERVICE_URL;
const auth=require(root+'/backend/dist/services/api-gateway/auth-store.js');auth.getUserThreeCxDn=async()=> '901';
const gateway=require(root+'/backend/dist/services/api-gateway/server.js');
const user={id:'follow-up-browser',username:'follow-up-browser',name:'Follow Up Fixture',role:'operatore'};
gateway.__setTestSession('follow-up-session',user);const gatewayUrl=await listen(gateway.server);
for(const count of [0,1,2,5]){
const id='attempts-'+count,now=new Date().toISOString();
await store.createLead({id,fullName:'Cliente '+count,phone:'+39333123456'+count,status:workflow.LEAD_STATUSES.TO_CONTACT,assignedTo:user.username,callAttempts:0,createdAt:now,updatedAt:now,documents:{items:[]},payments:{items:[]}});
for(let i=0;i<count;i++){const response=await fetch(process.env.LEAD_SERVICE_URL+'/internal/call-events',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({externalLeadId:id,callId:id+'-'+i,disposition:'no_answer'})});if(!response.ok)throw Error('Failed fixture call')}
}
await leads.ensureSlaTasks();process.env.API_TARGET=gatewayUrl;
const {createServer}=await import(require('url').pathToFileURL(root+'/frontend/node_modules/vite/dist/node/index.js').href);
const vite=await createServer({root:root+'/frontend',configFile:root+'/frontend/vite.config.ts',server:{host:'127.0.0.1',port:0,strictPort:false}});await vite.listen();
process.send({frontUrl:'http://127.0.0.1:'+vite.httpServer.address().port,gatewayUrl,user});
})().catch(error=>{console.error(error);process.exit(1)});
`;
const child = spawn(process.execPath, ['-e', source], { cwd: root, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env,
  NODE_ENV: 'test', JSON_DB_FILE: dbFile, MONGODB_URI: '', MONGO_URL: '', THREECX_ENABLED: 'false',
  WHATSAPP_ACCESS_TOKEN: '', WHATSAPP_PHONE_NUMBER_ID: '', WHATSAPP_AUTOMATION_ENABLED: 'false', META_CRM_SYNC_ENABLED: 'false' } });
let logs = '';
child.stdout.on('data', data => { logs += data; }); child.stderr.on('data', data => { logs += data; });
const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error('Fixture timeout\n' + logs)), 30000);
  child.once('message', message => { clearTimeout(timer); resolve(message); });
  child.once('exit', code => { clearTimeout(timer); reject(Error('Fixture exited ' + code + '\n' + logs)); });
});
(async () => {
  let browser;
  try {
    const fixture = await ready;
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
    const detail = async id => {
      const response = await fetch(fixture.gatewayUrl + '/api/leads/' + id, { headers: { Authorization: 'Bearer follow-up-session' } });
      assert.equal(response.status, 200); return response.json();
    };
    for (const width of [1440, 1100, 390]) for (const attempts of [0, 1, 2, 5]) {
      const id = 'attempts-' + attempts;
      const before = await detail(id);
      assert.equal(before.lead.callAttempts, attempts, 'fixture must contain the requested real attempt count');
      const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1000 } });
      const errors = [], mutations = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => { if (!['GET', 'OPTIONS'].includes(request.method()) && request.url().includes('/api/leads/')) mutations.push(request.url()); });
      await page.addInitScript(user => { localStorage.setItem('crm.auth.token', 'follow-up-session'); localStorage.setItem('crm.auth.user', JSON.stringify(user)); }, fixture.user);
      await page.goto(fixture.frontUrl + '/pratiche/' + id);
      await page.locator('.pd-hero-action-call').waitFor();
      assert.equal(await page.getByRole('dialog').count(), 0, 'opening practice must never force an outcome');
      if (attempts >= 2) await page.getByText(attempts + ' tentativi senza risposta', { exact: true }).waitFor();
      else assert.equal(await page.locator('.pd-attempts-alert').filter({ hasText: /tentativ/ }).count(), 0);
      const outcome = page.locator('#timeline-section').getByRole('button', { name: 'Registra esito', exact: true });
      for (const method of ['escape', 'cancel', 'close', 'backdrop']) {
        await outcome.click(); const dialog = page.getByRole('dialog', { name: 'Esito chiamata', exact: true }); await dialog.waitFor();
        await dialog.locator('textarea').fill('Bozza da scartare');
        if (method === 'escape') await page.keyboard.press('Escape');
        if (method === 'cancel') await dialog.getByRole('button', { name: 'Annulla', exact: true }).click();
        if (method === 'close') await dialog.getByRole('button', { name: 'Chiudi modale esito chiamata' }).click();
        if (method === 'backdrop') await page.locator('.pd-note-modal-backdrop').click({ position: { x: 2, y: 2 } });
        await dialog.waitFor({ state: 'detached' });
      }
      assert.deepEqual(mutations, [], 'dismissal must not save outcomes or mutate the practice');
      const dismissed = await detail(id);
      assert.equal(dismissed.lead.status, before.lead.status);
      assert.deepEqual(dismissed.callLogs, before.callLogs); assert.deepEqual(dismissed.timeline, before.timeline);
      assert.deepEqual(dismissed.tasks, before.tasks);
      // Existing document/payment/timeline areas remain reachable, without changing their data.
      await page.getByRole('heading', { name: 'Documenti', exact: true }).scrollIntoViewIfNeeded();
      await page.locator('.pd-payments-edit').click();
      await page.getByRole('form', { name: 'Modifica importi pratica' }).getByRole('button', { name: 'Annulla', exact: true }).click();
      await page.locator('.pd-hero-action-note').click();
      await page.locator('.pd-notes-input').fill('Dati consultati ' + width + 'px');
      await page.getByRole('button', { name: 'Salva nota', exact: true }).click();
      await page.locator('.pd-notes-input').waitFor({ state: 'detached' });
      assert.equal((await detail(id)).lead.callAttempts, attempts);
      await page.waitForFunction(() => document.querySelector('.pd-hero-action-call')?.title !== 'Interno 3CX non configurato');
      const dial = page.waitForResponse(response => response.url().endsWith('/api/3cx/call') && response.request().method() === 'POST');
      await page.locator('.pd-hero-action-call').click(); assert.equal((await dial).status(), 200);
      await page.reload(); await page.locator('.pd-hero-action-call').waitFor();
      assert.equal(await page.getByRole('dialog').count(), 0, 'reload after dial must not force outcome');
      const after = await detail(id); assert.equal(after.lead.status, before.lead.status);
      assert.deepEqual(after.callLogs, before.callLogs); assert.deepEqual(after.tasks, before.tasks);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
      assert.deepEqual(errors, []); await page.close();
      console.log('PASS follow-up ' + attempts + ' attempts / ' + width + 'px: open, dismiss x4 without writes, documents/payments, edit note, dial, reload, history/tasks');
    }
  } finally {
    if (browser) await browser.close();
    if (child.exitCode === null && child.signalCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; }
    fs.rmSync(dbFile, { force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
