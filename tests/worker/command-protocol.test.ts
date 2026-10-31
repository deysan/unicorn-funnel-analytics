import { beforeAll, beforeEach, expect, it } from 'vitest';
import { executeCommand, type CommandAttempt } from '../../src/server/storage/command-executor';
import { BUDGETS, persistCapacityPause, readCapacitySnapshot, releaseCapacity, reserveCapacity, type Budget, type Growth } from '../../src/server/storage/capacity';
import { GuardedBatch, classifyGuard } from '../../src/server/storage/transaction-guards';
import { importFingerprintKey, type FingerprintKeyring } from '../../src/server/storage/command-fingerprint';
import { COMMAND_RESULT_TTL_MS, type NormalizedCommand } from '../../src/server/storage/command-results';
import { catalogVersion, db, eventStatement, freshBusinessDb, id, now, userId, userStatement } from './helpers/business-db';

let keys: FingerprintKeyring;
const secretHash = userId.replaceAll('-', '').padEnd(64, '0');
const command: NormalizedCommand = { userId, operationId: id(2), operationType: 'entry', business: { preland_id: 'demo' } };
const select: NormalizedCommand = { ...command, operationType: 'offer_selection' };
const noOffer = { code: 'no_offer', catalog_version: catalogVersion } as const;
const entry = (event = id(10)): CommandAttempt => ({ result: { code: 'accepted', event_id: event }, growth: { events: 1, undelivered: 1 }, effects: [
  { statement: eventStatement(event), changes: 1 },
  { statement: db.prepare("INSERT INTO event_delivery (event_id, status, next_attempt_at) VALUES (?, 'pending', ?)").bind(event, now), changes: 1 },
] });
const selection = (): CommandAttempt => ({ result: noOffer, growth: {}, effects: [] });
function run(overrides: Partial<Parameters<typeof executeCommand>[0]> = {}) {
  return executeCommand({ db, command, secretHash, keys, now: () => now, build: async () => entry(), ...overrides });
}
// Керований збій/конкурентний commit перед реальним D1 batch; решта binding справжня.
function interceptBatch(intercept: (statements: D1PreparedStatement[]) => Promise<D1Result[]>) {
  return new Proxy(db, { get(target, property) {
    if (property === 'batch') return intercept;
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
async function counts() {
  return (await db.prepare('SELECT budget_key, used_count, capacity_paused, capacity_epoch FROM capacity_control ORDER BY budget_key').all()).results;
}
async function budget(key: Budget) {
  return db.prepare('SELECT used_count, capacity_paused, capacity_epoch FROM capacity_control WHERE budget_key = ?').bind(key)
    .first<{ used_count: number; capacity_paused: number; capacity_epoch: number }>();
}
async function seedBudget(key: Budget, used: number, paused = 0, epoch = 0) {
  await db.prepare('UPDATE capacity_control SET used_count = ?, capacity_paused = ?, capacity_epoch = ? WHERE budget_key = ?')
    .bind(used, paused, epoch, key).run();
}
async function reserve(growth: Growth) {
  const batch = new GuardedBatch(db); reserveCapacity(batch, growth, await readCapacitySnapshot(db, growth));
  await db.batch(batch.finish());
}
async function release(key: Budget, amount: number) {
  const batch = new GuardedBatch(db); releaseCapacity(batch, key, amount); await db.batch(batch.finish());
}
beforeAll(async () => { keys = { currentVersion: 'v1', keys: new Map([['v1', await importFingerprintKey(new Uint8Array(32).fill(1))]]) }; });
beforeEach(async () => { await freshBusinessDb(); await userStatement().run(); await seedBudget('profiles', 1); });

it('фіксує подію, доставку, результат і три бюджети разом; replay не змінює стан', async () => {
  const result = await run({ now: () => now + 1 });
  expect(result).toEqual({ status: 'found', result: { code: 'accepted', event_id: id(10) } });
  const saved = await counts();
  await db.prepare('UPDATE system_control SET integrity_paused = 1, history_unverified = 1').run();
  await db.prepare('UPDATE capacity_control SET capacity_paused = 1').run();
  expect(await run({ now: () => now + 2, build: async () => { throw new Error('must not build replay'); } })).toEqual(result);
  expect((await counts()).map((row) => row.used_count)).toEqual(saved.map((row) => row.used_count));
  expect(await db.prepare('SELECT last_active_at FROM users').first('last_active_at')).toBe(now + 1);
  expect(await db.prepare('SELECT selection_revision FROM users').first('selection_revision')).toBe(0);
  expect(await db.prepare('SELECT COUNT(*) AS n FROM transaction_assertions').first('n')).toBe(0);
});

it('no_offer витрачає лише ключ; інші paused-бюджети з нульовим приростом не заважають', async () => {
  await db.prepare("UPDATE capacity_control SET capacity_paused = 1 WHERE budget_key != 'command_keys'").run();
  expect(await run({ command: select, build: async () => selection() })).toEqual({ status: 'found', result: noOffer });
  expect(await budget('command_keys')).toMatchObject({ used_count: 1 });
  expect(await budget('events')).toMatchObject({ used_count: 0 });
});

it('два одночасні ключі-команди залишають лише одного переможця та повертають його результат', async () => {
  let arrive = 0; let releaseBoth!: () => void;
  const gate = new Promise<void>((resolve) => { releaseBoth = resolve; });
  const build = (event: string) => async () => { if (++arrive === 2) releaseBoth(); await gate; return entry(event); };
  const outcomes = await Promise.all([run({ build: build(id(10)) }), run({ build: build(id(11)) })]);
  expect(outcomes[0]).toEqual(outcomes[1]); expect(outcomes[0].status).toBe('found');
  expect(await budget('events')).toMatchObject({ used_count: 1 });
  expect(await budget('command_keys')).toMatchObject({ used_count: 1 });
  expect(await db.prepare('SELECT COUNT(*) AS n FROM events').first('n')).toBe(1);
});

it('доведений revision-конфлікт перечитує стан із тим самим payload і завершується третьою спробою', async () => {
  let writes = 0; const revisions: number[] = []; const payloads: string[] = [];
  const proxy = interceptBatch(async (statements) => {
    if (++writes < 3) await db.prepare('UPDATE users SET selection_revision = selection_revision + 1').run();
    return db.batch(statements);
  });
  expect(await run({ db: proxy, command: select, build: async ({ profile, command: input }) => {
    revisions.push(profile.selection_revision); payloads.push(JSON.stringify(input)); return selection();
  } })).toEqual({ status: 'found', result: noOffer });
  expect(writes).toBe(3); expect(revisions).toEqual([0, 1, 2]); expect(new Set(payloads).size).toBe(1);
  expect(await budget('command_keys')).toMatchObject({ used_count: 1 });
});

it('після третього revision-конфлікту зупиняється без результату та резервів', async () => {
  let writes = 0;
  const proxy = interceptBatch(async (statements) => {
    writes++; await db.prepare('UPDATE users SET selection_revision = selection_revision + 1').run(); return db.batch(statements);
  });
  expect(await run({ db: proxy, command: select, build: async () => selection() })).toEqual({ status: 'rejected', reason: 'temporary' });
  expect(writes).toBe(3); expect(await budget('command_keys')).toMatchObject({ used_count: 0 });
  expect(await db.prepare('SELECT COUNT(*) AS n FROM request_results').first('n')).toBe(0);
});

it('після третьої відмови знаходить конкурентний результат', async () => {
  let writes = 0;
  const proxy = interceptBatch(async (statements) => {
    writes++; await db.prepare('UPDATE users SET selection_revision = selection_revision + 1').run();
    try { return await db.batch(statements); } catch (error) {
      if (writes === 3) await run({ command: select, build: async () => selection() });
      throw error;
    }
  });
  expect(await run({ db: proxy, command: select, build: async () => selection() })).toEqual({ status: 'found', result: noOffer });
  expect(writes).toBe(3); expect(await budget('command_keys')).toMatchObject({ used_count: 1 });
});

it.each([false, true])('невідомий результат не повторює запис; committed=%s', async (committed) => {
  let writes = 0;
  const proxy = interceptBatch(async (statements) => { writes++; if (committed) await db.batch(statements); throw new Error('network unavailable'); });
  expect(await run({ db: proxy })).toEqual(committed ? { status: 'found', result: { code: 'accepted', event_id: id(10) } }
    : { status: 'rejected', reason: 'temporary' });
  expect(writes).toBe(1);
  expect(await budget('events')).toMatchObject({ used_count: committed ? 1 : 0, capacity_paused: 0 });
});

it('конфлікт payload і expired-ключ не запускають builder або паузу', async () => {
  await run();
  const build = async () => { throw new Error('must not build'); };
  expect(await run({ command: { ...command, business: { preland_id: 'other' } }, build })).toEqual({ status: 'conflict' });
  expect(await run({ now: () => now + COMMAND_RESULT_TTL_MS, build })).toEqual({ status: 'expired' });
  expect(await budget('events')).toMatchObject({ used_count: 1, capacity_paused: 0 });
});

it.each(['revoked', 'hash', 'ttl'] as const)('готовий replay недоступний після втрати доступу: %s', async (kind) => {
  expect((await run()).status).toBe('found');
  const savedCounts = await counts();
  const savedResult = await db.prepare('SELECT * FROM request_results').first();
  if (kind === 'revoked') await db.prepare('UPDATE users SET revoked_at = ?').bind(now).run();
  if (kind === 'hash') await db.prepare('UPDATE users SET access_secret_hash = ?').bind('f'.repeat(64)).run();
  let builds = 0;
  expect(await run({ now: () => kind === 'ttl' ? now + 180 * 86400000 : now + 1,
    build: async () => { builds++; return entry(id(11)); },
  })).toEqual({ status: 'rejected', reason: 'access' });
  expect(builds).toBe(0);
  expect(await counts()).toEqual(savedCounts);
  expect(await db.prepare('SELECT * FROM request_results').first()).toEqual(savedResult);
  expect(await db.prepare('SELECT last_active_at FROM users').first('last_active_at')).toBe(now);
  expect(await db.prepare('SELECT COUNT(*) AS n FROM events').first('n')).toBe(1);
});

it('entry не повторює запис автоматично після доведеного revision-конфлікту', async () => {
  let writes = 0;
  const savedCounts = await counts();
  const proxy = interceptBatch(async (statements) => {
    if (++writes === 1) await db.prepare('UPDATE users SET selection_revision = selection_revision + 1').run();
    return db.batch(statements);
  });
  expect(await run({ db: proxy })).toEqual({ status: 'rejected', reason: 'temporary' });
  expect(writes).toBe(1);
  expect(await counts()).toEqual(savedCounts);
  for (const table of ['events', 'event_delivery', 'request_results', 'transaction_assertions']) {
    expect(await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first('n')).toBe(0);
  }
});

it.each(['revoked', 'ttl', 'hash'] as const)('доступ %s перевіряється перед commit незалежно від revision', async (kind) => {
  let writes = 0; let clock = now;
  const proxy = interceptBatch(async (statements) => {
    writes++;
    if (kind === 'revoked') await db.prepare('UPDATE users SET revoked_at = ?').bind(now).run();
    if (kind === 'hash') await db.prepare('UPDATE users SET access_secret_hash = ?').bind('f'.repeat(64)).run();
    return db.batch(statements);
  });
  const outcome = await run({ db: proxy, now: () => clock, build: async () => {
    if (kind === 'ttl') clock = now + 180 * 86400000;
    return entry();
  } });
  expect(outcome).toEqual({ status: 'rejected', reason: 'access' }); expect(writes).toBe(1);
  expect(await budget('events')).toMatchObject({ used_count: 0 });
});

it('references використовують час перед commit і відхиляють прострочений доказ', async () => {
  let clock = now;
  expect(await run({ now: () => clock, build: async () => {
    clock += 10;
    return { ...entry(), references: (time) => [{ sql: '? < ?', bindings: [time, now + 5] }] };
  } })).toEqual({ status: 'rejected', reason: 'reference' });
  expect(await budget('events')).toMatchObject({ used_count: 0 });
});

it('нуль змінених рядків пізнього ефекту відкочує всі записи', async () => {
  const before = await counts();
  expect(await run({ build: async () => ({ ...entry(), effects: [...entry().effects,
    { statement: db.prepare("UPDATE users SET preferred_gender = 'women' WHERE user_id = 'missing'"), changes: 1 }] }) }))
    .toEqual({ status: 'rejected', reason: 'temporary' });
  expect(await counts()).toEqual(before);
  for (const table of ['events', 'event_delivery', 'request_results', 'transaction_assertions']) {
    expect(await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first('n')).toBe(0);
  }
});

it.each(['integrity', 'missing_system', 'missing_budget', 'invalid_budget'] as const)('контроль %s зупиняє новий запис без автоматичного відновлення', async (kind) => {
  if (kind === 'integrity') await db.prepare('UPDATE system_control SET integrity_paused = 1').run();
  if (kind === 'missing_system') await db.prepare('DELETE FROM system_control').run();
  if (kind === 'missing_budget') await db.prepare("DELETE FROM capacity_control WHERE budget_key = 'events'").run();
  if (kind === 'invalid_budget') await seedBudget('events', 10001);
  expect(await run()).toEqual({ status: 'rejected', reason: kind === 'integrity' ? 'integrity' : 'temporary' });
  expect(await db.prepare('SELECT COUNT(*) AS n FROM events').first('n')).toBe(0);
});

it('пізня integrity-пауза зупиняє запит у польоті', async () => {
  const proxy = interceptBatch(async (statements) => {
    await db.prepare('UPDATE system_control SET integrity_paused = 1').run(); return db.batch(statements);
  });
  expect(await run({ db: proxy })).toEqual({ status: 'rejected', reason: 'integrity' });
  expect(await budget('command_keys')).toMatchObject({ used_count: 0 });
});

// Порогові тести використовують синтетичні counts; це не перевірка reconciliation.
it.each(Object.keys(BUDGETS) as Budget[])('%s: рівно limit успішно й ставить pause; наступний запис не вміщується', async (key) => {
  await seedBudget(key, BUDGETS[key].limit - 1);
  await reserve({ [key]: 1 });
  expect(await budget(key)).toEqual({ used_count: BUDGETS[key].limit, capacity_paused: 1, capacity_epoch: 0 });
  try { await reserve({ [key]: 1 }); throw new Error('expected failure'); }
  catch (error) { expect(classifyGuard(error), error instanceof Error ? error.message : String(error)).toBe(`capacity_${key}`); }
});

it('переповнення одного бюджету не резервує інші; службова пауза зберігається окремо', async () => {
  await seedBudget('undelivered', 999);
  expect(await run({ build: async () => ({ ...entry(), growth: { events: 2, undelivered: 2 } }) }))
    .toEqual({ status: 'rejected', reason: 'capacity', budget: 'undelivered' });
  expect(await budget('undelivered')).toEqual({ used_count: 999, capacity_paused: 1, capacity_epoch: 0 });
  expect(await budget('events')).toMatchObject({ used_count: 0 });
  expect(await budget('command_keys')).toMatchObject({ used_count: 0 });
  expect(await db.prepare('SELECT COUNT(*) AS n FROM events').first('n')).toBe(0);
});

it('застарілий epoch перевіряється перед переповненням будь-якого бюджету без retry чи pause', async () => {
  await seedBudget('undelivered', 1000); let writes = 0;
  const proxy = interceptBatch(async (statements) => {
    writes++; await db.prepare("UPDATE capacity_control SET capacity_epoch = 1 WHERE budget_key = 'events'").run();
    return db.batch(statements);
  });
  expect(await run({ db: proxy })).toEqual({ status: 'rejected', reason: 'temporary' });
  expect(writes).toBe(1); expect(await budget('undelivered')).toMatchObject({ capacity_paused: 0 });
});

it.each(Object.keys(BUDGETS) as Budget[])('%s: рівно поріг не відновлює; нижче — новий epoch і зняття тільки власної pause', async (key) => {
  await db.prepare('UPDATE capacity_control SET capacity_paused = 1').run();
  await seedBudget(key, BUDGETS[key].resumeBelow + 1, 1, 4);
  await release(key, 1);
  expect(await budget(key)).toEqual({ used_count: BUDGETS[key].resumeBelow, capacity_paused: 1, capacity_epoch: 4 });
  await release(key, 1);
  expect(await budget(key)).toEqual({ used_count: BUDGETS[key].resumeBelow - 1, capacity_paused: 0, capacity_epoch: 5 });
  expect((await counts()).filter((row) => row.budget_key !== key).every((row) => row.capacity_paused === 1)).toBe(true);
});

it('пізня pause після drain/refill не відновлює старий цикл; новий цикл може зупинитися', async () => {
  await seedBudget('undelivered', 801);
  await release('undelivered', 2);
  await reserve({ undelivered: 150 });
  await persistCapacityPause(db, 'undelivered', 0);
  expect(await budget('undelivered')).toEqual({ used_count: 949, capacity_paused: 0, capacity_epoch: 1 });
  await db.prepare('UPDATE system_control SET integrity_paused = 1').run();
  await persistCapacityPause(db, 'undelivered', 1);
  expect(await budget('undelivered')).toMatchObject({ capacity_paused: 1 });
  expect(await db.prepare('SELECT integrity_paused FROM system_control').first('integrity_paused')).toBe(1);
});

it('збій службової pause повертає temporary і не повторює бізнес-запис', async () => {
  await seedBudget('undelivered', 1000); let writes = 0;
  const proxy = interceptBatch(async (statements) => { if (++writes === 2) throw new Error('pause unavailable'); return db.batch(statements); });
  expect(await run({ db: proxy })).toEqual({ status: 'rejected', reason: 'temporary' });
  expect(writes).toBe(2); expect(await budget('undelivered')).toMatchObject({ capacity_paused: 0, used_count: 1000 });
});

it('конкурентний winner після відмови місткості повертається до спроби ставити pause', async () => {
  await seedBudget('undelivered', 1000); let writes = 0;
  const proxy = interceptBatch(async (statements) => {
    writes++;
    try { return await db.batch(statements); } catch (error) {
      await seedBudget('undelivered', 0, 0, 1); await run(); throw error;
    }
  });
  expect(await run({ db: proxy })).toEqual({ status: 'found', result: { code: 'accepted', event_id: id(10) } });
  expect(writes).toBe(1); expect(await budget('undelivered')).toMatchObject({ used_count: 1, capacity_paused: 0 });
});

it('ACK/release є одним batch: пізній збій і повтор не віднімають count вдруге', async () => {
  await run();
  const ack = (lateFailure = false) => {
    const batch = new GuardedBatch(db);
    releaseCapacity(batch, 'undelivered', 1);
    batch.effect({ statement: db.prepare("UPDATE event_delivery SET status = 'delivered', delivered_at = ?, next_attempt_at = NULL WHERE event_id = ? AND status = 'pending'").bind(now, id(10)), changes: 1 });
    if (lateFailure) batch.assert('effects', { sql: '0' });
    return db.batch(batch.finish());
  };
  await expect(ack(true)).rejects.toThrow('guard_effects');
  expect(await budget('undelivered')).toMatchObject({ used_count: 1 });
  await ack(); await expect(ack()).rejects.toThrow('guard_effects');
  expect(await budget('undelivered')).toMatchObject({ used_count: 0 });
  expect(await budget('events')).toMatchObject({ used_count: 1 });
});

it('integrity pause блокує release; underflow також відкочує batch', async () => {
  await expect(release('events', 1)).rejects.toThrow('guard_effects');
  await seedBudget('events', 10); await db.prepare('UPDATE system_control SET integrity_paused = 1').run();
  await expect(release('events', 1)).rejects.toThrow('guard_integrity');
  expect(await budget('events')).toMatchObject({ used_count: 10 });
});

it('невідомі та вкладені повідомлення не підробляють відому причину guard', () => {
  for (const error of [new Error('timeout guard_revision'), new Error('other', { cause: new Error('CHECK constraint failed: guard_revision') }),
    new Error('CHECK constraint failed: guard_unknown'), new Error('UNIQUE constraint failed: request_results.user_id')]) {
    expect(classifyGuard(error)).toBe('unknown');
  }
});
