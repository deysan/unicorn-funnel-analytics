import { z } from 'zod';
export const DAY = 86_400_000;
export const reportQuestions = ['preferred_gender', 'preferred_ethnicity', 'email'] as const;
export const reportQuestionLabels = { preferred_gender: 'Вподобання', preferred_ethnicity: 'Регіон', email: 'Email' };
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => {
  const ms = Date.parse(s + 'T00:00:00.000Z');
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === s;
});
export const prelandSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}(?![\s\S])/);
export const offerIdSchema = z.string().regex(/^[0-9]{3}(?![\s\S])/);
export const reportQuerySchema = z.strictObject({ from: dateSchema, to: dateSchema, preland_id: prelandSchema.optional(), offer_id: offerIdSchema.optional() })
  .refine((q) => q.from <= q.to);
export type ReportQuery = z.infer<typeof reportQuerySchema>;
export function parseReportQuery(params: { entries(): IterableIterator<[string, string]> }, now?: number): ReportQuery {
  const entries = [...params.entries()];
  if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error('validation_failed');
  const query = reportQuerySchema.parse(Object.fromEntries(entries));
  if (now !== undefined && query.to > utcDay(now)) throw new Error('validation_failed');
  return query;
}
export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const queryString = (query: ReportQuery) => Object.entries(query).filter(([, value]) => value !== undefined).map(([key, value]) => encodeURIComponent(key) + '=' + encodeURIComponent(value!)).join('&');
export function availableFrom(boundary: number, now: number) {
  if (!Number.isSafeInteger(boundary) || boundary < 0 || boundary % DAY !== 0 || boundary > now) throw new Error('history_metadata_invalid');
  return Math.max(boundary, (Math.floor((now - 90 * DAY + 300_000) / DAY) + 1) * DAY);
}
export const conversionSchema = z.strictObject({ numerator: count, denominator: count }).refine((p) => p.numerator <= p.denominator);
export type Conversion = z.infer<typeof conversionSchema>;
export function formatConversion(value: Conversion) {
  const pair = conversionSchema.parse(value);
  return pair.denominator === 0 ? 'немає даних' : (100 * pair.numerator / pair.denominator).toLocaleString('uk-UA', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';
}
const questions = <T extends z.ZodType>(schema: T) => z.strictObject({ preferred_gender: schema, preferred_ethnicity: schema, email: schema });
export const metricsSchema = z.strictObject({
  quiz: z.strictObject({ activity: z.strictObject({ entered: count, started: count, questions: questions(z.strictObject({ viewed: count, confirmed: count })), completed: count }),
    conversions: z.strictObject({ questions: questions(conversionSchema), started_completed: conversionSchema, started_offer: conversionSchema }) }),
  offers: z.strictObject({ activity: z.strictObject({ transitioned: count, bypass: count, leads: count, buyers: count, purchases: count }),
    conversions: z.strictObject({ transition_lead: conversionSchema, transition_purchase: conversionSchema }) }),
});
export const funnelSchema = z.union([
  z.strictObject({ report_status: z.literal('ready'), updated_at: count, available_from: dateSchema, filters: reportQuerySchema, metrics: metricsSchema }),
  z.strictObject({ report_status: z.literal('unavailable'), reason: z.literal('history_unverified'), updated_at: count, filters: reportQuerySchema }),
  z.strictObject({ report_status: z.literal('unavailable'), reason: z.literal('period_unavailable'), updated_at: count, available_from: dateSchema, filters: reportQuerySchema }),
]);
export type Funnel = z.infer<typeof funnelSchema>;
export const filtersSchema = z.strictObject({ updated_at: count, catalog_version: z.string().regex(/^[a-f0-9]{64}$/),
  prelands: z.array(prelandSchema), offers: z.array(z.strictObject({ id: offerIdSchema, name: z.string().min(1).max(256).optional(), status: z.enum(['active', 'inactive', 'historical']) })) });
export type ReportFilters = z.infer<typeof filtersSchema>;
export const reportStatusSchema = z.strictObject({ updated_at: count,
  receiver_mode: z.enum(['normal', 'unavailable']),
  delivery: z.strictObject({ pending: count, in_flight: count, delivered: count, oldest_age_ms: count.nullable(), delayed: z.boolean(), last_ack_at: count.nullable(), errors: z.array(z.strictObject({ code: z.string().regex(/^[a-z_]+$/), count })) }),
  budgets: z.array(z.strictObject({ key: z.enum(['undelivered', 'events', 'profiles', 'command_keys']), used: count, limit: count, paused: z.boolean(), alert: z.enum(['normal', 'warning', 'critical']) })),
  integrity_paused: z.boolean(), history_unverified: z.boolean(), history_metadata: z.enum(['confirmed', 'missing', 'invalid']),
  pause_reason: z.enum(['integrity', 'capacity']).nullable(),
  cron: z.strictObject({ status: z.enum(['unknown', 'running', 'complete', 'partial_failure']), last_attempt_at: count.nullable(), last_success_at: count.nullable(), stale: z.boolean().nullable(), errors: z.array(z.string().regex(/^[a-z_]+$/)) }),
  cleanup: z.strictObject({ at: count.nullable(), phases: z.record(z.string(), z.strictObject({ changed: count, skipped: count, has_more: z.boolean(), error: z.literal('cleanup_failed').nullable() })).nullable() }),
  reconciliation: z.strictObject({ status: z.enum(['unknown', 'claimed', 'matched', 'mismatch', 'read_failed']), attempt_at: count.nullable(), read_at: count.nullable(), summary: z.record(z.string(), count.nullable()).nullable() }),
});
export type ReportStatus = z.infer<typeof reportStatusSchema>;
