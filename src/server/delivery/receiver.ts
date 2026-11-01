import { addIntegrityGuard } from '../storage/capacity';
import { GuardedBatch } from '../storage/transaction-guards';
import { normalized, readPacket, readSnapshot, receiverMode } from './contract';

// Внутрішній адаптер. Commit приймача ніколи не змінює event_delivery.
export async function receive(db: D1Database, packet: string, mode: unknown, now: number): Promise<string> {
  if (receiverMode(mode) === 'unavailable') throw new Error('receiver_unavailable');
  const events = readPacket(packet);
  const batch = new GuardedBatch(db); addIntegrityGuard(batch);
  const statements = batch.finish();
  const reads: number[] = [];
  for (const event of events) {
    const payload = normalized(event);
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
    const fingerprint = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
    statements.push(db.prepare(`INSERT INTO mock_received_events (event_id, payload_json, payload_fingerprint, accepted_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING`).bind(event.event_id, payload, fingerprint, now));
    reads.push(statements.length);
    statements.push(db.prepare('SELECT payload_json FROM mock_received_events WHERE event_id = ?').bind(event.event_id));
  }
  const result = await db.batch<{ payload_json: string }>(statements);
  return JSON.stringify({ schema_version: 1, results: events.map((event, index) => {
    let accepted = false;
    try { accepted = normalized(readSnapshot(result[reads[index]].results[0].payload_json, event.event_id)) === normalized(event); } catch { /* Зіпсований старий запис не перезаписуємо. */ }
    return { event_id: event.event_id, status: accepted ? 'accepted' : 'conflict' };
  }) });
}
