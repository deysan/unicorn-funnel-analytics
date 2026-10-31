import { beforeAll, beforeEach, expect, it } from 'vitest';
import { importFingerprintKey, type FingerprintKeyring } from '../../src/server/storage/command-fingerprint';
import { checkCommandReplay, COMMAND_RESULT_TTL_MS, prepareCommandResult, prepareExpireCommandResult,
  readCommandResult, type CommandResult, type NormalizedCommand } from '../../src/server/storage/command-results';
import { catalogVersion, clickStatement, db, eventStatement, freshBusinessDb, id, now, userId, userStatement } from './helpers/business-db';

let keys: FingerprintKeyring;
const command: NormalizedCommand = { userId, operationId: id(2), operationType: 'entry', business: { preland_id: 'demo' } };
const result = { code: 'accepted', event_id: id(10) } satisfies CommandResult;
beforeAll(async () => { keys = { currentVersion: 'v1', keys: new Map([['v1', await importFingerprintKey(new Uint8Array(32).fill(1))]]) }; });
beforeEach(async () => { await freshBusinessDb(); await userStatement().run(); });

// Реальні бізнес-таблиці, але тестовий batch: admission/revision протокол
// наступного підкроку не підміняємо цим допоміжним кодом.
async function entryBatch(eventId = result.event_id, request = command, time = now) {
  return [
    db.prepare('UPDATE users SET selection_revision = selection_revision + 1 WHERE user_id = ?').bind(request.userId),
    eventStatement(eventId, 'funnel_entered', { user: request.userId }),
    db.prepare("INSERT INTO event_delivery (event_id, status, next_attempt_at) VALUES (?, 'pending', ?)").bind(eventId, time),
    db.prepare("UPDATE capacity_control SET used_count = used_count + 1 WHERE budget_key IN ('events', 'undelivered', 'command_keys')"),
    await prepareCommandResult(db, request, { code: 'accepted', event_id: eventId }, keys, time),
  ];
}

it('повтор читає старий результат, не поновлює час і не змінює новіший профіль', async () => {
  await db.batch(await entryBatch());
  await db.batch(await entryBatch(id(11), { ...command, operationId: id(3) }, now + 1));
  expect(await checkCommandReplay(db, command, keys, now + 10)).toEqual({ status: 'found', result });
  expect(await readCommandResult(db, command, now + 10)).toEqual({ status: 'found', result });
  expect(await db.prepare('SELECT selection_revision FROM users').first('selection_revision')).toBe(2);
  expect(await db.prepare('SELECT created_at FROM request_results WHERE operation_id = ?').bind(command.operationId).first('created_at')).toBe(now);
  expect(await db.prepare('SELECT COUNT(*) AS n FROM events').first('n')).toBe(2);
});

it('змінений зміст і інший тип із тим самим ключем — конфлікт', async () => {
  await db.batch(await entryBatch());
  expect(await checkCommandReplay(db, { ...command, business: { preland_id: 'other' } }, keys, now)).toEqual({ status: 'conflict' });
  expect(await checkCommandReplay(db, { ...command, operationType: 'answer' }, keys, now)).toEqual({ status: 'conflict' });
});

it('інший користувач має окремий простір ключів', async () => {
  await db.batch(await entryBatch());
  const other = { ...command, userId: id(99) };
  expect(await readCommandResult(db, other, now)).toEqual({ status: 'not_found' });
  await userStatement(other.userId).run();
  await db.batch(await entryBatch(id(12), other));
  expect(await readCommandResult(db, other, now)).toEqual({ status: 'found', result: { code: 'accepted', event_id: id(12) } });
});

