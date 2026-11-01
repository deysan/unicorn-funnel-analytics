import { addIntegrityGuard, BUDGETS } from '../storage/capacity';
import { GuardedBatch } from '../storage/transaction-guards';
import { bytes, readAck, readSnapshot, receiverMode, type AckStatus } from './contract';
import { receive } from './receiver';

export const LEASE_MS = 120_000;
export const TIMEOUT_MS = 5_000;
export interface Claimed { event_id: string; attempt_count: number; lease_token: string; payload_json: string; schema_version: number }
export function backoff(attempt: number, random: () => number): number {
  return Math.floor([1, 2, 4, 8, 15][Math.min(4, Math.max(0, attempt - 1))] * 60_000 * (1 - Math.min(1, Math.max(0, random())) * 0.1));
}
// Один SQL snapshot; індексні проходи обмежені 1001 рядком. Overflow також є mismatch.
export async function reconcileUndelivered(db: D1Database): Promise<boolean> {
  const count = `(SELECT COUNT(*) FROM (SELECT event_id FROM event_delivery WHERE status = 'pending'
    UNION ALL SELECT event_id FROM event_delivery WHERE status = 'in_flight' LIMIT 1001))`;
  const results = await db.batch<{ integrity_paused: number }>([
    db.prepare(`UPDATE system_control SET integrity_paused = 1, history_unverified = 1 WHERE singleton_id = 1
      AND (integrity_paused = 0 OR history_unverified = 0) AND
      (NOT EXISTS (SELECT 1 FROM capacity_control WHERE budget_key = 'undelivered' AND used_count = ${count} AND used_count <= 1000))`),
    db.prepare('SELECT integrity_paused FROM system_control WHERE singleton_id = 1'),
  ]);
  return results[1].results[0]?.integrity_paused === 0;
}
export async function claim(db: D1Database, now: number): Promise<Claimed[]> {
  // A negative read only skips this invocation; it never authorizes a send.
  // The guarded UPDATE below still selects and claims the actual current rows.
  const ready = await db.prepare(`SELECT EXISTS (SELECT 1 FROM event_delivery WHERE status = 'pending' AND next_attempt_at <= ?)
    OR EXISTS (SELECT 1 FROM event_delivery WHERE status = 'in_flight' AND lease_until <= ?) AS ready`).bind(now, now).first<number>('ready');
  if (ready === 0) return [];
  if (ready !== 1) throw new Error('claim_unknown');
  const batch = new GuardedBatch(db); addIntegrityGuard(batch);
  const statements = batch.finish();
  statements.push(db.prepare(`UPDATE event_delivery SET status = 'in_flight', lease_token = ?, lease_until = ?,
    attempt_count = attempt_count + 1 WHERE event_id IN (
      SELECT event_id FROM (
        SELECT event_id, next_attempt_at FROM event_delivery WHERE status = 'pending' AND next_attempt_at <= ?
        UNION ALL
        SELECT event_id, next_attempt_at FROM event_delivery WHERE status = 'in_flight' AND lease_until <= ?
      ) ORDER BY next_attempt_at, event_id LIMIT 10
    ) RETURNING event_id, attempt_count, lease_token,
      (SELECT payload_json FROM events WHERE events.event_id = event_delivery.event_id) AS payload_json,
      (SELECT schema_version FROM events WHERE events.event_id = event_delivery.event_id) AS schema_version`)
    .bind(crypto.randomUUID(), now + LEASE_MS, now, now));
  const results = await db.batch<Claimed>(statements);
  return results[results.length - 1].results;
}
export async function applyResults(db: D1Database, claimed: Claimed[], statuses: Map<string, AckStatus>,
  errors: Map<string, string>, now: number, random: () => number): Promise<void> {
  const batch = new GuardedBatch(db); addIntegrityGuard(batch);
  batch.assert('control', { sql: `EXISTS (SELECT 1 FROM capacity_control WHERE budget_key = 'undelivered'
    AND used_count BETWEEN 0 AND 1000 AND capacity_epoch BETWEEN 0 AND ?)`, bindings: [Number.MAX_SAFE_INTEGER - 1] });
  const statements = batch.finish();
  for (const row of claimed) {
    const accepted = statuses.get(row.event_id) === 'accepted';
    statements.push(db.prepare(`UPDATE event_delivery SET status = ?, next_attempt_at = ?, lease_token = NULL,
      lease_until = NULL, delivered_at = ?, last_error_code = ?
      WHERE event_id = ? AND status = 'in_flight' AND lease_token = ? AND lease_until > ?`)
      .bind(accepted ? 'delivered' : 'pending', accepted ? null : now + backoff(row.attempt_count, random),
        accepted ? now : null, accepted ? null : errors.get(row.event_id) ?? statuses.get(row.event_id) ?? 'missing_ack', row.event_id, row.lease_token, now));
    if (accepted) {
      // changes() належить безпосередньому UPDATE доставки: stale = 0, чинний = 1.
      // CHECK used_count >= 0 відкотить весь batch, якщо бюджет пошкоджений.
      const threshold = BUDGETS.undelivered.resumeBelow;
      statements.push(db.prepare(`UPDATE capacity_control SET
        capacity_epoch = capacity_epoch + CASE WHEN used_count >= ? AND used_count - changes() < ? THEN 1 ELSE 0 END,
        capacity_paused = CASE WHEN used_count - changes() < ? THEN 0 ELSE capacity_paused END,
        used_count = used_count - changes() WHERE budget_key = 'undelivered' AND changes() > 0`).bind(threshold, threshold, threshold));
      statements.push(db.prepare('UPDATE maintenance_control SET last_ack_at = MAX(COALESCE(last_ack_at, 0), ?) WHERE singleton_id = 1 AND changes() > 0').bind(now));
    }
  }
  await db.batch(statements);
}
export interface DeliveryOptions {
  db: D1Database; mode: unknown; now?: () => number; random?: () => number;
  send?: (packet: string) => Promise<string>;
}
export type RunResult = 'complete' | 'integrity_paused' | 'reconcile_failed' | 'claim_unknown' | 'ack_unknown' | 'invalid_mode';
export async function runDelivery(options: DeliveryOptions): Promise<RunResult> {
  const { db } = options; const clock = options.now ?? Date.now; const random = options.random ?? Math.random;
  let mode: 'normal' | 'unavailable';
  try { mode = receiverMode(options.mode); } catch { return 'invalid_mode'; }
  try { if (!await reconcileUndelivered(db)) return 'integrity_paused'; } catch { return 'reconcile_failed'; }
  let claimed: Claimed[];
  try { claimed = await claim(db, clock()); } catch { return 'claim_unknown'; }
  if (!claimed.length) return 'complete';
  const errors = new Map<string, string>();
  const events = claimed.flatMap((row) => {
    try {
      if (row.schema_version !== 1) throw new Error('invalid_snapshot');
      return [readSnapshot(row.payload_json, row.event_id)];
    } catch { errors.set(row.event_id, 'invalid_snapshot'); return []; }
  });
  let statuses = new Map<string, AckStatus>();
  if (events.length) {
    const packet = JSON.stringify({ schema_version: 1, events });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failure = 'receiver_unavailable';
    try {
      if (bytes(packet) > 65536) throw new Error('invalid_packet');
      const started = clock();
      const response = await Promise.race([
        Promise.resolve().then(() => options.send ? options.send(packet) : receive(db, packet, mode, clock())),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { failure = 'timeout'; reject(new Error('timeout')); }, TIMEOUT_MS); }),
      ]);
      if (clock() - started >= TIMEOUT_MS) { failure = 'timeout'; throw new Error('timeout'); }
      failure = 'invalid_ack';
      statuses = readAck(response, events.map((event) => event.event_id));
    } catch { for (const event of events) errors.set(event.event_id, failure); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }
  try { await applyResults(db, claimed, statuses, errors, clock(), random); } catch { return 'ack_unknown'; }
  return 'complete';
}
