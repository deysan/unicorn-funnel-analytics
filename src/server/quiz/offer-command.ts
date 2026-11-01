import { buildOfferUrl, type OfferCatalog } from '../offers/catalog';
import { returningUserAction, selectOffer } from '../offers/selection';
import type { CommandAttempt, CommandRejection, ProfileSnapshot } from '../storage/command-executor';
import { COMMAND_RESULT_TTL_MS } from '../storage/command-results';
import type { SqlPredicate } from '../storage/transaction-guards';
import { selectionState } from './context';
import { entryReference } from './event-references';
import type { QuizCommand } from './commands';

type SelectionCommand = Extract<QuizCommand, { type: 'offer_selection' }>;
// Конкретна A, не остання A профілю. JSON/result та подія незмінні;
// очищення або сплив TTL додатково перевіряються всередині batch.
function completionQuery(operationId: string, userId: string, prelandId: string, now: number): SqlPredicate {
  return { sql: `SELECT e.event_id FROM request_results AS r JOIN events AS e
    ON e.event_id = json_extract(r.result_json, '$.event_id')
    WHERE r.user_id = ? AND r.operation_id = ? AND r.operation_type = 'email_confirmation'
    AND r.expired = 0 AND r.created_at > ? AND json_extract(r.result_json, '$.code') = 'accepted'
    AND e.event_type = 'answer_confirmed' AND e.question_id = 'email'
    AND e.user_id = r.user_id AND e.preland_id = ?`,
  bindings: [userId, operationId, now - COMMAND_RESULT_TTL_MS, prelandId] };
}

export async function buildOfferSelection(options: {
  db: D1Database; command: SelectionCommand; profile: ProfileSnapshot; catalog: OfferCatalog; now: number;
}): Promise<CommandAttempt | CommandRejection> {
  const { db, command, profile, catalog, now } = options;
  const userId = profile.user_id;
  const state = selectionState(profile);
  let completionId: string | null = null;
  if (command.completion_operation_id !== undefined) {
    const query = completionQuery(command.completion_operation_id, userId, command.preland_id, now);
    const completion = await db.prepare(query.sql).bind(...query.bindings!).first<{ event_id: string }>();
    if (!completion) return { rejection: 'selection_not_ready' };
    completionId = completion.event_id;
  } else if (returningUserAction(catalog, state) !== 'select_offer') return { rejection: 'selection_not_ready' };
  const selection = selectOffer(catalog, state);
  if (selection.status === 'needs_quiz') return { rejection: 'selection_not_ready' };
  const checks = {
    references: (time: number) => [entryReference(command.entry_event_id, userId, command.preland_id, time)],
    selection: (time: number): SqlPredicate[] => {
      if (command.completion_operation_id === undefined) return []; // bypass захищений revision.
      const query = completionQuery(command.completion_operation_id, userId, command.preland_id, time);
      return [{ sql: `EXISTS (${query.sql} AND e.event_id = ?)`, bindings: [...query.bindings!, completionId] }];
    },
  };
  if (selection.status !== 'selected') return {
    result: { code: 'no_offer', catalog_version: catalog.version }, effects: [], growth: {}, ...checks,
  };
  const offer = selection.offer;
  const clickId = crypto.randomUUID(); const eventId = crypto.randomUUID();
  const url = buildOfferUrl(offer, clickId);
  const mode = completionId === null ? 'bypass' : 'quiz';
  const payload = JSON.stringify({ schema_version: 1, event_id: eventId, event_type: 'offer_transition',
    user_id: userId, preland_id: command.preland_id, occurred_at: now, received_at: now,
    click_id: clickId, offer_id: offer.id, flow_mode: mode, entry_event_id: command.entry_event_id,
    ...(completionId === null ? {} : { completion_event_id: completionId }) });
  if (new TextEncoder().encode(payload).length > 4096) throw new Error('event_too_large');
  return { result: { code: 'offer_selected', event_id: eventId, click_id: clickId, catalog_version: catalog.version,
    offer_id: offer.id, offer_name: offer.name, target_url: url }, growth: { events: 1, undelivered: 1 }, ...checks,
  effects: [
    { statement: db.prepare(`INSERT INTO clicks (click_id, user_id, offer_id, partner_id, preland_id,
      created_at, offer_name_snapshot, target_url_snapshot, catalog_version, flow_mode, entry_event_id, completion_event_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(clickId, userId, offer.id, offer.partner_id, command.preland_id,
        now, offer.name, url, catalog.version, mode, command.entry_event_id, completionId), changes: 1 },
    { statement: db.prepare(`INSERT INTO events (event_id, event_type, user_id, preland_id, occurred_at, received_at,
      click_id, offer_id, flow_mode, entry_event_id, completion_event_id, schema_version, payload_json)
      VALUES (?, 'offer_transition', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`).bind(eventId, userId, command.preland_id,
        now, now, clickId, offer.id, mode, command.entry_event_id, completionId, payload), changes: 1 },
    { statement: db.prepare("INSERT INTO event_delivery (event_id, status, next_attempt_at) VALUES (?, 'pending', ?)")
      .bind(eventId, now), changes: 1 },
  ] };
}