it('логічна межа рівно 7 діб не залежить від фізичного очищення', async () => {
  await db.batch(await entryBatch());
  expect(await readCommandResult(db, command, now + COMMAND_RESULT_TTL_MS - 1)).toEqual({ status: 'found', result });
  for (const time of [now + COMMAND_RESULT_TTL_MS, now + COMMAND_RESULT_TTL_MS + 1]) {
    expect(await readCommandResult(db, command, time)).toEqual({ status: 'expired' });
    expect(await checkCommandReplay(db, { ...command, business: 'changed' }, { currentVersion: 'missing', keys: new Map() }, time))
      .toEqual({ status: 'expired' });
  }
  expect(await db.prepare('SELECT expired FROM request_results').first('expired')).toBe(0);
});

it('очищення прибирає весь результат, тип і HMAC, лишаючи зайнятий ключ та бюджет', async () => {
  await db.batch(await entryBatch());
  await db.batch([prepareExpireCommandResult(db, command, now + COMMAND_RESULT_TTL_MS - 1)]);
  expect(await readCommandResult(db, command, now)).toMatchObject({ status: 'found' });
  await db.batch([prepareExpireCommandResult(db, command, now + COMMAND_RESULT_TTL_MS)]);
  expect(await db.prepare('SELECT * FROM request_results').first()).toEqual({
    user_id: userId, operation_id: command.operationId, created_at: now, expired: 1,
    operation_type: null, request_fingerprint: null, fingerprint_key_version: null, fingerprint_format_version: null, result_json: null,
  });
  expect(await checkCommandReplay(db, command, keys, now + COMMAND_RESULT_TTL_MS)).toEqual({ status: 'expired' });
  expect(await db.prepare("SELECT used_count FROM capacity_control WHERE budget_key = 'command_keys'").first('used_count')).toBe(1);
  expect(await db.prepare('SELECT COUNT(*) AS n FROM events').first('n')).toBe(1);
  await expect(db.batch(await entryBatch(id(12)))).rejects.toThrow('UNIQUE');
  expect(await db.prepare('SELECT COUNT(*) AS n FROM events').first('n')).toBe(1);
});

it('ротація використовує старий ключ; відсутній ключ/формат дає технічну відмову', async () => {
  await db.batch(await entryBatch());
  const rotated = { currentVersion: 'v2', keys: new Map([...keys.keys, ['v2', await importFingerprintKey(new Uint8Array(32).fill(2))] as const]) };
  expect(await checkCommandReplay(db, command, rotated, now)).toEqual({ status: 'found', result });
  await expect(checkCommandReplay(db, command, { currentVersion: 'v2', keys: new Map([['v2', rotated.keys.get('v2')!]]) }, now))
    .rejects.toThrow('fingerprint_unavailable');
  await db.prepare('UPDATE request_results SET fingerprint_format_version = 99').run();
  await expect(checkCommandReplay(db, command, keys, now)).rejects.toThrow('fingerprint_unavailable');
  expect(await readCommandResult(db, command, now)).toEqual({ status: 'found', result });
});

it('два одночасні INSERT дають одного переможця без часткових ефектів програвшого', async () => {
  const [a, b] = await Promise.all([entryBatch(id(10)), entryBatch(id(11))]);
  const outcomes = await Promise.allSettled([db.batch(a), db.batch(b)]);
  expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter((item) => item.status === 'rejected')).toHaveLength(1);
  expect(await db.prepare('SELECT COUNT(*) AS n FROM events').first('n')).toBe(1);
  expect(await db.prepare('SELECT COUNT(*) AS n FROM event_delivery').first('n')).toBe(1);
  expect(await db.prepare('SELECT selection_revision FROM users').first('selection_revision')).toBe(1);
  expect((await db.prepare("SELECT used_count FROM capacity_control WHERE budget_key != 'profiles'").all()).results)
    .toEqual([{ used_count: 1 }, { used_count: 1 }, { used_count: 1 }]);
  const replay = await checkCommandReplay(db, command, keys, now);
  expect(replay).toEqual({ status: 'found', result: { code: 'accepted', event_id: await db.prepare('SELECT event_id FROM events').first('event_id') } });
});

