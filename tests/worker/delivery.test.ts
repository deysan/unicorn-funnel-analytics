import { env } from 'cloudflare:workers';
import { createExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/server/index';
import { readStatus } from '../../src/server/report/read';
import { applyResults, backoff, claim, LEASE_MS, reconcileUndelivered, runDelivery } from '../../src/server/delivery/executor';
import { readAck, readPacket, readSnapshot } from '../../src/server/delivery/contract';
import { receive } from '../../src/server/delivery/receiver';
import { executeQuizCommand } from '../../src/server/quiz/commands';
import { acceptPartnerEvent } from '../../src/server/partner/events';
import { importFingerprintKey } from '../../src/server/storage/command-fingerprint';
import { db, eventStatement, freshBusinessDb, id, now, userId, userStatement } from './helpers/business-db';

async function seed(count: number) {
  await db.batch([userStatement(), ...Array.from({ length: count }, (_, i) => eventStatement(id(i + 10)))]);
  await db.batch([
    db.prepare("INSERT INTO event_delivery (event_id, status, next_attempt_at) SELECT event_id, 'pending', received_at FROM events"),
    db.prepare("UPDATE capacity_control SET used_count = CASE budget_key WHEN 'events' THEN ? WHEN 'undelivered' THEN ? WHEN 'profiles' THEN 1 ELSE 0 END").bind(count, count),
  ]);
}
const rows = () => db.prepare('SELECT * FROM event_delivery ORDER BY event_id').all<Record<string, unknown>>().then((r) => r.results);
const count = () => db.prepare("SELECT used_count FROM capacity_control WHERE budget_key = 'undelivered'").first<number>('used_count');
const ack = (ids: string[], status = 'accepted') => JSON.stringify({ schema_version: 1, results: ids.map((event_id) => ({ event_id, status })) });
const run = (time = now, extra: Partial<Parameters<typeof runDelivery>[0]> = {}) => runDelivery({ db, mode: 'normal', now: () => time, random: () => 0, ...extra });
async function packet() { return JSON.stringify({ schema_version: 1, events: (await db.prepare('SELECT payload_json FROM events ORDER BY event_id').all<{ payload_json: string }>()).results.map((r) => JSON.parse(r.payload_json)) }); }

beforeEach(freshBusinessDb);
describe('M4: справжня локальна D1', () => {
  it('scheduled без HTTP доставляє 10 із 11; наступний запуск — залишок', async () => {
    await seed(11);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try { await worker.scheduled({} as ScheduledController, env, createExecutionContext()); } finally { clock.mockRestore(); }
    expect(await count()).toBe(1);
    expect((await rows()).filter((r) => r.status === 'delivered')).toHaveLength(10);
    expect(await run(now)).toBe('complete'); expect(await count()).toBe(0);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM mock_received_events').first('n')).toBe(11);
    expect(await db.prepare("SELECT used_count FROM capacity_control WHERE budget_key = 'events'").first('used_count')).toBe(11);
  });
  it('доставляє справжні producer snapshots усіх типів, quiz/bypass і обидва Purchase', async () => {
    await userStatement().run();
    await db.prepare("UPDATE capacity_control SET used_count = 1 WHERE budget_key = 'profiles'").run();
    const keys = { currentVersion: 'v1', keys: new Map([['v1', await importFingerprintKey(new Uint8Array(32).fill(1))]]) };
    let operation = 1000;
    const quiz = async (input: Record<string, unknown>) => {
      const result = await executeQuizCommand({ db, userId, secretHash: userId.replaceAll('-', '').padEnd(64, '0'),
        keys, now: () => now, input: { preland_id: 'demo', operation_id: id(operation++), ...input } });
      expect(result).toMatchObject({ status: 'found', result: { code: input.type === 'offer_selection' ? 'offer_selected' : 'accepted' } });
    };
    await quiz({ type: 'entry', event_id: id(100) });
    await quiz({ type: 'question_view', event_id: id(101), entry_event_id: id(100), question_id: 'preferred_gender' });
    await quiz({ type: 'answer', view_event_id: id(101), question_id: 'preferred_gender', value: 'women' });
    await quiz({ type: 'question_view', event_id: id(102), entry_event_id: id(100), question_id: 'preferred_ethnicity' });
    await quiz({ type: 'answer', view_event_id: id(102), question_id: 'preferred_ethnicity', value: 'asia' });
    await quiz({ type: 'question_view', event_id: id(103), entry_event_id: id(100), question_id: 'email' });
    const completionOperation = id(operation);
    await quiz({ type: 'email_confirmation', view_event_id: id(103), email: 'synthetic@example.test' });
    await quiz({ type: 'offer_selection', entry_event_id: id(100), completion_operation_id: completionOperation });
    const click = await db.prepare("SELECT click_id, partner_id FROM clicks WHERE flow_mode = 'quiz'").first<{ click_id: string; partner_id: string }>();
    expect(click).not.toBeNull();
    for (const input of [
      { event_type: 'Lead', partner_event_id: 'synthetic-lead' },
      { event_type: 'Purchase', partner_event_id: 'synthetic-purchase-no-amount' },
      { event_type: 'Purchase', partner_event_id: 'synthetic-purchase-amount', amount_minor: 2500, currency: 'USD' },
    ]) {
      expect(await acceptPartnerEvent({ db, partnerId: click!.partner_id, now: () => now,
        input: { ...input, click_id: click!.click_id, occurred_at: new Date(now).toISOString() } })).toEqual({ status: 'accepted' });
    }
    await quiz({ type: 'entry', event_id: id(104) });
    await quiz({ type: 'offer_selection', entry_event_id: id(104) });
    const source = (await db.prepare('SELECT event_id, payload_json FROM events ORDER BY event_id')
      .all<{ event_id: string; payload_json: string }>()).results;
    const snapshots = source.map((row) => JSON.parse(row.payload_json));
    expect(source).toHaveLength(13);
    expect(new Set(snapshots.map((event) => event.event_type))).toEqual(new Set([
      'funnel_entered', 'question_viewed', 'answer_confirmed', 'offer_transition', 'Lead', 'Purchase',
    ]));
    expect(snapshots.filter((event) => event.event_type === 'offer_transition').map((event) => event.flow_mode).sort()).toEqual(['bypass', 'quiz']);
    const purchases = snapshots.filter((event) => event.event_type === 'Purchase');
    expect(purchases).toHaveLength(2);
    expect(purchases.find((event) => event.partner_event_id === 'synthetic-purchase-no-amount')).not.toHaveProperty('amount_minor');
    expect(purchases.find((event) => event.partner_event_id === 'synthetic-purchase-amount')).toMatchObject({ amount_minor: 2500, currency: 'USD' });
    expect(await count()).toBe(13);
    expect(await run()).toBe('complete'); expect(await count()).toBe(3);
    expect(await run()).toBe('complete'); expect(await count()).toBe(0);
    expect((await rows()).every((row) => row.status === 'delivered')).toBe(true);
    const received = (await db.prepare('SELECT event_id, payload_json FROM mock_received_events ORDER BY event_id')
      .all<{ event_id: string; payload_json: string }>()).results;
    expect(received.map((row) => ({ event_id: row.event_id, payload: JSON.parse(row.payload_json) })))
      .toEqual(source.map((row) => ({ event_id: row.event_id, payload: JSON.parse(row.payload_json) })));
    expect(await db.prepare("SELECT used_count FROM capacity_control WHERE budget_key = 'events'").first('used_count')).toBe(13);
  });
  it('7/10: лише accepted звільняють budget, інші отримують backoff', async () => {
    await seed(10);
    await run(now, { send: async (body) => { const result = JSON.parse(await receive(db, body, 'normal', now)); result.results.splice(7); return JSON.stringify(result); } });
    expect(await count()).toBe(3);
    expect((await rows()).slice(7).every((r) => r.status === 'pending' && r.next_attempt_at === now + 60_000)).toBe(true);
  });
  it('commit приймача + втрата ACK: повтор не дублює і не змінює accepted_at', async () => {
    await seed(2);
    await run(now, { send: async (body) => { await receive(db, body, 'normal', now); throw new Error('lost'); } });
    expect(await count()).toBe(2);
    await run(now + 60_000);
    expect(await count()).toBe(0);
    expect((await db.prepare('SELECT accepted_at FROM mock_received_events').all()).results).toEqual([{ accepted_at: now }, { accepted_at: now }]);
  });
  it('нормалізація порядку JSON і конфлікт без перезапису', async () => {
    await seed(1); const body = await packet();
    await receive(db, body, 'normal', now);
    const reordered = JSON.parse(body); reordered.events[0] = Object.fromEntries(Object.entries(reordered.events[0]).reverse());
    expect(JSON.parse(await receive(db, JSON.stringify(reordered), 'normal', now + 1)).results[0].status).toBe('accepted');
    await db.prepare("UPDATE events SET payload_json = json_set(payload_json, '$.preland_id', 'different')").run();
    await run(); expect(await count()).toBe(1); expect((await rows())[0].last_error_code).toBe('conflict');
    expect((await db.prepare('SELECT payload_json FROM mock_received_events').first<string>('payload_json'))!).toContain('"preland_id":"demo"');
  });
  it.each([
    '{broken', ack([id(10), id(10)]), ack([id(10), id(999)]),
    JSON.stringify({ schema_version: 1, results: [{ event_id: id(10), status: 'accepted', extra: 1 }] }),
    JSON.stringify({ schema_version: 2, results: [] }), ' '.repeat(8193),
    JSON.stringify({ schema_version: 1, results: [], extra: 1 }), ack([id(10)], 'other'),
  ])('некоректний ACK цілком непридатний (%#)', async (response) => {
    await seed(2); await run(now, { send: async () => response });
    expect(await count()).toBe(2); expect((await rows()).every((r) => r.last_error_code === 'invalid_ack')).toBe(true);
  });
  it('порожній ACK і явний retry лишають pending', async () => {
    await seed(2); await run(now, { send: async () => ack([id(10)], 'retry') });
    expect((await rows()).map((r) => r.last_error_code)).toEqual(['retry', 'missing_ack']); expect(await count()).toBe(2);
  });
  it('паралельні claims не перехоплюють живі lease; expired відновлюється', async () => {
    await seed(2); const claims = await Promise.all([claim(db, now), claim(db, now)]);
    expect(claims.flat()).toHaveLength(2); expect(claims.some((r) => r.length === 0)).toBe(true);
    expect(await claim(db, now + LEASE_MS - 1)).toHaveLength(0);
    const recovered = await claim(db, now + LEASE_MS); expect(recovered).toHaveLength(2);
    expect(recovered.every((r) => r.attempt_count === 2 && r.lease_token !== claims.flat()[0].lease_token)).toBe(true);
  });
  it('stale рядок не скасовує інші ACK; повтор не зменшує count удруге', async () => {
    await seed(2); const claimed = await claim(db, now);
    await db.prepare('UPDATE event_delivery SET lease_token = ? WHERE event_id = ?').bind(id(999), id(10)).run();
    const statuses = new Map(claimed.map((r) => [r.event_id, 'accepted' as const]));
    await applyResults(db, claimed, statuses, new Map(), now + 1000, () => 0); expect(await count()).toBe(1);
    expect((await readStatus(db,'normal', now + 1000)).delivery.last_ack_at).toBe(now + 1000);
    await applyResults(db, claimed, statuses, new Map(), now + 2000, () => 0); expect(await count()).toBe(1);
    expect((await readStatus(db,'normal', now + 2000)).delivery.last_ack_at).toBe(now + 1000);
    expect((await rows()).map((r) => r.status)).toEqual(['in_flight', 'delivered']);
  });
  it('stale ACK without a previous accepted result never invents last_ack_at', async () => {
    await seed(1); const claimed = await claim(db, now);
    await db.prepare('UPDATE event_delivery SET lease_token = ?').bind(id(999)).run();
    await applyResults(db, claimed, new Map([[id(10), 'accepted']]), new Map(), now + 1000, () => 0);
    expect((await readStatus(db,'normal', now + 1000)).delivery.last_ack_at).toBeNull();
  });
  it('ACK після lease expiry не застосовується', async () => {
    await seed(1); const claimed = await claim(db, now);
    await applyResults(db, claimed, new Map([[id(10), 'accepted']]), new Map(), now + LEASE_MS, () => 0);
    expect(await count()).toBe(1); expect((await rows())[0].status).toBe('in_flight');
    expect((await readStatus(db,'normal', now + LEASE_MS)).delivery.last_ack_at).toBeNull();
  });
  it.each(['claim', 'ack'] as const)('невідомий %s commit без компенсації або негайного повтору', async (phase) => {
    await seed(1); let calls = 0;
    const wrapped = new Proxy(db, { get(target, key) {
      if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
        calls++; const result = await target.batch(statements);
        if (calls === (phase === 'claim' ? 2 : 3)) throw new Error('unknown_commit');
        return result;
      };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const send = vi.fn(async () => ack([id(10)]));
    expect(await run(now, { db: wrapped, send })).toBe(phase === 'claim' ? 'claim_unknown' : 'ack_unknown');
    expect(calls).toBe(phase === 'claim' ? 2 : 3);
    expect(send).toHaveBeenCalledTimes(phase === 'claim' ? 0 : 1);
    expect(await count()).toBe(phase === 'claim' ? 1 : 0);
    await run(now + LEASE_MS); expect(await count()).toBe(0);
  });
  it('unavailable не пише receiver, backoff не скидається після normal', async () => {
    await seed(1); await run(now, { mode: 'unavailable' });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM mock_received_events').first('n')).toBe(0);
    await run(now + 59_999); expect(await count()).toBe(1);
    await run(now + 60_000); expect(await count()).toBe(0);
  });
  it('5 секунд охоплюють відповідь ACK; пізній успіх ігнорується', async () => {
    await seed(1); let time = now;
    await run(now, { now: () => time, send: async (body) => { const response = await receive(db, body, 'normal', now); time += 5000; return response; } });
    expect(await count()).toBe(1); expect((await rows())[0]).toMatchObject({ last_error_code: 'timeout', next_attempt_at: now + 65_000 });
  });
  it('timer завершує завислий приймач; пізня відповідь не змінює результат', async () => {
    await seed(1); vi.useFakeTimers();
    let resolve!: (value: string) => void;
    let started!: () => void;
    const sending = new Promise<void>((done) => { started = done; });
    const running = run(now, { send: () => { started(); return new Promise<string>((accept) => { resolve = accept; }); } });
    try {
      await sending; await vi.advanceTimersByTimeAsync(5001);
      expect(await running).toBe('complete');
      expect((await rows())[0].last_error_code).toBe('timeout');
      resolve(ack([id(10)])); await Promise.resolve();
      expect(await count()).toBe(1);
    } finally { vi.useRealTimers(); }
  });
  it('узгоджений mismatch ставить обидві паузи без ремонту count; повтор не знімає', async () => {
    await seed(1); await db.prepare("UPDATE capacity_control SET used_count = 0 WHERE budget_key = 'undelivered'").run();
    expect(await run()).toBe('integrity_paused'); expect(await count()).toBe(0);
    expect(await db.prepare('SELECT integrity_paused, history_unverified FROM system_control').first()).toEqual({ integrity_paused: 1, history_unverified: 1 });
    await db.prepare("UPDATE capacity_control SET used_count = 1 WHERE budget_key = 'undelivered'").run();
    expect(await reconcileUndelivered(db)).toBe(false); expect((await rows())[0].attempt_count).toBe(0);
  });
  it('integrity guard у claim, receiver та ACK транзакціях', async () => {
    await seed(1); const claimed = await claim(db, now);
    await db.prepare('UPDATE system_control SET integrity_paused = 1').run();
    await expect(claim(db, now + LEASE_MS)).rejects.toThrow();
    await expect(receive(db, await packet(), 'normal', now)).rejects.toThrow();
    await expect(applyResults(db, claimed, new Map([[id(10), 'accepted']]), new Map(), now, () => 0)).rejects.toThrow();
    expect(await count()).toBe(1); expect((await rows())[0].status).toBe('in_flight');
  });
  it('пошкоджений snapshot не перебудовується й не блокує здоровий', async () => {
    await seed(2); await db.prepare("UPDATE events SET payload_json = json_set(payload_json, '$.schema_version', 99) WHERE event_id = ?").bind(id(10)).run();
    await run(); expect(await count()).toBe(1);
    expect((await rows()).map((r) => [r.status, r.last_error_code])).toEqual([['pending', 'invalid_snapshot'], ['delivered', null]]);
    expect(await db.prepare("SELECT json_extract(payload_json, '$.schema_version') AS v FROM events WHERE event_id = ?").bind(id(10)).first('v')).toBe(99);
  });
  it('поріг 800 → 799 звільняє pause та змінює epoch рівно раз', async () => {
    await seed(801); await db.prepare("UPDATE capacity_control SET capacity_paused = 1 WHERE budget_key = 'undelivered'").run();
    const claimed = await claim(db, now);
    await applyResults(db, claimed, new Map(claimed.slice(0, 2).map((r) => [r.event_id, 'accepted'])), new Map(), now, () => 0);
    expect(await db.prepare("SELECT used_count, capacity_paused, capacity_epoch FROM capacity_control WHERE budget_key = 'undelivered'").first()).toEqual({ used_count: 799, capacity_paused: 0, capacity_epoch: 1 });
  });
  it('rollback ACK не залишає часткових delivered або звільнень бюджету', async () => {
    await seed(2); const claimed = await claim(db, now);
    await db.prepare("UPDATE capacity_control SET used_count = 1 WHERE budget_key = 'undelivered'").run();
    await expect(applyResults(db, claimed, new Map(claimed.map((r) => [r.event_id, 'accepted'])), new Map(), now, () => 0)).rejects.toThrow();
    expect((await rows()).every((r) => r.status === 'in_flight')).toBe(true); expect(await count()).toBe(1);
  });
  it('порядок next_attempt_at, EventID; відкладені не блокують готові', async () => {
    await seed(3);
    await db.prepare('UPDATE event_delivery SET next_attempt_at = ? WHERE event_id = ?').bind(now + 1, id(10)).run();
    const claimed = await claim(db, now); expect(claimed.map((r) => r.event_id).sort()).toEqual([id(11), id(12)]);
  });
  it('claim обирає точні 10 з 14 ready за next_attempt_at, потім EventID', async () => {
    await seed(14);
    const offsets = [0, 5, 1, 2, 5, 2, 3, 3, 4, 4, 5, 5, 1, 5];
    await db.batch(offsets.map((offset, index) => db.prepare('UPDATE event_delivery SET next_attempt_at = ? WHERE event_id = ?')
      .bind(now - offset, id(10 + index))));
    const chosen = [11, 14, 20, 21, 23, 18, 19, 16, 17, 13].map(id);
    const remainder = [10, 12, 15, 22].map(id);
    const claimed = await claim(db, now);
    // RETURNING не обіцяє порядок; перевіряємо саме склад набору.
    expect(claimed).toHaveLength(10);
    expect(new Set(claimed.map((row) => row.event_id))).toEqual(new Set(chosen));
    const delivery = await rows();
    expect(delivery.filter((row) => row.status === 'pending').map((row) => row.event_id)).toEqual(remainder);
    expect(delivery.filter((row) => row.status === 'in_flight').map((row) => row.event_id)).toEqual([...chosen].sort());
    expect(delivery.filter((row) => row.status === 'pending').every((row) => row.attempt_count === 0)).toBe(true);
    expect(await count()).toBe(14);
  });
  it('порожній Cron не пише рядки; невідомий mode відхилено', async () => {
    const before = await db.prepare('SELECT * FROM capacity_control').all();
    expect(await run()).toBe('complete'); expect(await run(now, { mode: undefined })).toBe('invalid_mode');
    expect((await db.prepare('SELECT * FROM capacity_control').all()).results).toEqual(before.results);
  });
  it('межі payload/packet/ACK та backoff', async () => {
    await seed(1); const body = await packet(); const event = JSON.parse(body).events[0];
    expect(() => readSnapshot(JSON.stringify({ ...event, email: 'synthetic@example.test' }))).toThrow();
    expect(() => readSnapshot(' '.repeat(4097))).toThrow();
    expect(() => readSnapshot(JSON.stringify({ ...event, preland_id: 'demo\n' }))).toThrow();
    expect(() => readSnapshot(JSON.stringify({ ...event, event_id: event.event_id + '\n' }))).toThrow();
    expect(() => readPacket(JSON.stringify({ schema_version: 1, events: Array(11).fill(event) }))).toThrow();
    expect(() => readPacket(' '.repeat(65537))).toThrow();
    expect(() => readAck(ack(Array(11).fill(id(10))), [id(10)])).toThrow();
    expect([1, 2, 3, 4, 5, 99].map((a) => backoff(a, () => 0))).toEqual([60000, 120000, 240000, 480000, 900000, 900000]);
    expect(backoff(5, () => 1)).toBe(810000);
  });
});
