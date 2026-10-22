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
const customers=require(root+'/backend/dist/services/common/customerStore.js');const shared=await customers.findOrCreateCustomerByContact({phone:'+393401112233',fullName:'Cliente Condiviso'});
for(const [id,extra] of [['shared-a',{status:'In contatto'}],['shared-b',{status:'Perso',closingOutcome:'lost'}]])await store.createLead({id,fullName:'Cliente Condiviso',phone:'+393401112233',customerId:shared.id,createdAt:now,updatedAt:now,documents:{items:[]},payments:{items:[]},...extra});
const leads=require(root+'/backend/dist/services/lead-service/server.js');process.env.LEAD_SERVICE_URL=await listen(leads.server);
const mock=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end('{}')});process.env.WHATSAPP_SERVICE_URL=await listen(mock);
// Self-contained: the real workflow definition, without depending on a locally running stack.
const {getWorkflowView,isValidTransition}=require(root+'/backend/dist/services/common/workflow.js');
const workflow=http.createServer((req,res)=>{const u=new URL(req.url,'http://x');res.setHeader('Content-Type','application/json');
if(u.pathname==='/workflow'){res.end(JSON.stringify(getWorkflowView()));return}
if(u.pathname==='/internal/validate-transition'){res.end(JSON.stringify({valid:isValidTransition(String(u.searchParams.get('from')||''),String(u.searchParams.get('to')||''))}));return}
res.statusCode=404;res.end('{}')});process.env.WORKFLOW_SERVICE_URL=await listen(workflow);
let rows=[],writes=[];
const {ThreeCxController,ThreeCxOAuth,capabilities}=require(root+'/backend/dist/services/call-service/threecx-controller.js');
const {monitorConfig}=require(root+'/backend/dist/services/call-service/threecx-monitor.js');
const {isCallControlInternal}=require(root+'/backend/dist/services/call-service/threecx-internal.js');
const config=monitorConfig({THREECX_ENABLED:'true',THREECX_BASE_URL:'https://pbx.invalid',THREECX_CLIENT_ID:'fixture',THREECX_API_KEY:'unused-synthetic-key'});
const pbx=async(url,init)=>{
if(url.endsWith('/connect/token'))return Response.json({access_token:'unused-synthetic-token',expires_in:3600});
if(init.method==='GET'){const pathname=new URL(url).pathname,dn=pathname.split('/')[2];if(!pathname.includes('/participants/'))return Response.json({dn,participants:rows.filter(row=>row.agentDn===dn).map(row=>({id:row.participantId,dn,callid:Number(row.callId)}))});const row=rows.find(row=>row.agentDn===dn&&row.participantId===Number(pathname.split('/').at(-1)));return row?Response.json({id:row.participantId,dn:row.agentDn,callid:Number(row.callId),status:row.status==='ringing'?'Ringing':'Connected',direct_control:row.directControl}):new Response('',{status:404})}
writes.push(new URL(url).pathname);
if(url.endsWith('/answer'))rows=rows.map(row=>({...row,status:'connected',answeredAt:new Date().toISOString()}));
if(url.endsWith('/drop')||url.endsWith('/transferto'))rows=[];
await new Promise(r=>setTimeout(r,120));return Response.json({finalstatus:'Success',result:{callid:789},providerSecret:'must-never-display'});
};
let deviceMap={'901':[{id:'private-device-901',ua:'3CX Web Client 20'}],'913':[{id:'private-device-913',ua:'3CX Web Client 20'}]};
const {deviceLabel}=require(root+'/backend/dist/services/call-service/threecx-device-label.js');
const mask=id=>'device-'+require('crypto').createHash('sha256').update(id).digest('hex').slice(0,12);
const controller=new ThreeCxController(config,new ThreeCxOAuth(config,pbx),()=>rows,async()=>{},pbx,undefined,dn=>(deviceMap[dn]||[]).map(d=>d.id),mask);
const internal=http.createServer(async(req,res)=>{
if(!isCallControlInternal(req.headers['x-leadium-call-control'])){res.writeHead(403);res.end();return}
try{let data;if(req.url.startsWith('/3cx/devices')){const dn=new URL(req.url,'http://x').searchParams.get('dn');data={available:true,devices:(deviceMap[dn]||[]).map(d=>({device:mask(d.id),label:deviceLabel(d.ua),userAgent:d.ua}))}}
else if(req.url.startsWith('/3cx/live'))data={available:true,calls:rows.map(({participantId,directControl,...call})=>({...call,capabilities:capabilities({...call,participantId,directControl})}))};
else{let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);data=await controller.execute(body.actor,body.action,body.input,body.callId)}
res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(data));
}catch(e){res.writeHead(e.status||503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}))}});
process.env.CALL_SERVICE_URL=await listen(internal);
const auth=require(root+'/backend/dist/services/api-gateway/auth-store.js');auth.getUserThreeCxDn=async user=>user.id==='mapped-user'?'901':user.id==='other-user'?'913':'';
auth.listUsers=async()=>[{id:'u-giuseppe',username:'Giuseppe',name:'Giuseppe',surname:'Piraino',role:'operatore'},{id:'u-giuseppe-r',username:'giuseppe.r',name:'Giuseppe',surname:'Piraino',role:'operatore'},{id:'mapped-user',username:'mapped',name:'Mapped',surname:'Fixture',role:'operatore'},{id:'admin-user',username:'admin',name:'Admin',surname:'Fixture',role:'admin'}];
const gateway=require(root+'/backend/dist/services/api-gateway/server.js');
const users={mapped:{id:'mapped-user',username:'mapped',name:'Mapped Fixture',role:'operatore'},other:{id:'other-user',username:'other',name:'Other Fixture',role:'operatore'},unmapped:{id:'unmapped-user',username:'unmapped',name:'Unmapped Fixture',role:'operatore'},admin:{id:'admin-user',username:'admin',name:'Admin Fixture',role:'admin'},giuseppe:{id:'u-giuseppe',username:'Giuseppe',name:'Giuseppe',surname:'Piraino',role:'operatore'}};
for(const [key,user]of Object.entries(users))gateway.__setTestSession('native-'+key,user);
const gatewayUrl=await listen(gateway.server);process.env.API_TARGET=gatewayUrl;
process.on('message',msg=>{if(msg.rows)rows=msg.rows;if(msg.devices)deviceMap=msg.devices;if(msg.reset){rows=[];writes=[];controller.recent.clear();controller.rates.clear()}process.send({ack:true,writes})});
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
async function geometryOf(page, root) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  for (const el of await root.locator('button,input').all()) {
    if (!(await el.isVisible())) continue;
    assert.ok(await el.evaluate(node => { const r = node.getBoundingClientRect(); return r.width > 0 && r.x >= 0 && r.right <= innerWidth; }));
  }
}
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
      await card.getByText('Rispondi dal dispositivo 3CX').waitFor(); assert.equal(await card.getByRole('button',{name:'Rispondi',exact:true}).isDisabled(),true,'answer shown but disabled without direct_control');
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
      const attemptCard=page.getByRole('region',{name:'Chiamata in uscita'});
      await attemptCard.getByText('Richiesta accettata da 3CX',{exact:true}).waitFor();
      await attemptCard.getByText(/Riferimento per la diagnostica: [a-f0-9]{8}/).waitFor();
      await attemptCard.getByText('Cliente Native Fixture').waitFor();
      await attemptCard.getByText('3331234567',{exact:false}).first().waitFor();
      assert.ok((await attemptCard.innerText()).includes('salvato: +393331234567'),'dialed national, stored number shown unchanged');
      assert.equal(await attemptCard.locator('time').count(),0,'no timer before an observed connection');
      let state=await update({});assert.equal(state.writes.filter(p=>p.endsWith('/makecall')).length,1);
      // Observed phases from the (synthetic) PBX events, keyed by the callid makecall returned (789).
      const outbound=(extra)=>({callId:'789',agentDn:'901',direction:'outbound',customerPhone:'',status:'ringing',startedAt:new Date().toISOString(),participantId:9,directControl:false,...extra});
      await update({rows:[outbound({phase:'callback_ringing'})]});
      await attemptCard.getByText('Rispondi nel client 3CX',{exact:true}).waitFor();
      await attemptCard.getByRole('button',{name:'Annulla chiamata'}).waitFor();
      assert.equal(await attemptCard.getByRole('button',{name:/^Rispondi$/}).count(),0,'no in-CRM answer on a device without direct control');
      await page.screenshot({path:path.join(os.tmpdir(),'leadium-attempt-callback-'+width+'.png')});
      await update({rows:[outbound({phase:'dialing_customer',customerPhone:'+393331234567'})]});
      await attemptCard.getByText('Chiamata al cliente in corso',{exact:true}).waitFor();
      const connectedAt=new Date(Date.now()-65000).toISOString();
      await update({rows:[outbound({phase:'connected',status:'connected',customerPhone:'+393331234567',connectedAt})]});
      await attemptCard.getByText('In conversazione',{exact:true}).waitFor();
      await attemptCard.locator('time').filter({hasText:/^01:0[5-9]$/}).waitFor();
      await attemptCard.getByRole('button',{name:'Termina'}).waitFor();
      assert.equal(await page.locator('.threecx-live-call').count(),0,'the attempt call is not duplicated as a second card');
      await page.screenshot({path:path.join(os.tmpdir(),'leadium-attempt-connected-'+width+'.png')});
      // 3CX replaces legs during a makecall: a short gap in the snapshots is not the end of the call.
      await update({rows:[]});await new Promise(resolve=>setTimeout(resolve,1500));
      await update({rows:[outbound({phase:'connected',status:'connected',customerPhone:'+393331234567',connectedAt})]});
      await new Promise(resolve=>setTimeout(resolve,3500));
      assert.equal(await attemptCard.getByText('Chiamata conclusa',{exact:true}).count(),0,'a short gap does not end the attempt');
      await attemptCard.getByText('In conversazione',{exact:true}).waitFor();
      // A reload of the page keeps the open call card, with its hang-up control.
      await page.reload();
      await attemptCard.getByText('In conversazione',{exact:true}).waitFor();
      await attemptCard.getByRole('button',{name:'Termina'}).waitFor();
      await update({rows:[]});
      await attemptCard.getByText('Chiamata conclusa',{exact:true}).waitFor();
      await attemptCard.getByText(/Durata conversazione 01:[0-5][0-9]\./).waitFor();
      await page.screenshot({path:path.join(os.tmpdir(),'leadium-attempt-ended-'+width+'.png')});
      await attemptCard.getByRole('button',{name:'Registra esito'}).click();
      await page.locator('.pd-note-modal-backdrop').waitFor();
      assert.ok(page.url().includes('/pratiche/native-fixture'),'existing outcome dialog opened in place');
      await page.keyboard.press('Escape');await page.waitForFunction(()=>document.querySelectorAll('.pd-note-modal-backdrop').length===0);
      await attemptCard.getByRole('button',{name:'Chiudi'}).click();await attemptCard.waitFor({state:'detached'});
      // Two devices (web client + app): explicit choice, the chosen one is dialed, cancel sends nothing.
      await update({reset:true,devices:{'901':[{id:'web-901',ua:'3CX Web Client 20'},{id:'android-901',ua:'3CXAndroid 20.1'}]}});
      await page.locator('.pd-hero-action-call').click();
      const picker=page.getByRole('group',{name:'Scegli il dispositivo'});await picker.waitFor();
      assert.equal(await picker.getByRole('button').filter({hasText:'App 3CX Android'}).count(),1);
      assert.equal(await picker.getByRole('button').filter({hasText:'Client web 3CX'}).count(),1);
      await geometry(page);
      if(width===390)await page.screenshot({path:path.join(os.tmpdir(),'leadium-device-picker-390.png')});
      await picker.getByRole('button',{name:'Annulla'}).click();await page.getByText('Chiamata annullata',{exact:true}).waitFor();
      state=await update({});assert.equal(state.writes.filter(p=>p.endsWith('/makecall')).length,0,'cancel never dials');
      await page.locator('.pd-hero-action-call').click();
      await page.getByRole('group',{name:'Scegli il dispositivo'}).getByRole('button').filter({hasText:'App 3CX Android'}).click();
      await page.getByRole('region',{name:'Chiamata in uscita'}).getByText('Richiesta accettata da 3CX',{exact:true}).waitFor();
      await page.getByRole('region',{name:'Chiamata in uscita'}).getByText('App 3CX Android',{exact:true}).waitFor();
      state=await update({});assert.deepEqual(state.writes.filter(p=>p.endsWith('/makecall')),['/callcontrol/901/devices/android-901/makecall'],'the chosen device, never the first');
      await update({reset:true,devices:{'901':[],'913':[]}});
      await page.locator('.pd-hero-action-call').click();await page.getByText(/Nessun dispositivo 3CX collegato all'interno 901/).waitFor();
      await update({reset:true,devices:{'901':[{id:'private-device-901',ua:'3CX Web Client 20'}],'913':[{id:'private-device-913',ua:'3CX Web Client 20'}]}});
      const leadResponse=await fetch(fixture.gatewayUrl+'/api/leads/native-fixture',{headers:{Authorization:'Bearer native-mapped'}});assert.equal((await leadResponse.json()).lead.status,'In contatto');
      assert.equal(await page.locator('.pd-hero-actions').getByRole('button',{name:'Registra esito',exact:true}).count(),0);
      const outcomeButton=page.locator('#timeline-section').getByRole('button',{name:'Registra esito',exact:true});
      await outcomeButton.evaluate(el=>el.scrollIntoView({block:'center',behavior:'instant'}));
      await page.screenshot({path:path.join(os.tmpdir(),'leadium-threecx-timeline-'+width+'.png')});
      assert.ok(await outcomeButton.evaluate(el=>{const r=el.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.x>=0&&r.right<=innerWidth&&!!hit&&(el===hit||el.contains(hit));}));
      await outcomeButton.click();await page.locator('.pd-note-modal-backdrop').waitFor();
      await page.keyboard.press('Escape');await page.waitForFunction(()=>document.querySelectorAll('.pd-note-modal-backdrop').length===0);
      assert.deepEqual(errors,[]);await geometry(page);await page.close();
      console.log('PASS V2 '+width+'px: global incoming, direct_control, lookup, answer/transfer/reject, isolation, no duplicates, native dial/double-click, device choice/cancel/none, unchanged practice, usable controls');
    }
    const unmapped=await browser.newPage();await unmapped.addInitScript(user=>{localStorage.setItem('crm.auth.token','native-unmapped');localStorage.setItem('crm.auth.user',JSON.stringify(user))},fixture.users.unmapped);
    await unmapped.goto(fixture.frontUrl+'/pratiche/native-fixture');await unmapped.locator('.pd-hero-action-call').click();await unmapped.getByText('Interno 3CX non configurato',{exact:true}).waitFor();await unmapped.close();
    console.log('PASS V2 no mapping: readable unavailable state, no local URI/audio dependency');
    // Contact correction (operator: name/email; admin: phone) and duplicate notice, real gateway + lead-service.
    for (const width of [1440, 390]) {
      const operatorPage=await browser.newPage({viewport:{width,height:900}});const operatorErrors=[];operatorPage.on('pageerror',error=>operatorErrors.push(error.message));
      await operatorPage.addInitScript(user=>{localStorage.setItem('crm.auth.token','native-mapped');localStorage.setItem('crm.auth.user',JSON.stringify(user))},fixture.users.mapped);
      await operatorPage.goto(fixture.frontUrl+'/pratiche/native-fixture');await operatorPage.getByRole('button',{name:'Modifica dati'}).click();
      const opDialog=operatorPage.getByRole('dialog',{name:'Modifica dati cliente'});await opDialog.waitFor();
      await opDialog.getByLabel('Email').fill('non-valida@');await opDialog.getByRole('button',{name:'Salva dati'}).click();
      await opDialog.getByRole('alert').getByText(/Email non valida/).waitFor();
      const renamed='Cliente Rinominato '+width;
      await opDialog.getByLabel('Nome',{exact:true}).fill('Cliente');await opDialog.getByLabel('Cognome').fill('Rinominato '+width);
      await opDialog.getByLabel('Email').fill('cliente.'+width+'@example.test');
      await operatorPage.screenshot({path:path.join(os.tmpdir(),'leadium-contact-modal-'+width+'.png')});
      await geometryOf(operatorPage,opDialog);
      await opDialog.getByRole('button',{name:'Salva dati'}).click();await opDialog.waitFor({state:'detached'});
      await operatorPage.locator('.pd-hero-main h4').getByText(renamed,{exact:true}).waitFor();
      await operatorPage.getByText('cliente.'+width+'@example.test').first().waitFor();
      await operatorPage.getByText('Dati cliente modificati').first().waitFor();
      // Back to the fixture name used by the later checks (the edit itself is what was under test).
      await operatorPage.getByRole('button',{name:'Modifica dati'}).click();
      await opDialog.getByLabel('Nome',{exact:true}).fill('Cliente');await opDialog.getByLabel('Cognome').fill('Native Fixture');
      await opDialog.getByRole('button',{name:'Salva dati'}).click();await opDialog.waitFor({state:'detached'});
      await operatorPage.locator('.pd-hero-main h4').getByText('Cliente Native Fixture',{exact:true}).waitFor();
      assert.deepEqual(operatorErrors,[]);await operatorPage.close();
      const page=await browser.newPage({viewport:{width,height:900}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
      await page.addInitScript(user=>{localStorage.setItem('crm.auth.token','native-admin');localStorage.setItem('crm.auth.user',JSON.stringify(user))},fixture.users.admin);
      await page.goto(fixture.frontUrl+'/pratiche/native-fixture');await page.getByRole('button',{name:'Modifica dati'}).click();
      const dialog=page.getByRole('dialog',{name:'Modifica dati cliente'});await dialog.waitFor();
      const target=width===1440?'+39 333 7777777':'+39 333 7777778';
      await dialog.getByLabel('Telefono').fill(target.replace('+39 ',''));await dialog.getByRole('button',{name:'Salva dati'}).click();
      await dialog.getByRole('alert').getByText(/formato internazionale/).waitFor();
      await page.screenshot({path:path.join(os.tmpdir(),'leadium-phone-modal-'+width+'.png')});
      await dialog.getByLabel('Telefono').fill(target);await dialog.getByRole('button',{name:'Salva dati'}).click();
      await dialog.waitFor({state:'detached'});
      await page.locator('.pd-sub').first().getByText(target).waitFor();
      await page.getByText('Telefono modificato').first().waitFor();
      await page.goto(fixture.frontUrl+'/pratiche');await page.getByRole('button',{name:'+ Nuovo lead'}).click();
      await page.getByPlaceholder('Nome e cognome del cliente').fill('Nome Diverso '+width);await page.getByPlaceholder('+39 ...').fill(target);
      await page.getByRole('button',{name:'Crea lead',exact:true}).click();
      await page.getByText('Lead gia esistente con questo telefono').waitFor();await page.getByText(/stato e avanzamento della pratica non sono cambiati/).waitFor();
      assert.ok(page.url().endsWith('/pratiche'),'no silent navigation to the existing lead');
      await page.screenshot({path:path.join(os.tmpdir(),'leadium-duplicate-'+width+'.png')});
      await page.getByRole('button',{name:'Apri lead esistente'}).click();await page.waitForURL('**/pratiche/native-fixture**');
      assert.deepEqual(errors,[]);await page.close();
      console.log('PASS '+width+'px: operator corrects name/email (invalid refused, saved, audited), admin phone (ambiguous refused, saved, audited), duplicate notice without silent navigation');
    }
    {
      const page=await browser.newPage({viewport:{width:1100,height:900}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
      await page.addInitScript(user=>{localStorage.setItem('crm.auth.token','native-admin');localStorage.setItem('crm.auth.user',JSON.stringify(user))},fixture.users.admin);
      await page.goto(fixture.frontUrl+'/pratiche/shared-a');await page.getByRole('button',{name:'Modifica dati'}).click();
      const dialog=page.getByRole('dialog',{name:'Modifica dati cliente'});await dialog.getByLabel('Telefono').fill('+39 340 1112244');
      await dialog.getByRole('button',{name:'Salva dati'}).click();
      const choice=dialog.getByRole('group',{name:'Scheda cliente collegata'});await choice.getByText(/condivisa con un'altra pratica/).waitFor();
      await page.screenshot({path:path.join(os.tmpdir(),'leadium-phone-choice-1100.png')});
      await choice.getByRole('button',{name:'Solo questa pratica'}).click();
      await page.locator('.pd-sub').first().getByText('+39 340 1112244').waitFor();await page.locator('.pd-phone-notice').getByText(/Correzione parziale.*WhatsApp/).waitFor();
      assert.deepEqual(errors,[]);await page.close();
      console.log('PASS shared customer: explicit choice shown with impact, lead-only correction applied and flagged as partial for WhatsApp');
    }
    {
      // Operator: create -> practice opens -> back to Pratiche (fresh list, own scope) -> visible.
      const page=await browser.newPage({viewport:{width:1100,height:900}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
      await page.addInitScript(user=>{localStorage.setItem('crm.auth.token','native-mapped');localStorage.setItem('crm.auth.user',JSON.stringify(user))},fixture.users.mapped);
      await page.goto(fixture.frontUrl+'/pratiche');await page.getByRole('button',{name:'+ Nuovo lead'}).click();
      await page.getByPlaceholder('Nome e cognome del cliente').fill('Lead Operatore UAT');await page.getByPlaceholder('+39 ...').fill('+39 333 4440099');
      await page.getByRole('button',{name:'Crea lead',exact:true}).click();
      await page.waitForURL(url=>String(url).includes('/pratiche/lead_'));await page.getByRole('heading',{name:'Lead Operatore UAT'}).waitFor();
      await page.getByRole('link',{name:'Torna a pratiche'}).click();await page.waitForURL('**/pratiche');
      await page.getByText('Lead Operatore UAT').first().waitFor({timeout:10000});
      await page.getByRole('button',{name:'+ Nuovo lead'}).click();
      await page.getByPlaceholder('Nome e cognome del cliente').fill('Altro nome');await page.getByPlaceholder('+39 ...').fill('+39 333 4440099');
      await page.getByRole('button',{name:'Crea lead',exact:true}).click();await page.getByText('E gia tra le tue pratiche.').waitFor();
      await page.getByRole('button',{name:'Chiudi',exact:true}).click();
      await page.getByRole('button',{name:'+ Nuovo lead'}).click();
      await page.getByPlaceholder('Nome e cognome del cliente').fill('Nome diverso');await page.getByPlaceholder('+39 ...').fill('+39 333 7777778');
      await page.getByRole('button',{name:'Crea lead',exact:true}).click();
      await page.getByText(/Non e assegnato a nessuno: non compare tra le tue pratiche/).waitFor();
      await page.screenshot({path:path.join(os.tmpdir(),'leadium-operator-duplicate-1100.png')});
      assert.deepEqual(errors,[]);await page.close();
      console.log('PASS operator: created lead is assigned, listed in Pratiche after creation and opens; duplicate notice explains own/unassigned');
    }
    for (const width of [1100, 390]) {
      // Admin assigns "Cliente Native Fixture" to Giuseppe through the dialog (no prompt, no free text).
      const page=await browser.newPage({viewport:{width,height:900}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
      page.on('dialog',dialog=>{errors.push('native dialog: '+dialog.message());void dialog.dismiss();});
      await page.addInitScript(user=>{localStorage.setItem('crm.auth.token','native-admin');localStorage.setItem('crm.auth.user',JSON.stringify(user))},fixture.users.admin);
      await page.goto(fixture.frontUrl+'/pratiche');
      const openDialog=async()=>{await page.getByRole('button',{name:'Azioni per Cliente Native Fixture'}).first().click();await page.getByRole('menuitem',{name:'Assegna'}).click();const d=page.getByRole('dialog',{name:'Assegna pratica'});await d.waitFor();return d;};
      const leadNow=async()=>(await (await fetch(fixture.gatewayUrl+'/api/leads/native-fixture',{headers:{Authorization:'Bearer native-admin'}})).json()).lead;
      const before=(await leadNow()).assignedTo||'';
      let dialog=await openDialog();
      await dialog.getByText('Cliente Native Fixture').waitFor();await dialog.getByText('Assegnatario attuale',{exact:true}).waitFor();
      await dialog.getByRole('radio',{name:/Giuseppe Piraino \(@Giuseppe\)/}).waitFor();
      await dialog.getByRole('radio',{name:/Giuseppe Piraino \(@giuseppe\.r\)/}).waitFor();
      assert.equal(await dialog.getByRole('button',{name:'Conferma assegnazione'}).isDisabled(),true,'nothing preselected');
      await dialog.getByRole('radio',{name:/@Giuseppe\)/}).check();
      await dialog.getByRole('button',{name:'Annulla'}).click();await dialog.waitFor({state:'detached'});
      assert.equal((await leadNow()).assignedTo||'',before,'cancel changes nothing');
      dialog=await openDialog();
      await page.route('**/api/leads/native-fixture/assign',route=>route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'Salvataggio non riuscito, riprova.'})}));
      await dialog.getByRole('radio',{name:/@Giuseppe\)/}).check();await dialog.getByRole('button',{name:'Conferma assegnazione'}).click();
      await dialog.getByRole('alert').getByText('Salvataggio non riuscito, riprova.').waitFor();
      assert.ok(await dialog.isVisible(),'dialog stays open on failure');
      await page.unroute('**/api/leads/native-fixture/assign');
      await dialog.getByRole('button',{name:'Annulla'}).click();await dialog.waitFor({state:'detached'});
      // Keyboard: search, move into the list, pick with arrows, confirm with Enter.
      dialog=await openDialog();
      await page.keyboard.type('pira');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Space');
      await page.keyboard.press('ArrowDown');await page.keyboard.press('ArrowUp');
      assert.equal(await dialog.getByRole('radio',{name:/@Giuseppe\)/}).isChecked(),true,'keyboard selection');
      if(width===390)await page.screenshot({path:path.join(os.tmpdir(),'leadium-assign-390.png')});else await page.screenshot({path:path.join(os.tmpdir(),'leadium-assign-1100.png')});
      await geometryOf(page,dialog);
      await dialog.getByRole('button',{name:'Conferma assegnazione'}).focus();await page.keyboard.press('Enter');
      await dialog.waitFor({state:'detached'});
      await page.getByText(/assegnata a Giuseppe Piraino \(@Giuseppe\)/).waitFor();
      assert.equal((await leadNow()).assignedTo,'Giuseppe','username stored');
      assert.deepEqual(errors,[]);await page.close();
      // Giuseppe, after a reload, finds it among "Assegnate a te".
      const g=await browser.newPage({viewport:{width,height:900}});
      await g.addInitScript(user=>{localStorage.setItem('crm.auth.token','native-giuseppe');localStorage.setItem('crm.auth.user',JSON.stringify(user))},fixture.users.giuseppe);
      await g.goto(fixture.frontUrl+'/pratiche');await g.reload();
      await g.getByText(/Assegnate a te/).first().waitFor();
      await g.getByText('Cliente Native Fixture').first().waitFor({timeout:10000});
      await g.close();
      // Reset for the next width.
      await fetch(fixture.gatewayUrl+'/api/leads/native-fixture/assign',{method:'POST',headers:{Authorization:'Bearer native-admin','Content-Type':'application/json'},body:JSON.stringify({userId:'u-giuseppe-r'})});
      console.log('PASS '+width+'px assign dialog: real operators, homonyms distinct, cancel/no change, error keeps dialog, keyboard select+confirm, notice, visible to Giuseppe after reload');
    }
    {
      // Booking report: a real call outcome, then the Excel and CSV downloads read back as files.
      const recorded=await fetch(fixture.gatewayUrl+'/api/leads/native-fixture/calls',{method:'POST',headers:{Authorization:'Bearer native-admin','Content-Type':'application/json'},
        body:JSON.stringify({disposition:'interested',note:'Richiamare; dopo\nle 18',startedAt:'2026-10-20T08:15:00.000Z',endedAt:'2026-10-20T08:20:00.000Z',idempotencyKey:'booking-report-uat'})});
      assert.ok(recorded.ok,'call outcome recorded: '+recorded.status);
      const page=await browser.newPage({viewport:{width:1280,height:900},acceptDownloads:true});const errors=[];page.on('pageerror',error=>errors.push(error.message));
      await page.addInitScript(user=>{localStorage.setItem('crm.auth.token','native-admin');localStorage.setItem('crm.auth.user',JSON.stringify(user))},fixture.users.admin);
      await page.goto(fixture.frontUrl+'/reports/booking-activities');
      const [xlsxDownload]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Esporta Excel'}).click()]);
      assert.equal(xlsxDownload.suggestedFilename(),'booking-activities.xlsx');
      const xlsxPath=path.join(os.tmpdir(),'leadium-booking-uat.xlsx');await xlsxDownload.saveAs(xlsxPath);
      const XLSX=require(path.join(__dirname,'..','node_modules','xlsx'));
      const sheet=XLSX.readFile(xlsxPath,{cellNF:true}).Sheets['Attivita booking'];
      const table=XLSX.utils.sheet_to_json(sheet,{header:1,raw:false});
      assert.deepEqual(table[0].slice(0,6),['Operatore','Cliente','Lead/Pratica','Data','Ora','Numero contatto']);
      const line=table.find(r=>r[1]==='Cliente Native Fixture');assert.ok(line,'the recorded call is exported');
      const rowIndex=table.indexOf(line)+1;
      assert.equal(sheet['D'+rowIndex].t,'n','Data is a real Excel date');assert.equal(sheet['D'+rowIndex].w,'20/10/2026');
      assert.equal(sheet['E'+rowIndex].v,'10:15','Ora in Italian time (08:15 UTC)');
      assert.equal(sheet['F'+rowIndex].t,'s','phone stays text');assert.match(String(sheet['F'+rowIndex].v),/^\+39\d{9,10}$/,'phone in +39 form, digits kept (number changed by the contact checks above)');
      assert.equal(sheet['I'+rowIndex].v,'Richiamare; dopo le 18','note on one line');
      const [csvDownload]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'CSV (altri programmi)'}).click()]);
      const csvPath=path.join(os.tmpdir(),'leadium-booking-uat.csv');await csvDownload.saveAs(csvPath);
      const csvLines=fs.readFileSync(csvPath,'utf8').replace(/^\uFEFF/,'').split('\r\n');
      assert.ok(csvLines[0].startsWith('Operatore;Cliente;'),'Italian Excel separator');
      assert.ok(csvLines.some(l=>l.includes(';Cliente Native Fixture;')&&l.includes('"Richiamare; dopo le 18"')),'a field containing ; stays in one column');
      await page.screenshot({path:path.join(os.tmpdir(),'leadium-booking-report-1280.png')});
      // Gestione operativa: per-operator load shows practices and open tasks separately.
      await page.goto(fixture.frontUrl+'/tasks');
      await page.locator('.ops-operator-stack').getByText(/\d+ pratich[ea] · \d+ attivit/).first().waitFor();
      await page.screenshot({path:path.join(os.tmpdir(),'leadium-operations-1280.png')});
      assert.deepEqual(errors,[]);await page.close();
      console.log('PASS booking report: Excel with real dates, text phones, one-line notes; CSV with ";"; operations load shows practices and tasks');
    }
  } finally {
    if(browser)await browser.close();
    if(child.exitCode===null&&child.signalCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited;}
    if(fs.existsSync(dbFile))fs.unlinkSync(dbFile);
  }
})().catch(error=>{console.error(error);process.exitCode=1});
