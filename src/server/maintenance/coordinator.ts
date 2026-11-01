import { reconcileUndelivered, runDelivery, type DeliveryOptions } from '../delivery/executor';
import { runCleanup } from './cleanup';
import { reconcileHourly } from './reconciliation';

export async function runMaintenance(options: DeliveryOptions) {
 const { db } = options; const clock = options.now ?? Date.now; const token = crypto.randomUUID();
 const errors: string[] = []; let clean: Awaited<ReturnType<typeof runCleanup>> | null = null;
 try {
  const attemptedAt = clock();
  await db.prepare(`UPDATE maintenance_control SET cron_token = ?, cron_attempt_at = ?,
   cron_first_attempt_at = COALESCE(cron_first_attempt_at, ?), cron_result = 'running', cron_errors_json = '[]'
   WHERE singleton_id = 1`).bind(token, attemptedAt, attemptedAt).run();
 }
 catch { errors.push('status_write_failed'); }
 let integrityKnown = false;
 try { integrityKnown = await reconcileUndelivered(db); if (!integrityKnown) errors.push('integrity_paused'); }
 catch { errors.push('undelivered_read_failed'); }
 const hourly = await reconcileHourly(db, clock());
 if (!['matched', 'already_attempted'].includes(hourly)) errors.push('hourly_' + hourly);
 // A failed integrity read never permits cleanup; independent delivery still gets its own check.
 if (integrityKnown && !['mismatch', 'read_failed', 'claim_unknown'].includes(hourly)) {
  clean = await runCleanup(db, clock());
  if (Object.values(clean).some((p) => p.error)) errors.push('cleanup_failed');
 }
 const delivery = await runDelivery(options);
 if (delivery !== 'complete') errors.push('delivery_' + delivery);
 // A completed executor may still have failed individual sends/ACKs. Surface these as partial failure.
 try {
  const failed = await db.prepare(`SELECT COUNT(*) AS n FROM event_delivery WHERE last_error_code IS NOT NULL AND status != 'delivered'`).first<number>('n');
  if (failed === null) errors.push('delivery_status_failed'); else if (failed > 0) errors.push('delivery_items_failed');
 } catch { errors.push('delivery_status_failed'); }
 const finished = clock();
 // A newer attempt owns its status/cleanup fields, but every confirmed successful
 // completion contributes to the global success timestamp, including overlapping runs.
 try { await db.prepare(`UPDATE maintenance_control SET
  cron_result = CASE WHEN cron_token = ? THEN ? ELSE cron_result END,
  cron_errors_json = CASE WHEN cron_token = ? THEN ? ELSE cron_errors_json END,
  cron_success_at = CASE WHEN ? = 0 THEN MAX(COALESCE(cron_success_at, 0), ?) ELSE cron_success_at END,
  cleanup_at = CASE WHEN cron_token = ? AND ? IS NOT NULL THEN ? ELSE cleanup_at END,
  cleanup_json = CASE WHEN cron_token = ? THEN COALESCE(?, cleanup_json) ELSE cleanup_json END WHERE singleton_id = 1`)
  .bind(token, errors.length ? 'partial_failure' : 'complete', token, JSON.stringify(errors), errors.length, finished,
   token, clean ? JSON.stringify(clean) : null, finished, token, clean ? JSON.stringify(clean) : null).run(); }
 catch { errors.push('status_write_failed'); }
 return { delivery, hourly, cleanup: clean, errors };
}
