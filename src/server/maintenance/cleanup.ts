import { DAY, availableFrom } from '../../shared/report';
import { addIntegrityGuard, releaseCapacity } from '../storage/capacity';
import { GuardedBatch, classifyGuard } from '../storage/transaction-guards';

// At most 26 mutation batches + 9 cursor/window calls.
// Reserve 11 D1 calls for Cron/delivery: the full invocation stays below Free's 50.
// Materialized raw keyset windows bound examination BEFORE TTL/dependency predicates.
export const CLEANUP_CAP = 2;
export const KEY_CAP = 10;
export interface PhaseResult { changed: number; skipped: number; has_more: boolean; error: 'cleanup_failed' | null }
export type CleanupResult = Record<string, PhaseResult>;
const noDependencies = `NOT EXISTS (SELECT 1 FROM events WHERE user_id = users.user_id)
 AND NOT EXISTS (SELECT 1 FROM clicks WHERE user_id = users.user_id)
 AND NOT EXISTS (SELECT 1 FROM partner_events WHERE user_id = users.user_id)`;
const eventEligible = `received_at <= ? AND EXISTS (SELECT 1 FROM event_delivery d WHERE d.event_id = events.event_id AND status = 'delivered')
 AND NOT EXISTS (SELECT 1 FROM events child WHERE child.entry_event_id = events.event_id OR child.view_event_id = events.event_id OR child.completion_event_id = events.event_id)
 AND NOT EXISTS (SELECT 1 FROM clicks child WHERE child.entry_event_id = events.event_id OR child.completion_event_id = events.event_id)`;
const partnerEligible = `NOT EXISTS (SELECT 1 FROM clicks WHERE click_id = partner_events.click_id)
 AND NOT EXISTS (SELECT 1 FROM events WHERE event_id = partner_events.event_id)`;
const mockEligible = 'NOT EXISTS (SELECT 1 FROM events WHERE event_id = mock_received_events.event_id)';
const safeUser = `expired_at IS NOT NULL AND ${noDependencies}`;
type Row = { id: string; operation_id?: string; occurred_at?: number; lead_count?: number; eligible: number };
const windows: Record<string, { table: string; key: string; cap: number; subkey?: string }> = {
 profiles: { table: 'users', key: 'user_id', cap: CLEANUP_CAP },
 email: { table: 'users', key: 'user_id', cap: CLEANUP_CAP },
 results: { table: 'request_results', key: 'user_id', subkey: 'operation_id', cap: CLEANUP_CAP },
 clicks: { table: 'clicks', key: 'click_id', cap: CLEANUP_CAP },
 events: { table: 'events', key: 'event_id', cap: CLEANUP_CAP },
 partner_keys: { table: 'partner_events', key: 'event_id', cap: CLEANUP_CAP },
 mock_keys: { table: 'mock_received_events', key: 'event_id', cap: CLEANUP_CAP },
 command_keys: { table: 'request_results', key: 'user_id', subkey: 'operation_id', cap: KEY_CAP },
 user_keys: { table: 'users', key: 'user_id', cap: CLEANUP_CAP },
};
function windowSql(name: string) {
 const { table, key, cap, subkey } = windows[name];
 const after = `(SELECT after_key FROM cleanup_cursors WHERE phase = '${name}')`;
 const afterSub = `(SELECT after_subkey FROM cleanup_cursors WHERE phase = '${name}')`;
 const order = subkey ? `${key}, ${subkey}` : key;
 const seek = subkey ? `(${key}, ${subkey}) > (${after}, ${afterSub})` : `${key} > ${after}`;
 return { ...windows[name], order, window: `WITH candidates AS MATERIALIZED (SELECT * FROM ${table} WHERE ${seek} ORDER BY ${order} LIMIT ${cap + 1})` };
}

