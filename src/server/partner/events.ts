import { partnerEventSchema, type PartnerEvent } from '../../shared/partner';
import { PROFILE_TTL_MS } from '../storage/profile';
import { readCapacitySnapshot, reserveCapacity, persistCapacityPause, type Budget } from '../storage/capacity';
import { GuardedBatch, classifyGuard } from '../storage/transaction-guards';

type Outcome = { status: 'accepted' } | { status: 'rejected'; reason: 'validation' | 'conflict' | 'click_unavailable' | 'temporary' | 'capacity' | 'integrity' };
interface Saved { click_id: string; occurred_at: number; amount_minor: number | null; currency: string | null }
interface Click {
  user_id: string; offer_id: string; preland_id: string; partner_id: string; created_at: number;
  selection_revision: number; last_active_at: number | null; expired_at: number | null; latest_lead_at: number | null;
}
function money(event: PartnerEvent) { return event.event_type === 'Purchase' ? [event.amount_minor ?? null, event.currency ?? null] as const : [null, null] as const; }
async function replay(db: D1Database, partnerId: string, event: PartnerEvent): Promise<Outcome | undefined> {
  const saved = await db.prepare(`SELECT click_id, occurred_at, amount_minor, currency FROM partner_events
    WHERE partner_id = ? AND event_type = ? AND partner_event_id = ?`).bind(partnerId, event.event_type, event.partner_event_id).first<Saved>();
  if (!saved) return undefined;
  const [amount, currency] = money(event);
  return saved.click_id === event.click_id && saved.occurred_at === event.occurred_at && saved.amount_minor === amount && saved.currency === currency
    ? { status: 'accepted' } : { status: 'rejected', reason: 'conflict' };
}

