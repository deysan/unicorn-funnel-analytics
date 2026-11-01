import { z } from 'zod';

// RFC3339 subset; validate the calendar before applying the numeric offset.
export function partnerTime(value: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})(?![\s\S])/.exec(value);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second, fraction, zone] = match;
  const [y, mo, d, h, mi, s] = [year, month, day, hour, minute, second].map(Number);
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59 || zone === '-00:00') return undefined;
  const date = new Date(0); date.setUTCFullYear(y, mo - 1, d); date.setUTCHours(h, mi, s, Number((fraction ?? '').padEnd(3, '0')));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return undefined;
  const offsetHour = zone === 'Z' ? 0 : Number(zone.slice(1, 3));
  const offsetMinute = zone === 'Z' ? 0 : Number(zone.slice(4, 6));
  if (offsetHour > 23 || offsetMinute > 59) return undefined;
  const result = date.getTime() - (zone.startsWith('-') ? -1 : 1) * (offsetHour * 60 + offsetMinute) * 60_000;
  return Number.isSafeInteger(result) && result >= 0 ? result : undefined;
}
const time = z.string().transform(partnerTime).pipe(z.number().int().nonnegative());
const common = {
  partner_event_id: z.string().regex(/^[A-Za-z0-9._:-]{1,128}(?![\s\S])/),
  click_id: z.string().length(36).regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i).transform((s) => s.toLowerCase()),
  occurred_at: time,
};
export const partnerEventSchema = z.discriminatedUnion('event_type', [
  z.strictObject({ ...common, event_type: z.literal('Lead') }),
  z.strictObject({ ...common, event_type: z.literal('Purchase'), amount_minor: z.number().int().min(1).max(1_000_000).optional(), currency: z.literal('USD').optional() })
    .refine((value) => (value.amount_minor === undefined) === (value.currency === undefined)),
]);
export type PartnerEventInput = z.input<typeof partnerEventSchema>;
export type PartnerEvent = z.output<typeof partnerEventSchema>;
