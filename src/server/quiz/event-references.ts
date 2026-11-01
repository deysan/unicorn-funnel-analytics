import type { SqlPredicate } from '../storage/transaction-guards';

export const EVENT_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export function entryReference(eventId: string, userId: string, prelandId: string, now: number): SqlPredicate {
  return { sql: `EXISTS (SELECT 1 FROM events WHERE event_id = ?
    AND event_type = 'funnel_entered' AND user_id = ? AND preland_id = ? AND received_at > ?)`,
  bindings: [eventId, userId, prelandId, now - EVENT_TTL_MS] };
}
export function viewReference(eventId: string, userId: string, prelandId: string, questionId: string, now: number): SqlPredicate {
  return { sql: `EXISTS (SELECT 1 FROM events AS view JOIN events AS entry ON entry.event_id = view.entry_event_id
    WHERE view.event_id = ? AND view.event_type = 'question_viewed' AND view.user_id = ?
    AND view.preland_id = ? AND view.question_id = ? AND view.received_at > ?
    AND entry.event_type = 'funnel_entered' AND entry.user_id = view.user_id
    AND entry.preland_id = view.preland_id AND entry.received_at > ?)`,
  bindings: [eventId, userId, prelandId, questionId, now - EVENT_TTL_MS, now - EVENT_TTL_MS] };
}
