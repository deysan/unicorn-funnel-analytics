import { checkCommandReplay, prepareCommandResult, type CommandResult, type NormalizedCommand, type ReplayLookup } from './command-results';
import type { FingerprintKeyring } from './command-fingerprint';
import { persistCapacityPause, reserveCapacity, readCapacitySnapshot, type Budget, type Growth } from './capacity';
import { GuardedBatch, classifyGuard, type SqlEffect, type SqlPredicate } from './transaction-guards';
import { accessPredicate, readActiveProfile, type ProfileSnapshot } from './profile';
export type { ProfileSnapshot } from './profile';

export interface CommandAttempt {
  result: CommandResult;
  effects: SqlEffect[];
  growth: Pick<Growth, 'events' | 'undelivered'>;
  references?: (now: number) => SqlPredicate[];
  selection?: (now: number) => SqlPredicate[];
}
export interface CommandRejection { rejection: 'step_not_ready' | 'selection_not_ready' }
export type CommandOutcome = Exclude<ReplayLookup, { status: 'not_found' }>
  | { status: 'rejected'; reason: 'access' | 'reference' | 'integrity' | 'capacity' | 'temporary' | 'step_not_ready' | 'selection_not_ready'; budget?: Budget };
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); }
  return value;
}

// Внутрішній executor. Caller валідує/нормалізує команду, отримує hash із cookie,
// фіксує каталог і будує доменні SQL/TTL-предикати; сирий SQL з HTTP заборонено.
export async function executeCommand(options: {
  db: D1Database; command: NormalizedCommand; secretHash: string; keys: FingerprintKeyring;
  now: () => number;
  onCommit?: (lastActiveAt: number) => void;
  build: (context: { profile: ProfileSnapshot; command: NormalizedCommand; now: number }) => Promise<CommandAttempt | CommandRejection>;
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
    if (!await readActiveProfile(db, command.userId, secretHash, now)) return { status: 'rejected', reason: 'access' };
    return checkCommandReplay(db, command, keys, now);
  };
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const previous = await replay();
      if (previous.status !== 'not_found') return previous;
      const now = time();
      const profile = await readActiveProfile(db, command.userId, secretHash, now);
      if (!profile) return { status: 'rejected', reason: 'access' };
      if (!Number.isSafeInteger(profile.selection_revision) || profile.selection_revision < 0
        || profile.selection_revision >= Number.MAX_SAFE_INTEGER) throw new Error('storage_invalid_revision');
      const plan = await build({ profile, command, now });
      const rejected = 'rejection' in plan;
      const growth: Growth = rejected ? {} : { ...plan.growth, command_keys: 1 };
      const capacity = rejected ? {} : await readCapacitySnapshot(db, growth);
      const result = rejected ? null : await prepareCommandResult(db, command, plan.result, keys, now);
      // Час перевірки доступу береться після async побудови; revision не замінює TTL.
      const commitTime = time();
      const batch = new GuardedBatch(db);
      batch.assert('access', accessPredicate(command.userId, secretHash, commitTime));
      batch.assert('revision', { sql: '(SELECT selection_revision FROM users WHERE user_id = ?) = ?',
        bindings: [command.userId, profile.selection_revision] });
      if (!rejected) {
        for (const predicate of plan.references?.(commitTime) ?? []) batch.assert('reference', predicate);
        for (const predicate of plan.selection?.(commitTime) ?? []) batch.assert('selection', predicate);
        reserveCapacity(batch, growth, capacity);
        for (const effect of plan.effects) batch.effect(effect);
        batch.effect({ statement: db.prepare('UPDATE users SET last_active_at = MAX(last_active_at, ?) WHERE user_id = ? RETURNING last_active_at AS committed_last_active_at')
          .bind(commitTime, command.userId), changes: 1 });
        batch.effect({ statement: result!, changes: 1 });
      }
      try {
        const committed = await db.batch<{ committed_last_active_at: number }>(batch.finish());
        if (rejected) {
          // Конкурентний виконавець міг уже прийняти цей ключ.
          const winner = await replay();
          return winner.status === 'not_found' ? { status: 'rejected', reason: plan.rejection } : winner;
        }
        const activity = committed.flatMap((item) => item.results).find((row) => Number.isSafeInteger(row.committed_last_active_at))?.committed_last_active_at;
        if (activity !== undefined) options.onCommit?.(activity);
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
        if (failure === 'selection') return { status: 'rejected', reason: 'selection_not_ready' };
        return { status: 'rejected', reason: 'temporary' };
      }
    }
  } catch {
    // Відсутній ключ/контрольний рядок/збій D1: жодного сирого SQL або payload.
    return { status: 'rejected', reason: 'temporary' };
  }
  return { status: 'rejected', reason: 'temporary' };
}
