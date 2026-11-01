import { beforeEach, expect, it } from 'vitest';
import { newHistorySql } from '../../scripts/report-history';
import { db, freshBusinessDb, userStatement } from './helpers/business-db';
const day=Date.parse('2026-10-31');
beforeEach(freshBusinessDb);
it('guarded explicit new-history initializer establishes UTC day once',async()=>{
  await db.prepare(newHistorySql(day)).run();expect(await db.prepare('SELECT history_available_from FROM system_control').first('history_available_from')).toBe(day);
  await db.prepare(newHistorySql(day+86400000)).run();expect(await db.prepare('SELECT history_available_from FROM system_control').first('history_available_from')).toBe(day);
});
it.each(['data','unverified','integrity','capacity'])('never backfills a database with %s',async(kind)=>{
  if(kind==='data')await userStatement().run();
  if(kind==='unverified')await db.prepare('UPDATE system_control SET history_unverified=1').run();
  if(kind==='integrity')await db.prepare('UPDATE system_control SET integrity_paused=1').run();
  if(kind==='capacity')await db.prepare("UPDATE capacity_control SET used_count=1 WHERE budget_key='events'").run();
  await db.prepare(newHistorySql(day)).run();expect(await db.prepare('SELECT history_available_from FROM system_control').first('history_available_from')).toBeNull();
});
