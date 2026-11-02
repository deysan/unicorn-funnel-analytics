import { beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { db, freshBusinessDb, userStatement, id, userId } from './helpers/business-db';
import { readFilters, readFunnel, readStatus } from '../../src/server/report/read';
import { report, type ReportBindings } from '../../src/server/http/report';
import app from '../../src/server';
import { DAY, type ReportQuery } from '../../src/shared/report';
import { encodeSecret } from '../../src/server/http/security';
const day = Date.parse('2026-10-30'); const today = day + DAY;
const query: ReportQuery = {from:'2026-10-30',to:'2026-10-30'};
let nextId = 100;
type Event = {type: string; user?:string; at?:number; preland?:string; question?:string; entry?:string; view?:string; completion?:string; click?:string; offer?:string; flow?:string};
async function event(o: Event) {
  const eventId=id(nextId++);
  await db.prepare(`INSERT INTO events (event_id,event_type,user_id,preland_id,occurred_at,received_at,question_id,entry_event_id,view_event_id,completion_event_id,click_id,offer_id,flow_mode,schema_version,payload_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,'{}')`)
    .bind(eventId,o.type,o.user??userId,o.preland??'demo',o.at??day+1000,today,o.question??null,o.entry??null,o.view??null,o.completion??null,o.click??null,o.offer??null,o.flow??null).run();
  return eventId;
}
async function view(o: Partial<Event>={}) { const entry=await event({type:'funnel_entered',user:o.user,preland:o.preland,at:o.at}); return event({type:'question_viewed',question:'email',...o,entry}); }
async function transition(o: Partial<Event>={}) { const entry=await event({type:'funnel_entered',user:o.user,preland:o.preland,at:o.at}); const click=id(nextId++); await event({type:'offer_transition',offer:'003',flow:'bypass',...o,entry,click}); return click; }
async function ready(q=query, now=today+1000) { const result=await readFunnel(db,q,now); expect(result.report_status).toBe('ready'); if(result.report_status!=='ready') throw new Error('not ready'); return result; }
beforeEach(async()=>{await freshBusinessDb(); nextId=100; await db.batch([userStatement(),userStatement(id(2))]); await db.prepare('UPDATE system_control SET history_available_from=?').bind(day-10*DAY).run();});
it('unique users are nonadditive across prelands/offers, offer filter never affects quiz',async()=>{
  for(const [preland,offer] of [['demo','003'],['second','999']]) {
    const v=await view({preland});await event({type:'answer_confirmed',question:'email',preland,view:v});
    const click=await transition({preland,offer});await event({type:'Purchase',preland,offer,click});
  }
  const all=(await ready()).metrics;const a=(await ready({...query,offer_id:'003'})).metrics;const b=(await ready({...query,preland_id:'second',offer_id:'999'})).metrics;
  expect(all.quiz.activity).toMatchObject({entered:1,started:1,completed:1});expect(all.offers.activity).toMatchObject({transitioned:1,buyers:1,purchases:2});
  expect(a.quiz).toEqual(all.quiz);expect(a.offers.activity.purchases+b.offers.activity.purchases).toBe(2);expect(a.offers.activity.buyers+b.offers.activity.buyers).toBe(2);
  expect(all.offers.conversions.transition_purchase).toEqual({numerator:1,denominator:1});
});
it('cohorts retain later return progress across entries, end-day boundaries and same-time causal chain',async()=>{
  const first=await view({question:'preferred_gender',at:day+DAY-1});
  const later=await view({question:'preferred_gender',at:today+100});await event({type:'answer_confirmed',question:'preferred_gender',view:later,at:today+100});
  const email=await view({at:today+100});const completion=await event({type:'answer_confirmed',question:'email',view:email,at:today+100});
  await transition({flow:'quiz',completion,at:today+100});
  expect(first).not.toBe(later);
  const m=(await ready()).metrics;
  expect(m.quiz.activity).toMatchObject({started:1,completed:0});
  expect(m.quiz.conversions.questions.preferred_gender).toEqual({numerator:1,denominator:1});
  expect(m.quiz.conversions.started_completed).toEqual({numerator:1,denominator:1});expect(m.quiz.conversions.started_offer).toEqual({numerator:1,denominator:1});
  expect(m.offers.activity.transitioned).toBe(0);
});
it('question repeated after an old view requires a qualifying linked view; wrong user/preland/question/time never converts',async()=>{
  const old=await view({at:day-1});await view();
  await event({type:'answer_confirmed',question:'email',view:old,at:today});
  const alien=await view({user:id(2)});await event({type:'answer_confirmed',question:'email',view:alien});
  const different=await view({preland:'other'});await event({type:'answer_confirmed',question:'email',view:different});
  const wrongQuestion=await view({question:'preferred_gender'});await event({type:'answer_confirmed',question:'email',view:wrongQuestion});
  const future=await view({at:today+200});await event({type:'answer_confirmed',question:'email',view:future,at:today+100});
  expect((await ready({...query,preland_id:'demo'})).metrics.quiz.conversions.started_completed.numerator).toBe(0);
  const later=await view({at:today+300});await event({type:'answer_confirmed',question:'email',view:later,at:today+300});
  expect((await ready({...query,preland_id:'demo'})).metrics.quiz.conversions.started_completed.numerator).toBe(1);
});
it('bypass never completes quiz and only exact linked quiz completion converts',async()=>{
  const v=await view();const completion=await event({type:'answer_confirmed',question:'email',view:v});
  await transition();expect((await ready()).metrics.quiz.conversions.started_offer.numerator).toBe(0);
  const otherView=await view({user:id(2)});const otherCompletion=await event({type:'answer_confirmed',question:'email',view:otherView,user:id(2)});
  await transition({flow:'quiz',completion:otherCompletion});expect((await ready()).metrics.quiz.conversions.started_offer.numerator).toBe(0);
  await transition({flow:'quiz',completion});expect((await ready()).metrics.quiz.conversions.started_offer.numerator).toBe(1);
});
it('exact transition ClickID, late Purchase without Lead, future/early accepted timestamps, distinct buyers',async()=>{
  const old=await transition({at:day-1000});const current=await transition();
  await event({type:'Lead',click:old,offer:'003'});
  let m=(await ready()).metrics;expect(m.offers.activity.leads).toBe(1);expect(m.offers.conversions.transition_lead).toEqual({numerator:0,denominator:1});
  await event({type:'Purchase',click:current,offer:'003',at:today+300_000});
  m=(await ready()).metrics;expect(m.offers.activity.purchases).toBe(0);expect(m.offers.conversions.transition_purchase).toEqual({numerator:1,denominator:1});
  await event({type:'Purchase',click:current,offer:'003',at:day-1000});
  expect((await ready()).metrics.offers.conversions.transition_purchase).toEqual({numerator:1,denominator:1});
  await event({type:'Purchase',click:current,offer:'003'});await event({type:'Purchase',click:current,offer:'003'});
  expect((await ready()).metrics.offers.activity).toMatchObject({buyers:1,purchases:2});
});
it('an early accepted partner timestamp alone converts its exact transition',async()=>{
  const click=await transition({at:day+1000});await event({type:'Purchase',click,offer:'003',at:day-1000});
  const m=(await ready()).metrics;expect(m.offers.activity.purchases).toBe(0);expect(m.offers.conversions.transition_purchase.numerator).toBe(1);
});
it('empty available period has zeroes; missing/invalid metadata throws without initialization; unverified wins',async()=>{
  expect((await ready()).metrics.offers.activity.purchases).toBe(0);
  await db.prepare('UPDATE system_control SET history_available_from=NULL').run();await expect(readFunnel(db,query,today)).rejects.toThrow();
  expect(await db.prepare('SELECT history_available_from FROM system_control').first('history_available_from')).toBeNull();
  await db.prepare('UPDATE system_control SET history_available_from=?').bind(today+1).run();await expect(readFunnel(db,query,today)).rejects.toThrow();
  await db.prepare('UPDATE system_control SET history_unverified=1').run();
  expect(await readFunnel(db,query,today)).toEqual({report_status:'unavailable',reason:'history_unverified',updated_at:today,filters:query});
  await db.prepare('UPDATE system_control SET history_unverified=0,history_available_from=?').bind(today).run();
  expect(await readFunnel(db,query,today)).toMatchObject({report_status:'unavailable',reason:'period_unavailable',available_from:'2026-10-31'});
});
it('one SELECT for snapshot, no writes, date compared with query snapshot',async()=>{
  const prepare=vi.fn(db.prepare.bind(db));const wrapped=new Proxy(db,{get(target,key){return key==='prepare'?prepare:Reflect.get(target,key);}});
  const before=(await db.prepare('SELECT * FROM users').all()).results;
  await readFunnel(wrapped,query,today);expect(prepare).toHaveBeenCalledOnce();expect(prepare.mock.calls[0][0]).toMatch(/^WITH/);
  await expect(readFunnel(db,{from:'2026-10-31',to:'2026-10-31'},today-1)).rejects.toThrow('validation_failed');
  expect((await db.prepare('SELECT * FROM users').all()).results).toEqual(before);
});
it('status uses actual delivery counts; filters include saved historical ids without private catalog fields',async()=>{
  const e=await event({type:'funnel_entered',preland:'saved'});await db.prepare("INSERT INTO event_delivery(event_id,status,next_attempt_at) VALUES (?,'pending',?)").bind(e,today).run();
  await transition({preland:'archived',offer:'999'});
  const filters=await readFilters(db);expect(filters.prelands).toEqual(['archived','demo','saved']);expect(filters.offers).toContainEqual({id:'999',status:'historical'});expect(JSON.stringify(filters)).not.toMatch(/epu|https|email|user_id/);
  const status=await readStatus(db,'normal');expect(status).toMatchObject({delivery:{pending:1,in_flight:0,delivered:0},cron:{status:'unknown'},reconciliation:{status:'unknown'},history_metadata:'confirmed'});
  expect(status.budgets.every(b=>b.used===0)).toBe(true); // Observed delivery count is not faked from capacity counters.
});
const token=encodeSecret(new Uint8Array(32).fill(3));const allow={limit:async()=>({success:true})} as RateLimit;
const bindings:ReportBindings={...env,IP_HMAC_SECRET:token,REPORT_USERNAME:'synthetic',REPORT_PASSWORD:token,REPORT_IP_LIMITER:allow,REPORT_LIMITER:allow,ASSETS:{fetch:async()=>new Response('<main>report</main>')} as unknown as Fetcher};
const authorization='Basic '+btoa('synthetic:'+token);
const request=(path='/api/v1/report/status',custom:ReportBindings=bindings,auth=authorization)=>report.request('https://localhost:5173'+path,{headers:{Authorization:auth}},custom);
const demoBindings:ReportBindings={...bindings,REPORT_USERNAME:'demo',REPORT_PASSWORD:'unicorn-demo'};
const demoAuthorization='Basic '+btoa('demo:unicorn-demo');
it('public demo credentials read HTML, status, filters and funnel without cookies or business writes',async()=>{
  const tables=['users','events','clicks','partner_events','user_offer_leads','request_results','event_delivery','mock_received_events','capacity_control','system_control','maintenance_control','cleanup_cursors'];
  const state=()=>Promise.all(tables.map(async table=>(await db.prepare(`SELECT * FROM ${table}`).all()).results));
  const before=await state();
  for(const path of ['/report/','/api/v1/report/status','/api/v1/report/filters','/api/v1/report/funnel?from=2026-10-30&to=2026-10-30']) {
    const response=await request(path,demoBindings,demoAuthorization);
    expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');expect(response.headers.has('set-cookie')).toBe(false);
  }
  expect(await state()).toEqual(before);
});
it('report passwords accept the 8 and 128 character boundaries and printable ASCII punctuation',async()=>{
  const printable=Array.from({length:94},(_,index)=>String.fromCharCode(0x21+index)).join('');
  for(const password of ['!A:0_a~?','a'.repeat(128),printable]) {
    const response=await request('/report/',{...demoBindings,REPORT_PASSWORD:password},'Basic '+btoa('demo:'+password));
    expect(response.status).toBe(200);
  }
});
for(const path of ['/report/','/api/v1/report/status']) {
  it.each([
    {label:'missing authorization',auth:undefined},
    {label:'same-length wrong username',auth:'Basic '+btoa('deox:unicorn-demo')},
    {label:'different-length wrong username',auth:'Basic '+btoa('other:unicorn-demo')},
    {label:'same-length wrong password',auth:'Basic '+btoa('demo:unicorn-demx')},
    {label:'shorter wrong password',auth:'Basic '+btoa('demo:short')},
    {label:'longer wrong password',auth:'Basic '+btoa('demo:unicorn-demo-more')},
    {label:'invalid base64 characters',auth:'Basic !!!!'},
    {label:'invalid base64 length',auth:'Basic A'},
    {label:'missing colon',auth:'Basic '+btoa('demounicorn-demo')},
    {label:'HTTP',auth:demoAuthorization,protocol:'http:'},
  ])(`demo Basic $label denies ${path} before private handlers and report limiter`,async({auth,protocol})=>{
    const scope={limit:vi.fn(async()=>({success:true}))};
    const assets={fetch:vi.fn(async()=>new Response('protected'))};
    const prepare=vi.fn(db.prepare.bind(db));
    const wrapped=new Proxy(db,{get(target,key){return key==='prepare'?prepare:Reflect.get(target,key);}});
    const response=await report.request((protocol??'https:')+'//localhost:5173'+path,{headers:auth?{Authorization:auth}:{}},
      {...demoBindings,DB:wrapped,REPORT_LIMITER:scope,ASSETS:assets as unknown as Fetcher});
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({error:{code:'unauthorized',message:'Звіт недоступний. Перевірте доступ і фільтри або повторіть пізніше.',retryable:false}});
    expect(response.headers.get('www-authenticate')).toContain('Basic');expect(response.headers.get('cache-control')).toBe('no-store');expect(response.headers.has('set-cookie')).toBe(false);
    expect(scope.limit).not.toHaveBeenCalled();expect(assets.fetch).not.toHaveBeenCalled();expect(prepare).not.toHaveBeenCalled();
  });
}
it('invalid report password configuration fails safely before private handlers and report limiter',async()=>{
  const scope={limit:vi.fn(async()=>({success:true}))};
  const assets={fetch:vi.fn(async()=>new Response('protected'))};
  const prepare=vi.fn(db.prepare.bind(db));
  const wrapped=new Proxy(db,{get(target,key){return key==='prepare'?prepare:Reflect.get(target,key);}});
  for(const password of [undefined,'','a'.repeat(7),'a'.repeat(129),'demo password','unicorn-demo\n','unicorn\tdemo','unicorn\0demo','unicorn\x7fdemo','unicorn-démo']) {
    const response=await request('/api/v1/report/status',{...demoBindings,DB:wrapped,REPORT_PASSWORD:password,REPORT_LIMITER:scope,ASSETS:assets as unknown as Fetcher},demoAuthorization);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({error:{code:'temporarily_unavailable',message:'Звіт недоступний. Перевірте доступ і фільтри або повторіть пізніше.',retryable:true}});
    expect(response.headers.get('cache-control')).toBe('no-store');expect(response.headers.has('set-cookie')).toBe(false);
  }
  expect(scope.limit).not.toHaveBeenCalled();expect(assets.fetch).not.toHaveBeenCalled();expect(prepare).not.toHaveBeenCalled();
});
it('status shows current handler receiver mode without rewriting previous attempts',async()=>{
  await db.prepare("UPDATE maintenance_control SET cron_result='partial_failure', cron_errors_json='[\"delivery_items_failed\"]' WHERE singleton_id=1").run();
  const before=await db.prepare('SELECT * FROM maintenance_control').first();
  for(const mode of ['unavailable','normal']) {
    const response=await request(undefined,{...bindings,MOCK_RECEIVER_MODE:mode} as ReportBindings);
    expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({receiver_mode:mode,cron:{status:'partial_failure',errors:['delivery_items_failed']}});
  }
  expect(await db.prepare('SELECT * FROM maintenance_control').first()).toEqual(before);
});
it('status rejects missing or invalid receiver config instead of assuming normal',async()=>{
  for(const mode of [undefined,'invalid']) {
    const response=await request(undefined,{...bindings,MOCK_RECEIVER_MODE:mode} as unknown as ReportBindings);
    expect(response.status).toBe(503);expect(await response.text()).not.toContain('receiver_mode');
  }
});
it('HTML and API gated, no cookies/writes, independent from quiz and partner auth',async()=>{
  for(const path of ['/report','/report/','/report/nested','/api/v1/report/status','/api/v1/report/filters','/api/v1/report/funnel?from=2026-10-30&to=2026-10-30']) {
    const denied=await request(path,bindings,'');expect(denied.status).toBe(401);expect(denied.headers.get('www-authenticate')).toContain('Basic');expect(denied.headers.get('cache-control')).toBe('no-store');
    const success=await request(path);expect(success.status).toBe(200);expect(success.headers.get('cache-control')).toBe('no-store');expect(success.headers.has('set-cookie')).toBe(false);
  }
  expect((await request('/report',bindings,'Bearer '+token)).status).toBe(401);
  const publicRoute=await app.fetch(new Request('https://localhost:5173/api/v1/health'),bindings as Env);expect(publicRoute.status).toBe(200);
  const protectedRoute=await app.fetch(new Request('https://localhost:5173/report/'),bindings as Env);expect(protectedRoute.status).toBe(401);
});
it('strict query and safe D1/config failures, no leaked details',async()=>{
  for(const path of ['/api/v1/report/status?a=1','/api/v1/report/filters?a=1','/api/v1/report/funnel','/api/v1/report/funnel?from=9999-12-31&to=9999-12-31','/api/v1/report/funnel?from=2026-10-30&to=2026-10-30&extra=1']) expect((await request(path)).status).toBe(400);
  const broken=new Proxy(db,{get(){return()=>{throw new Error('private SQL secret');};}});
  for(const custom of [{...bindings,DB:broken},{...bindings,REPORT_PASSWORD:'bad'},{...bindings,REPORT_USERNAME:undefined}]) {const response=await request(undefined,custom);expect(response.status).toBe(503);expect(await response.text()).not.toMatch(/SQL|secret/);}
  expect((await report.request('http://localhost:5173/report',{headers:{Authorization:authorization}},bindings)).status).toBe(401);
});
for(const stage of ['ip','report'] as const)for(const refusal of ['deny','throw'] as const)it(`${stage} limiter ${refusal} is fail-closed`,async()=>{
  const fail={limit:vi.fn(async()=>{if(refusal==='throw')throw new Error();return{success:false};})};const good={limit:vi.fn(async()=>({success:true}))};
  const response=await request(undefined,{...bindings,REPORT_IP_LIMITER:stage==='ip'?fail:good,REPORT_LIMITER:stage==='report'?fail:good});
  expect(response.status).toBe(refusal==='deny'?429:503);expect(response.headers.get('retry-after')).toBe(refusal==='deny'?'60':'30');
  if(stage==='ip')expect(good.limit).not.toHaveBeenCalled();else expect(fail.limit).toHaveBeenCalledWith({key:'report'});
});
it('IP before auth, report scope after; total limiter wait <= 1s',async()=>{
  const ip={limit:vi.fn(async()=>({success:true}))};const scope={limit:vi.fn(async()=>({success:true}))};
  expect((await request(undefined,{...bindings,REPORT_IP_LIMITER:ip,REPORT_LIMITER:scope},'')).status).toBe(401);expect(ip.limit).toHaveBeenCalledOnce();expect(scope.limit).not.toHaveBeenCalled();
  vi.useFakeTimers();try {const slow={limit:()=>new Promise(resolve=>setTimeout(()=>resolve({success:true}),600))} as RateLimit;
    const pending=request(undefined,{...bindings,REPORT_IP_LIMITER:slow,REPORT_LIMITER:slow});await vi.advanceTimersByTimeAsync(1200);expect((await pending).status).toBe(503);
  } finally {vi.useRealTimers();}
});
it('SC-14 full numerical fixture: all three questions, two prelands, two offers and unfinished U16',async()=>{
  for(const [preland,offer] of [['p1','003'],['p2','004']]) {
    const entry=await event({type:'funnel_entered',preland});let completion='';
    for(const question of ['preferred_gender','preferred_ethnicity','email']) {const v=await event({type:'question_viewed',preland,question,entry});completion=await event({type:'answer_confirmed',preland,question,view:v});}
    const click=id(nextId++);await event({type:'offer_transition',preland,offer,entry,completion,flow:'quiz',click});
    await event({type:'Lead',preland,offer,click});if(offer==='003')for(let n=0;n<2;n++)await event({type:'Purchase',preland,offer,click});
  }
  await view({preland:'p1',user:id(2),question:'preferred_gender'});
  for(const preland of [undefined,'p1','p2']) {
    const m=(await ready({...query,...(preland?{preland_id:preland}:{})})).metrics;const denominator=preland==='p2'?1:2;
    expect(m.quiz.activity.started).toBe(denominator);
    expect(m.quiz.activity.questions).toEqual({preferred_gender:{viewed:denominator,confirmed:1},preferred_ethnicity:{viewed:1,confirmed:1},email:{viewed:1,confirmed:1}});
    expect(m.quiz.conversions.started_completed).toEqual({numerator:1,denominator});expect(m.quiz.conversions.started_offer).toEqual({numerator:1,denominator});
    expect(m.quiz.conversions.questions.preferred_gender).toEqual({numerator:1,denominator});
  }
  for(const [preland_id,offer_id,transitions,buyers,purchases] of [['p1',undefined,1,1,2],['p1','003',1,1,2],['p1','004',0,0,0],['p2','004',1,0,0],[undefined,undefined,1,1,2]] as const) {
    const m=(await ready({...query,...(preland_id?{preland_id}:{}),...(offer_id?{offer_id}:{})})).metrics;
    expect(m.offers.activity).toEqual({transitioned:transitions,bypass:0,leads:transitions,buyers,purchases});
    expect(m.offers.conversions).toEqual({transition_lead:{numerator:transitions,denominator:transitions},transition_purchase:{numerator:buyers,denominator:transitions}});
    if(preland_id==='p1')expect(m.quiz.activity.started).toBe(2);
  }
});
for (const path of ['/report/', '/api/v1/report/status']) {
  it.each([
    ['wrong password', 'synthetic', encodeSecret(new Uint8Array(32).fill(4))],
    ['same-length wrong username', 'synthetix', token],
  ])(`well-formed Basic %s cannot authorize ${path}`, async (_case, username, password) => {
    const scope = { limit: vi.fn(async () => ({ success: true })) };
    const assets = { fetch: vi.fn(async () => new Response('protected')) };
    const response = await request(path, { ...bindings, REPORT_LIMITER: scope, ASSETS: assets as unknown as Fetcher }, 'Basic ' + btoa(username + ':' + password));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'unauthorized', retryable: false } });
    expect(response.headers.get('www-authenticate')).toContain('Basic');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(scope.limit).not.toHaveBeenCalled(); expect(assets.fetch).not.toHaveBeenCalled();
  });
}
