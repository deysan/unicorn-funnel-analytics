import { beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { createExecutionContext } from 'cloudflare:test';
import worker from '../../src/server';
import { DAY, availableFrom } from '../../src/shared/report';
import { runCleanup, CLEANUP_CAP, KEY_CAP } from '../../src/server/maintenance/cleanup';
import { reconcileHourly } from '../../src/server/maintenance/reconciliation';
import { runMaintenance } from '../../src/server/maintenance/coordinator';
import { readStatus } from '../../src/server/report/read';
import { executeQuizCommand } from '../../src/server/quiz/commands';
import { acceptPartnerEvent } from '../../src/server/partner/events';
import { importFingerprintKey } from '../../src/server/storage/command-fingerprint';
import { db, freshBusinessDb, userStatement, eventStatement, clickStatement, id, now, userId } from './helpers/business-db';
const at = now + 200 * DAY;
const count = (table: string) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<number>('n');
const user = () => db.prepare('SELECT * FROM users WHERE user_id = ?').bind(userId).first<Record<string, unknown>>();
const budget = (key: string) => db.prepare('SELECT used_count FROM capacity_control WHERE budget_key = ?').bind(key).first<number>('used_count');
async function counters() {
 await db.prepare(`UPDATE capacity_control SET used_count = CASE budget_key
  WHEN 'events' THEN (SELECT COUNT(*) FROM events) WHEN 'profiles' THEN (SELECT COUNT(*) FROM users)
  WHEN 'command_keys' THEN (SELECT COUNT(*) FROM request_results)
  WHEN 'undelivered' THEN (SELECT COUNT(*) FROM event_delivery WHERE status != 'delivered') END`).run();
}
async function event(eventId = id(10), status = 'delivered', time = at - 90 * DAY) {
 await eventStatement(eventId).run();
 await db.prepare('UPDATE events SET received_at = ?, occurred_at = ? WHERE event_id = ?').bind(time, time, eventId).run();
 await db.prepare(`INSERT INTO event_delivery (event_id,status,next_attempt_at,delivered_at,lease_token,lease_until)
  VALUES (?,?,?,?,?,?)`).bind(eventId,status,status === 'pending' ? time : null,status === 'delivered' ? time : null,status === 'in_flight' ? 'lease' : null,status === 'in_flight' ? at+1000 : null).run();
}
async function result(operation = id(50), time = at - 7 * DAY) {
 await db.prepare(`INSERT INTO request_results(user_id,operation_id,created_at,operation_type,request_fingerprint,fingerprint_key_version,fingerprint_format_version,result_json)
 VALUES (?,?,?,'entry',?,'v1',1,'{}')`).bind(userId,operation,time,'a'.repeat(64)).run();
}
function interceptBatch(action: (statements: D1PreparedStatement[]) => Promise<D1Result<unknown>[]>) {
 return new Proxy(db, { get(target,key) { if(key==='batch')return action; const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value; } });
}
function measuredDb() {
 const metrics = { calls: 0, rows_read: 0, rows_written: 0 };
 const record = (results: D1Result<unknown>[]) => { metrics.calls++; for (const result of results) {
  metrics.rows_read += result.meta.rows_read; metrics.rows_written += result.meta.rows_written;
 } };
 const database = new Proxy(db, { get(target, key) {
  if (key === 'batch') return async (statements: D1PreparedStatement[]) => { const results = await target.batch(statements); record(results); return results; };
  if (key === 'prepare') return (sql: string) => {
   const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(st, method) {
    if (method === 'bind') return (...values: unknown[]) => wrap(st.bind(...values));
    if (method === 'first') return async (column?: string) => { const response = await st.all<Record<string, unknown>>(); record([response]); return column === undefined ? response.results[0] ?? null : response.results[0]?.[column] ?? null; };
    if (method === 'run' || method === 'all') return async () => { const response = await st.all(); record([response]); return response; };
    const value = Reflect.get(st, method); return typeof value === 'function' ? value.bind(st) : value;
   } }); return wrap(target.prepare(sql));
  };
  const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
 } });
 return { database, metrics };
}
beforeEach(async()=>{await freshBusinessDb();await userStatement().run();await db.prepare('UPDATE users SET last_active_at = ?').bind(at).run();await db.prepare('UPDATE system_control SET history_available_from = ?').bind(Math.floor(now/DAY)*DAY).run();await counters();});
it('full idle Cron keeps daily writes below the reserved service budget', async () => {
 await freshBusinessDb();
 const first = measuredDb(); await runMaintenance({ db: first.database, mode: 'normal', now: () => at });
 const idle = measuredDb(); await runMaintenance({ db: idle.database, mode: 'normal', now: () => at + 60_000 });
 const daily = idle.metrics.rows_written * 1440 + Math.max(0, first.metrics.rows_written - idle.metrics.rows_written) * 24;
 console.info('idle Cron measured', { first: first.metrics, idle: idle.metrics, daily });
 expect(daily).toBeLessThan(6000); expect(first.metrics.calls).toBeLessThanOrEqual(46); expect(idle.metrics.calls).toBeLessThanOrEqual(46);
});
it('small day of 10 quizzes, 5 bypass and 5 postbacks leaves a daily writes reserve', async () => {
 await freshBusinessDb();
 const business = measuredDb();
 const users = Array.from({ length: 10 }, (_, i) => id(1000 + i));
 await business.database.batch(users.map((user) => userStatement(user)));
 await business.database.prepare("UPDATE capacity_control SET used_count=10 WHERE budget_key='profiles'").run();
 const keys = { currentVersion: 'v1', keys: new Map([['v1', await importFingerprintKey(new Uint8Array(32).fill(1))]]) };
 let operation = 10_000;
 for (const [index, user] of users.entries()) {
  const entry = id(2000 + index * 10);
  const quiz = async (input: Record<string, unknown>) => {
   const op = id(operation++);
   const response = await executeQuizCommand({ db: business.database, userId: user, secretHash: user.replaceAll('-', '').padEnd(64, '0'),
    keys, now: () => now, input: { preland_id: 'demo', operation_id: op, ...input } });
   expect(response).toMatchObject({ status: 'found', result: { code: input.type === 'offer_selection' ? 'offer_selected' : 'accepted' } });
   return op;
  };
  await quiz({ type: 'entry', event_id: entry });
  for (const [q, question] of ['preferred_gender', 'preferred_ethnicity'].entries()) {
   const view = id(2001 + index * 10 + q);
   await quiz({ type: 'question_view', event_id: view, entry_event_id: entry, question_id: question });
   await quiz({ type: 'answer', view_event_id: view, question_id: question, value: q === 0 ? 'women' : 'asia' });
  }
  const emailView = id(2003 + index * 10);
  await quiz({ type: 'question_view', event_id: emailView, entry_event_id: entry, question_id: 'email' });
  const completion = await quiz({ type: 'email_confirmation', view_event_id: emailView, email: 'synthetic@example.test' });
  await quiz({ type: 'offer_selection', entry_event_id: entry, completion_operation_id: completion });
  if (index < 5) {
   const click = await db.prepare('SELECT click_id, partner_id FROM clicks WHERE user_id=?').bind(user).first<{click_id: string; partner_id: string}>();
   expect(await acceptPartnerEvent({ db: business.database, partnerId: click!.partner_id, now: () => now,
    input: { event_type: 'Lead', partner_event_id: 'synthetic-' + index, click_id: click!.click_id, occurred_at: new Date(now).toISOString() } })).toEqual({ status: 'accepted' });
   const bypass = id(2004 + index * 10);
   await quiz({ type: 'entry', event_id: bypass }); await quiz({ type: 'offer_selection', entry_event_id: bypass });
  }
 }
 expect(await count('events')).toBe(95);
 let deliveryWrites = 0;
 for (let tick = 0; tick < 10; tick++) {
  const measured = measuredDb();
  expect((await runMaintenance({ db: measured.database, mode: 'normal', now: () => now + tick * 60_000 })).errors).toEqual([]);
  deliveryWrites += measured.metrics.rows_written; expect(measured.metrics.calls).toBeLessThanOrEqual(46);
 }
 expect(await budget('undelivered')).toBe(0); expect(await count('mock_received_events')).toBe(95);
 let retainedIdleWrites = 0;
 // A full cursor sweep covers wrap as well as every populated retention category.
 for (let tick = 10; tick < 60; tick++) {
  const measured = measuredDb();
  expect((await runMaintenance({ db: measured.database, mode: 'normal', now: () => now + tick * 60_000 })).errors).toEqual([]);
  retainedIdleWrites = Math.max(retainedIdleWrites, measured.metrics.rows_written);
  expect(measured.metrics.calls).toBeLessThanOrEqual(46);
 }
 const nextHour = measuredDb(); await runMaintenance({ db: nextHour.database, mode: 'normal', now: () => now + 3_600_000 });
 const hourlyExtra = Math.max(0, nextHour.metrics.rows_written - retainedIdleWrites);
 const projectedWrites = business.metrics.rows_written + deliveryWrites + retainedIdleWrites * 1440 + hourlyExtra * 24 + 10_000;
 console.info('small day writes projection', { business: business.metrics.rows_written, deliveryWrites, retainedIdleWrites, hourlyExtra, projectedWrites });
 // Includes a 10k reserve for cleanup/retries, plus >20k unused Free writes.
 // Fixture provisioning is counted; this is a functional quota regression, not a benchmark.
 expect(projectedWrites).toBeLessThan(80_000);
});
it('pause before a window prevents both cursor advance and candidate mutation', async () => {
 for (let i=10;i<14;i++) await event(id(i)); await counters();
 const before = (await db.prepare('SELECT * FROM cleanup_cursors').all()).results; let paused = false;
 const wrapped = interceptBatch(async statements => {
  if (!paused) { paused = true; await db.prepare('UPDATE system_control SET integrity_paused=1').run(); }
  return db.batch(statements);
 });
 expect(Object.values(await runCleanup(wrapped, at)).every(p => p.error === 'cleanup_failed')).toBe(true);
 expect((await db.prepare('SELECT * FROM cleanup_cursors').all()).results).toEqual(before);
 expect(await count('events')).toBe(4); expect(await budget('events')).toBe(4);
});
it('pause after candidate discovery still prevents business deletion', async () => {
 await event(); await counters(); let paused = false;
 const wrapped = interceptBatch(async statements => {
  const response = await db.batch<Record<string, unknown>>(statements);
  if (!paused && response.some(r => r.results.some(row => row.id === id(10) && row.eligible === 1))) {
   paused = true; await db.prepare('UPDATE system_control SET integrity_paused=1').run();
  }
  return response;
 });
 expect((await runCleanup(wrapped, at)).events.error).toBe('cleanup_failed');
 expect(await count('events')).toBe(1); expect(await count('event_delivery')).toBe(1); expect(await budget('events')).toBe(1);
});
it('email 30d, result 7d exact boundary; tombstone retains key/counter and revision only email',async()=>{
 await db.prepare("UPDATE users SET email='synthetic@example.test',email_confirmed_at=?").bind(at-30*DAY).run();await result();await counters();
 await runCleanup(db,at-1);expect((await user())!.email).not.toBeNull();expect(await db.prepare('SELECT expired FROM request_results').first('expired')).toBe(0);
 await runCleanup(db,at);expect(await user()).toMatchObject({email:null,email_confirmed_at:null,selection_revision:1});
 expect(await db.prepare('SELECT * FROM request_results').first()).toMatchObject({expired:1,operation_type:null,request_fingerprint:null,fingerprint_key_version:null,fingerprint_format_version:null,result_json:null});
 expect(await budget('command_keys')).toBe(1);await runCleanup(db,at+1);expect((await user())!.selection_revision).toBe(1);
});
it('events and clicks 90d exact boundary, pending/inflight retained; event deletion releases counter and advances history',async()=>{
 await event();await event(id(11),'pending');await event(id(12),'in_flight');await clickStatement(id(20),id(10)).run();
 await db.prepare('UPDATE clicks SET created_at=?').bind(at-90*DAY).run();await counters();
 await runCleanup(db,at-1);expect(await count('events')).toBe(3);expect(await count('clicks')).toBe(1);
 await runCleanup(db,at);expect(await count('clicks')).toBe(0);
 // The pre-boundary visit advanced the raw cursor; wrap revisits the newly eligible event.
 await runCleanup(db,at);expect(await count('events')).toBe(2);expect(await budget('events')).toBe(2);expect(await budget('undelivered')).toBe(2);
 expect(await db.prepare('SELECT history_available_from FROM system_control').first('history_available_from')).toBe(availableFrom(Math.floor(now/DAY)*DAY,at));
});
it('parents retained for event children, repeated bounded runs drain dependency chain',async()=>{
 await event();await eventStatement(id(11),'question_viewed',{entry:id(10),question:'email'}).run();
 await db.prepare('UPDATE events SET received_at=?,occurred_at=?').bind(at-90*DAY,at-90*DAY).run();
 await db.prepare("INSERT INTO event_delivery(event_id,status,delivered_at) VALUES (?,'delivered',?)").bind(id(11),at-1).run();await counters();
 const first=await runCleanup(db,at);expect(first.events.changed).toBe(1);expect(await count('events')).toBe(1);
 const boundary=await db.prepare('SELECT history_available_from FROM system_control').first('history_available_from');
 await runCleanup(db,at);expect(await count('events')).toBe(0);expect(await budget('events')).toBe(0);
 expect(await db.prepare('SELECT history_available_from FROM system_control').first('history_available_from')).toBe(boundary);
});
it('180d transition clears profile and Lead once; independent pending history holds minimal row and command keys',async()=>{
 await db.prepare("UPDATE users SET last_active_at=?,email='synthetic@example.test',email_confirmed_at=?,preferred_gender='women',preferred_ethnicity='asia'").bind(at-180*DAY,at-1).run();
 await db.prepare("INSERT INTO user_offer_leads VALUES (?,'003',?)").bind(userId,at-1).run();await event(id(10),'pending');await result();await counters();
 await runCleanup(db,at-1);expect((await user())!.expired_at).toBeNull();
 await runCleanup(db,at);expect(await user()).toEqual({user_id:userId,created_at:null,last_active_at:null,email:null,email_confirmed_at:null,preferred_gender:null,preferred_ethnicity:null,access_secret_hash:null,revoked_at:null,expired_at:at,selection_revision:1});
 expect(await count('user_offer_leads')).toBe(0);expect(await count('request_results')).toBe(1);expect(await budget('profiles')).toBe(1);
 await runCleanup(db,at+1);expect((await user())!.selection_revision).toBe(1);
});
it('expired profile with no history deletes command keys in bounded portions and user only after last key',async()=>{
 await db.prepare('UPDATE users SET last_active_at=?').bind(at-180*DAY).run();
 for(let i=0;i<KEY_CAP+1;i++)await result(id(100+i));await counters();
 const first=await runCleanup(db,at);expect(first.command_keys).toMatchObject({changed:KEY_CAP,has_more:true});expect(await budget('command_keys')).toBe(1);expect(await count('users')).toBe(1);
 await runCleanup(db,at);expect(await count('request_results')).toBe(0);expect(await count('users')).toBe(0);expect(await budget('profiles')).toBe(0);expect(await budget('command_keys')).toBe(0);
});
it('click removal ignores partner key, immutable detailed event retains key; source disappearance releases mock and partner keys',async()=>{
 await event();await clickStatement(id(20),id(10)).run();await db.prepare('UPDATE clicks SET created_at=?').bind(at-90*DAY).run();
 await eventStatement(id(30),'Purchase',{click:id(20),offer:'003'}).run();
 await db.prepare("INSERT INTO event_delivery(event_id,status,next_attempt_at) VALUES (?,'pending',?)").bind(id(30),at).run();
 await db.prepare("INSERT INTO partner_events(event_id,partner_id,event_type,partner_event_id,click_id,user_id,offer_id,preland_id,occurred_at,received_at) VALUES (?,'demo','Purchase','synthetic',?,?,'003','demo',?,?)").bind(id(30),id(20),userId,now,now).run();
 await db.prepare("INSERT INTO mock_received_events VALUES (?,'{}',?,?)").bind(id(30),'a'.repeat(64),now).run();await counters();
 await runCleanup(db,at);expect(await count('clicks')).toBe(0);expect(await count('partner_events')).toBe(1);expect(await count('mock_received_events')).toBe(1);
 await db.prepare("UPDATE event_delivery SET status='delivered',next_attempt_at=NULL,delivered_at=?").bind(at).run();await counters();
 await runCleanup(db,at);expect(await count('partner_events')).toBe(0);expect(await count('mock_received_events')).toBe(0);
});
it('all cleanup phases honor integrity pause including email/results',async()=>{
 await db.prepare("UPDATE users SET last_active_at=?,email='synthetic@example.test',email_confirmed_at=?").bind(at-180*DAY,at-30*DAY).run();await event();await result();await counters();
 await db.prepare('UPDATE system_control SET integrity_paused=1').run();const before=await user();await runCleanup(db,at);
 expect(await user()).toEqual(before);expect(await count('events')).toBe(1);expect(await db.prepare('SELECT expired FROM request_results').first('expired')).toBe(0);
});
it('refreshed profile between candidate read and transaction survives',async()=>{
 await db.prepare('UPDATE users SET last_active_at=?').bind(at-180*DAY).run();let injected=false;
 const wrapped=interceptBatch(async statements=>{const response=await db.batch<Record<string, unknown>>(statements);if(!injected && response.some(r=>r.results.some(row=>row.id===userId && row.eligible===1))){injected=true;await db.prepare('UPDATE users SET last_active_at=?').bind(at).run();}return response;});
 const cleaned=await runCleanup(wrapped,at);expect(cleaned.profiles.skipped).toBe(1);expect((await user())!.expired_at).toBeNull();
});
it('concurrent parent reference is rechecked atomically before deleting delivery/event',async()=>{
 await event();await counters();let injected=false;
 const wrapped=interceptBatch(async statements=>{const response=await db.batch<Record<string, unknown>>(statements);if(!injected && response.some(r=>r.results.some(row=>row.id===id(10) && row.eligible===1))){injected=true;await eventStatement(id(11),'question_viewed',{entry:id(10),question:'email'}).run();}return response;});
 const cleaned=await runCleanup(wrapped,at);expect(cleaned.events.skipped).toBe(1);expect(await count('event_delivery')).toBe(1);expect(await budget('events')).toBe(1);
});
it('counter failure rolls back event, delivery and history boundary',async()=>{
 await event();const boundary=await db.prepare('SELECT history_available_from FROM system_control').first('history_available_from');
 const result=await runCleanup(db,at);expect(result.events.error).toBe('cleanup_failed');expect(await count('events')).toBe(1);expect(await count('event_delivery')).toBe(1);
 expect(await db.prepare('SELECT history_available_from FROM system_control').first('history_available_from')).toBe(boundary);
});
it.each([null,1])('missing/invalid boundary %s is not manufactured by event deletion',async boundary=>{
 await event();await counters();await db.prepare('UPDATE system_control SET history_available_from=?').bind(boundary).run();
 expect((await runCleanup(db,at)).events.error).toBe('cleanup_failed');expect(await count('events')).toBe(1);expect(await db.prepare('SELECT history_available_from FROM system_control').first('history_available_from')).toBe(boundary);
});
it('finite event cap and exact count/epoch transition on actual deletes',async()=>{
 for(let i=0;i<CLEANUP_CAP+1;i++)await event(id(100+i));await counters();
 const first=await runCleanup(db,at);expect(first.events).toMatchObject({changed:CLEANUP_CAP,has_more:true});expect(await budget('events')).toBe(1);
 await runCleanup(db,at);expect(await budget('events')).toBe(0);
});
it('hourly scan has one confirmed winner, matched snapshot, no catchup; next UTC hour scans',async()=>{
 const results=await Promise.all([reconcileHourly(db,at),reconcileHourly(db,at)]);expect(results.sort()).toEqual(['already_attempted','matched']);
 const summary=await db.prepare('SELECT reconcile_json FROM maintenance_control').first<string>('reconcile_json');expect(JSON.parse(summary!)).toMatchObject({profiles:1,profiles_counter:1,events:0,events_counter:0});
 expect(await reconcileHourly(db,at+1000)).toBe('already_attempted');expect(await reconcileHourly(db,at+3*3_600_000)).toBe('matched');
});
it.each(['events','profiles','command_keys'])('confirmed %s mismatch atomically pauses without repair',async key=>{
 await db.prepare('UPDATE capacity_control SET used_count=used_count+1 WHERE budget_key=?').bind(key).run();const before=await budget(key);
 expect(await reconcileHourly(db,at)).toBe('mismatch');expect(await budget(key)).toBe(before);expect(await db.prepare('SELECT integrity_paused,history_unverified FROM system_control').first()).toEqual({integrity_paused:1,history_unverified:1});
 await counters();expect(await reconcileHourly(db,at+3_600_000)).toBe('matched');expect(await db.prepare('SELECT integrity_paused FROM system_control').first('integrity_paused')).toBe(1);
});
it('failed hourly scan is not mismatch and cannot retry same hour',async()=>{
 const broken=interceptBatch(async()=>{throw new Error('read failed');});expect(await reconcileHourly(broken,at)).toBe('read_failed');expect(await reconcileHourly(db,at)).toBe('already_attempted');
 expect(await db.prepare('SELECT integrity_paused FROM system_control').first('integrity_paused')).toBe(0);expect(await reconcileHourly(db,at+3_600_000)).toBe('matched');
});
it('unknown hourly claim does not scan even when commit happened',async()=>{
 let scanned=0;const wrapped=new Proxy(db,{get(target,key){
  if(key==='batch')return (...args: Parameters<D1Database['batch']>)=>{scanned++;return target.batch(...args);};
  if(key==='prepare')return (sql:string)=>{const statement=target.prepare(sql);if(!sql.includes('RETURNING reconcile_token'))return statement;
   return {bind:(...values:(string|number)[])=>({all:async()=>{await statement.bind(...values).all();throw new Error('unknown');}})};};
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
 expect(await reconcileHourly(wrapped,at)).toBe('claim_unknown');expect(scanned).toBe(0);expect(await reconcileHourly(db,at)).toBe('already_attempted');
});
it('coordinator detects undelivered mismatch before cleanup',async()=>{
 await event(id(10),'pending');await db.prepare("UPDATE users SET email='synthetic@example.test',email_confirmed_at=?").bind(at-30*DAY).run();
 const result=await runMaintenance({db,mode:'normal',now:()=>at});expect(result.errors).toContain('integrity_paused');expect((await user())!.email).not.toBeNull();
});
it('cleanup failure does not stop independent delivery; empty run updates success but never ACK',async()=>{
 await event(id(10),'pending',at);await counters();
 // Missing history fails only a delivered event cleanup; pending delivery proceeds.
 await event(id(11));await counters();await db.prepare('UPDATE system_control SET history_available_from=NULL').run();
 const result=await runMaintenance({db,mode:'normal',now:()=>at});expect(result.errors).toContain('cleanup_failed');expect(await budget('undelivered')).toBe(0);
 let status=await readStatus(db,'normal',at);expect(status.delivery.last_ack_at).toBe(at);expect(status.cron.status).toBe('partial_failure');
 await db.prepare('UPDATE system_control SET history_available_from=?').bind(Math.floor(now/DAY)*DAY).run();await runMaintenance({db,mode:'normal',now:()=>at+1000});
 status=await readStatus(db,'normal',at+1000);expect(status.cron.last_success_at).toBe(at+1000);expect(status.delivery.last_ack_at).toBe(at);
});
it('receiver failure does not undo successful cleanup and status reports safe item errors',async()=>{
 await event(id(10),'pending',at);await db.prepare("UPDATE users SET email='synthetic@example.test',email_confirmed_at=?").bind(at-30*DAY).run();await counters();
 await runMaintenance({db,mode:'unavailable',now:()=>at});expect((await user())!.email).toBeNull();
 expect(await readStatus(db,'normal',at)).toMatchObject({cron:{status:'partial_failure'},delivery:{last_ack_at:null,errors:[{code:'receiver_unavailable',count:1}]}});
});
it('status starts unknown, thresholds/staleness exact, read failure throws and unsafe codes are redacted',async()=>{
 expect(await readStatus(db,'normal',at)).toMatchObject({cron:{status:'unknown',stale:null,last_success_at:null},reconciliation:{status:'unknown'}});
 await event(id(10),'pending',at-900_000);await counters();
 await db.prepare("UPDATE capacity_control SET used_count=800 WHERE budget_key='profiles'").run();await db.prepare("UPDATE capacity_control SET used_count=9500 WHERE budget_key='events'").run();
 await db.prepare("UPDATE maintenance_control SET cron_attempt_at=?,cron_success_at=?,cron_result='complete'").bind(at-300_000,at-300_000).run();
 let status=await readStatus(db,'normal',at);expect(status.cron.stale).toBe(false);expect(status.delivery.delayed).toBe(false);expect(status.budgets.find(b=>b.key==='profiles')!.alert).toBe('warning');expect(status.budgets.find(b=>b.key==='events')!.alert).toBe('critical');
 await db.prepare('UPDATE event_delivery SET last_error_code=?').bind('private@example.test').run();status=await readStatus(db,'normal',at+1);expect(status.cron.stale).toBe(true);expect(status.delivery.delayed).toBe(true);expect(status.delivery.errors).toEqual([{code:'unknown_error',count:1}]);
 const broken=new Proxy(db,{get(){return()=>{throw new Error('read failed');};}});await expect(readStatus(broken,'normal',at)).rejects.toThrow();
});
it('deactivation failure rolls back Lead deletion and revision with profile fields',async()=>{
 await db.prepare('UPDATE users SET last_active_at=?').bind(at-180*DAY).run();await db.prepare("INSERT INTO user_offer_leads VALUES (?,'003',?)").bind(userId,now).run();
 const before=await user();await db.exec("CREATE TRIGGER fail_expiry BEFORE UPDATE OF expired_at ON users BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
 const result=await runCleanup(db,at);expect(result.profiles.error).toBe('cleanup_failed');expect(await user()).toEqual(before);expect(await count('user_offer_leads')).toBe(1);expect(await budget('profiles')).toBe(1);
});
it('full coordinator bounded query budget includes cleanup reads, mutations, reconciliation and delivery',async()=>{
 // Multiple eligible categories plus a full ten-item delivery packet.
 for(let i=0;i<12;i++)await event(id(100+i),i<10?'pending':'delivered',i<10?at:at-90*DAY);
 for(let i=0;i<KEY_CAP+2;i++)await result(id(200+i));await db.prepare("UPDATE users SET email='synthetic@example.test',email_confirmed_at=?").bind(at-30*DAY).run();await counters();
 let queries=0;
 const wrapped=new Proxy(db,{get(target,key){
  if(key==='batch')return (statements:D1PreparedStatement[])=>{queries++;return target.batch(statements);};
  if(key==='prepare')return (sql:string)=>{
   const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>new Proxy(statement,{get(st,method){
    if(method==='bind')return (...values:unknown[])=>wrap(st.bind(...values));
    if(['run','all','first','raw'].includes(String(method)))return (...args:unknown[])=>{queries++;return (Reflect.get(st,method) as (...args:unknown[])=>unknown).apply(st,args);};
    const value=Reflect.get(st,method);return typeof value==='function'?value.bind(st):value;
   }});return wrap(target.prepare(sql));
  };
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
 await runMaintenance({db:wrapped,mode:'normal',now:()=>at});expect(await budget('undelivered')).toBe(0);expect(queries).toBeLessThanOrEqual(46);
 expect(CLEANUP_CAP*8+KEY_CAP+9+11).toBeLessThan(50);
});
it('bounded raw windows progress past retained entries and wrap to inserts behind the cursor',async()=>{
 for(let i=10;i<15;i++)await event(id(i),i===14?'delivered':'pending');await counters();
 expect((await runCleanup(db,at)).events).toMatchObject({changed:0,has_more:true});
 expect((await runCleanup(db,at)).events).toMatchObject({changed:0,has_more:true});
 await event(id(9));await counters(); // Behind the cursor; must be revisited on wrap.
 expect((await runCleanup(db,at)).events.changed).toBe(1);expect(await count('events')).toBe(5);
 expect((await runCleanup(db,at)).events.changed).toBe(1);expect(await count('events')).toBe(4);expect(await budget('events')).toBe(4);
});
it('overlapping cleanup claims disjoint raw windows and preserves exact deletion counters',async()=>{
 for(let i=10;i<16;i++)await event(id(i));await counters();
 const runs=await Promise.all([runCleanup(db,at),runCleanup(db,at)]);
 expect(runs.map(r=>r.events.changed).sort()).toEqual([2,2]);expect(await count('events')).toBe(2);expect(await budget('events')).toBe(2);
 await runCleanup(db,at);expect(await count('events')).toBe(0);expect(await budget('events')).toBe(0);
});
it('unknown committed window result authorizes no deletions, and wrap eventually revisits it',async()=>{
 for(let i=10;i<13;i++)await event(id(i));await counters();let lost=false;
 const wrapped=interceptBatch(async statements=>{const response=await db.batch<Record<string,unknown>>(statements);
  if(!lost && response.some(r=>r.results.some(row=>row.id===id(10) && row.eligible===1))){lost=true;throw new Error('unknown window result');}return response;});
 expect((await runCleanup(wrapped,at)).events.error).toBe('cleanup_failed');expect(await count('events')).toBe(3);
 await runCleanup(db,at);expect(await count('events')).toBe(2);
 await runCleanup(db,at);expect(await count('events')).toBe(0);expect(await budget('events')).toBe(0);
});
it('4000 retained mocks/partner events/command keys use bounded rows_read; delivered error count uses partial index',async()=>{
 await db.prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<999)
  INSERT INTO users(user_id,created_at,last_active_at,access_secret_hash)
  SELECT 'retained-user-' || printf('%04d',i),?,?,printf('%064x',i) FROM n`).bind(at,at).run();
 await db.prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<4000)
  INSERT INTO events(event_id,event_type,user_id,preland_id,occurred_at,received_at,click_id,offer_id,schema_version,payload_json)
  SELECT 'retained-' || printf('%05d',i),'Purchase',?,'demo',?,?, 'retained-click-' || i,'003',1,'{}' FROM n`).bind(userId,at,at).run();
 await db.prepare("INSERT INTO event_delivery(event_id,status,delivered_at) SELECT event_id,'delivered',received_at FROM events").run();
 await db.prepare("INSERT INTO mock_received_events(event_id,payload_json,payload_fingerprint,accepted_at) SELECT event_id,payload_json,?,received_at FROM events").bind('a'.repeat(64)).run();
 await db.prepare("INSERT INTO partner_events(event_id,partner_id,event_type,partner_event_id,click_id,user_id,offer_id,preland_id,occurred_at,received_at) SELECT event_id,'demo-partner','Purchase',event_id,click_id,user_id,offer_id,preland_id,occurred_at,received_at FROM events").run();
 await db.prepare("INSERT INTO request_results(user_id,operation_id,created_at,expired) SELECT user_id,event_id,received_at,1 FROM events").run();await counters();
 let rowsRead=0;let windows=0;
 const wrapped=interceptBatch(async statements=>{const response=await db.batch(statements);rowsRead+=response.reduce((n,r)=>n+r.meta.rows_read,0);windows++;return response;});
 const cleaned=await runCleanup(wrapped,at);expect(Object.values(cleaned).every(p=>p.changed===0 && p.error===null)).toBe(true);expect(windows).toBe(9);
 expect(rowsRead).toBeLessThan(1000);expect(await count('mock_received_events')).toBe(4000);expect(await count('partner_events')).toBe(4000);
 const sql="SELECT COUNT(*) AS n FROM event_delivery WHERE last_error_code IS NOT NULL AND status != 'delivered'";
 const errors=await db.prepare(sql).all<{n:number}>();expect(errors.results[0].n).toBe(0);expect(errors.meta.rows_read).toBeLessThan(10);
 const plan=await db.prepare('EXPLAIN QUERY PLAN '+sql).all<{detail:string}>();expect(plan.results.map(r=>r.detail).join(' ')).toContain('delivery_current_errors');
 // Bounds include all window/control/cursor work and guard against retained-history scans.

});
it.each(['normal','unavailable'] as const)('scheduled emits one safe phase summary (%s)',async mode=>{
 await event(id(10),'pending',at);await counters();
 const info=vi.spyOn(console,'info').mockImplementation(()=>{});const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});const clock=vi.spyOn(Date,'now').mockReturnValue(at);
 try {
  await worker.scheduled({} as ScheduledController,{...env,MOCK_RECEIVER_MODE:mode} as unknown as Env,createExecutionContext());
  const logs=mode==='normal'?info:warn;expect(logs).toHaveBeenCalledTimes(1);expect(mode==='normal'?warn:info).not.toHaveBeenCalled();
  const summary=JSON.parse(logs.mock.calls[0][0] as string);expect(Object.keys(summary).sort()).toEqual(['cleanup','code','delivery','errors','hourly']);expect(summary.code).toBe('maintenance_run');
  expect(Object.keys(summary.cleanup).sort()).toEqual(['clicks','command_keys','email','events','mock_keys','partner_keys','profiles','results','user_keys']);
  for(const phase of Object.values(summary.cleanup))expect(Object.keys(phase as object).sort()).toEqual(['changed','error','has_more','skipped']);
  expect(JSON.stringify(summary)).not.toContain(userId);expect(JSON.stringify(summary)).not.toContain(id(10));expect(JSON.stringify(summary)).not.toMatch(/payload|secret|@/);
 }finally{info.mockRestore();warn.mockRestore();clock.mockRestore();}
});
