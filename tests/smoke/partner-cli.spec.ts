import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:https';
import { randomUUID } from 'node:crypto';
import { reportCredentials } from './report-helpers';
import { test, expect } from './fixtures';
const execute=promisify(execFile);
async function partnerToken(){
  const text=await readFile('.dev.vars','utf8');const line=text.split('\n').find(line=>line.startsWith('PARTNER_TOKENS='))!.slice('PARTNER_TOKENS='.length);
  const json=line.startsWith("'")?line.slice(1,-1):line;return JSON.parse(json)['demo-partner'] as string;
}
async function cli(args:string[], token?:string){
  try{return{ok:true,...await execute(process.execPath,['scripts/partner-cli.ts',...args],{env:{...process.env,FORCE_COLOR:undefined,PARTNER_TOKEN:token,NODE_EXTRA_CA_CERTS:resolve('.wrangler/tls/cert.pem')},timeout:15000})};}
  catch(error){const e=error as {stdout?:string;stderr?:string};return{ok:false,stdout:e.stdout??'',stderr:e.stderr??''};}
}
async function database(){
  const directory='.wrangler/e2e-state/v3/d1/miniflare-D1DatabaseObject';const names=(await readdir(directory)).filter(name=>name.endsWith('.sqlite'));
  for(const name of names){const db=new DatabaseSync(resolve(directory,name),{readOnly:true});if(db.prepare("SELECT name FROM sqlite_master WHERE name='partner_events'").get())return db;db.close();}
  throw new Error('Isolated D1 missing');
}
test('справжній CLI → HTTPS → D1: Lead, bypass, дві покупки, повтор і конфлікт', {tag:'@partner'},async({page,context})=>{
  const profiles=JSON.parse(await readFile('.wrangler/e2e-profiles.json','utf8')) as {id:string;token:string}[];const profile=profiles[99];
  await context.addCookies([{name:'__Host-unicorn',value:profile.token,domain:'localhost',path:'/',httpOnly:true,secure:true,sameSite:'Lax'}]);
  await page.goto('/');await page.getByLabel('Жінки',{exact:true}).check();await page.getByRole('button',{name:'Продовжити'}).click();
  await page.getByLabel('Азія',{exact:true}).check();await page.getByRole('button',{name:'Продовжити'}).click();
  await page.getByLabel('Email',{exact:true}).fill('PartnerDemo@example.test');await page.getByRole('button',{name:'Підтвердити та підібрати'}).click();
  await expect(page.getByText('ВАША ПРОПОЗИЦІЯ · 003')).toBeVisible();const click=await page.locator('dd code').innerText();const token=await partnerToken();
  const prefix=randomUUID();const at=new Date().toISOString();
  const prepare=async(file:string,type:string,extra:string[]=[])=>expect(await cli(['prepare','--file',file,'--type',type,'--click',click,'--at',at,...extra])).toMatchObject({ok:true,stdout:'prepared\n'});
  const send=async(file:string)=>cli(['send','--file',file,'--target','https://localhost:4173'],token);
  const lead=prefix+'-lead.json';await prepare(lead,'Lead',['--id',prefix]);
  const db=await database();
  try{
    const before=db.prepare('SELECT last_active_at,selection_revision FROM users WHERE user_id=?').get(profile.id)!;
    expect(await send(lead)).toMatchObject({ok:true,stdout:'accepted\n'});
    expect(db.prepare('SELECT last_active_at,selection_revision FROM users WHERE user_id=?').get(profile.id)).toEqual({...before,selection_revision:Number(before.selection_revision)+1});
    const first=await readFile('.wrangler/partner-events/'+lead,'utf8');
    const snapshot=()=>JSON.stringify(['partner_events','events','event_delivery','user_offer_leads','users','capacity_control'].map(t=>db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()));
    const accepted=snapshot();expect(await send(lead)).toMatchObject({ok:true,stdout:'accepted\n'});expect(snapshot()).toBe(accepted);expect(await readFile('.wrangler/partner-events/'+lead,'utf8')).toBe(first);
    let views=0;let emails=0;page.on('request',request=>{if(request.url().endsWith('/question-views'))views++;if(request.url().endsWith('/email-confirmations'))emails++;});
    await page.goto('/');await expect(page.getByText('ВАША ПРОПОЗИЦІЯ · 003')).toBeVisible();expect(await page.locator('dd code').innerText()).not.toBe(click);expect(views).toBe(0);expect(emails).toBe(0);
    expect(db.prepare("SELECT flow_mode FROM clicks WHERE user_id=? ORDER BY created_at DESC LIMIT 1").get(profile.id)).toEqual({flow_mode:'bypass'});
    for(const n of [1,2]){const file=prefix+'-purchase'+n+'.json';await prepare(file,'Purchase',['--id',prefix+'-purchase'+n,'--amount-minor','2500','--currency','USD']);expect(await send(file)).toMatchObject({ok:true,stdout:'accepted\n'});if(n===1){const saved=snapshot();expect(await send(file)).toMatchObject({ok:true});expect(snapshot()).toBe(saved);}}
    expect(db.prepare('SELECT event_type,COUNT(*) AS n FROM partner_events GROUP BY event_type ORDER BY event_type').all()).toEqual([{event_type:'Lead',n:1},{event_type:'Purchase',n:2}]);
    const conflict=prefix+'-conflict.json';await prepare(conflict,'Purchase',['--id',prefix+'-purchase1','--amount-minor','2600','--currency','USD']);
    const saved=snapshot();expect(await send(conflict)).toMatchObject({ok:false,stderr:'postback_conflict\n'});expect(snapshot()).toBe(saved);
    expect(await page.locator('a[href^="https://"]').count()).toBe(0);
    const reportAuth=await reportCredentials();const beforeReport=snapshot();const cookies=await context.cookies();
    await context.setExtraHTTPHeaders({Authorization:'Basic '+Buffer.from(reportAuth.username+':'+reportAuth.password).toString('base64')});
    await page.goto('/report/');
    await expect(page.getByTestId('report-metrics')).toBeVisible();
    await expect(page.getByTestId('entered')).toHaveText('1');await expect(page.getByTestId('completed')).toHaveText('1');
    await expect(page.getByTestId('transitioned')).toHaveText('1');await expect(page.getByTestId('bypass')).toHaveText('1');
    await expect(page.getByTestId('leads')).toHaveText('1');await expect(page.getByTestId('buyers')).toHaveText('1');await expect(page.getByTestId('purchases')).toHaveText('2');
    expect(snapshot()).toBe(beforeReport);expect(await context.cookies()).toEqual(cookies);
    await page.screenshot({path:'test-results/report-desktop.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:'test-results/report-mobile.png',fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);

  }finally{db.close();}
});
test('CLI перевіряє локальний TLS і не слідує справжньому redirect', {tag:'@partner'},async()=>{
  const file=randomUUID()+'.json';expect(await cli(['prepare','--file',file,'--type','Lead','--click',randomUUID()])).toMatchObject({ok:true});
  let first=0;let redirected=0;
  const server=createServer({key:await readFile('.wrangler/tls/key.pem'),cert:await readFile('.wrangler/tls/cert.pem')},(req,res)=>{
    if(req.url==='/redirected'){redirected++;res.end('{"status":"accepted"}');return;}
    first++;res.writeHead(307,{Location:'/redirected'});res.end();
  });
  await new Promise<void>(resolve=>server.listen(0,'localhost',resolve));const address=server.address() as {port:number};
  try{expect(await cli(['send','--file',file,'--target',`https://localhost:${address.port}`],await partnerToken())).toMatchObject({ok:false,stderr:'network_or_response_failure_repeat_same_file\n'});expect(first).toBe(1);expect(redirected).toBe(0);}
  finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
