import { z } from 'zod';
import { normalizeEmail } from '../shared/email';
import { uuidSchema } from '../shared/quiz';
const uuid = uuidSchema;
export const draftSchema = z.strictObject({
  version: z.literal(1), user: uuid, preland: z.literal('demo'), deadline: z.number().int().nonnegative(),
  phase: z.enum(['a', 'b', 'done', 'expired']), entry: uuid, b: uuid, a: uuid.optional(), view: uuid.optional(), email: z.string().optional(),
}).refine((d) => d.a !== d.b && (d.phase === 'a'
  ? Boolean(d.a && d.view && d.email && normalizeEmail(d.email) === d.email)
  : d.email === undefined && d.view === undefined));
export type Draft = z.infer<typeof draftSchema>;
export const draftKey = 'unicorn.final.v1';
export function readDraft(): Draft | null {
  const raw = sessionStorage.getItem(draftKey); if (raw === null) return null;
  const result = draftSchema.safeParse(JSON.parse(raw)); if (!result.success) throw new Error('draft_invalid'); return result.data;
}
export function writeDraft(draft: Draft) { sessionStorage.setItem(draftKey, JSON.stringify(draftSchema.parse(draft))); }
export function clearDraft() { sessionStorage.removeItem(draftKey); }
export function expireDraft(draft: Draft, now: number): Draft {
  return now < draft.deadline ? draft : { ...draft, phase: 'expired', email: undefined, view: undefined };
}
