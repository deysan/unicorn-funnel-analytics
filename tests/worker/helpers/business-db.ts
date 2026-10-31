import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';

export const db = env.DB;
export const now = 1_800_000_000_000;
export const id = (suffix: number) => `00000000-0000-4000-8000-${suffix.toString(16).padStart(12, '0')}`;
export const userId = id(1);
export const catalogVersion = 'a'.repeat(64);

// reset стосується тільки ізольованого тестового runtime, не dev D1.
export async function freshBusinessDb() {
  await reset();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
}

export function userStatement(user = userId) {
  return db.prepare(`INSERT INTO users (user_id, created_at, last_active_at, access_secret_hash)
    VALUES (?, ?, ?, ?)`).bind(user, now, now, user.replaceAll('-', '').padEnd(64, '0'));
}

type EventKind = 'funnel_entered' | 'question_viewed' | 'answer_confirmed' | 'offer_transition' | 'Lead' | 'Purchase';
export function eventStatement(eventId: string, type: EventKind = 'funnel_entered', options: {
  user?: string; entry?: string; view?: string; completion?: string; question?: string;
  click?: string; offer?: string; flow?: string;
} = {}) {
  return db.prepare(`INSERT INTO events (event_id, event_type, user_id, preland_id,
    occurred_at, received_at, question_id, click_id, offer_id, flow_mode,
    entry_event_id, view_event_id, completion_event_id, schema_version, payload_json)
    VALUES (?, ?, ?, 'demo', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`)
    .bind(eventId, type, options.user ?? userId, now, now, options.question ?? null,
      options.click ?? null, options.offer ?? null, options.flow ?? null,
      options.entry ?? null, options.view ?? null, options.completion ?? null,
      JSON.stringify({ schema_version: 1, event_id: eventId, event_type: type }));
}

export function clickStatement(clickId: string, entryId: string, completionId: string | null = null) {
  return db.prepare(`INSERT INTO clicks (click_id, user_id, offer_id, partner_id, preland_id,
    created_at, offer_name_snapshot, target_url_snapshot, catalog_version, flow_mode,
    entry_event_id, completion_event_id) VALUES (?, ?, '003', 'demo-partner', 'demo', ?,
    'Synthetic offer', ?, ?, ?, ?, ?)`)
    .bind(clickId, userId, now, `https://example.test/?click_id=${clickId}`, catalogVersion,
      completionId ? 'quiz' : 'bypass', entryId, completionId);
}
