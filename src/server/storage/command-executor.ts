import { checkCommandReplay, prepareCommandResult, type CommandResult, type NormalizedCommand, type ReplayLookup } from './command-results';
import type { FingerprintKeyring } from './command-fingerprint';
import { persistCapacityPause, reserveCapacity, readCapacitySnapshot, type Budget, type Growth } from './capacity';
import { GuardedBatch, classifyGuard, type SqlEffect, type SqlPredicate } from './transaction-guards';

const PROFILE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
export interface ProfileSnapshot {
  user_id: string; selection_revision: number;
  preferred_gender: 'women' | 'men' | null;
  preferred_ethnicity: 'asia' | 'europe' | 'latam' | null;
  email: string | null; email_confirmed_at: number | null; last_active_at: number;
}
export interface CommandAttempt {
  result: CommandResult;
  effects: SqlEffect[];
  growth: Pick<Growth, 'events' | 'undelivered'>;
  references?: (now: number) => SqlPredicate[];
}
export type CommandOutcome = Exclude<ReplayLookup, { status: 'not_found' }>
  | { status: 'rejected'; reason: 'access' | 'reference' | 'integrity' | 'capacity' | 'temporary'; budget?: Budget };

function accessPredicate(userId: string, secretHash: string, now: number): SqlPredicate {
  return { sql: `EXISTS (SELECT 1 FROM users WHERE user_id = ? AND access_secret_hash = ?
    AND revoked_at IS NULL AND expired_at IS NULL AND last_active_at > ?)`,
  bindings: [userId, secretHash, now - PROFILE_TTL_MS] };
}
async function activeProfile(db: D1Database, userId: string, secretHash: string, now: number) {
  const access = accessPredicate(userId, secretHash, now);
  return db.prepare(`SELECT user_id, selection_revision, preferred_gender, preferred_ethnicity,
    email, email_confirmed_at, last_active_at FROM users WHERE user_id = ? AND (${access.sql})`)
    .bind(userId, ...access.bindings!).first<ProfileSnapshot>();
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); }
  return value;
}

// Внутрішній executor. Caller валідує/нормалізує команду, отримує hash із cookie,
// фіксує каталог і будує доменні SQL/TTL-предикати; сирий SQL з HTTP заборонено.
export async function executeCommand(options: {
  db: D1Database; command: NormalizedCommand; secretHash: string; keys: FingerprintKeyring;
  now: () => number;
  build: (context: { profile: ProfileSnapshot; command: NormalizedCommand; now: number }) => Promise<CommandAttempt>;
}): Promise<CommandOutcome> {
  const { db, secretHash, keys, build } = options;
  const command = freeze(structuredClone(options.command));
  if (!/^[0-9a-f]{64}$/.test(secretHash)) return { status: 'rejected', reason: 'access' };
  const time = () => {
    const value = options.now();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('storage_invalid_time');
    return value;
  };
  const replay = async (): Promise<ReplayLookup | { status: 'rejected'; reason: 'access' }> => {
    const now = time();
    if (!await activeProfile(db, command.userId, secretHash, now)) return { status: 'rejected', reason: 'access' };
    return checkCommandReplay(db, command, keys, now);
  };
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const previous = await replay();
      if (previous.status !== 'not_found') return previous;
      const now = time();
      const profile = await activeProfile(db, command.userId, secretHash, now);
      if (!profile) return { status: 'rejected', reason: 'access' };
      if (!Number.isSafeInteger(profile.selection_revision) || profile.selection_revision < 0
        || profile.selection_revision >= Number.MAX_SAFE_INTEGER) throw new Error('storage_invalid_revision');
      const plan = await build({ profile, command, now });
      const growth: Growth = { ...plan.growth, command_keys: 1 };
      const capacity = await readCapacitySnapshot(db, growth);
      const result = await prepareCommandResult(db, command, plan.result, keys, now);
      // Час перевірки доступу береться після async побудови; revision не замінює TTL.
      const commitTime = time();
      const batch = new GuardedBatch(db);
      batch.assert('access', accessPredicate(command.userId, secretHash, commitTime));
      batch.assert('revision', { sql: '(SELECT selection_revision FROM users WHERE user_id = ?) = ?',
        bindings: [command.userId, profile.selection_revision] });
      for (const predicate of plan.references?.(commitTime) ?? []) batch.assert('reference', predicate);
      reserveCapacity(batch, growth, capacity);
      for (const effect of plan.effects) batch.effect(effect);
      batch.effect({ statement: db.prepare('UPDATE users SET last_active_at = MAX(last_active_at, ?) WHERE user_id = ?')
        .bind(commitTime, command.userId), changes: 1 });
      batch.effect({ statement: result, changes: 1 });
      try {
        await db.batch(batch.finish());
        return { status: 'found', result: plan.result };
      } catch (error) {
        // Навіть timeout може мати committed winner; це читання, не повтор запису.
        const winner = await replay();
        if (winner.status !== 'not_found') return winner;
        const failure = classifyGuard(error);
        if (failure === 'revision' && command.operationType !== 'entry' && attempt < 2) continue;
        if (failure.startsWith('capacity_')) {
          const budget = failure.slice('capacity_'.length) as Budget;
          await persistCapacityPause(db, budget, capacity[budget]!);
          return { status: 'rejected', reason: 'capacity', budget };
        }
        if (failure === 'access' || failure === 'reference' || failure === 'integrity') return { status: 'rejected', reason: failure };
        return { status: 'rejected', reason: 'temporary' };
      }
    }
  } catch {
    // Відсутній ключ/контрольний рядок/збій D1: жодного сирого SQL або payload.
    return { status: 'rejected', reason: 'temporary' };
  }
  return { status: 'rejected', reason: 'temporary' };
}
