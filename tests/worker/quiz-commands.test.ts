import { beforeAll, beforeEach, expect, it } from 'vitest';
import { executeQuizCommand, EVENT_TTL_MS, type QuizCommand } from '../../src/server/quiz/commands';
import { EMAIL_TTL_MS, readQuizContext } from '../../src/server/quiz/context';
import { createOfferCatalog, getOfferCatalog } from '../../src/server/offers/catalog';
import { offerConfig } from '../../src/server/offers/config';
import { importFingerprintKey, type FingerprintKeyring } from '../../src/server/storage/command-fingerprint';
import { PROFILE_TTL_MS } from '../../src/server/storage/profile';
import { db, eventStatement, freshBusinessDb, id, now, userId, userStatement } from './helpers/business-db';

let keys: FingerprintKeyring;
const secretHash = userId.replaceAll('-', '').padEnd(64, '0');
const entry: QuizCommand = { type: 'entry', operation_id: id(10), event_id: id(11), preland_id: 'demo' };
const view: QuizCommand = { type: 'question_view', operation_id: id(20), event_id: id(21), preland_id: 'demo',
  question_id: 'preferred_gender', entry_event_id: id(11) };
const answer: QuizCommand = { type: 'answer', operation_id: id(30), preland_id: 'demo',
  question_id: 'preferred_gender', value: 'women', view_event_id: id(21) };