it('пізня помилка відкочує результат; невідома помилка читання не маскується як not_found', async () => {
  await expect(db.batch([...(await entryBatch()), db.prepare("INSERT INTO transaction_assertions (assertion_id, effects_ok) VALUES ('fail', 0)")]))
    .rejects.toThrow('guard_effects');
  expect(await readCommandResult(db, command, now)).toEqual({ status: 'not_found' });
  expect(await db.prepare('SELECT COUNT(*) AS n FROM events').first('n')).toBe(0);
  await db.prepare('DROP TABLE request_results').run();
  await expect(readCommandResult(db, command, now)).rejects.toThrow();
});

it('no_offer зберігає версію каталогу без ClickID та події переходу', async () => {
  const select: NormalizedCommand = { ...command, operationType: 'offer_selection', business: { entry_event_id: id(10) } };
  const noOffer: CommandResult = { code: 'no_offer', catalog_version: catalogVersion };
  await db.batch([await prepareCommandResult(db, select, noOffer, keys, now)]);
  expect(await checkCommandReplay(db, select, keys, now)).toEqual({ status: 'found', result: noOffer });
  expect(await db.prepare('SELECT COUNT(*) AS n FROM clicks').first('n')).toBe(0);
  expect(await db.prepare('SELECT COUNT(*) AS n FROM events').first('n')).toBe(0);
});

it('зберігає незмінний результат переходу зі знімком назви та URL', async () => {
  const select: NormalizedCommand = { ...command, operationType: 'offer_selection', business: { entry_event_id: id(10) } };
  const selected: CommandResult = { code: 'offer_selected', event_id: id(12), click_id: id(11), catalog_version: catalogVersion,
    offer_id: '003', offer_name: 'Synthetic offer', target_url: `https://example.test/?click_id=${id(11)}` };
  await db.batch([eventStatement(id(10)), clickStatement(id(11), id(10)),
    eventStatement(id(12), 'offer_transition', { entry: id(10), click: id(11), offer: '003', flow: 'bypass' }),
    await prepareCommandResult(db, select, selected, keys, now)]);
  expect(await readCommandResult(db, select, now + 1)).toEqual({ status: 'found', result: selected });
  expect(await checkCommandReplay(db, select, keys, now + 2)).toEqual({ status: 'found', result: selected });
});

it('невірний URL/ClickID та пошкоджений збережений результат не повертаються клієнту', async () => {
  const selected: CommandResult = { code: 'offer_selected', event_id: id(12), click_id: id(11), catalog_version: catalogVersion,
    offer_id: '003', offer_name: 'Synthetic offer', target_url: `https://example.test/?click_id=${id(99)}` };
  await expect(prepareCommandResult(db, { ...command, operationType: 'offer_selection' }, selected, keys, now))
    .rejects.toThrow('stored_result_invalid');
  await db.batch(await entryBatch());
  await db.prepare("UPDATE request_results SET result_json = '{}'").run();
  await expect(readCommandResult(db, command, now)).rejects.toThrow('stored_result_invalid');
});

it('відхиляє персональні/зайві поля та завеликий серіалізований результат до INSERT', async () => {
  await expect(prepareCommandResult(db, command, { ...result, email: 'synthetic@example.test' } as CommandResult, keys, now))
    .rejects.toThrow('stored_result_invalid');
  await expect(prepareCommandResult(db, command, { code: 'no_offer', catalog_version: catalogVersion }, keys, now)).rejects.toThrow('stored_result_invalid');
  const selected: CommandResult = { code: 'offer_selected', event_id: id(10), click_id: id(11), catalog_version: catalogVersion,
    offer_id: '003', offer_name: 'Synthetic offer', target_url: 'https://example.test/' + '\\'.repeat(1980) + `?click_id=${id(11)}` };
  await expect(prepareCommandResult(db, { ...command, operationType: 'offer_selection' }, selected, keys, now)).rejects.toThrow('stored_result_too_large');
  expect(await db.prepare('SELECT COUNT(*) AS n FROM request_results').first('n')).toBe(0);
});
