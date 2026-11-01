import { z } from 'zod';
export const uuidSchema = z.string().length(36).regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i).transform((s) => s.toLowerCase());
export type Question = 'preferred_gender' | 'preferred_ethnicity' | 'email';
export interface ReadyContext {
  identity_status: 'ready'; user_id: string; server_time: number;
  answers: { preferred_gender?: 'women' | 'men'; preferred_ethnicity?: 'asia' | 'europe' | 'latam' };
  email?: string; next_action: 'quiz' | 'select_offer';
}
export type QuizContext = ReadyContext | { identity_status: 'missing' | 'invalid'; server_time: number };
export type QuizResult = { code: 'accepted'; event_id: string } | { code: 'no_offer'; catalog_version: string }
  | { code: 'offer_selected'; event_id: string; click_id: string; catalog_version: string; offer_id: string; offer_name: string; target_url: string };
export const apiErrorSchema = z.object({ error: z.object({ code: z.string().min(1), message: z.string().min(1), retryable: z.boolean() }) });
export type ApiError = z.infer<typeof apiErrorSchema>;
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const contextSchema = z.discriminatedUnion('identity_status', [
  z.strictObject({ identity_status: z.literal('ready'), user_id: uuidSchema, server_time: time,
    answers: z.strictObject({ preferred_gender: z.enum(['women','men']).optional(), preferred_ethnicity: z.enum(['asia','europe','latam']).optional() }),
    email: z.string().optional(), next_action: z.enum(['quiz','select_offer']) }),
  z.strictObject({ identity_status: z.literal('missing'), server_time: time }),
  z.strictObject({ identity_status: z.literal('invalid'), server_time: time }),
]);
const hash = z.string().length(64).regex(/^[0-9a-f]+$/);
export const quizResultSchema = z.discriminatedUnion('code', [
  z.strictObject({ code: z.literal('accepted'), event_id: uuidSchema }),
  z.strictObject({ code: z.literal('no_offer'), catalog_version: hash }),
  z.strictObject({ code: z.literal('offer_selected'), event_id: uuidSchema, click_id: uuidSchema, catalog_version: hash,
    offer_id: z.string().length(3).regex(/^\d{3}$/), offer_name: z.string().min(1).max(256), target_url: z.string().max(2048) }),
]);
export const identityResponseSchema = z.strictObject({ user_id: uuidSchema });
