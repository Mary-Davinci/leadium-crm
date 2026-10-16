/* Local-only Calls UI regression: build backend first; supply an existing Playwright runtime
 * via PLAYWRIGHT_MODULE / PLAYWRIGHT_CHROMIUM_EXECUTABLE if it isn't installed locally.
 * Real local gateway/session checks, isolated JSON fixtures, disabled 3CX, no production access. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
const dbFile = path.join(os.tmpdir(), 'leadium-calls-browser-' + process.pid + '.json');
const source = `
const fs=require('fs'),http=require('http');
const root=${JSON.stringify(root)};
const listen=async s=>{await new Promise(r=>s.listen(0,'127.0.0.1',r));return 'http://127.0.0.1:'+s.address().port;};
(async()=>{
fs.writeFileSync(process.env.JSON_DB_FILE,JSON.stringify({leads:[],activities:[],tasks:[],customers:[],purchases:[],callLogs:[]}));
const store=require(root+'/backend/dist/services/common/leadStore.js');
const calls=require(root+'/backend/dist/services/common/callStore.js');
const now=new Date().toISOString();
await store.createLead({id:'calls-fixture',fullName:'Cliente fixture chiamate',phone:'+393331234567',status:'In contatto',createdAt:now,updatedAt:now});
await calls.createCallLog({leadId:'calls-fixture',startedAt:now,endedAt:now,outcome:'completed',actor:'901',source:'3cx'});
const leads=require(root+'/backend/dist/services/lead-service/server.js');
process.env.LEAD_SERVICE_URL=await listen(leads.server);
const mock=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end('[]');});
process.env.WHATSAPP_SERVICE_URL=await listen(mock);
const service=require(root+'/backend/dist/services/call-service/server.js');
if(!service.server.listening)await new Promise(r=>service.server.once('listening',r));
process.env.CALL_SERVICE_URL='http://127.0.0.1:'+service.server.address().port;
const gateway=require(root+'/backend/dist/services/api-gateway/server.js');
const users={};for(const role of ['admin','super_admin','operatore']){users[role]={id:'calls-'+role,username:'calls-'+role,name:'Fixture '+role,role};gateway.__setTestSession('calls-browser-'+role,users[role]);}
const gatewayUrl=await listen(gateway.server);
process.on('message',message=>{if(message.expire){gateway.__setTestSession('calls-browser-'+message.expire,users[message.expire],-1);process.send({expired:message.expire});}});
process.env.API_TARGET=gatewayUrl;
const {createServer}=await import(require('url').pathToFileURL(root+'/frontend/node_modules/vite/dist/node/index.js').href);
const vite=await createServer({root:root+'/frontend',configFile:root+'/frontend/vite.config.ts',server:{host:'127.0.0.1',port:0,strictPort:false}});
await vite.listen();process.send({frontUrl:'http://127.0.0.1:'+vite.httpServer.address().port,gatewayUrl,users});
})().catch(()=>{console.error('Calls fixture startup failed');process.exit(1)});
`;
const child = spawn(process.execPath, ['-e', source], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  env: { ...process.env, NODE_ENV: 'test', JSON_DB_FILE: dbFile, MONGODB_URI: '', MONGO_URL: '', META_CRM_SYNC_ENABLED: 'false',
    CALL_SERVICE_PORT: '0', THREECX_ENABLED: 'false', THREECX_CLIENT_ID: 'fixture', THREECX_BASE_URL: 'https://pbx.invalid', THREECX_API_KEY: 'unused-synthetic-fixture' }
});
let logs = '';
child.stdout.on('data', chunk => { logs += chunk; });
child.stderr.on('data', chunk => { logs += chunk; });
const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Calls fixture timeout\n' + logs)), 30000);
  child.once('message', message => { clearTimeout(timer); resolve(message); });
  child.once('exit', code => { clearTimeout(timer); reject(new Error('Calls fixture exited ' + code + '\n' + logs)); });
});
async function checkGeometry(page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  for (const control of await page.locator('.calls-hero-actions button,.calls-diagnostics button').all()) {
    await control.scrollIntoViewIfNeeded();
    const fits = await control.evaluate(el => { const r = el.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return r.x >= 0 && r.right <= innerWidth && r.width > 0 && !!hit && (el === hit || el.contains(hit)); });
    assert.ok(fits, 'Calls control must fit and remain uncovered');
  }
}
(async () => {
  let browser;
  try {
    const fixture = await ready;
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
    for (const width of [1440, 1100, 390]) for (const role of ['admin', 'super_admin', 'operatore']) {
      const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1000 } });
      const errors = [], diagnosticsRequests = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => { if (request.url().includes('/api/3cx/diagnostics')) diagnosticsRequests.push(request); });
      await page.addInitScript(({ user, token }) => { localStorage.setItem('crm.auth.token', token); localStorage.setItem('crm.auth.user', JSON.stringify(user)); }, { user: fixture.users[role], token: 'calls-browser-' + role });
      await page.goto(fixture.frontUrl + '/calls');
      await page.locator('.calls-row').waitFor();
      assert.equal(await page.locator('.calls-error').count(), 0);
      assert.equal(await page.locator('#calls-legacy-webhook').count(), 0);
      if (role !== 'operatore') {
        const panel = page.getByRole('region', { name: 'Stato 3CX' });
        await panel.getByText('enabled', { exact: true }).waitFor();
        const fields = await panel.locator('dt').allTextContents();
        assert.deepEqual(fields, ['enabled', 'configured', 'connected', 'lastConnectedAt', 'lastEventAt', 'lastCallId', 'lastError']);
        assert.equal(await panel.locator('dd').first().innerText(), 'false');
        assert.ok(diagnosticsRequests.every(request => request.headers().authorization === 'Bearer calls-browser-' + role));
        await page.getByRole('button', { name: 'Strumento tecnico/admin: test webhook 3CX legacy' }).click();
        await page.locator('#calls-legacy-webhook textarea').waitFor();
        await page.getByRole('button', { name: 'Nascondi test tecnico' }).click();
        assert.equal(await page.locator('#calls-legacy-webhook').count(), 0);
        // A diagnostic outage must not masquerade as an empty call register or logout.
        await page.route('**/api/3cx/diagnostics', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Stato temporaneamente non disponibile"}' }));
        await panel.getByRole('button', { name: 'Aggiorna stato' }).click();
        await panel.getByRole('alert').waitFor(); assert.equal(await page.locator('.calls-row').count(), 1);
      } else {
        assert.equal(await page.getByRole('region', { name: 'Stato 3CX' }).count(), 0);
        assert.equal(await page.getByRole('button', { name: /test webhook/ }).count(), 0);
        assert.equal(diagnosticsRequests.length, 0);
      }
      await checkGeometry(page); assert.deepEqual(errors, []);
      console.log('PASS Calls UI ' + role + ' ' + width + 'px: register, diagnostics permissions, legacy collapsed, usable controls');
      await page.close();
    }
    const page = await browser.newPage();
    await page.addInitScript(user => { localStorage.setItem('crm.auth.token', 'calls-browser-admin'); localStorage.setItem('crm.auth.user', JSON.stringify(user)); }, fixture.users.admin);
    await page.goto(fixture.frontUrl + '/calls'); await page.locator('.calls-row').waitFor();
    const expired = new Promise(resolve => child.once('message', resolve)); child.send({ expire: 'admin' }); await expired;
    await page.getByRole('button', { name: 'Aggiorna', exact: true }).click();
    await page.waitForURL('**/login'); await page.getByRole('heading', { name: 'Bentornato' }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('crm.auth.token')), null);
    assert.equal(await page.evaluate(() => localStorage.getItem('crm.auth.user')), null);
    console.log('PASS invalidated admin session: real gateway 401 redirects to login and removes cached identity'); await page.close();
    const anonymous = await browser.newPage(); await anonymous.goto(fixture.frontUrl + '/calls'); await anonymous.waitForURL('**/login');
    for (const route of ['/api/calls?limit=250', '/api/3cx/diagnostics']) assert.equal((await fetch(fixture.gatewayUrl + route)).status, 401);
    console.log('PASS no session: login required; calls and diagnostics remain protected'); await anonymous.close();
  } finally {
    if (browser) await browser.close();
    if (child.exitCode === null && child.signalCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; }
    if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
