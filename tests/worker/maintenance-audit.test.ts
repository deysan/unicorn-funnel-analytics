import { beforeEach, expect, it } from 'vitest';
import { DAY } from '../../src/shared/report';
import { runDelivery } from '../../src/server/delivery/executor';
import { runCleanup } from '../../src/server/maintenance/cleanup';
import { runMaintenance } from '../../src/server/maintenance/coordinator';
import { acceptPartnerEvent } from '../../src/server/partner/events';
import { clickStatement, db, eventStatement, freshBusinessDb, id, now, userId, userStatement } from './helpers/business-db';

const budget = (key: string) => db.prepare('SELECT used_count FROM capacity_control WHERE budget_key = ?')
  .bind(key).first<number>('used_count');

beforeEach(freshBusinessDb);

it('late Purchase keeps its own 90 days from receipt after its click and occurrence have expired', async () => {
  const entryId = id(10);
  const clickId = id(20);
  const receivedAt = now + 89 * DAY;
  const expiresAt = receivedAt + 90 * DAY;
  await db.batch([
    userStatement(), eventStatement(entryId), clickStatement(clickId, entryId),
    db.prepare("INSERT INTO event_delivery (event_id, status, next_attempt_at) VALUES (?, 'pending', ?)").bind(entryId, now),
    db.prepare("UPDATE capacity_control SET used_count = CASE budget_key WHEN 'profiles' THEN 1 WHEN 'events' THEN 1 WHEN 'undelivered' THEN 1 ELSE 0 END"),
    db.prepare('UPDATE system_control SET history_available_from = ?').bind(Math.floor(now / DAY) * DAY),
  ]);
  const purchase = { event_type: 'Purchase', partner_event_id: 'synthetic-late-purchase',
    click_id: clickId, occurred_at: new Date(now).toISOString(), amount_minor: 2500, currency: 'USD' };
  expect(await acceptPartnerEvent({ db, partnerId: 'demo-partner', input: purchase, now: () => receivedAt }))
    .toEqual({ status: 'accepted' });
  const saved = await db.prepare('SELECT event_id, occurred_at, received_at FROM partner_events WHERE partner_event_id = ?')
    .bind(purchase.partner_event_id).first<{ event_id: string; occurred_at: number; received_at: number }>();
  expect(saved).toMatchObject({ occurred_at: now, received_at: receivedAt });
  const purchaseId = saved!.event_id;

  expect(await runDelivery({ db, mode: 'normal', now: () => receivedAt })).toBe('complete');
  expect(await db.prepare('SELECT status FROM event_delivery WHERE event_id = ?').bind(purchaseId).first('status'))
    .toBe('delivered');
  expect(await budget('events')).toBe(2);
  expect(await budget('undelivered')).toBe(0);

  // The click and occurred_at reach 90 days together; this Purchase was only received yesterday.
  await runCleanup(db, now + 90 * DAY);
  expect(await db.prepare('SELECT click_id FROM clicks WHERE click_id = ?').bind(clickId).first()).toBeNull();
  expect(await db.prepare('SELECT event_id FROM events WHERE event_id = ?').bind(entryId).first()).toBeNull();
  const retained = async () => {
    expect(await db.prepare('SELECT occurred_at, received_at FROM events WHERE event_id = ?').bind(purchaseId).first())
      .toEqual({ occurred_at: now, received_at: receivedAt });
    expect(await db.prepare('SELECT event_id, received_at FROM partner_events WHERE partner_event_id = ?')
      .bind(purchase.partner_event_id).first()).toEqual({ event_id: purchaseId, received_at: receivedAt });
    expect(await db.prepare('SELECT event_id FROM mock_received_events WHERE event_id = ?').bind(purchaseId).first('event_id'))
      .toBe(purchaseId);
    expect(await budget('events')).toBe(1);
    expect(await budget('undelivered')).toBe(0);
  };
  await retained();
  expect(await acceptPartnerEvent({ db, partnerId: 'demo-partner', input: purchase, now: () => now + 90 * DAY }))
    .toEqual({ status: 'accepted' });
  await runCleanup(db, expiresAt - 1);
  await retained();

  await runCleanup(db, expiresAt);
  for (const table of ['events', 'event_delivery', 'partner_events', 'mock_received_events']) {
    expect(await db.prepare(`SELECT event_id FROM ${table} WHERE event_id = ?`).bind(purchaseId).first()).toBeNull();
  }
  expect(await budget('events')).toBe(0);
  expect(await budget('undelivered')).toBe(0);
  expect(await budget('profiles')).toBe(1);
});

it('the coordinator counts current delivery errors without reading thousands of delivered rows', async () => {
  await userStatement().run();
  await db.prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < 4000)
    INSERT INTO events (event_id, event_type, user_id, preland_id, occurred_at, received_at, schema_version, payload_json)
    SELECT 'synthetic-delivered-' || printf('%05d', i), 'funnel_entered', ?, 'demo', ?, ?, 1, '{}' FROM n`)
    .bind(userId, now, now).run();
  await db.prepare("INSERT INTO event_delivery (event_id, status, delivered_at) SELECT event_id, 'delivered', received_at FROM events").run();
  const pendingId = id(30);
  await db.batch([
    eventStatement(pendingId),
    db.prepare(`INSERT INTO event_delivery (event_id, status, next_attempt_at, last_error_code)
      VALUES (?, 'pending', ?, 'receiver_unavailable')`).bind(pendingId, now + 60_000),
    db.prepare("UPDATE capacity_control SET used_count = CASE budget_key WHEN 'profiles' THEN 1 WHEN 'events' THEN 4001 WHEN 'undelivered' THEN 1 ELSE 0 END"),
    db.prepare('UPDATE system_control SET history_available_from = ?').bind(Math.floor(now / DAY) * DAY),
  ]);

  const measured: { rowsRead: number; value: unknown }[] = [];
  const instrumented = new Proxy(db, { get(target, key) {
    if (key === 'prepare') return (sql: string) => {
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(st, method) {
        if (method === 'bind') return (...values: unknown[]) => wrap(st.bind(...values));
        if (method === 'first' && sql.includes('event_delivery') && sql.includes('last_error_code')) {
          return async (column?: string) => {
            // Execute the statement supplied by production once. all() exposes the metadata that first() discards.
            const result = await st.all<Record<string, unknown>>();
            const row = result.results[0];
            const value = row === undefined ? null : column === undefined ? row : row[column];
            measured.push({ rowsRead: result.meta.rows_read, value });
            return value;
          };
        }
        const value = Reflect.get(st, method);
        return typeof value === 'function' ? value.bind(st) : value;
      } });
      return wrap(target.prepare(sql));
    };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });

  const result = await runMaintenance({ db: instrumented, mode: 'normal', now: () => now });
  expect(result.errors).toEqual(['delivery_items_failed']);
  expect(measured).toHaveLength(1);
  expect(measured[0].value).toBe(1);
  expect(measured[0].rowsRead).toBeLessThan(10);
  expect(await db.prepare("SELECT COUNT(*) AS n FROM event_delivery WHERE status = 'delivered'").first('n')).toBe(4000);
  expect(await db.prepare('SELECT status, last_error_code FROM event_delivery WHERE event_id = ?').bind(pendingId).first())
    .toEqual({ status: 'pending', last_error_code: 'receiver_unavailable' });
});
