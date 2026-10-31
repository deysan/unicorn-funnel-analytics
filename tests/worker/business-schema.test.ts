import { beforeEach, expect, it } from 'vitest';
import { catalogVersion, clickStatement, db, eventStatement, freshBusinessDb, id, now, userId, userStatement } from './helpers/business-db';

beforeEach(async () => { await freshBusinessDb(); await userStatement().run(); });

it('створює чотири незалежні бюджети та окремі контрольні прапорці', async () => {
  const rows = await db.prepare('SELECT * FROM capacity_control ORDER BY budget_key').all();
  expect(rows.results).toEqual(['command_keys', 'events', 'profiles', 'undelivered'].map((budget_key) => ({
    budget_key, used_count: 0, capacity_paused: 0, capacity_epoch: 0,
  })));
  expect(await db.prepare('SELECT * FROM system_control').first()).toEqual({
    singleton_id: 1, integrity_paused: 0, history_unverified: 0, history_available_from: null,
  });
});

it('утримує причинні докази й профіль, а явне видалення у правильному порядку працює', async () => {
  const entry = id(10), view = id(11), completion = id(12), click = id(13), transition = id(14);
  await db.batch([
    eventStatement(entry), eventStatement(view, 'question_viewed', { entry, question: 'email' }),
    eventStatement(completion, 'answer_confirmed', { view, question: 'email' }),
    clickStatement(click, entry, completion),
    eventStatement(transition, 'offer_transition', { entry, completion, click, offer: '003', flow: 'quiz' }),
    db.prepare("INSERT INTO event_delivery (event_id, status, next_attempt_at) VALUES (?, 'pending', ?)").bind(transition, now),
  ]);
  for (const event of [entry, view, completion, transition]) {
    await expect(db.prepare('DELETE FROM events WHERE event_id = ?').bind(event).run()).rejects.toThrow('FOREIGN KEY');
  }
  await expect(db.prepare('DELETE FROM users WHERE user_id = ?').bind(userId).run()).rejects.toThrow('FOREIGN KEY');
  await db.batch([
    db.prepare('DELETE FROM event_delivery'),
    db.prepare('DELETE FROM events WHERE event_id = ?').bind(transition),
    db.prepare('DELETE FROM clicks'),
    db.prepare('DELETE FROM events WHERE event_id = ?').bind(completion),
    db.prepare('DELETE FROM events WHERE event_id = ?').bind(view),
    db.prepare('DELETE FROM events WHERE event_id = ?').bind(entry),
    db.prepare('DELETE FROM users'),
  ]);
  expect(await db.prepare('PRAGMA foreign_key_check').all()).toMatchObject({ results: [] });
});

it('партнерський ключ, Lead та імітатор переживають видалення події й ClickID', async () => {
  const entry = id(10), click = id(13), lead = id(20);
  await db.batch([
    eventStatement(entry), clickStatement(click, entry), eventStatement(lead, 'Lead', { click, offer: '003' }),
    db.prepare(`INSERT INTO partner_events (event_id, partner_id, event_type, partner_event_id,
      click_id, user_id, offer_id, preland_id, occurred_at, received_at)
      VALUES (?, 'demo-partner', 'Lead', 'registration-1', ?, ?, '003', 'demo', ?, ?)`)
      .bind(lead, click, userId, now, now),
    db.prepare("INSERT INTO user_offer_leads VALUES (?, '003', ?)").bind(userId, now),
    db.prepare('INSERT INTO mock_received_events VALUES (?, ?, ?, ?)').bind(lead, '{}', catalogVersion, now),
  ]);
  await db.batch([
    db.prepare('DELETE FROM events WHERE event_id = ?').bind(lead),
    db.prepare('DELETE FROM clicks WHERE click_id = ?').bind(click),
  ]);
  expect(await db.prepare('SELECT click_id FROM partner_events').first('click_id')).toBe(click);
  expect(await db.prepare('SELECT latest_lead_at FROM user_offer_leads').first('latest_lead_at')).toBe(now);
  expect(await db.prepare('SELECT event_id FROM mock_received_events').first('event_id')).toBe(lead);
  await expect(db.prepare("INSERT INTO user_offer_leads VALUES (?, '003', ?)").bind(userId, now).run()).rejects.toThrow('UNIQUE');
});

