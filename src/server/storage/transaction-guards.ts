const constraints = {
  revision: 'revision_ok', access: 'access_ok', reference: 'reference_ok', effects: 'effects_ok', selection: 'selection_ok',
  control: 'control_ok', integrity: 'integrity_ok', epoch: 'epoch_ok',
  capacity_undelivered: 'undelivered_ok', capacity_events: 'events_ok',
  capacity_profiles: 'profiles_ok', capacity_command_keys: 'command_keys_ok',
} as const;
export type GuardFailure = keyof typeof constraints;
export interface SqlPredicate { sql: string; bindings?: (string | number | null)[] }
export interface SqlEffect { statement: D1PreparedStatement; changes: number }

// SQL і назви надходять тільки з коду сервера, ніколи з HTTP payload.
// Один DELETE наприкінці зменшує число D1 statements; guard-рядки не
// переживають commit і не видаляють перевірки іншого batch.
export class GuardedBatch {
  private readonly statements: D1PreparedStatement[] = [];
  private readonly ids: string[] = [];
  constructor(readonly db: D1Database) {}

  assert(guard: GuardFailure, predicate: SqlPredicate) {
    const id = crypto.randomUUID();
    this.ids.push(id);
    this.statements.push(this.db.prepare(`INSERT INTO transaction_assertions (assertion_id, ${constraints[guard]})
      VALUES (?, CASE WHEN (${predicate.sql}) THEN 1 ELSE 0 END)`).bind(id, ...(predicate.bindings ?? [])));
  }

  effect(effect: SqlEffect) {
    if (!Number.isSafeInteger(effect.changes) || effect.changes < 0) throw new Error('storage_invalid_effect');
    this.statements.push(effect.statement);
    this.assert('effects', { sql: 'changes() = ?', bindings: [effect.changes] });
  }

  finish(): D1PreparedStatement[] {
    if (!this.ids.length) throw new Error('storage_empty_batch');
    return [...this.statements, this.db.prepare(`DELETE FROM transaction_assertions WHERE assertion_id IN
      (${this.ids.map(() => '?').join(',')})`).bind(...this.ids)];
  }
}

// Вузький формат перевірено на workerd. Невідомий формат лишається unknown,
// не шукаємо назву guard довільним substring у тексті/причині помилки.
export function classifyGuard(error: unknown): GuardFailure | 'unknown' {
  if (!(error instanceof Error)) return 'unknown';
  const match = /^(?:D1_ERROR: )?CHECK constraint failed: guard_([a-z_]+)(?:: SQLITE_CONSTRAINT(?: \(extended: SQLITE_CONSTRAINT_CHECK\))?)?$/.exec(error.message);
  return match && Object.hasOwn(constraints, match[1]) ? match[1] as GuardFailure : 'unknown';
}
