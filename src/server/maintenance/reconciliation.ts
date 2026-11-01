export type ReconciliationResult = 'matched' | 'mismatch' | 'already_attempted' | 'claim_unknown' | 'read_failed';
// Claim commits separately BEFORE scanning. Unknown outcomes never authorize a scan.
export async function reconcileHourly(db: D1Database, now: number): Promise<ReconciliationResult> {
 const hour = Math.floor(now / 3_600_000); const token = crypto.randomUUID();
 try {
  const claim = await db.prepare(`UPDATE maintenance_control SET reconcile_hour = ?, reconcile_token = ?,
   reconcile_attempt_at = ?, reconcile_read_at = NULL, reconcile_status = 'claimed', reconcile_json = NULL
   WHERE singleton_id = 1 AND (reconcile_hour IS NULL OR reconcile_hour < ?) RETURNING reconcile_token`).bind(hour, token, now, hour).all<{reconcile_token: string}>();
  if (claim.results.length !== 1 || claim.results[0].reconcile_token !== token) return 'already_attempted';
 } catch { return 'claim_unknown'; }
 try {
  // One SELECT snapshot for all physical rows and their corresponding counters.
  // Counts are run only by the confirmed hourly claimant, never on every minute.
  const snapshot = `SELECT json_object(
    'events', (SELECT COUNT(*) FROM events), 'profiles', (SELECT COUNT(*) FROM users),
    'command_keys', (SELECT COUNT(*) FROM request_results),
    'events_counter', (SELECT used_count FROM capacity_control WHERE budget_key = 'events'),
    'profiles_counter', (SELECT used_count FROM capacity_control WHERE budget_key = 'profiles'),
    'command_keys_counter', (SELECT used_count FROM capacity_control WHERE budget_key = 'command_keys'))`;
  const mismatch = `EXISTS (SELECT 1 FROM maintenance_control WHERE singleton_id = 1 AND reconcile_token = ? AND
    (json_extract(reconcile_json, '$.events') IS NOT json_extract(reconcile_json, '$.events_counter') OR
     json_extract(reconcile_json, '$.profiles') IS NOT json_extract(reconcile_json, '$.profiles_counter') OR
     json_extract(reconcile_json, '$.command_keys') IS NOT json_extract(reconcile_json, '$.command_keys_counter')))`;
  const rows = await db.batch<{reconcile_status: string}>([
   db.prepare(`UPDATE maintenance_control SET reconcile_json = (${snapshot}), reconcile_read_at = ?, reconcile_status = 'matched'
    WHERE singleton_id = 1 AND reconcile_token = ?`).bind(now, token),
   db.prepare(`UPDATE system_control SET integrity_paused = 1, history_unverified = 1 WHERE singleton_id = 1 AND ${mismatch}`).bind(token),
   db.prepare(`UPDATE maintenance_control SET reconcile_status = 'mismatch' WHERE singleton_id = 1 AND ${mismatch}`).bind(token),
   db.prepare('SELECT reconcile_status FROM maintenance_control WHERE singleton_id = 1 AND reconcile_token = ?').bind(token),
  ]);
  const status = rows[3].results[0]?.reconcile_status;
  return status === 'matched' || status === 'mismatch' ? status : 'read_failed';
 } catch {
  // Do not overwrite a committed-but-unknown scan, and never retry the scan in this hour.
  try { await db.prepare("UPDATE maintenance_control SET reconcile_status = 'read_failed' WHERE singleton_id = 1 AND reconcile_token = ? AND reconcile_status = 'claimed'").bind(token).run(); } catch { /* status remains visibly claimed */ }
  return 'read_failed';
 }
}
