/* Isolated local V2 UAT: actual gateway + CRM lookup + SSE + controller, synthetic PBX only.
 * Uses an existing Playwright runtime; never connects to 3CX or production. */
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
const dbFile = path.join(os.tmpdir(), 'leadium-threecx-v2-browser-' + process.pid + '.json');
const source = `
const fs=require('fs'),http=require('http');
const root=${JSON.stringify(root)};
const listen=async s=>{await new Promise(r=>s.listen(0,'127.0.0.1',r));return 'http://127.0.0.1:'+s.address().port};
(async()=>{
fs.writeFileSync(process.env.JSON_DB_FILE,JSON.stringify({leads:[],activities:[],tasks:[],customers:[],purchases:[],callLogs:[]}));
const store=require(root+'/backend/dist/services/common/leadStore.js');
const now=new Date().toISOString();
await store.createLead({id:'native-fixture',fullName:'Cliente Native Fixture',phone:'+393331234567',status:'In contatto',createdAt:now,updatedAt:now,documents:{items:[]},payments:{items:[]}});
const leads=require(root+'/backend/dist/services/lead-service/server.js');process.env.LEAD_SERVICE_URL=await listen(leads.server);
const mock=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end('{}')});process.env.WHATSAPP_SERVICE_URL=await listen(mock);
let rows=[],writes=[];
const {ThreeCxController,ThreeCxOAuth,capabilities}=require(root+'/backend/dist/services/call-service/threecx-controller.js');
const {monitorConfig}=require(root+'/backend/dist/services/call-service/threecx-monitor.js');
const {isCallControlInternal}=require(root+'/backend/dist/services/call-service/threecx-internal.js');
const config=monitorConfig({THREECX_ENABLED:'true',THREECX_BASE_URL:'https://pbx.invalid',THREECX_CLIENT_ID:'fixture',THREECX_API_KEY:'unused-synthetic-key'});
const pbx=async(url,init)=>{
if(url.endsWith('/connect/token'))return Response.json({access_token:'unused-synthetic-token',expires_in:3600});
if(init.method==='GET'){const row=rows[0];return Response.json({id:row.participantId,dn:row.agentDn,callid:Number(row.callId),status:row.status==='ringing'?'Ringing':'Connected',direct_control:row.directControl})}
writes.push(new URL(url).pathname);
if(url.endsWith('/answer'))rows=rows.map(row=>({...row,status:'connected',answeredAt:new Date().toISOString()}));
if(url.endsWith('/drop')||url.endsWith('/transferto'))rows=[];
await new Promise(r=>setTimeout(r,120));return Response.json({finalstatus:'Success',result:{callid:789},providerSecret:'must-never-display'});
};
const controller=new ThreeCxController(config,new ThreeCxOAuth(config,pbx),()=>rows,async()=>{},pbx);
const internal=http.createServer(async(req,res)=>{
if(!isCallControlInternal(req.headers['x-leadium-call-control'])){res.writeHead(403);res.end();return}
try{let data;if(req.url.startsWith('/3cx/live'))data={available:true,calls:rows.map(({participantId,directControl,...call})=>({...call,capabilities:capabilities({...call,participantId,directControl})}))};
else{let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);data=await controller.execute(body.actor,body.action,body.input,body.callId)}
res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(data));
}catch(e){res.writeHead(e.status||503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}))}});
process.env.CALL_SERVICE_URL=await listen(internal);
const auth=require(root+'/backend/dist/services/api-gateway/auth-store.js');auth.getUserThreeCxDn=async user=>user.id==='mapped-user'?'901':user.id==='other-user'?'913':'';
const gateway=require(root+'/backend/dist/services/api-gateway/server.js');
const users={mapped:{id:'mapped-user',username:'mapped',name:'Mapped Fixture',role:'operatore'},other:{id:'other-user',username:'other',name:'Other Fixture',role:'operatore'},unmapped:{id:'unmapped-user',username:'unmapped',name:'Unmapped Fixture',role:'operatore'}};
for(const [key,user]of Object.entries(users))gateway.__setTestSession('native-'+key,user);
const gatewayUrl=await listen(gateway.server);process.env.API_TARGET=gatewayUrl;
process.on('message',msg=>{if(msg.rows)rows=msg.rows;if(msg.reset){rows=[];writes=[];controller.recent.clear();controller.rates.clear()}process.send({ack:true,writes})});
const {createServer}=await import(require('url').pathToFileURL(root+'/frontend/node_modules/vite/dist/node/index.js').href);
const vite=await createServer({root:root+'/frontend',configFile:root+'/frontend/vite.config.ts',server:{host:'127.0.0.1',port:0,strictPort:false}});await vite.listen();
process.send({frontUrl:'http://127.0.0.1:'+vite.httpServer.address().port,gatewayUrl,users});
})().catch(e=>{console.error(e);process.exit(1)});
`;
const child = spawn(process.execPath, ['-e', source], { cwd: root, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env,
  NODE_ENV: 'test', JSON_DB_FILE: dbFile, MONGODB_URI: '', MONGO_URL: '', THREECX_ENABLED: 'false', WHATSAPP_AUTOMATION_ENABLED: 'false', META_CRM_SYNC_ENABLED: 'false' } });
