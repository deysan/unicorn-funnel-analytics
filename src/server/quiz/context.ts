import { getOfferCatalog, validPreferences, type OfferCatalog } from '../offers/catalog';
import { returningUserAction, type SelectionState } from '../offers/selection';
import { readActiveProfile, type ProfileSnapshot } from '../storage/profile';

export const EMAIL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export type QuestionId = 'preferred_gender' | 'preferred_ethnicity' | 'email';
export function selectionState(profile: ProfileSnapshot): SelectionState {
  return { preferredGender: profile.preferred_gender, preferredEthnicity: profile.preferred_ethnicity, leads: profile.leads };
}
export function stepReady(catalog: OfferCatalog, profile: ProfileSnapshot, question: QuestionId): boolean {
  if (returningUserAction(catalog, selectionState(profile)) !== 'quiz') return false;
  if (question === 'preferred_gender') return true;
  if (question === 'preferred_ethnicity') return profile.preferred_gender === 'women' || profile.preferred_gender === 'men';
  return validPreferences(profile.preferred_gender, profile.preferred_ethnicity) !== null;
}

// Внутрішнє читання після отримання cookie-секрету; missing розрізнятиме HTTP-шар.
// Відмова D1 має поширитись як технічна помилка, а не як відсутній профіль.
export async function readQuizContext(options: {
  db: D1Database; userId: string; secretHash: string; now: number;
  catalog?: () => Promise<OfferCatalog>;
}) {
  const profile = await readActiveProfile(options.db, options.userId, options.secretHash, options.now);
  if (!profile) return { status: 'invalid' } as const;
  const catalog = await (options.catalog ?? getOfferCatalog)();
  const answers: { preferred_gender?: 'women' | 'men'; preferred_ethnicity?: 'asia' | 'europe' | 'latam' } = {};
  if (profile.preferred_gender === 'women' || profile.preferred_gender === 'men') answers.preferred_gender = profile.preferred_gender;
  if (['asia', 'europe', 'latam'].includes(profile.preferred_ethnicity ?? '')) answers.preferred_ethnicity = profile.preferred_ethnicity!;
  const email = profile.email !== null && profile.email_confirmed_at !== null
    && options.now < profile.email_confirmed_at + EMAIL_TTL_MS ? { email: profile.email } : {};
  return { status: 'ready', user_id: profile.user_id, server_time: options.now, answers, ...email,
    next_action: returningUserAction(catalog, selectionState(profile)) } as const;
}
