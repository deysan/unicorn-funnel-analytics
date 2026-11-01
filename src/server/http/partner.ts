import { Hono } from 'hono';
import { acceptPartnerEvent } from '../partner/events';
import { partnerIdentity } from '../partner/auth';
import { boundedJson, HttpFailure, ipKey, limit } from './security';
export type PartnerBindings = Pick<Env, 'DB' | 'LOCAL_RUNTIME' | 'PARTNER_IP_LIMITER' | 'PARTNER_ID_LIMITER'>
  & Partial<Pick<Env, 'IP_HMAC_SECRET' | 'PARTNER_TOKENS'>>;
export const partner = new Hono<{ Bindings: PartnerBindings }>();
partner.post('/events', async (c) => {
  c.header('Cache-Control', 'no-store');
  try {
    const budget = { remaining: 1000 };
    await limit(c.env.PARTNER_IP_LIMITER, await ipKey(c.req.raw, c.env), budget);
    if (new URL(c.req.url).protocol !== 'https:') throw new HttpFailure('unauthorized', 401);
    const partnerId = partnerIdentity(c.req.raw, c.env.PARTNER_TOKENS);
    await limit(c.env.PARTNER_ID_LIMITER, partnerId, budget);
    const input = await boundedJson(c.req.raw);
    const result = await acceptPartnerEvent({ db: c.env.DB, partnerId, input, now: Date.now });
    if (result.status === 'accepted') return c.json({ status: 'accepted' } as const);
    switch (result.reason) {
      case 'validation': throw new HttpFailure('validation_failed', 400);
      case 'conflict': throw new HttpFailure('postback_conflict', 409);
      case 'click_unavailable': throw new HttpFailure('click_unavailable', 422);
      case 'capacity': throw new HttpFailure('capacity_exceeded', 503, true);
      default: throw new HttpFailure('temporarily_unavailable', 503, true);
    }
  } catch (error) {
    const e = error instanceof HttpFailure ? error : new HttpFailure('temporarily_unavailable', 503, true);
    if (e.retryAfter) c.header('Retry-After', String(e.retryAfter));
    return c.json({ error: { code: e.code, message: 'Постбек не прийнято. Перевірте запит або повторіть той самий файл.', retryable: e.retryable } }, e.status);
  }
});