it('дві покупки одного переходу дозволені, але повтор партнерського ключа — ні', async () => {
  const purchase = (event: number, key: string, amount: number | null, currency: string | null) => db.prepare(`INSERT INTO partner_events
    (event_id, partner_id, event_type, partner_event_id, click_id, user_id, offer_id, preland_id, occurred_at, received_at, amount_minor, currency)
    VALUES (?, 'demo-partner', 'Purchase', ?, ?, ?, '003', 'demo', ?, ?, ?, ?)`)
    .bind(id(event), key, id(13), userId, now, now, amount, currency);
  await db.batch([purchase(20, 'p-1', null, null), purchase(21, 'p-2', 100, 'USD')]);
  await expect(purchase(22, 'p-1', null, null).run()).rejects.toThrow('UNIQUE');
  for (const [amount, currency] of [[0, 'USD'], [1000001, 'USD'], [1, 'EUR'], [1, null], [null, 'USD']] as const) {
    await expect(purchase(23, 'invalid', amount, currency).run()).rejects.toThrow('CHECK');
  }
  expect(await db.prepare('SELECT COUNT(*) AS total FROM partner_events').first('total')).toBe(2);
});

it('не дозволяє частково очищений профіль-залишок або каскадне видалення історії', async () => {
  await db.batch([eventStatement(id(10)), db.prepare("UPDATE users SET preferred_gender = 'women', selection_revision = 4 WHERE user_id = ?").bind(userId)]);
  await expect(db.prepare('UPDATE users SET expired_at = ? WHERE user_id = ?').bind(now, userId).run()).rejects.toThrow('CHECK');
  await db.prepare(`UPDATE users SET expired_at = ?, created_at = NULL, last_active_at = NULL,
    preferred_gender = NULL, preferred_ethnicity = NULL, email = NULL, email_confirmed_at = NULL,
    access_secret_hash = NULL, revoked_at = NULL, selection_revision = selection_revision + 1 WHERE user_id = ?`).bind(now, userId).run();
  expect(await db.prepare('SELECT access_secret_hash FROM users').first('access_secret_hash')).toBeNull();
  expect(await db.prepare('SELECT selection_revision FROM users').first('selection_revision')).toBe(5);
  expect(await db.prepare('SELECT COUNT(*) AS total FROM events').first('total')).toBe(1);
});

it('SQL відхиляє відсутні причинні поля й неповний lease доставки', async () => {
  await expect(eventStatement(id(11), 'question_viewed', { question: 'email' }).run()).rejects.toThrow('CHECK');
  await eventStatement(id(10)).run();
  await expect(db.prepare("INSERT INTO event_delivery (event_id, status) VALUES (?, 'in_flight')").bind(id(10)).run()).rejects.toThrow('CHECK');
  await expect(eventStatement(id(12), 'question_viewed', { entry: id(999), question: 'email' }).run()).rejects.toThrow('FOREIGN KEY');
});

it('байтові обмеження застосовуються до UTF-8 та JSON, а не лише числа символів', async () => {
  await eventStatement(id(10)).run();
  await clickStatement(id(13), id(10)).run();
  await expect(db.prepare('UPDATE clicks SET offer_name_snapshot = ?').bind('я'.repeat(129)).run()).rejects.toThrow('CHECK');
  await expect(db.prepare('UPDATE events SET payload_json = ?').bind(JSON.stringify({ x: 'я'.repeat(2048) })).run()).rejects.toThrow('CHECK');
  await expect(db.prepare('UPDATE events SET payload_json = ?').bind('{invalid').run()).rejects.toThrow();
  await expect(db.prepare('UPDATE users SET selection_revision = 1.5').run()).rejects.toThrow();
});
