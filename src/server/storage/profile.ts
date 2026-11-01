import { z } from 'zod';
import type { Lead } from '../offers/selection';
import type { SqlPredicate } from './transaction-guards';

export const PROFILE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
export interface ProfileSnapshot {
  user_id: string; selection_revision: number;
  preferred_gender: 'women' | 'men' | null;
  preferred_ethnicity: 'asia' | 'europe' | 'latam' | null;
  email: string | null; email_confirmed_at: number | null; last_active_at: number;
  leads: readonly Lead[];
}
export function accessPredicate(userId: string, secretHash: string, now: number): SqlPredicate {
  return { sql: `EXISTS (SELECT 1 FROM users WHERE user_id = ? AND access_secret_hash = ?
    AND revoked_at IS NULL AND expired_at IS NULL AND last_active_at > ?)`,
  bindings: [userId, secretHash, now - PROFILE_TTL_MS] };
}
const leadsSchema = z.array(z.strictObject({
  offerId: z.string().regex(/^[0-9]{3}$/), registeredAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}));

// Один SQL-знімок: зміна Lead між читаннями не може дати змішаний контекст.
// Секрет — уже SHA-256 з довіреного серверного шару, UserID сам не авторизує.
export async function readActiveProfile(db: D1Database, userId: string, secretHash: string, now: number): Promise<ProfileSnapshot | null> {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('storage_invalid_time');
  if (!/^[0-9a-f]{64}$/.test(secretHash)) return null;
  const access = accessPredicate(userId, secretHash, now);
  const row = await db.prepare(`SELECT user_id, selection_revision, preferred_gender, preferred_ethnicity,
    email, email_confirmed_at, last_active_at,
    (SELECT json_group_array(json_object('offerId', offer_id, 'registeredAt', latest_lead_at))
      FROM user_offer_leads WHERE user_id = users.user_id) AS leads_json
    FROM users WHERE user_id = ? AND (${access.sql})`)
    .bind(userId, ...access.bindings!).first<Omit<ProfileSnapshot, 'leads'> & { leads_json: string }>();
  if (!row) return null;
  const { leads_json, ...profile } = row;
  const parsed = leadsSchema.safeParse(JSON.parse(leads_json));
  if (!parsed.success) throw new Error('storage_invalid_leads');
  return { ...profile, leads: parsed.data };
}
