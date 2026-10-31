import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, it } from 'vitest';

const db = env.DB;

beforeAll(async () => {
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  // Зменшена синтетична модель ефектів команди, не бізнес-схема M1.
  await db.batch([
    db.prepare('CREATE TABLE __guard_profile (id TEXT PRIMARY KEY, revision INTEGER NOT NULL)'),
    db.prepare('CREATE TABLE __guard_events (id TEXT PRIMARY KEY)'),
    db.prepare('CREATE TABLE __guard_delivery (event_id TEXT PRIMARY KEY)'),
    db.prepare('CREATE TABLE __guard_results (user_id TEXT NOT NULL, operation_id TEXT NOT NULL, result TEXT NOT NULL, UNIQUE(user_id, operation_id))'),
    db.prepare('CREATE TABLE __guard_budget (id TEXT PRIMARY KEY, used_count INTEGER NOT NULL)'),
  ]);
});

beforeEach(async () => {
  await db.batch([
    db.prepare('DELETE FROM __guard_profile'),
    db.prepare('DELETE FROM __guard_events'),
    db.prepare('DELETE FROM __guard_delivery'),
    db.prepare('DELETE FROM __guard_results'),
    db.prepare('DELETE FROM __guard_budget'),
    db.prepare("INSERT INTO __guard_profile VALUES ('synthetic-user', 0)"),
    db.prepare("INSERT INTO __guard_budget VALUES ('events', 0)"),
  ]);
  // Не очищаємо guard за тест: залишок повинен зламати перевірку.
  expect(await db.prepare('SELECT COUNT(*) FROM transaction_assertions').first('COUNT(*)')).toBe(0);
});

function effects(eventId = 'synthetic-event', operationId = 'synthetic-operation') {
  return [
    db.prepare("UPDATE __guard_profile SET revision = revision + 1 WHERE id = 'synthetic-user'"),
    db.prepare('INSERT INTO __guard_events VALUES (?)').bind(eventId),
    db.prepare('INSERT INTO __guard_delivery VALUES (?)').bind(eventId),
    db.prepare("UPDATE __guard_budget SET used_count = used_count + 1 WHERE id = 'events'"),
    db.prepare("INSERT INTO __guard_results VALUES ('synthetic-user', ?, ?)").bind(operationId, eventId),
  ];
}

function revisionGuard(expectedRevision: number, userId = 'synthetic-user') {
  return db.prepare(`INSERT INTO transaction_assertions (assertion_id, revision_ok)
    VALUES ('revision', CASE WHEN
      (SELECT revision FROM __guard_profile WHERE id = ?) = ? THEN 1 ELSE 0 END)`)
    .bind(userId, expectedRevision);
}

const clearGuard = () => db.prepare('DELETE FROM transaction_assertions');

async function expectEffects(count: number) {
  expect(await db.prepare("SELECT revision FROM __guard_profile WHERE id = 'synthetic-user'").first('revision')).toBe(count);
  expect(await db.prepare("SELECT used_count FROM __guard_budget WHERE id = 'events'").first('used_count')).toBe(count);
  for (const table of ['__guard_events', '__guard_delivery', '__guard_results', 'transaction_assertions']) {
    // Назви — локальні константи тесту, не вхід користувача.
    expect(await db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).first('total'))
      .toBe(table === 'transaction_assertions' ? 0 : count);
  }
}

it('повторно застосовує міграції без повторного створення таблиці', async () => {
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  expect(await db.prepare('SELECT COUNT(*) AS total FROM d1_migrations').first('total')).toBe(env.TEST_MIGRATIONS.length);
});

it('записує весь успішний batch і прибирає guard до commit', async () => {
  await db.batch([
    revisionGuard(0), ...effects(),
    db.prepare(`INSERT INTO transaction_assertions (assertion_id, effects_ok)
      VALUES ('row-count', CASE WHEN changes() = 1 THEN 1 ELSE 0 END)`),
    clearGuard(),
  ]);
  await expectEffects(1);
});

it.each([
  ['стара revision', 9, 'synthetic-user'],
  ['відсутній профіль', 0, 'missing-user'],
] as const)('%s не допускає жодного ефекту', async (_label, revision, userId) => {
  await expect(db.batch([revisionGuard(revision, userId), ...effects(), clearGuard()]))
    .rejects.toThrow('CHECK constraint failed: guard_revision');
  await expectEffects(0);
});

it.each([
  ['revision_ok', 'guard_revision'], ['access_ok', 'guard_access'],
  ['reference_ok', 'guard_reference'], ['capacity_ok', 'guard_capacity'],
  ['effects_ok', 'guard_effects'],
] as const)('%s відхиляє 0 після запису всіх ефектів і відкочує їх', async (column, constraint) => {
  await expect(db.batch([
    ...effects(),
    db.prepare(`INSERT INTO transaction_assertions (assertion_id, ${column}) VALUES ('late', 0)`),
    clearGuard(),
  ])).rejects.toThrow(`CHECK constraint failed: ${constraint}`);
  await expectEffects(0);
});

it('NULL не обходить CHECK через тризначну логіку SQL', async () => {
  await expect(db.batch([
    ...effects(),
    db.prepare("INSERT INTO transaction_assertions (assertion_id, revision_ok) VALUES ('null', NULL)"),
    clearGuard(),
  ])).rejects.toThrow('NOT NULL constraint failed: transaction_assertions.revision_ok');
  await expectEffects(0);
});

it('нуль оновлених рядків відхиляє batch усередині транзакції', async () => {
  await expect(db.batch([
    ...effects(),
    db.prepare("UPDATE __guard_profile SET revision = revision + 1 WHERE id = 'missing-user'"),
    db.prepare(`INSERT INTO transaction_assertions (assertion_id, effects_ok)
      VALUES ('row-count', CASE WHEN changes() = 1 THEN 1 ELSE 0 END)`),
    clearGuard(),
  ])).rejects.toThrow('CHECK constraint failed: guard_effects');
  await expectEffects(0);
});

it('помилка після видалення guard відкочує також попередні успішні запити', async () => {
  await expect(db.batch([
    revisionGuard(0), ...effects(), clearGuard(),
    db.prepare("INSERT INTO __guard_events VALUES ('synthetic-event')"),
  ])).rejects.toThrow('UNIQUE constraint failed: __guard_events.id');
  await expectEffects(0);
});

it('два одночасні batch з одним ключем залишають лише ефекти переможця', async () => {
  const outcomes = await Promise.allSettled([
    db.batch([...effects('event-a'), clearGuard()]),
    db.batch([...effects('event-b'), clearGuard()]),
  ]);
  expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
  const loser = outcomes.find((outcome) => outcome.status === 'rejected');
  expect(loser?.status === 'rejected' && loser.reason instanceof Error && loser.reason.message)
    .toContain('UNIQUE constraint failed: __guard_results.user_id, __guard_results.operation_id');
  await expectEffects(1);
  const winner = await db.prepare('SELECT result FROM __guard_results').first<string>('result');
  expect(await db.prepare('SELECT id FROM __guard_events').first('id')).toBe(winner);
  expect(await db.prepare('SELECT event_id FROM __guard_delivery').first('event_id')).toBe(winner);
});
