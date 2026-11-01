import { z } from 'zod';
import { getOfferCatalog, type OfferCatalog } from '../offers/catalog';
import { executeCommand, type CommandOutcome } from '../storage/command-executor';
import type { FingerprintKeyring } from '../storage/command-fingerprint';
import type { SqlEffect, SqlPredicate } from '../storage/transaction-guards';
import { stepReady } from './context';
import { normalizeEmail } from '../../shared/email';
import { entryReference, viewReference } from './event-references';
import { buildOfferSelection } from './offer-command';
export { EVENT_TTL_MS } from './event-references';

const uuid = z.string().length(36).regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
// Абсолютний кінець рядка: звичайний $ також збігається перед кінцевим newline.
const base = { operation_id: uuid, preland_id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}(?![\s\S])/) };
const commandSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...base, type: z.literal('entry'), event_id: uuid }),
  z.strictObject({ ...base, type: z.literal('question_view'), event_id: uuid, entry_event_id: uuid,
    question_id: z.enum(['preferred_gender', 'preferred_ethnicity', 'email']) }),
  z.strictObject({ ...base, type: z.literal('answer'), view_event_id: uuid,
    question_id: z.enum(['preferred_gender', 'preferred_ethnicity']), value: z.enum(['women', 'men', 'asia', 'europe', 'latam']) }),
  z.strictObject({ ...base, type: z.literal('email_confirmation'), view_event_id: uuid,
    email: z.string().transform(normalizeEmail).pipe(z.string()) }),
  z.strictObject({ ...base, type: z.literal('offer_selection'), entry_event_id: uuid, completion_operation_id: uuid.optional() }),
]).refine((command) => command.type !== 'answer' || (command.question_id === 'preferred_gender'
  ? ['women', 'men'].includes(command.value) : ['asia', 'europe', 'latam'].includes(command.value)));
export type QuizCommand = z.infer<typeof commandSchema>;
type EventCommand = Exclude<QuizCommand, { type: 'offer_selection' }>;

function references(command: EventCommand, userId: string, now: number): SqlPredicate[] {
  if (command.type === 'entry') return [];
  if (command.type === 'question_view') return [entryReference(command.entry_event_id, userId, command.preland_id, now)];
  return [viewReference(command.view_event_id, userId, command.preland_id,
    command.type === 'email_confirmation' ? 'email' : command.question_id, now)];
}

function eventEffects(db: D1Database, command: EventCommand, userId: string, eventId: string, now: number): SqlEffect[] {
  const type = command.type === 'entry' ? 'funnel_entered' : command.type === 'question_view' ? 'question_viewed' : 'answer_confirmed';
  const question = command.type === 'entry' ? null : command.type === 'email_confirmation' ? 'email' : command.question_id;
  const entry = command.type === 'question_view' ? command.entry_event_id : null;
  const view = command.type === 'answer' || command.type === 'email_confirmation' ? command.view_event_id : null;
  // Незмінний експортний знімок: лише факт підтвердження, без значення відповіді.
  const payload = JSON.stringify({ schema_version: 1, event_id: eventId, event_type: type,
    user_id: userId, preland_id: command.preland_id, occurred_at: now, received_at: now,
    ...(question === null ? {} : { question_id: question }),
    ...(entry === null ? {} : { entry_event_id: entry }), ...(view === null ? {} : { view_event_id: view }) });
  if (new TextEncoder().encode(payload).length > 4096) throw new Error('event_too_large');
  return [
    { statement: db.prepare(`INSERT INTO events (event_id, event_type, user_id, preland_id,
      occurred_at, received_at, question_id, entry_event_id, view_event_id, schema_version, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`).bind(eventId, type, userId, command.preland_id, now, now, question, entry, view, payload), changes: 1 },
    { statement: db.prepare("INSERT INTO event_delivery (event_id, status, next_attempt_at) VALUES (?, 'pending', ?)")
      .bind(eventId, now), changes: 1 },
  ];
}

// Внутрішній сервіс: HTTP додасть body-byte-limit, cookie/Origin та rate limit.
// Клієнтський type визначатиметься маршрутом, userId/hash — довіреним контекстом.
export async function executeQuizCommand(options: {
  db: D1Database; userId: string; secretHash: string; keys: FingerprintKeyring;
  onCommit?: (lastActiveAt: number) => void;
  input: unknown; now: () => number; catalog?: () => Promise<OfferCatalog>;
}): Promise<CommandOutcome | { status: 'rejected'; reason: 'validation' }> {
  const parsed = commandSchema.safeParse(options.input);
  if (!parsed.success || !uuid.safeParse(options.userId).success) return { status: 'rejected', reason: 'validation' };
  const command = parsed.data;
  const { operation_id, type, ...business } = command;
  // Ліниво після replay; одна версія для всіх revision-спроб цього виклику.
  let catalog: Promise<OfferCatalog> | undefined;
  return executeCommand({ db: options.db, secretHash: options.secretHash, keys: options.keys, now: options.now, onCommit: options.onCommit,
    command: { userId: options.userId, operationId: operation_id, operationType: type, business },
    build: async ({ profile, now }) => {
      if (command.type !== 'entry') {
        catalog ??= (options.catalog ?? getOfferCatalog)();
        if (command.type === 'offer_selection') return buildOfferSelection({ db: options.db, command, profile, catalog: await catalog, now });
        if (!stepReady(await catalog, profile, command.type === 'email_confirmation' ? 'email' : command.question_id)) return { rejection: 'step_not_ready' };
      }
      const eventId = command.type === 'answer' || command.type === 'email_confirmation' ? crypto.randomUUID() : command.event_id;
      const effects = eventEffects(options.db, command, options.userId, eventId, now);
      if (command.type === 'answer') {
        // Ім'я колонки походить із закритого enum, ніколи з довільного SQL.
        const column = command.question_id;
        effects.push({ statement: options.db.prepare(`UPDATE users SET ${column} = ?,
          selection_revision = selection_revision + CASE WHEN ${column} IS ? THEN 0 ELSE 1 END
          WHERE user_id = ?`).bind(command.value, command.value, options.userId), changes: 1 });
      }
      if (command.type === 'email_confirmation') {
        effects.push({ statement: options.db.prepare(`UPDATE users SET email = ?, email_confirmed_at = ?,
          selection_revision = selection_revision + CASE WHEN email IS ? AND email_confirmed_at IS ? THEN 0 ELSE 1 END
          WHERE user_id = ?`).bind(command.email, now, command.email, now, options.userId), changes: 1 });
      }
      return { result: { code: 'accepted', event_id: eventId }, effects, growth: { events: 1, undelivered: 1 },
        references: (commitTime) => references(command, options.userId, commitTime) };
    },
  });
}
