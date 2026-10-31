import { GuardedBatch } from './transaction-guards';

export const BUDGETS = {
  undelivered: { limit: 1000, resumeBelow: 800 },
  events: { limit: 10000, resumeBelow: 8000 },
  profiles: { limit: 1000, resumeBelow: 800 },
  command_keys: { limit: 20000, resumeBelow: 16000 },
} as const;
export type Budget = keyof typeof BUDGETS;
export type Growth = Partial<Record<Budget, number>>;
export type CapacitySnapshot = Partial<Record<Budget, number>>;
const budgetKeys = Object.keys(BUDGETS) as Budget[];

function needed(growth: Growth): Budget[] {
  for (const [key, amount] of Object.entries(growth)) {
    if (!Object.hasOwn(BUDGETS, key) || !Number.isSafeInteger(amount) || amount < 0
      || amount > BUDGETS[key as Budget].limit) throw new Error('storage_invalid_growth');
  }
  return budgetKeys.filter((key) => (growth[key] ?? 0) > 0);
}

function validControl(key: Budget) {
  return { sql: `EXISTS (SELECT 1 FROM capacity_control WHERE budget_key = ?
    AND used_count BETWEEN 0 AND ? AND capacity_paused IN (0, 1)
    AND capacity_epoch BETWEEN 0 AND ?)`, bindings: [key, BUDGETS[key].limit, Number.MAX_SAFE_INTEGER - 1] };
}

export function addIntegrityGuard(batch: GuardedBatch) {
  batch.assert('control', { sql: 'EXISTS (SELECT 1 FROM system_control WHERE singleton_id = 1 AND integrity_paused IN (0, 1))' });
  batch.assert('integrity', { sql: '(SELECT integrity_paused FROM system_control WHERE singleton_id = 1) = 0' });
}

export async function readCapacitySnapshot(db: D1Database, growth: Growth): Promise<CapacitySnapshot> {
  const keys = needed(growth);
  if (!keys.length) return {};
  const rows = (await db.prepare(`SELECT budget_key, used_count, capacity_paused, capacity_epoch
    FROM capacity_control WHERE budget_key IN (${keys.map(() => '?').join(',')})`).bind(...keys)
    .all<{ budget_key: Budget; used_count: number; capacity_paused: number; capacity_epoch: number }>()).results;
  const snapshot: CapacitySnapshot = {};
  for (const key of keys) {
    const row = rows.find((item) => item.budget_key === key);
    if (!row || !Number.isSafeInteger(row.used_count) || row.used_count < 0 || row.used_count > BUDGETS[key].limit
      || ![0, 1].includes(row.capacity_paused) || !Number.isSafeInteger(row.capacity_epoch)
      || row.capacity_epoch < 0 || row.capacity_epoch >= Number.MAX_SAFE_INTEGER) throw new Error('storage_control_unavailable');
    snapshot[key] = row.capacity_epoch;
  }
  return snapshot;
}

// Всі epoch перед будь-якою відмовою місткості. Застосувати разом з ефектами.
export function reserveCapacity(batch: GuardedBatch, growth: Growth, snapshot: CapacitySnapshot) {
  const keys = needed(growth);
  addIntegrityGuard(batch);
  for (const key of keys) {
    if (!Number.isSafeInteger(snapshot[key]) || snapshot[key]! < 0) throw new Error('storage_invalid_epoch');
    batch.assert('control', validControl(key));
  }
  for (const key of keys) batch.assert('epoch', {
    sql: '(SELECT capacity_epoch FROM capacity_control WHERE budget_key = ?) = ?', bindings: [key, snapshot[key]!],
  });
  for (const key of keys) batch.assert(`capacity_${key}`, {
    sql: 'EXISTS (SELECT 1 FROM capacity_control WHERE budget_key = ? AND capacity_paused = 0 AND used_count + ? <= ?)',
    bindings: [key, growth[key]!, BUDGETS[key].limit],
  });
  for (const key of keys) batch.effect({ changes: 1, statement: batch.db.prepare(`UPDATE capacity_control
    SET used_count = used_count + ?, capacity_paused = CASE WHEN used_count + ? = ? THEN 1 ELSE capacity_paused END
    WHERE budget_key = ?`).bind(growth[key]!, growth[key]!, BUDGETS[key].limit, key) });
}

// Окрема транзакція тільки після відомого guard_capacity та читання повтору.
// Не змінює integrity_paused; старий epoch або відновлений count — no-op.
export async function persistCapacityPause(db: D1Database, key: Budget, epoch: number) {
  if (!Object.hasOwn(BUDGETS, key) || !Number.isSafeInteger(epoch) || epoch < 0) throw new Error('storage_invalid_epoch');
  const batch = new GuardedBatch(db);
  batch.assert('control', validControl(key));
  // 0 або 1 рядок допустимі: старий epoch повинен бути no-op.
  const update = db.prepare(`UPDATE capacity_control SET capacity_paused = 1
    WHERE budget_key = ? AND capacity_epoch = ? AND used_count >= ?`).bind(key, epoch, BUDGETS[key].resumeBelow);
  await db.batch([...batch.finish(), update]);
}

// Caller додає фактичний ACK/delete з перевіркою changes() у цей самий batch.
// Цей helper не є очищенням, звіркою або автоматичним виправленням count.
export function releaseCapacity(batch: GuardedBatch, key: Budget, amount: number) {
  if (!Object.hasOwn(BUDGETS, key) || !Number.isSafeInteger(amount) || amount <= 0 || amount > BUDGETS[key].limit) {
    throw new Error('storage_invalid_release');
  }
  const threshold = BUDGETS[key].resumeBelow;
  addIntegrityGuard(batch);
  batch.assert('control', validControl(key));
  batch.assert('effects', { sql: '(SELECT used_count FROM capacity_control WHERE budget_key = ?) >= ?', bindings: [key, amount] });
  batch.effect({ changes: 1, statement: batch.db.prepare(`UPDATE capacity_control SET
    capacity_epoch = capacity_epoch + CASE WHEN used_count >= ? AND used_count - ? < ? THEN 1 ELSE 0 END,
    capacity_paused = CASE WHEN used_count - ? < ? THEN 0 ELSE capacity_paused END,
    used_count = used_count - ? WHERE budget_key = ?`).bind(threshold, amount, threshold, amount, threshold, amount, key) });
}
