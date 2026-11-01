import { z } from 'zod';

const uuid = z.string().length(36).regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const identifier = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}(?![\s\S])/);
const question = z.enum(['preferred_gender', 'preferred_ethnicity', 'email']);
const common = { schema_version: z.literal(1), event_id: uuid, user_id: uuid, preland_id: identifier,
  occurred_at: z.number().int().nonnegative(), received_at: z.number().int().nonnegative() };
const attribution = { click_id: uuid, offer_id: z.string().regex(/^[0-9]{3}(?![\s\S])/) };
const partner = { ...attribution, partner_id: identifier, partner_event_id: z.string().regex(/^[A-Za-z0-9._:-]{1,128}(?![\s\S])/) };
export const snapshotSchema = z.discriminatedUnion('event_type', [
  z.strictObject({ ...common, event_type: z.literal('funnel_entered') }),
  z.strictObject({ ...common, event_type: z.literal('question_viewed'), question_id: question, entry_event_id: uuid }),
  z.strictObject({ ...common, event_type: z.literal('answer_confirmed'), question_id: question, view_event_id: uuid }),
  z.strictObject({ ...common, ...attribution, event_type: z.literal('offer_transition'), flow_mode: z.enum(['quiz', 'bypass']),
    entry_event_id: uuid, completion_event_id: uuid.optional() }).refine((v) => (v.flow_mode === 'quiz') === (v.completion_event_id !== undefined)),
  z.strictObject({ ...common, ...partner, event_type: z.literal('Lead') }),
  z.strictObject({ ...common, ...partner, event_type: z.literal('Purchase'), amount_minor: z.number().int().min(1).max(1_000_000).optional(),
    currency: z.literal('USD').optional() }).refine((v) => (v.amount_minor === undefined) === (v.currency === undefined)),
]);
export type Snapshot = z.infer<typeof snapshotSchema>;
export type AckStatus = 'accepted' | 'retry' | 'conflict';
export const bytes = (value: string) => new TextEncoder().encode(value).length;
// Схема плоска. Порядок полів/пробіли не впливають на тотожність змісту.
export function normalized(snapshot: Snapshot): string {
  return JSON.stringify(Object.fromEntries(Object.entries(snapshot).sort(([a], [b]) => a.localeCompare(b))));
}
export function readSnapshot(json: string, eventId?: string): Snapshot {
  if (bytes(json) > 4096) throw new Error('invalid_snapshot');
  const snapshot = snapshotSchema.parse(JSON.parse(json));
  if (eventId !== undefined && snapshot.event_id !== eventId) throw new Error('invalid_snapshot');
  return snapshot;
}
export function readPacket(json: string): Snapshot[] {
  if (bytes(json) > 65536) throw new Error('invalid_packet');
  const packet = z.strictObject({ schema_version: z.literal(1), events: z.array(z.unknown()).max(10) }).parse(JSON.parse(json));
  const events = packet.events.map((event) => readSnapshot(JSON.stringify(event)));
  if (new Set(events.map((event) => event.event_id)).size !== events.length) throw new Error('invalid_packet');
  return events;
}
export function readAck(json: string, sentIds: string[]): Map<string, AckStatus> {
  if (bytes(json) > 8192) throw new Error('invalid_ack');
  const ack = z.strictObject({ schema_version: z.literal(1), results: z.array(z.strictObject({
    event_id: uuid, status: z.enum(['accepted', 'retry', 'conflict']),
  })).max(10) }).parse(JSON.parse(json));
  const results = new Map<string, AckStatus>();
  for (const result of ack.results) {
    if (!sentIds.includes(result.event_id) || results.has(result.event_id)) throw new Error('invalid_ack');
    results.set(result.event_id, result.status);
  }
  return results;
}
export function receiverMode(value: unknown): 'normal' | 'unavailable' {
  if (value !== 'normal' && value !== 'unavailable') throw new Error('invalid_receiver_mode');
  return value;
}