let logs = '';
child.stdout.on('data', data => { logs += data; }); child.stderr.on('data', data => { logs += data; });
const ready = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('V2 fixture timeout\n' + logs)), 30000);
  child.once('message', msg => { clearTimeout(timer); resolve(msg); }); child.once('exit', code => { clearTimeout(timer); reject(Error('V2 fixture exit ' + code + '\n' + logs)); }); });
const update = msg => new Promise(resolve => { child.once('message', resolve); child.send(msg); });
const incoming = (extra = {}) => ({ callId: '123', agentDn: '901', direction: 'inbound', customerPhone: '+393331234567', status: 'ringing', startedAt: new Date().toISOString(), participantId: 1, directControl: false, ...extra });
async function geometry(page) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  for (const button of await page.locator('.threecx-live button,.threecx-live a,.threecx-live select').all()) {
    await button.scrollIntoViewIfNeeded(); assert.ok(await button.evaluate(el => { const r=el.getBoundingClientRect(), hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.width>0&&r.x>=0&&r.right<=innerWidth&&!!hit&&(el===hit||el.contains(hit)); }));
  }
}
(async () => {
  let browser;
  try {
    const fixture = await ready;
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
    for (const width of [1440, 1100, 390]) {
      await update({ reset: true });
      const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1000 },
        ...(width === 1100 ? { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36' } : {}) });
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(user => { localStorage.setItem('crm.auth.token','native-mapped');localStorage.setItem('crm.auth.user',JSON.stringify(user)); }, fixture.users.mapped);
      const eventsReady = page.waitForResponse(response => response.url().includes('/api/3cx/events'));
      await page.goto(fixture.frontUrl + '/calls'); await eventsReady;
      await update({ rows: [incoming()] });
      let card = page.getByRole('region', { name: 'Chiamata in arrivo' }); await card.waitFor();
      assert.ok((await card.innerText()).includes('Cliente Native Fixture'));
      await card.getByText('Rispondi dal dispositivo 3CX').waitFor(); assert.equal(await card.getByRole('button',{name:'Rispondi',exact:true}).count(),0);
      await update({ rows: [incoming({ directControl: true })] });
      await card.getByRole('button',{name:'Rispondi',exact:true}).waitFor(); assert.equal(await page.locator('.threecx-live-call').count(),1);
      await card.getByRole('link',{name:'Apri pratica'}).click();await page.waitForURL('**/pratiche/native-fixture');
      assert.equal(await page.locator('.threecx-live-call').count(),1,'global call card survives client-side page navigation');
      await geometry(page);
      await page.screenshot({path:path.join(os.tmpdir(),'leadium-threecx-v2-'+width+'.png')});
      await card.getByRole('button',{name:'Rispondi',exact:true}).click();
      card=page.getByRole('region',{name:'Chiamata 3CX attiva'});await card.waitFor();await card.getByText(/In chiamata/).waitFor();
      await card.getByLabel('Destinazione trasferimento').selectOption('913');await card.getByRole('button',{name:'Trasferisci',exact:true}).click();
      await page.waitForFunction(()=>document.querySelectorAll('.threecx-live-call').length===0);
      await update({rows:[incoming({callId:'456',agentDn:'913'})]}); await new Promise(resolve=>setTimeout(resolve,1800));assert.equal(await page.locator('.threecx-live-call').count(),0);
      await update({rows:[incoming({callId:'789',customerPhone:'+393339876543',directControl:true})]});card=page.getByRole('region',{name:'Chiamata in arrivo'});await card.waitFor();await card.getByText('Numero non associato').waitFor();
      await card.getByRole('button',{name:'Rifiuta',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.threecx-live-call').length===0);
      await update({reset:true});
      await page.goto(fixture.frontUrl+'/pratiche/native-fixture');await page.locator('.pd-hero-action-call').waitFor();
      await page.waitForFunction(()=>document.querySelector('.pd-hero-action-call')?.title !== 'Interno 3CX non configurato');
      await page.locator('.pd-hero-action-call').evaluate(el=>{el.click();el.click()});
      await page.getByText('Chiamata inviata a 3CX',{exact:true}).waitFor();
      const state=await update({});assert.equal(state.writes.filter(p=>p.endsWith('/makecall')).length,1);
      const leadResponse=await fetch(fixture.gatewayUrl+'/api/leads/native-fixture',{headers:{Authorization:'Bearer native-mapped'}});assert.equal((await leadResponse.json()).lead.status,'In contatto');
      assert.equal(await page.locator('.pd-hero-actions').getByRole('button',{name:'Registra esito',exact:true}).count(),0);
      const outcomeButton=page.locator('#timeline-section').getByRole('button',{name:'Registra esito',exact:true});
      await outcomeButton.evaluate(el=>el.scrollIntoView({block:'center',behavior:'instant'}));
      await page.screenshot({path:path.join(os.tmpdir(),'leadium-threecx-timeline-'+width+'.png')});
      assert.ok(await outcomeButton.evaluate(el=>{const r=el.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.x>=0&&r.right<=innerWidth&&!!hit&&(el===hit||el.contains(hit));}));
      await outcomeButton.click();await page.locator('.pd-note-modal-backdrop').waitFor();
      await page.keyboard.press('Escape');await page.waitForFunction(()=>document.querySelectorAll('.pd-note-modal-backdrop').length===0);
      assert.deepEqual(errors,[]);await geometry(page);await page.close();
      console.log('PASS V2 '+width+'px: global incoming, direct_control, lookup, answer/transfer/reject, isolation, no duplicates, native dial/double-click, unchanged practice, usable controls');
    }
    const unmapped=await browser.newPage();await unmapped.addInitScript(user=>{localStorage.setItem('crm.auth.token','native-unmapped');localStorage.setItem('crm.auth.user',JSON.stringify(user))},fixture.users.unmapped);
    await unmapped.goto(fixture.frontUrl+'/pratiche/native-fixture');await unmapped.locator('.pd-hero-action-call').click();await unmapped.getByText('Interno 3CX non configurato',{exact:true}).waitFor();await unmapped.close();
    console.log('PASS V2 no mapping: readable unavailable state, no local URI/audio dependency');
  } finally {
    if(browser)await browser.close();
    if(child.exitCode===null&&child.signalCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited;}
    if(fs.existsSync(dbFile))fs.unlinkSync(dbFile);
  }
})().catch(error=>{console.error(error);process.exitCode=1});
