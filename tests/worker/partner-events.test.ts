import { beforeEach, expect, it } from 'vitest';
import { acceptPartnerEvent } from '../../src/server/partner/events';
import { PROFILE_TTL_MS } from '../../src/server/storage/profile';
import { db, freshBusinessDb, userStatement, eventStatement, clickStatement, userId, id, now } from './helpers/business-db';
const lead = { event_type:'Lead', partner_event_id:'lead-1', click_id:id(3), occurred_at:new Date(now).toISOString() };
const accepted = {status:'accepted'};
const run = (input: unknown = lead, options: Partial<Parameters<typeof acceptPartnerEvent>[0]> = {}) => acceptPartnerEvent({db,partnerId:'demo-partner',input,now:()=>now,...options});
function interceptBatch(intercept: (statements: D1PreparedStatement[]) => Promise<D1Result[]>) {
  return new Proxy(db,{get(target,key){ if(key==='batch')return intercept;const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value; }});
}
const scalar = (sql:string) => db.prepare(sql).first('n');
async function state() {
  return Promise.all(['partner_events','events','event_delivery','user_offer_leads','users','request_results','capacity_control','transaction_assertions'].map(async table=>(await db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results));
}
beforeEach(async()=>{await freshBusinessDb();await db.batch([userStatement(),eventStatement(id(2)),clickStatement(id(3),id(2))]);});
it('Lead atomically writes immutable attribution/delivery, max/revision; replay changes nothing even under all pauses',async()=>{
  expect(await run()).toEqual(accepted);const before=await state();
  const row=await db.prepare('SELECT * FROM partner_events').first();const event=await db.prepare("SELECT * FROM events WHERE event_type='Lead'").first();
  expect(event).toMatchObject({event_id:row!.event_id,user_id:userId,offer_id:'003',preland_id:'demo',occurred_at:now,received_at:now,schema_version:1});
  expect(JSON.parse(event!.payload_json as string)).toMatchObject({event_id:row!.event_id,partner_id:'demo-partner',partner_event_id:'lead-1'});
  expect(await scalar('SELECT selection_revision AS n FROM users')).toBe(1);expect(await scalar('SELECT last_active_at AS n FROM users')).toBe(now);
  expect(await scalar('SELECT COUNT(*) AS n FROM request_results')).toBe(0);expect(await scalar('SELECT COUNT(*) AS n FROM transaction_assertions')).toBe(0);
  expect(await run({...lead,click_id:lead.click_id.toUpperCase(),occurred_at:'2027-01-15T10:00:00+02:00'})).toEqual(accepted); // same instant as fixture
  expect(await state()).toEqual(before);
  await db.prepare('UPDATE capacity_control SET capacity_paused=1').run();await db.prepare('UPDATE system_control SET integrity_paused=1').run();const paused=await state();
  expect(await run(lead,{now:()=>now+1000})).toEqual(accepted);expect(await state()).toEqual(paused);
});
it('Purchase before Lead, second Purchase and same external ID in another event type are independent',async()=>{
  const purchase={...lead,event_type:'Purchase',amount_minor:100,currency:'USD'};
  expect(await run(purchase)).toEqual(accepted);expect(await run({...purchase,partner_event_id:'purchase-2'})).toEqual(accepted);
  expect(await scalar('SELECT selection_revision AS n FROM users')).toBe(0);expect(await scalar('SELECT COUNT(*) AS n FROM user_offer_leads')).toBe(0);
  expect(await run()).toEqual(accepted);expect(await scalar('SELECT COUNT(*) AS n FROM partner_events')).toBe(3);
  expect(await scalar("SELECT used_count AS n FROM capacity_control WHERE budget_key='events'")).toBe(3);
  expect(await scalar("SELECT used_count AS n FROM capacity_control WHERE budget_key='undelivered'")).toBe(3);
  expect(await scalar("SELECT used_count AS n FROM capacity_control WHERE budget_key='command_keys'")).toBe(0);
});
for(const withMoney of [true,false])it(`Purchase immutable payload ${withMoney?'with':'without'} money preserves exact fields and attribution`,async()=>{
  const purchase={...lead,event_type:'Purchase',...(withMoney?{amount_minor:100,currency:'USD'}:{})};
  expect(await run(purchase)).toEqual(accepted);
  const saved=await db.prepare("SELECT * FROM partner_events WHERE event_type='Purchase'").first();
  expect(saved).toMatchObject({partner_id:'demo-partner',partner_event_id:lead.partner_event_id,
    click_id:lead.click_id,user_id:userId,offer_id:'003',preland_id:'demo',occurred_at:now,received_at:now,
    amount_minor:withMoney?100:null,currency:withMoney?'USD':null});
  const event=await db.prepare('SELECT * FROM events WHERE event_id=?').bind(saved!.event_id).first();
  expect(event).toMatchObject({event_id:saved!.event_id,event_type:'Purchase',user_id:userId,
    click_id:lead.click_id,offer_id:'003',preland_id:'demo',occurred_at:now,received_at:now,schema_version:1});
  expect(JSON.parse(event!.payload_json as string)).toStrictEqual({schema_version:1,event_id:saved!.event_id,
    event_type:'Purchase',user_id:userId,preland_id:'demo',click_id:lead.click_id,offer_id:'003',
    partner_id:'demo-partner',partner_event_id:lead.partner_event_id,occurred_at:now,received_at:now,
    ...(withMoney?{amount_minor:100,currency:'USD'}:{})});
  expect(await run(purchase,{now:()=>now+1000})).toEqual(accepted);
  expect(await db.prepare('SELECT payload_json FROM events WHERE event_id=?').bind(saved!.event_id).first('payload_json')).toBe(event!.payload_json);
});
it('all business fields conflict before resolving a changed unavailable click',async()=>{
  const purchase={...lead,event_type:'Purchase',amount_minor:100,currency:'USD'};await run(purchase);const before=await state();
  for(const changed of [{click_id:id(999)},{occurred_at:new Date(now+1).toISOString()},{amount_minor:101},{amount_minor:undefined,currency:undefined}]) expect(await run({...purchase,...changed})).toEqual({status:'rejected',reason:'conflict'});
  expect(await state()).toEqual(before);
});
it('concurrent duplicate elects one EventID and one set of effects',async()=>{
  expect(await Promise.all([run(),run(),run()])).toEqual([accepted,accepted,accepted]);
  expect(await scalar('SELECT COUNT(*) AS n FROM partner_events')).toBe(1);expect(await scalar('SELECT selection_revision AS n FROM users')).toBe(1);
  expect(await scalar('SELECT COUNT(*) AS n FROM event_delivery')).toBe(1);
});
it('replay survives click and event cleanup; a new key with absent/foreign click is unavailable',async()=>{
  await run();await db.prepare('DELETE FROM event_delivery').run();await db.prepare("DELETE FROM events WHERE event_type='Lead'").run();await db.prepare('DELETE FROM clicks').run();const before=await state();
  expect(await run()).toEqual(accepted);expect(await state()).toEqual(before);
  expect(await run({...lead,partner_event_id:'new'})).toEqual({status:'rejected',reason:'click_unavailable'});
  await clickStatement(id(3),id(2)).run();expect(await run({...lead,partner_event_id:'foreign'},{partnerId:'other'})).toEqual({status:'rejected',reason:'click_unavailable'});
});
it('retained click older than 90 days is accepted without current catalogue',async()=>{
  const old=now-100*86400000;await db.prepare('UPDATE clicks SET created_at=?,partner_id=?').bind(old,'retired-partner').run();
  expect(await run({...lead,occurred_at:new Date(old).toISOString()},{partnerId:'retired-partner'})).toEqual(accepted);
});
it('time window is inclusive, one millisecond outside fails without changes',async()=>{
  const before=await state();for(const time of [now-300001,now+300001])expect(await run({...lead,occurred_at:new Date(time).toISOString()})).toEqual({status:'rejected',reason:'validation'});
  expect(await state()).toEqual(before);
  for(const time of [now-300000,now+300000])expect(await run({...lead,partner_event_id:String(time),occurred_at:new Date(time).toISOString()})).toEqual(accepted);
});
it('only increasing Lead maximum changes revision; historical events all remain',async()=>{
  for(const [n,offset] of [0,-1,0,1].entries()) expect(await run({...lead,partner_event_id:String(n),occurred_at:new Date(now+offset).toISOString()})).toEqual(accepted);
  expect(await scalar('SELECT selection_revision AS n FROM users')).toBe(2);expect(await scalar('SELECT latest_lead_at AS n FROM user_offer_leads')).toBe(now+1);
  expect(await scalar('SELECT COUNT(*) AS n FROM partner_events')).toBe(4);
});
for(const mode of ['logical','stub','revoked','crossing'] as const)it(`profile ${mode}: history retained, TTL independent of cookie and revision`,async()=>{
  let clock=()=>now;
  if(mode==='logical')await db.prepare('UPDATE users SET created_at=?,last_active_at=?').bind(now-PROFILE_TTL_MS,now-PROFILE_TTL_MS).run();
  if(mode==='stub')await db.prepare('UPDATE users SET created_at=NULL,last_active_at=NULL,access_secret_hash=NULL,expired_at=?').bind(now).run();
  if(mode==='revoked')await db.prepare('UPDATE users SET revoked_at=?').bind(now).run();
  if(mode==='crossing'){await db.prepare('UPDATE users SET created_at=?,last_active_at=?').bind(now-PROFILE_TTL_MS+1,now-PROFILE_TTL_MS+1).run();let calls=0;clock=()=>now+(calls++?1:0);}
  expect(await run(lead,{now:clock})).toEqual(accepted);
  expect(await scalar('SELECT COUNT(*) AS n FROM user_offer_leads')).toBe(mode==='revoked'?1:0);
  expect(await scalar('SELECT selection_revision AS n FROM users')).toBe(mode==='revoked'?1:0);
  expect(await scalar('SELECT COUNT(*) AS n FROM partner_events')).toBe(1);
});
it('late SQL failure rolls back keys, budgets, Lead and delivery; unknown no commit never ACKs',async()=>{
  const before=await state();let calls=0;
  const broken=interceptBatch(async statements=>{calls++;return db.batch([...statements,db.prepare('INSERT INTO nonexistent_table VALUES (1)')]);});
  expect(await run(lead,{db:broken})).toEqual({status:'rejected',reason:'temporary'});expect(calls).toBe(1);expect(await state()).toEqual(before);
  const timeout=interceptBatch(async()=>{calls++;throw new Error('timeout');});expect(await run(lead,{db:timeout})).toEqual({status:'rejected',reason:'temporary'});expect(calls).toBe(2);expect(await state()).toEqual(before);
});
it('lost commit response is proven by key; mismatch is conflict',async()=>{
  const lost=interceptBatch(async statements=>{await db.batch(statements);throw new Error('timeout');});
  expect(await run(lead,{db:lost})).toEqual(accepted);expect(await scalar('SELECT COUNT(*) AS n FROM partner_events')).toBe(1);
  const raced=interceptBatch(async()=>{await run({...lead,partner_event_id:'raced',occurred_at:new Date(now+1).toISOString()});throw new Error('timeout');});
  expect(await run({...lead,partner_event_id:'raced'},{db:raced})).toEqual({status:'rejected',reason:'conflict'});
});
for(const conflicts of [1,2,3])it(`proven revision conflict ${conflicts} uses at most three attempts`,async()=>{
  let batches=0;const racing=interceptBatch(async statements=>{if(batches++<conflicts)await db.prepare('UPDATE users SET selection_revision=selection_revision+1').run();return db.batch(statements);});
  expect(await run(lead,{db:racing})).toEqual(conflicts<3?accepted:{status:'rejected',reason:'temporary'});expect(batches).toBe(Math.min(3,conflicts+1));
  expect(await scalar('SELECT COUNT(*) AS n FROM partner_events')).toBe(conflicts<3?1:0);
});
it('last revision failure still returns a concurrent committed key',async()=>{
  let calls=0;const racing=interceptBatch(async statements=>{calls++;await db.prepare('UPDATE users SET selection_revision=selection_revision+1').run();if(calls===3)await run();return db.batch(statements);});
  expect(await run(lead,{db:racing})).toEqual(accepted);expect(calls).toBe(3);expect(await scalar('SELECT COUNT(*) AS n FROM partner_events')).toBe(1);
});
it('cleanup deleting click before batch rejects without partial writes',async()=>{
  const racing=interceptBatch(async statements=>{await db.prepare('DELETE FROM clicks').run();return db.batch(statements);});
  expect(await run(lead,{db:racing})).toEqual({status:'rejected',reason:'click_unavailable'});expect(await scalar('SELECT COUNT(*) AS n FROM partner_events')).toBe(0);
  expect(await scalar("SELECT SUM(used_count) AS n FROM capacity_control")).toBe(0);
});
it('deactivation between snapshot and commit retries into stub without reviving Lead',async()=>{
  let batches=0;const racing=interceptBatch(async statements=>{if(batches++===0)await db.prepare('UPDATE users SET created_at=NULL,last_active_at=NULL,access_secret_hash=NULL,expired_at=?,selection_revision=selection_revision+1').bind(now).run();return db.batch(statements);});
  expect(await run(lead,{db:racing})).toEqual(accepted);expect(batches).toBe(2);expect(await scalar('SELECT COUNT(*) AS n FROM user_offer_leads')).toBe(0);
});
for(const key of ['events','undelivered'])it(`exact ${key} budget stops new events while replay survives`,async()=>{
  const limit=key==='events'?10000:1000;await db.prepare('UPDATE capacity_control SET used_count=? WHERE budget_key=?').bind(limit-1,key).run();
  expect(await run()).toEqual(accepted);expect(await db.prepare('SELECT used_count,capacity_paused FROM capacity_control WHERE budget_key=?').bind(key).first()).toEqual({used_count:limit,capacity_paused:1});
  const before=await state();expect(await run({...lead,partner_event_id:'new'})).toEqual({status:'rejected',reason:'capacity'});expect(await run()).toEqual(accepted);expect(await state()).toEqual(before);
});
it('integrity pause, missing control, D1 read error and stale epoch fail safely',async()=>{
  await db.prepare('UPDATE system_control SET integrity_paused=1').run();expect(await run()).toEqual({status:'rejected',reason:'integrity'});
  await db.prepare('UPDATE system_control SET integrity_paused=0').run();
  const racing=interceptBatch(async statements=>{await db.prepare("UPDATE capacity_control SET capacity_epoch=capacity_epoch+1 WHERE budget_key='events'").run();return db.batch(statements);});
  expect(await run(lead,{db:racing})).toEqual({status:'rejected',reason:'temporary'});
  await db.prepare("DELETE FROM capacity_control WHERE budget_key='events'").run();expect(await run()).toEqual({status:'rejected',reason:'temporary'});
  const broken=new Proxy(db,{get(){return ()=>{throw new Error('private');};}});expect(await run(lead,{db:broken})).toEqual({status:'rejected',reason:'temporary'});
  expect(await scalar('SELECT COUNT(*) AS n FROM partner_events')).toBe(0);
});
