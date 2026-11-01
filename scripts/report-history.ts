// Call only with external proof that persistence did not exist before migrations.
// The SQL additionally refuses business rows, previous metadata or paused controls.
export function newHistorySql(day: number) {
  if (!Number.isSafeInteger(day) || day < 0 || day % 86400000) throw new Error('invalid_history_day');
  const tables = ['users', 'events', 'clicks', 'partner_events', 'user_offer_leads', 'request_results', 'event_delivery', 'mock_received_events'];
  return `UPDATE system_control SET history_available_from = ${day}
    WHERE singleton_id = 1 AND history_available_from IS NULL AND history_unverified = 0 AND integrity_paused = 0
    AND NOT EXISTS (SELECT 1 FROM capacity_control WHERE used_count != 0 OR capacity_paused != 0 OR capacity_epoch != 0)
    ${tables.map((table) => `AND NOT EXISTS (SELECT 1 FROM ${table})`).join('\n')};`;
}

export type HistoryMetadata = {
  history_available_from: number | null;
  history_unverified: 0 | 1;
};

// Trust revocation is unconditional and idempotent, including after restore.
// It must remain possible when the boundary is missing or corrupt.
export function markHistoryUnverifiedSql() {
  return `UPDATE system_control SET history_unverified = 1 WHERE singleton_id = 1
    RETURNING history_available_from, history_unverified, integrity_paused;`;
}

// Generate only: the operator supplies external evidence and holds a maintenance
// fence throughout diagnosis and execution. CAS does not detect an ABA restore.
export function confirmHistorySql(day: number, expected: HistoryMetadata, now = Date.now()) {
  const validDay = (value: number) => Number.isSafeInteger(value) && value >= 0 && value % 86400000 === 0 && value <= now;
  if (!Number.isSafeInteger(now) || now < 0 || !validDay(day)) throw new Error('invalid_history_day');
  if (!expected || ![0, 1].includes(expected.history_unverified)
    || (expected.history_available_from !== null && !validDay(expected.history_available_from))) {
    throw new Error('invalid_history_metadata');
  }
  if (expected.history_available_from !== null && day < expected.history_available_from) throw new Error('history_boundary_regression');
  return `UPDATE system_control SET history_available_from = ${day}, history_unverified = 0
    WHERE singleton_id = 1 AND integrity_paused = 0
    AND ${day} <= CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
    AND history_unverified = ${expected.history_unverified}
    AND history_available_from IS ${expected.history_available_from === null ? 'NULL' : expected.history_available_from}
    AND (history_available_from IS NULL OR history_available_from <= ${day})
    RETURNING history_available_from, history_unverified, integrity_paused;`;
}