export async function runCleanup(db: D1Database, now: number): Promise<CleanupResult> {
 const result: CleanupResult = {};
 async function phase(name: string, columns: string, eligible: string,
  bindings: (string | number)[], mutate: (batch: GuardedBatch, row: Row) => void) {
  const summary: PhaseResult = { changed: 0, skipped: 0, has_more: false, error: null }; result[name] = summary;
  try {
   const { table, key, cap, subkey, window, order } = windowSql(name);
   const read = db.prepare(`${window} SELECT ${columns}, CASE WHEN (${eligible}) THEN 1 ELSE 0 END AS eligible
    FROM candidates AS ${table} ORDER BY ${order}`).bind(...bindings);
   const lastKey = `(SELECT ${key} FROM candidates ORDER BY ${order} LIMIT 1 OFFSET ${cap - 1})`;
   const lastSub = subkey ? `(SELECT ${subkey} FROM candidates ORDER BY ${order} LIMIT 1 OFFSET ${cap - 1})` : "''";
   // The cursor's only effect is guarded directly in SQL. No transient assertion rows
   // are needed for a no-op window; every business deletion/update below keeps GuardedBatch.
   // Read/control/advance share one atomic batch. Unknown results authorize no mutations.
   const response = await db.batch<Row & { integrity_paused: number }>([
    db.prepare(`SELECT integrity_paused FROM system_control JOIN cleanup_cursors ON phase = ? WHERE singleton_id = 1`).bind(name),
    read,
    db.prepare(`${window}, next_cursor AS MATERIALIZED (SELECT
     CASE WHEN (SELECT COUNT(*) FROM candidates) > ${cap} THEN ${lastKey} ELSE '' END AS next_key,
     CASE WHEN (SELECT COUNT(*) FROM candidates) > ${cap} THEN ${lastSub} ELSE '' END AS next_subkey)
     UPDATE cleanup_cursors SET after_key = (SELECT next_key FROM next_cursor), after_subkey = (SELECT next_subkey FROM next_cursor)
     WHERE phase = ? AND EXISTS (SELECT 1 FROM system_control WHERE singleton_id = 1 AND integrity_paused = 0)
     AND (after_key != (SELECT next_key FROM next_cursor) OR after_subkey != (SELECT next_subkey FROM next_cursor))`).bind(name),
   ]);
   if (response[0].results[0]?.integrity_paused !== 0) throw new Error('cleanup_failed');
   const rows = response[1].results;
   summary.has_more = rows.length > cap;
   for (const row of rows.slice(0, cap)) {
    if (row.eligible !== 1) continue;
    const batch = new GuardedBatch(db); addIntegrityGuard(batch); mutate(batch, row);
    try { await db.batch(batch.finish()); summary.changed++; }
    catch (error) {
     if (classifyGuard(error) === 'reference') { summary.skipped++; summary.has_more = true; }
     else throw error;
    }
   }
  } catch { summary.error = 'cleanup_failed'; }
 }
 const expired = now - 180 * DAY;
 await phase('profiles', 'user_id AS id, (SELECT COUNT(*) FROM user_offer_leads l WHERE l.user_id = users.user_id) AS lead_count', 'expired_at IS NULL AND last_active_at <= ?', [expired], (b, r) => {
  b.assert('reference', { sql: 'EXISTS (SELECT 1 FROM users WHERE user_id = ? AND expired_at IS NULL AND last_active_at <= ?)', bindings: [r.id, expired] });
  b.effect({ changes: r.lead_count!, statement: db.prepare('DELETE FROM user_offer_leads WHERE user_id = ?').bind(r.id) });
  b.effect({ changes: 1, statement: db.prepare(`UPDATE users SET created_at = NULL, last_active_at = NULL,
    preferred_gender = NULL, preferred_ethnicity = NULL, email = NULL, email_confirmed_at = NULL,
    access_secret_hash = NULL, revoked_at = NULL, expired_at = ?, selection_revision = selection_revision + 1 WHERE user_id = ?`).bind(now, r.id) });
 });
 await phase('email', 'user_id AS id', 'email IS NOT NULL AND email_confirmed_at <= ?', [now - 30 * DAY], (b, r) => {
  b.assert('reference', { sql: 'EXISTS (SELECT 1 FROM users WHERE user_id = ? AND email IS NOT NULL AND email_confirmed_at <= ?)', bindings: [r.id, now - 30 * DAY] });
  b.effect({ changes: 1, statement: db.prepare('UPDATE users SET email = NULL, email_confirmed_at = NULL, selection_revision = selection_revision + 1 WHERE user_id = ?').bind(r.id) });
 });
 await phase('results', 'user_id AS id, operation_id', 'expired = 0 AND created_at <= ?', [now - 7 * DAY], (b, r) => {
  b.assert('reference', { sql: 'EXISTS (SELECT 1 FROM request_results WHERE user_id = ? AND operation_id = ? AND expired = 0 AND created_at <= ?)', bindings: [r.id, r.operation_id!, now - 7 * DAY] });
  b.effect({ changes: 1, statement: db.prepare(`UPDATE request_results SET expired = 1, operation_type = NULL, request_fingerprint = NULL,
   fingerprint_key_version = NULL, fingerprint_format_version = NULL, result_json = NULL WHERE user_id = ? AND operation_id = ?`).bind(r.id, r.operation_id!) });
 });
 await phase('clicks', 'click_id AS id', 'created_at <= ?', [now - 90 * DAY], (b, r) => {
  b.assert('reference', { sql: 'EXISTS (SELECT 1 FROM clicks WHERE click_id = ? AND created_at <= ?)', bindings: [r.id, now - 90 * DAY] });
  b.effect({ changes: 1, statement: db.prepare('DELETE FROM clicks WHERE click_id = ?').bind(r.id) });
 });
 await phase('events', 'event_id AS id, occurred_at', eventEligible, [now - 90 * DAY], (b, r) => {
  b.assert('reference', { sql: `EXISTS (SELECT 1 FROM events WHERE event_id = ? AND ${eventEligible})`, bindings: [r.id, now - 90 * DAY] });
  // Preserve unknown/corrupt boundaries instead of manufacturing a verified history.
  b.assert('control', { sql: 'EXISTS (SELECT 1 FROM system_control WHERE singleton_id = 1 AND history_available_from >= 0 AND history_available_from % ? = 0 AND history_available_from <= ?)', bindings: [DAY, now] });
  b.effect({ changes: 1, statement: db.prepare('UPDATE system_control SET history_available_from = MAX(history_available_from, ?, ?) WHERE singleton_id = 1')
   .bind(availableFrom(0, now), (Math.floor(r.occurred_at! / DAY) + 1) * DAY) });
  b.effect({ changes: 1, statement: db.prepare("DELETE FROM event_delivery WHERE event_id = ? AND status = 'delivered'").bind(r.id) });
  b.effect({ changes: 1, statement: db.prepare('DELETE FROM events WHERE event_id = ?').bind(r.id) });
  releaseCapacity(b, 'events', 1);
 });
 await phase('partner_keys', 'event_id AS id', partnerEligible, [], (b, r) => {
  b.assert('reference', { sql: `EXISTS (SELECT 1 FROM partner_events WHERE event_id = ? AND ${partnerEligible})`, bindings: [r.id] });
  b.effect({ changes: 1, statement: db.prepare('DELETE FROM partner_events WHERE event_id = ?').bind(r.id) });
 });
 await phase('mock_keys', 'event_id AS id', mockEligible, [], (b, r) => {
  b.assert('reference', { sql: `EXISTS (SELECT 1 FROM mock_received_events WHERE event_id = ? AND ${mockEligible})`, bindings: [r.id] });
  b.effect({ changes: 1, statement: db.prepare('DELETE FROM mock_received_events WHERE event_id = ?').bind(r.id) });
 });
 await phase('command_keys', 'user_id AS id, operation_id', `EXISTS (SELECT 1 FROM users WHERE users.user_id = request_results.user_id AND ${safeUser})`, [], (b, r) => {
  b.assert('reference', { sql: `EXISTS (SELECT 1 FROM users WHERE user_id = ? AND ${safeUser})`, bindings: [r.id] });
  b.effect({ changes: 1, statement: db.prepare('DELETE FROM request_results WHERE user_id = ? AND operation_id = ?').bind(r.id, r.operation_id!) });
  releaseCapacity(b, 'command_keys', 1);
 });
 await phase('user_keys', 'user_id AS id', `${safeUser} AND NOT EXISTS (SELECT 1 FROM request_results WHERE user_id = users.user_id)`, [], (b, r) => {
  b.assert('reference', { sql: `EXISTS (SELECT 1 FROM users WHERE user_id = ? AND ${safeUser}) AND NOT EXISTS (SELECT 1 FROM request_results WHERE user_id = ?)`, bindings: [r.id, r.id] });
  b.effect({ changes: 1, statement: db.prepare('DELETE FROM users WHERE user_id = ?').bind(r.id) }); releaseCapacity(b, 'profiles', 1);
 });
 return result;
}
