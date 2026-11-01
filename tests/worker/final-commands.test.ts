import { beforeAll, beforeEach, expect, it } from 'vitest';
import { executeQuizCommand, EVENT_TTL_MS, type QuizCommand } from '../../src/server/quiz/commands';
import { createOfferCatalog, getOfferCatalog } from '../../src/server/offers/catalog';
import { offerConfig } from '../../src/server/offers/config';
import { importFingerprintKey, type FingerprintKeyring } from '../../src/server/storage/command-fingerprint';
import { COMMAND_RESULT_TTL_MS, prepareExpireCommandResult } from '../../src/server/storage/command-results';
import { db, freshBusinessDb, id, now, userId, userStatement } from './helpers/business-db';

let keys: FingerprintKeyring;
const secretHash = userId.replaceAll('-', '').padEnd(64, '0');
const entry: QuizCommand = { type: 'entry', operation_id: id(10), event_id: id(11), preland_id: 'demo' };
const view: QuizCommand = { type: 'question_view', operation_id: id(20), event_id: id(21), preland_id: 'demo', question_id: 'email', entry_event_id: id(11) };
const a: QuizCommand = { type: 'email_confirmation', operation_id: id(30), preland_id: 'demo', view_event_id: id(21), email: '  Demo+tag@EXAMPLE.TEST ' };
const b: QuizCommand = { type: 'offer_selection', operation_id: id(40), preland_id: 'demo', entry_event_id: id(11), completion_operation_id: id(30) };
type Options = Parameters<typeof executeQuizCommand>[0];
function run(input: unknown, overrides: Partial<Options> = {}) {
  return executeQuizCommand({ db, userId, secretHash, keys, input, now: () => now, ...overrides });
}
async function preferences() {
  await db.prepare("UPDATE users SET preferred_gender = 'women', preferred_ethnicity = 'asia', selection_revision = selection_revision + 1 WHERE user_id = ?").bind(userId).run();
}
async function prepareA() {
  await preferences(); expect((await run(entry)).status).toBe('found'); expect((await run(view)).status).toBe('found');
}
async function acceptA() {
  await prepareA(); const result = await run(a);
  if (result.status !== 'found' || result.result.code !== 'accepted') throw new Error('fixture_a_failed');
  return result.result.event_id;
}
async function profile() { return db.prepare('SELECT * FROM users WHERE user_id = ?').bind(userId).first(); }
async function snapshot() {
  return Promise.all(['users', 'events', 'event_delivery', 'clicks', 'request_results', 'capacity_control', 'transaction_assertions']
    .map(async (table) => (await db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results));
}
async function count(table: string) { return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<number>('n'); }
async function lead(offer = '001') {
  await db.batch([db.prepare('INSERT INTO user_offer_leads (user_id, offer_id, latest_lead_at) VALUES (?, ?, ?)').bind(userId, offer, now),
    db.prepare('UPDATE users SET selection_revision = selection_revision + 1 WHERE user_id = ?').bind(userId)]);
}
function interceptBatch(intercept: (statements: D1PreparedStatement[]) => Promise<D1Result[]>) {
  return new Proxy(db, { get(target, property) {
    if (property === 'batch') return intercept;
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
beforeAll(async () => { keys = { currentVersion: 'v1', keys: new Map([['v1', await importFingerprintKey(new Uint8Array(32).fill(1))]]) }; });
beforeEach(async () => { await freshBusinessDb(); await userStatement().run(); await db.prepare("UPDATE capacity_control SET used_count = 1 WHERE budget_key = 'profiles'").run(); });

it('A → B зберігає email, ClickID, URL та однакові зв’язки переходу й події без персональних даних', async () => {
  const completionId = await acceptA();
  const result = await run(b, { now: () => now + 1 });
  expect(result).toMatchObject({ status: 'found', result: { code: 'offer_selected', offer_id: '003', offer_name: 'Asia Connect' } });
  if (result.status !== 'found' || result.result.code !== 'offer_selected') throw new Error('expected_selection');
  const click = await db.prepare('SELECT * FROM clicks').first();
  expect(click).toMatchObject({ click_id: result.result.click_id, user_id: userId, offer_id: '003', partner_id: 'demo-partner',
    preland_id: 'demo', flow_mode: 'quiz', entry_event_id: id(11), completion_event_id: completionId,
    offer_name_snapshot: result.result.offer_name, target_url_snapshot: result.result.target_url, catalog_version: result.result.catalog_version });
  expect(new URL(result.result.target_url).searchParams.getAll('click_id')).toEqual([result.result.click_id]);
  const event = await db.prepare("SELECT * FROM events WHERE event_type = 'offer_transition'").first();
  expect(event).toMatchObject({ event_id: result.result.event_id, click_id: click!.click_id, flow_mode: 'quiz',
    entry_event_id: click!.entry_event_id, completion_event_id: click!.completion_event_id, offer_id: click!.offer_id });
  const payload = JSON.parse(event!.payload_json as string);
  for (const field of ['event_id', 'event_type', 'user_id', 'preland_id', 'occurred_at', 'received_at', 'click_id', 'offer_id', 'flow_mode', 'entry_event_id', 'completion_event_id', 'schema_version']) expect(payload[field]).toBe(event![field]);
  expect(await profile()).toMatchObject({ email: 'Demo+tag@example.test', email_confirmed_at: now, selection_revision: 2 });
  expect(await count('events')).toBe(4); expect(await count('event_delivery')).toBe(4); expect(await count('request_results')).toBe(4);
  expect(await count('transaction_assertions')).toBe(0);
  const exported = (await db.prepare('SELECT payload_json FROM events').all()).results;
  const results = (await db.prepare('SELECT result_json FROM request_results').all()).results;
  expect(JSON.stringify([exported, results, click])).not.toMatch(/Demo\+tag|EXAMPLE|example\.test|women|asia"|access_secret|fingerprint/);
});

it('A порівнює нормалізований email; local-part під тим самим ключем конфліктує', async () => {
  await prepareA(); const first = await run(a); const saved = await snapshot();
  expect(await run({ ...a, email: 'Demo+tag@example.test' }, { now: () => now + 5 })).toEqual(first);
  expect(await run({ ...a, email: 'demo+tag@example.test' })).toEqual({ status: 'conflict' });
  expect(await snapshot()).toEqual(saved);
});

it('нова A змінює revision лише при зміні email або часу підтвердження', async () => {
  await acceptA();
  expect((await run({ ...a, operation_id: id(31) })).status).toBe('found');
  expect(await profile()).toMatchObject({ selection_revision: 2 });
  expect((await run({ ...a, operation_id: id(32) }, { now: () => now + 1 })).status).toBe('found');
  expect(await profile()).toMatchObject({ selection_revision: 3, email_confirmed_at: now + 1 });
  expect((await run({ ...a, operation_id: id(33), email: 'other@example.test' }, { now: () => now + 1 })).status).toBe('found');
  expect(await profile()).toMatchObject({ selection_revision: 4, email: 'other@example.test' });
});

it.each(['preferences', 'lead', 'wrong_view', 'old_entry'] as const)('A відхиляє недопустимий стан: %s', async (kind) => {
  await prepareA();
  if (kind === 'preferences') await db.prepare('UPDATE users SET preferred_ethnicity = NULL, selection_revision = selection_revision + 1').run();
  if (kind === 'lead') await lead();
  if (kind === 'wrong_view') await db.prepare("UPDATE events SET question_id = 'preferred_gender' WHERE event_id = ?").bind(id(21)).run();
  if (kind === 'old_entry') await db.prepare('UPDATE events SET received_at = ? WHERE event_id = ?').bind(now - EVENT_TTL_MS, id(11)).run();
  const saved = await snapshot();
  expect(await run(a)).toEqual({ status: 'rejected', reason: kind === 'preferences' || kind === 'lead' ? 'step_not_ready' : 'reference' });
  expect(await snapshot()).toEqual(saved);
});

it.each([
  { ...a, email: 'a@localhost' }, { ...a, email: null }, { ...a, event_id: id(99) },
  { ...b, completion_operation_id: null }, { ...b, flow_mode: 'bypass' }, { ...b, completion_event_id: id(99) },
])('A/B відхиляють неправильний DTO без запису', async (input) => {
  const saved = await snapshot(); expect(await run(input)).toEqual({ status: 'rejected', reason: 'validation' });
  expect(await snapshot()).toEqual(saved);
});

it('B без A не приймає самі збережені відповіді/email як bypass', async () => {
  await acceptA(); const saved = await snapshot();
  expect(await run({ type: 'offer_selection', operation_id: id(40), preland_id: 'demo', entry_event_id: id(11) }))
    .toEqual({ status: 'rejected', reason: 'selection_not_ready' });
  expect(await snapshot()).toEqual(saved);
});

it('bypass з активним Lead не потребує A чи вподобань і не створює підтвердження email', async () => {
  await run(entry); await lead();
  expect(await run({ type: 'offer_selection', operation_id: id(40), preland_id: 'demo', entry_event_id: id(11) }))
    .toMatchObject({ status: 'found', result: { code: 'offer_selected', offer_id: '001' } });
  expect(await db.prepare('SELECT * FROM clicks').first()).toMatchObject({ flow_mode: 'bypass', completion_event_id: null });
  const event = await db.prepare("SELECT payload_json FROM events WHERE event_type = 'offer_transition'").first<string>('payload_json');
  expect(JSON.parse(event!)).not.toHaveProperty('completion_event_id');
  expect(await db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type = 'answer_confirmed'").first('n')).toBe(0);
  expect(await profile()).toMatchObject({ email: null, preferred_gender: null, selection_revision: 1 });
});

it('bypass із Lead видаленого офера та вподобаннями використовує новий matching', async () => {
  await preferences(); await run(entry); await lead();
  const catalog = await createOfferCatalog({ ...offerConfig, offers: offerConfig.offers.filter((offer) => offer.id !== '001') });
  expect(await run({ type: 'offer_selection', operation_id: id(40), preland_id: 'demo', entry_event_id: id(11) }, { catalog: async () => catalog }))
    .toMatchObject({ status: 'found', result: { code: 'offer_selected', offer_id: '003' } });
});

it.each(['missing', 'wrong_type', 'other_user', 'other_preland', 'expired', 'tombstone', 'wrong_event'] as const)('B не приймає непридатну конкретну A: %s', async (kind) => {
  await acceptA(); await lead(); // Навіть чинний bypass не замінює передану A.
  let input = { ...b };
  if (kind === 'missing') input = { ...b, completion_operation_id: id(99) };
  if (kind === 'wrong_type') input = { ...b, completion_operation_id: id(20) };
  if (kind === 'other_user') { await userStatement(id(2)).run(); await db.prepare('UPDATE request_results SET user_id = ? WHERE operation_id = ?').bind(id(2), id(30)).run(); }
  if (kind === 'other_preland') await db.prepare("UPDATE events SET preland_id = 'other' WHERE question_id = 'email' AND event_type = 'answer_confirmed'").run();
  if (kind === 'wrong_event') await db.prepare("UPDATE events SET question_id = 'preferred_gender' WHERE event_type = 'answer_confirmed'").run();
  if (kind === 'tombstone') await (await prepareExpireCommandResult(db, { userId, operationId: id(30) }, now + COMMAND_RESULT_TTL_MS)).run();
  const saved = await snapshot();
  expect(await run(input, { now: () => kind === 'expired' ? now + COMMAND_RESULT_TTL_MS : now }))
    .toEqual({ status: 'rejected', reason: 'selection_not_ready' });
  expect(await snapshot()).toEqual(saved);
});

it('B використовує передану старішу A навіть після нового email й іншого входу', async () => {
  const completionId = await acceptA();
  await run({ ...a, operation_id: id(31), email: 'other@example.test' }, { now: () => now + 1 });
  await run({ ...entry, operation_id: id(12), event_id: id(13) });
  expect((await run({ ...b, entry_event_id: id(13) })).status).toBe('found');
  expect(await db.prepare('SELECT * FROM clicks').first()).toMatchObject({ completion_event_id: completionId, entry_event_id: id(13), flow_mode: 'quiz' });
});

it('прийнята B повертає знімок після зміни каталогу, профілю та втрати A', async () => {
  await acceptA(); const first = await run(b, { now: () => now + 1000 });
  await db.prepare("UPDATE users SET preferred_ethnicity = 'latam', selection_revision = selection_revision + 1").run();
  await (await prepareExpireCommandResult(db, { userId, operationId: id(30) }, now + COMMAND_RESULT_TTL_MS)).run();
  const saved = await snapshot();
  expect(await run(b, { now: () => now + COMMAND_RESULT_TTL_MS, catalog: async () => { throw new Error('must not select'); } })).toEqual(first);
  expect(await run({ ...b, entry_event_id: id(99) })).toEqual({ status: 'conflict' });
  expect(await snapshot()).toEqual(saved);
});

it('no_offer займає лише ключ, повтор стабільний, нова B може знайти офер', async () => {
  await acceptA(); const catalog = await createOfferCatalog({ partners: [], offers: [] });
  const result = await run(b, { catalog: async () => catalog, now: () => now + 1 });
  expect(result).toEqual({ status: 'found', result: { code: 'no_offer', catalog_version: catalog.version } });
  expect(await count('clicks')).toBe(0); expect(await count('events')).toBe(3); expect(await count('event_delivery')).toBe(3);
  expect(await db.prepare('SELECT budget_key, used_count FROM capacity_control ORDER BY budget_key').all()).toMatchObject({ results: [
    { budget_key: 'command_keys', used_count: 4 }, { budget_key: 'events', used_count: 3 },
    { budget_key: 'profiles', used_count: 1 }, { budget_key: 'undelivered', used_count: 3 },
  ] });
  expect(await profile()).toMatchObject({ last_active_at: now + 1 });
  expect(await run(b)).toEqual(result);
  expect(await run({ ...b, operation_id: id(41) })).toMatchObject({ status: 'found', result: { code: 'offer_selected', offer_id: '003' } });
  expect(await count('clicks')).toBe(1);
});

it.each([false, true])('TTL A перевіряється на commit, включно з no_offer=%s', async (empty) => {
  await acceptA(); let calls = 0; const saved = await snapshot();
  const catalog = empty ? await createOfferCatalog({ partners: [], offers: [] }) : await getOfferCatalog();
  expect(await run(b, { catalog: async () => catalog,
    now: () => ++calls < 3 ? now + COMMAND_RESULT_TTL_MS - 1 : now + COMMAND_RESULT_TTL_MS }))
    .toEqual({ status: 'rejected', reason: 'selection_not_ready' });
  expect(await snapshot()).toEqual(saved);
});

it('очищення результату A між читанням і batch дає selection_not_ready без ClickID', async () => {
  await acceptA(); let writes = 0;
  const proxy = interceptBatch(async (statements) => {
    writes++; await (await prepareExpireCommandResult(db, { userId, operationId: id(30) }, now + COMMAND_RESULT_TTL_MS)).run();
    return db.batch(statements);
  });
  expect(await run(b, { db: proxy })).toEqual({ status: 'rejected', reason: 'selection_not_ready' });
  expect(writes).toBe(1); expect(await count('clicks')).toBe(0); expect(await count('events')).toBe(3);
});

it('Lead перед commit B переобчислює офер за тим самим каталогом, зберігає quiz', async () => {
  const completionId = await acceptA(); let writes = 0; let catalogs = 0;
  const proxy = interceptBatch(async (statements) => { if (++writes === 1) await lead(); return db.batch(statements); });
  expect(await run(b, { db: proxy, catalog: async () => { catalogs++; return getOfferCatalog(); } }))
    .toMatchObject({ status: 'found', result: { code: 'offer_selected', offer_id: '001' } });
  expect(writes).toBe(2); expect(catalogs).toBe(1); expect(await count('clicks')).toBe(1);
  expect(await db.prepare('SELECT * FROM clicks').first()).toMatchObject({ completion_event_id: completionId, flow_mode: 'quiz' });
});

it('зміна вподобання перед commit B переобчислює EPU-вибір', async () => {
  await acceptA(); let writes = 0;
  const proxy = interceptBatch(async (statements) => {
    if (++writes === 1) await db.prepare("UPDATE users SET preferred_ethnicity = 'europe', selection_revision = selection_revision + 1").run();
    return db.batch(statements);
  });
  expect(await run(b, { db: proxy })).toMatchObject({ status: 'found', result: { code: 'offer_selected', offer_id: '004' } });
  expect(writes).toBe(2); expect(await count('clicks')).toBe(1);
});

it('три revision-конфлікти B зупиняють запис без нового ключа й ефектів', async () => {
  await acceptA(); let writes = 0;
  const proxy = interceptBatch(async (statements) => {
    writes++; await db.prepare('UPDATE users SET selection_revision = selection_revision + 1').run(); return db.batch(statements);
  });
  expect(await run(b, { db: proxy })).toEqual({ status: 'rejected', reason: 'temporary' });
  expect(writes).toBe(3); expect(await count('clicks')).toBe(0); expect(await count('request_results')).toBe(3);
  expect((await run(b)).status).toBe('found'); expect(await count('clicks')).toBe(1);
});

it.each([a, b])('втрата відповіді після commit $type відновлює результат, не дублює запис', async (command) => {
  if (command.type === 'email_confirmation') await prepareA(); else await acceptA();
  let writes = 0;
  const proxy = interceptBatch(async (statements) => { writes++; await db.batch(statements); throw new Error('response lost'); });
  const result = await run(command, { db: proxy }); expect(result.status).toBe('found');
  const saved = await snapshot(); expect(await run(command)).toEqual(result);
  expect(writes).toBe(1); expect(await snapshot()).toEqual(saved);
});

it('збій B після вставки ClickID відкочує B, зберігає A; той самий ключ може виконатись', async () => {
  const completionId = await acceptA(); const saved = await snapshot();
  const proxy = interceptBatch(async (statements) => db.batch([...statements,
    db.prepare('INSERT INTO transaction_assertions (assertion_id, effects_ok) VALUES (?, 0)').bind(id(99))]));
  expect(await run(b, { db: proxy })).toEqual({ status: 'rejected', reason: 'temporary' });
  expect(await snapshot()).toEqual(saved); expect(await profile()).toMatchObject({ email: 'Demo+tag@example.test' });
  expect((await run(b)).status).toBe('found');
  expect(await db.prepare('SELECT completion_event_id FROM clicks').first('completion_event_id')).toBe(completionId);
});

it('паралельні однакові B залишають один ClickID і один перехід', async () => {
  await acceptA(); let arrived = 0; let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const proxy = interceptBatch(async (statements) => { if (++arrived <= 2) { if (arrived === 2) release(); await gate; } return db.batch(statements); });
  const results = await Promise.all([run(b, { db: proxy }), run(b, { db: proxy })]);
  expect(results[0].status).toBe('found'); expect(results[1]).toEqual(results[0]);
  expect(await count('clicks')).toBe(1); expect(await count('events')).toBe(4); expect(await count('request_results')).toBe(4);
});

it.each(['missing', 'preland', 'expired'])('B перевіряє власний вхід: %s', async (kind) => {
  await acceptA();
  if (kind === 'preland') await db.prepare("UPDATE events SET preland_id = 'other' WHERE event_id = ?").bind(id(11)).run();
  if (kind === 'expired') await db.prepare('UPDATE events SET received_at = ? WHERE event_id = ?').bind(now - EVENT_TTL_MS, id(11)).run();
  const saved = await snapshot();
  expect(await run(kind === 'missing' ? { ...b, entry_event_id: id(99) } : b)).toEqual({ status: 'rejected', reason: 'reference' });
  expect(await snapshot()).toEqual(saved);
});

it('B при переповненні не створює ClickID й не відкочує A', async () => {
  await acceptA(); await db.prepare("UPDATE capacity_control SET used_count = 1000, capacity_paused = 1 WHERE budget_key = 'undelivered'").run();
  const saved = await snapshot();
  expect(await run(b)).toEqual({ status: 'rejected', reason: 'capacity', budget: 'undelivered' });
  // Відомий paused epoch не змінюється від повторного запису паузи.
  expect(await snapshot()).toEqual(saved);
});