type Options = Parameters<typeof executeQuizCommand>[0];
function run(input: unknown, overrides: Partial<Options> = {}) {
  return executeQuizCommand({ db, userId, secretHash, keys, input, now: () => now, ...overrides });
}
function context(time = now, overrides: Partial<Parameters<typeof readQuizContext>[0]> = {}) {
  return readQuizContext({ db, userId, secretHash, now: time, ...overrides });
}
async function profile() { return db.prepare('SELECT * FROM users WHERE user_id = ?').bind(userId).first(); }
async function counts() {
  return db.prepare(`SELECT (SELECT COUNT(*) FROM events) AS events,
    (SELECT COUNT(*) FROM event_delivery) AS delivery, (SELECT COUNT(*) FROM request_results) AS commands,
    (SELECT used_count FROM capacity_control WHERE budget_key = 'events') AS budget_events,
    (SELECT used_count FROM capacity_control WHERE budget_key = 'undelivered') AS budget_delivery,
    (SELECT used_count FROM capacity_control WHERE budget_key = 'command_keys') AS budget_commands,
    (SELECT COUNT(*) FROM transaction_assertions) AS guards`).first();
}
async function seedView() { expect((await run(entry)).status).toBe('found'); expect((await run(view)).status).toBe('found'); }
function interceptBatch(intercept: (statements: D1PreparedStatement[]) => Promise<D1Result[]>) {
  return new Proxy(db, { get(target, property) {
    if (property === 'batch') return intercept;
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
async function lead(offer = '001') {
  await db.batch([
    db.prepare('INSERT INTO user_offer_leads (user_id, offer_id, latest_lead_at) VALUES (?, ?, ?)').bind(userId, offer, now),
    db.prepare('UPDATE users SET selection_revision = selection_revision + 1 WHERE user_id = ?').bind(userId),
  ]);
}
beforeAll(async () => { keys = { currentVersion: 'v1', keys: new Map([['v1', await importFingerprintKey(new Uint8Array(32).fill(1))]]) }; });
beforeEach(async () => { await freshBusinessDb(); await userStatement().run(); await db.prepare("UPDATE capacity_control SET used_count = 1 WHERE budget_key = 'profiles'").run(); });

it('проходить Q1/Q2, дозволяє показ email, атомарно зберігає журнал, delivery та відповіді', async () => {
  await seedView();
  const result = await run(answer, { now: () => now + 1 });
  expect(result).toMatchObject({ status: 'found', result: { code: 'accepted' } });
  const v2 = { ...view, operation_id: id(40), event_id: id(41), question_id: 'preferred_ethnicity' };
  expect((await run(v2, { now: () => now + 2 })).status).toBe('found');
  expect((await run({ ...answer, operation_id: id(50), view_event_id: id(41), question_id: 'preferred_ethnicity', value: 'asia' }, { now: () => now + 3 })).status).toBe('found');
  expect((await run({ ...view, operation_id: id(60), event_id: id(61), question_id: 'email' })).status).toBe('found');
  expect(await profile()).toMatchObject({ preferred_gender: 'women', preferred_ethnicity: 'asia', selection_revision: 2, last_active_at: now + 3 });
  expect(await counts()).toEqual({ events: 6, delivery: 6, commands: 6, budget_events: 6, budget_delivery: 6, budget_commands: 6, guards: 0 });
  const rows = (await db.prepare('SELECT * FROM events ORDER BY received_at, event_id').all()).results;
  for (const row of rows) {
    const payload = JSON.parse(row.payload_json as string);
    for (const field of ['event_id', 'event_type', 'user_id', 'preland_id', 'occurred_at', 'received_at', 'schema_version']) expect(payload[field]).toBe(row[field]);
    for (const field of ['question_id', 'entry_event_id', 'view_event_id']) expect(payload[field] ?? null).toBe(row[field]);
    expect(payload).not.toHaveProperty('value'); expect(payload).not.toHaveProperty('email');
    expect(JSON.stringify(payload)).not.toMatch(/women|asia|access_secret|fingerprint/);
  }
  expect(await context(now + 4)).toEqual({ status: 'ready', user_id: userId, server_time: now + 4,
    answers: { preferred_gender: 'women', preferred_ethnicity: 'asia' }, next_action: 'quiz' });
});

it('replay після появи Lead не перевіряє каталог, не змінює час/лічильники; інший payload конфліктує', async () => {
  await seedView(); const result = await run(answer); await lead();
  const before = await counts(); const saved = await profile();
  expect(await run(answer, { now: () => now + 20, catalog: async () => { throw new Error('must not load'); } })).toEqual(result);
  expect(await run({ ...answer, value: 'men' })).toEqual({ status: 'conflict' });
  expect(await counts()).toEqual(before); expect(await profile()).toEqual(saved);
  expect(await run({ ...answer, operation_id: id(31) })).toEqual({ status: 'rejected', reason: 'step_not_ready' });
  expect(await counts()).toEqual(before);
});

it('те саме значення з новим ключем додає факт підтвердження без приросту revision', async () => {
  await seedView(); await run(answer);
  const result = await run({ ...answer, operation_id: id(31) });
  expect(result.status).toBe('found'); expect(await profile()).toMatchObject({ selection_revision: 1 });
  expect(await counts()).toMatchObject({ events: 4, commands: 4 });
});

it('зміна Q1 зберігає допустимі Q2/email; змінюється лише своє поле', async () => {
  await seedView(); await run(answer);
  await db.prepare("UPDATE users SET preferred_ethnicity = 'latam', email = 'demo@example.test', email_confirmed_at = ?, selection_revision = selection_revision + 1").bind(now).run();
  expect((await run({ ...answer, operation_id: id(31), value: 'men' })).status).toBe('found');
  expect(await profile()).toMatchObject({ preferred_gender: 'men', preferred_ethnicity: 'latam', email: 'demo@example.test', email_confirmed_at: now, selection_revision: 3 });
});

it.each(['preferred_ethnicity', 'email'])('не приймає недоступний показ %s', async (question_id) => {
  await run(entry); const before = await counts(); const saved = await profile();
  expect(await run({ ...view, question_id })).toEqual({ status: 'rejected', reason: 'step_not_ready' });
  expect(await counts()).toEqual(before); expect(await profile()).toEqual(saved);
});

it('не приймає Q2-відповідь без Q1 навіть зі збереженим показом', async () => {
  await run(entry); await eventStatement(id(41), 'question_viewed', { question: 'preferred_ethnicity', entry: id(11) }).run();
  expect(await run({ ...answer, question_id: 'preferred_ethnicity', value: 'asia', view_event_id: id(41) }))
    .toEqual({ status: 'rejected', reason: 'step_not_ready' });
  expect(await profile()).toMatchObject({ preferred_ethnicity: null, selection_revision: 0 });
});

it.each(['missing', 'user', 'preland', 'type', 'expired'] as const)('відхиляє посилання показу на вхід: %s', async (kind) => {
  if (kind !== 'missing') await run(entry);
  if (kind === 'user') { await userStatement(id(2)).run(); await db.prepare('UPDATE events SET user_id = ?').bind(id(2)).run(); }
  if (kind === 'preland') await db.prepare("UPDATE events SET preland_id = 'other'").run();
  const input = kind === 'type' ? { ...view, entry_event_id: id(21), operation_id: id(22), event_id: id(23) } : view;
  if (kind === 'type') await run(view);
  const before = await counts();
  expect(await run(input, { now: () => kind === 'expired' ? now + EVENT_TTL_MS : now }))
    .toEqual({ status: 'rejected', reason: 'reference' });
  expect(await counts()).toEqual(before);
});

it.each(['missing', 'question', 'user', 'preland', 'type', 'view_expired', 'entry_expired'] as const)('відхиляє посилання відповіді: %s', async (kind) => {
  await seedView();
  let input = { ...answer };
  if (kind === 'missing') input = { ...answer, view_event_id: id(999) };
  if (kind === 'question') await db.prepare("UPDATE events SET question_id = 'email' WHERE event_id = ?").bind(id(21)).run();
  if (kind === 'user') { await userStatement(id(2)).run(); await db.prepare('UPDATE events SET user_id = ? WHERE event_id = ?').bind(id(2), id(21)).run(); }
  if (kind === 'preland') await db.prepare("UPDATE events SET preland_id = 'other' WHERE event_id = ?").bind(id(21)).run();
  if (kind === 'type') input = { ...answer, view_event_id: id(11) };
  if (kind === 'view_expired') await db.prepare('UPDATE events SET received_at = ? WHERE event_id = ?').bind(now - EVENT_TTL_MS, id(21)).run();
  if (kind === 'entry_expired') await db.prepare('UPDATE events SET received_at = ? WHERE event_id = ?').bind(now - EVENT_TTL_MS, id(11)).run();
  const before = await counts(); const saved = await profile();
  expect(await run(input)).toEqual({ status: 'rejected', reason: 'reference' });
  expect(await counts()).toEqual(before); expect(await profile()).toEqual(saved);
});

it('перевіряє TTL перед commit, а не лише перед побудовою', async () => {
  await run(entry); let calls = 0;
  expect(await run(view, { now: () => ++calls < 3 ? now + EVENT_TTL_MS - 1 : now + EVENT_TTL_MS }))
    .toEqual({ status: 'rejected', reason: 'reference' });
  expect(await counts()).toMatchObject({ events: 1, commands: 1 });
});

it.each([entry, view, answer])('відхиляє зайві поля в $type без запису', async (command) => {
  expect(await run({ ...command, extra: true })).toEqual({ status: 'rejected', reason: 'validation' });
  expect(await counts()).toMatchObject({ events: 0, commands: 0 });
});
it.each([
  { ...answer, value: 'asia' }, { ...answer, value: null }, { ...answer, question_id: 'email', value: 'demo@example.test' },
  { ...entry, preland_id: '../demo' }, { ...entry, event_id: 'not-uuid' },
  { ...entry, preland_id: 'demo\n' }, { ...entry, event_id: `${id(11)}\n` },
])('відхиляє неправильні типи, enum або ID', async (input) => {
  expect(await run(input)).toEqual({ status: 'rejected', reason: 'validation' });
  expect(await counts()).toMatchObject({ events: 0, commands: 0 });
});

it('заповнений бюджет не лишає відповідь, подію, delivery або результат', async () => {
  await seedView(); await db.prepare("UPDATE capacity_control SET used_count = 1000 WHERE budget_key = 'undelivered'").run();
  const before = await counts(); const saved = await profile();
  expect(await run(answer)).toEqual({ status: 'rejected', reason: 'capacity', budget: 'undelivered' });
  expect(await counts()).toEqual(before); expect(await profile()).toEqual(saved);
});

it('дві вкладки з різними відповідями: останній успішний запис перемагає', async () => {
  await seedView(); let writes = 0;
  const proxy = interceptBatch(async (statements) => {
    if (++writes === 1) expect((await run({ ...answer, operation_id: id(31), value: 'men' })).status).toBe('found');
    return db.batch(statements);
  });
  expect((await run(answer, { db: proxy })).status).toBe('found');
  expect(writes).toBe(2); expect(await profile()).toMatchObject({ preferred_gender: 'women', selection_revision: 2 });
  expect(await counts()).toMatchObject({ events: 4, commands: 4, guards: 0 });
});

it('Lead перед commit змушує переоцінити крок і відхилити відповідь без її ефектів', async () => {
  await seedView(); let writes = 0; let catalogs = 0; const before = await counts();
  const proxy = interceptBatch(async (statements) => { if (++writes === 1) await lead(); return db.batch(statements); });
  expect(await run(answer, { db: proxy, catalog: async () => { catalogs++; return getOfferCatalog(); } }))
    .toEqual({ status: 'rejected', reason: 'step_not_ready' });
  expect(writes).toBe(2); expect(catalogs).toBe(1); expect(await counts()).toEqual(before);
  expect(await profile()).toMatchObject({ preferred_gender: null, selection_revision: 1 });
});

it('перевіряє revision навіть для відмови: поява Q1 дозволяє повторну спробу показу Q2', async () => {
  await seedView(); let writes = 0;
  const proxy = interceptBatch(async (statements) => { if (++writes === 1) await run(answer); return db.batch(statements); });
  expect((await run({ ...view, operation_id: id(40), event_id: id(41), question_id: 'preferred_ethnicity' }, { db: proxy })).status).toBe('found');
  expect(writes).toBe(2); expect(await counts()).toMatchObject({ events: 4, commands: 4, guards: 0 });
});

it('паралельний однаковий ключ повертає один server EventID і один результат', async () => {
  await seedView(); let arrived = 0; let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const proxy = interceptBatch(async (statements) => { if (++arrived <= 2) { if (arrived === 2) release(); await gate; } return db.batch(statements); });
  const results = await Promise.all([run(answer, { db: proxy }), run(answer, { db: proxy })]);
  expect(results[0].status).toBe('found'); expect(results[0]).toEqual(results[1]);
  expect(await counts()).toMatchObject({ events: 3, commands: 3, guards: 0 });
  expect(await profile()).toMatchObject({ selection_revision: 1 });
});

it('невідомий результат commit відновлює записану відповідь без повторного запису', async () => {
  await seedView(); let writes = 0;
  const proxy = interceptBatch(async (statements) => { writes++; await db.batch(statements); throw new Error('response lost'); });
  expect((await run(answer, { db: proxy })).status).toBe('found');
  expect(writes).toBe(1); expect(await counts()).toMatchObject({ events: 3, commands: 3 });
});

it('контекст читає email до точної межі 30 діб, не змінює дані/активність', async () => {
  await db.prepare("UPDATE users SET email = 'demo@example.test', email_confirmed_at = ?").bind(now).run();
  const saved = await profile();
  expect(await context(now + EMAIL_TTL_MS - 1)).toMatchObject({ status: 'ready', email: 'demo@example.test', next_action: 'quiz' });
  expect(await context(now + EMAIL_TTL_MS)).not.toHaveProperty('email');
  expect(await profile()).toEqual(saved); expect(await counts()).toMatchObject({ commands: 0, events: 0 });
});

it('контекст враховує активний Lead, неактивний із вподобаннями та відсутність Lead', async () => {
  expect(await context()).toMatchObject({ next_action: 'quiz' });
  await lead(); expect(await context()).toMatchObject({ next_action: 'select_offer' });
  const catalog = await createOfferCatalog({ ...offerConfig, offers: offerConfig.offers.filter((offer) => offer.id !== '001') });
  expect(await context(now, { catalog: async () => catalog })).toMatchObject({ next_action: 'quiz' });
  await db.prepare("UPDATE users SET preferred_gender = 'women', preferred_ethnicity = 'asia'").run();
  expect(await context(now, { catalog: async () => catalog })).toMatchObject({ next_action: 'select_offer' });
});

it.each(['hash', 'revoked', 'expired'] as const)('контекст не розкриває профіль без доступу: %s', async (kind) => {
  if (kind === 'revoked') await db.prepare('UPDATE users SET revoked_at = ?').bind(now).run();
  expect(await context(kind === 'expired' ? now + PROFILE_TTL_MS : now, kind === 'hash' ? { secretHash: 'f'.repeat(64) } : {}))
    .toEqual({ status: 'invalid' });
});

it('збій читання контексту не перетворюється на втрату профілю', async () => {
  const broken = new Proxy(db, { get() { throw new Error('D1 unavailable'); } });
  await expect(context(now, { db: broken })).rejects.toThrow('D1 unavailable');
});