// Partner identity is trusted HTTP context. No browser activity, access cookie or request_results.
export async function acceptPartnerEvent(options: { db: D1Database; partnerId: string; input: unknown; now: () => number }): Promise<Outcome> {
  const parsed = partnerEventSchema.safeParse(options.input);
  if (!parsed.success) return { status: 'rejected', reason: 'validation' };
  const event = parsed.data; const { db, partnerId } = options;
  const clock = () => { const value = options.now(); if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid_time'); return value; };
  try {
    const receivedAt = clock();
    for (let attempt = 0; attempt < 3; attempt++) {
      const previous = await replay(db, partnerId, event); if (previous) return previous;
      const click = await db.prepare(`SELECT c.user_id, c.offer_id, c.preland_id, c.partner_id, c.created_at,
        u.selection_revision, u.last_active_at, u.expired_at, l.latest_lead_at
        FROM clicks c JOIN users u ON u.user_id = c.user_id
        LEFT JOIN user_offer_leads l ON l.user_id = c.user_id AND l.offer_id = c.offer_id
        WHERE c.click_id = ? AND c.partner_id = ?`).bind(event.click_id, partnerId).first<Click>();
      if (!click) return await replay(db, partnerId, event) ?? { status: 'rejected', reason: 'click_unavailable' };
      if (event.occurred_at < click.created_at - 300_000 || event.occurred_at > receivedAt + 300_000) return { status: 'rejected', reason: 'validation' };
      if (!Number.isSafeInteger(click.selection_revision) || click.selection_revision >= Number.MAX_SAFE_INTEGER) throw new Error('invalid_revision');
      const capacity = await readCapacitySnapshot(db, { events: 1, undelivered: 1 });
      const eventId = crypto.randomUUID(); const [amount, currency] = money(event);
      const payload = JSON.stringify({ schema_version: 1, event_id: eventId, event_type: event.event_type,
        user_id: click.user_id, preland_id: click.preland_id, click_id: event.click_id, offer_id: click.offer_id,
        partner_id: partnerId, partner_event_id: event.partner_event_id, occurred_at: event.occurred_at, received_at: receivedAt,
        ...(amount === null ? {} : { amount_minor: amount, currency }) });
      if (new TextEncoder().encode(payload).length > 4096) throw new Error('event_too_large');
      const commitTime = clock();
      const active = click.expired_at === null && click.last_active_at !== null && click.last_active_at > commitTime - PROFILE_TTL_MS;
      const changesLead = event.event_type === 'Lead' && active && (click.latest_lead_at === null || event.occurred_at > click.latest_lead_at);
      const batch = new GuardedBatch(db);
      batch.assert('reference', { sql: `EXISTS (SELECT 1 FROM clicks WHERE click_id = ? AND partner_id = ? AND user_id = ?
        AND offer_id = ? AND preland_id = ? AND created_at = ?)`, bindings: [event.click_id, partnerId, click.user_id, click.offer_id, click.preland_id, click.created_at] });
      if (event.event_type === 'Lead') {
        batch.assert('revision', { sql: '(SELECT selection_revision FROM users WHERE user_id = ?) = ?', bindings: [click.user_id, click.selection_revision] });
        // TTL is checked at commitTime independently of revision, even for a revoked browser cookie.
        batch.assert('access', { sql: `EXISTS (SELECT 1 FROM users WHERE user_id = ? AND
          (expired_at IS NULL AND last_active_at IS NOT NULL AND last_active_at > ?) = ?)`, bindings: [click.user_id, commitTime - PROFILE_TTL_MS, active ? 1 : 0] });
      }
      reserveCapacity(batch, { events: 1, undelivered: 1 }, capacity);
      batch.effect({ changes: 1, statement: db.prepare(`INSERT INTO partner_events
        (event_id, partner_id, event_type, partner_event_id, click_id, user_id, offer_id, preland_id, occurred_at, received_at, amount_minor, currency)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(eventId, partnerId, event.event_type, event.partner_event_id, event.click_id, click.user_id, click.offer_id, click.preland_id, event.occurred_at, receivedAt, amount, currency) });
      batch.effect({ changes: 1, statement: db.prepare(`INSERT INTO events
        (event_id, event_type, user_id, preland_id, occurred_at, received_at, click_id, offer_id, schema_version, payload_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`).bind(eventId, event.event_type, click.user_id, click.preland_id, event.occurred_at, receivedAt, event.click_id, click.offer_id, payload) });
      batch.effect({ changes: 1, statement: db.prepare("INSERT INTO event_delivery (event_id, status, next_attempt_at) VALUES (?, 'pending', ?)").bind(eventId, receivedAt) });
      if (changesLead) {
        batch.effect({ changes: 1, statement: db.prepare(`INSERT INTO user_offer_leads (user_id, offer_id, latest_lead_at) VALUES (?, ?, ?)
          ON CONFLICT(user_id, offer_id) DO UPDATE SET latest_lead_at = excluded.latest_lead_at WHERE excluded.latest_lead_at > latest_lead_at`).bind(click.user_id, click.offer_id, event.occurred_at) });
        batch.effect({ changes: 1, statement: db.prepare('UPDATE users SET selection_revision = selection_revision + 1 WHERE user_id = ?').bind(click.user_id) });
      }
      try { await db.batch(batch.finish()); return { status: 'accepted' }; }
      catch (error) {
        const winner = await replay(db, partnerId, event); if (winner) return winner;
        const failure = classifyGuard(error);
        if (failure === 'revision' && attempt < 2) continue;
        if (failure.startsWith('capacity_')) {
          const budget = failure.slice('capacity_'.length) as Budget;
          await persistCapacityPause(db, budget, capacity[budget]!);
          return { status: 'rejected', reason: 'capacity' };
        }
        if (failure === 'reference') return { status: 'rejected', reason: 'click_unavailable' };
        if (failure === 'integrity') return { status: 'rejected', reason: 'integrity' };
        return { status: 'rejected', reason: 'temporary' };
      }
    }
  } catch { return { status: 'rejected', reason: 'temporary' }; }
  return { status: 'rejected', reason: 'temporary' };
}
