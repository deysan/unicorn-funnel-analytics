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

import { confirmHistorySql, markHistoryUnverifiedSql, type HistoryMetadata } from '../../scripts/report-history';
import { DAY, availableFrom, utcDay } from '../../src/shared/report';
import { readFunnel } from '../../src/server/report/read';
import { runMaintenance } from '../../src/server/maintenance/coordinator';
import { executeQuizCommand } from '../../src/server/quiz/commands';
import { acceptPartnerEvent } from '../../src/server/partner/events';
import { importFingerprintKey } from '../../src/server/storage/command-fingerprint';
import { id, userId } from './helpers/business-db';
const clock = day + 12 * 3_600_000;
const metadata = () => db.prepare('SELECT history_available_from, history_unverified FROM system_control').first<HistoryMetadata>();
async function snapshot() {
  const tables = ['users', 'events', 'clicks', 'partner_events', 'user_offer_leads', 'request_results',
    'event_delivery', 'mock_received_events', 'capacity_control', 'maintenance_control', 'cleanup_cursors'];
  return Promise.all(tables.map(async table => (await db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results));
}
// Commands and partner acceptance own events, causal links and capacity counters.
async function quiz(at: number, seed: number) {
  const keys = { currentVersion: 'v1', keys: new Map([['v1', await importFingerprintKey(new Uint8Array(32).fill(1))]]) };
  let next = seed;
  const command = async (input: Record<string, unknown>) => {
    const operation = id(next++);
    expect(await executeQuizCommand({ db, userId, secretHash: userId.replaceAll('-', '').padEnd(64, '0'), keys,
      now: () => at, input: { preland_id: 'demo', operation_id: operation, ...input } }))
      .toMatchObject({ status: 'found', result: { code: input.type === 'offer_selection' ? 'offer_selected' : 'accepted' } });
    return operation;
  };
  const entry = id(next++);
  await command({ type: 'entry', event_id: entry });
  for (const [question, value] of [['preferred_gender', 'women'], ['preferred_ethnicity', 'asia'], ['email', 'synthetic@example.test']]) {
    const view = id(next++);
    await command({ type: 'question_view', event_id: view, entry_event_id: entry, question_id: question });
    const completion = await command(question === 'email' ? { type: 'email_confirmation', view_event_id: view, email: value }
      : { type: 'answer', view_event_id: view, question_id: question, value });
    if (question === 'email') await command({ type: 'offer_selection', entry_event_id: entry, completion_operation_id: completion });
  }
  return (await db.prepare('SELECT click_id FROM clicks WHERE entry_event_id = ?').bind(entry).first<{click_id: string}>())!.click_id;
}
async function business() {
  await userStatement().run();
  await db.prepare("UPDATE capacity_control SET used_count = 1 WHERE budget_key = 'profiles'").run();
  await db.prepare('UPDATE system_control SET history_available_from = ?').bind(day - 100 * DAY).run();
}

it('confirmation changes only history metadata and makes only the proven period ready', async () => {
  await business(); await quiz(clock, 1000);
  await db.prepare(markHistoryUnverifiedSql()).all();
  await db.prepare("UPDATE capacity_control SET capacity_paused = 1, capacity_epoch = 4 WHERE budget_key = 'events'").run();
  const before = await snapshot();
  const response = await db.prepare(confirmHistorySql(day, (await metadata())!, clock)).all();
  expect(response.results).toEqual([{ history_available_from: day, history_unverified: 0, integrity_paused: 0 }]);
  expect(await snapshot()).toEqual(before);
  expect(await readFunnel(db, { from: utcDay(day), to: utcDay(day) }, clock)).toMatchObject({ report_status: 'ready',
    metrics: { quiz: { activity: { entered: 1, started: 1, completed: 1 } }, offers: { activity: { transitioned: 1 } } } });
  expect(await readFunnel(db, { from: utcDay(day - DAY), to: utcDay(day) }, clock)).toMatchObject({ report_status: 'unavailable', reason: 'period_unavailable', available_from: utcDay(day) });
});

it('missing initial boundary can be explicitly confirmed only with supplied evidence, never by a read', async () => {
  await db.prepare(markHistoryUnverifiedSql()).all();
  const expected = (await metadata())!;
  expect(expected).toEqual({ history_available_from: null, history_unverified: 1 });
  expect(await readFunnel(db, { from: utcDay(day), to: utcDay(day) }, clock)).toMatchObject({ reason: 'history_unverified' });
  expect((await db.prepare(confirmHistorySql(day, expected, clock)).all()).results).toHaveLength(1);
});

it.each([day + DAY, day + 1, -DAY, NaN, Infinity, Number.MAX_SAFE_INTEGER])('refuses invalid or future UTC day %s without mutation', async boundary => {
  const before = await metadata();
  expect(() => confirmHistorySql(boundary, before!, clock)).toThrow('invalid_history_day');
  expect(await metadata()).toEqual(before);
});

it('checks future boundary at SQL execution too, even if generator clock was wrong', async () => {
  const future = Math.floor(Date.now() / DAY) * DAY + 10 * DAY;
  expect((await db.prepare(confirmHistorySql(future, (await metadata())!, future)).all()).results).toEqual([]);
  expect(await metadata()).toEqual({ history_available_from: null, history_unverified: 0 });
});

it.each([
  { history_available_from: day + 1, history_unverified: 1 },
  { history_available_from: day, history_unverified: 2 },
  { history_available_from: '0 OR 1=1', history_unverified: 1 },
])('refuses malformed expected metadata %#', async expected => {
  expect(() => confirmHistorySql(day, expected as HistoryMetadata, clock)).toThrow('invalid_history_metadata');
});

it.each(['boundary', 'trust'])('refuses stale %s metadata and preserves every row', async change => {
  await business(); await db.prepare(markHistoryUnverifiedSql()).all();
  const sql = confirmHistorySql(day, (await metadata())!, clock);
  await db.prepare(change === 'boundary' ? `UPDATE system_control SET history_available_from = ${day}` : 'UPDATE system_control SET history_unverified = 0').run();
  const before = await snapshot(); const controls = await metadata();
  expect((await db.prepare(sql).all()).results).toEqual([]);
  expect(await metadata()).toEqual(controls); expect(await snapshot()).toEqual(before);
});

it('refuses backward expansion and integrity-paused confirmation; revocation keeps pause and boundary', async () => {
  await business(); await db.prepare('UPDATE system_control SET history_available_from = ?').bind(day).run();
  const expected = (await metadata())!;
  expect(() => confirmHistorySql(day - DAY, expected, clock)).toThrow('history_boundary_regression');
  const sql = confirmHistorySql(day, expected, clock);
  await db.prepare('UPDATE system_control SET integrity_paused = 1').run();
  const before = await snapshot();
  expect((await db.prepare(sql).all()).results).toEqual([]);
  for (let attempt = 0; attempt < 2; attempt++) expect((await db.prepare(markHistoryUnverifiedSql()).all()).results)
    .toEqual([{ history_available_from: day, history_unverified: 1, integrity_paused: 1 }]);
  expect((await db.prepare(confirmHistorySql(day, (await metadata())!, clock)).all()).results).toEqual([]);
  expect(await snapshot()).toEqual(before);
});

it.each([false, true])('real Cron retention preserves allowed metrics and never clears distrust (%s)', async unverified => {
  await business();
  const oldAt = clock - 91 * DAY;
  await quiz(oldAt, 2000);
  // Deliver while old history is still eligible, then create a later complete quiz.
  expect((await runMaintenance({ db, mode: 'normal', now: () => oldAt })).errors).toEqual([]);
  const click = await quiz(clock, 3000);
  for (const event_type of ['Lead', 'Purchase'] as const) expect(await acceptPartnerEvent({ db, partnerId: 'demo-partner', now: () => clock,
    input: { event_type, partner_event_id: 'synthetic-' + event_type, click_id: click, occurred_at: new Date(clock).toISOString(),
      ...(event_type === 'Purchase' ? { amount_minor: 2500, currency: 'USD' } : {}) } })).toEqual({ status: 'accepted' });
  const filters = { from: utcDay(day), to: utcDay(day) };
  const before = await readFunnel(db, filters, clock);
  expect(before).toMatchObject({ report_status: 'ready', metrics: { offers: { activity: { leads: 1, buyers: 1, purchases: 1 } } } });
  if (unverified) await db.prepare(markHistoryUnverifiedSql()).all();
  // Two-row windows and causal child dependencies need several cursor sweeps.
  let removed = 0;
  for (let tick = 0; tick < 50 && removed < 8; tick++) {
    const result = await runMaintenance({ db, mode: 'normal', now: () => clock });
    expect(result.errors).toEqual([]); removed += result.cleanup!.events.changed;
  }
  expect(removed).toBe(8);
  expect(await db.prepare('SELECT COUNT(*) AS n FROM events WHERE received_at = ?').bind(oldAt).first('n')).toBe(0);
  expect((await metadata())!.history_available_from).toBe(availableFrom(day - 100 * DAY, clock));
  if (unverified) {
    // Even a new accepted fact after successful cleanup/Cron cannot re-establish trust.
    expect(await acceptPartnerEvent({ db, partnerId: 'demo-partner', now: () => clock,
      input: { event_type: 'Purchase', partner_event_id: 'synthetic-later', click_id: click, occurred_at: new Date(clock).toISOString(), amount_minor: 2500, currency: 'USD' } })).toEqual({ status: 'accepted' });
    expect((await runMaintenance({ db, mode: 'normal', now: () => clock + 60_000 })).errors).toEqual([]);
    expect(await readFunnel(db, filters, clock)).toEqual({ report_status: 'unavailable', reason: 'history_unverified', updated_at: clock, filters });
  } else {
    expect(await readFunnel(db, filters, clock)).toEqual(before);
    expect(await readFunnel(db, { from: utcDay(oldAt), to: utcDay(oldAt) }, clock)).toMatchObject({ report_status: 'unavailable', reason: 'period_unavailable' });
  }
});
