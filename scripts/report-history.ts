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
