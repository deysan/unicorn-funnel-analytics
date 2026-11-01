import { availableFrom, DAY, filtersSchema, funnelSchema, reportQuestions, reportStatusSchema, utcDay, type ReportQuery } from '../../shared/report';
import { getOfferCatalog } from '../offers/catalog';
import { HttpFailure } from '../http/security';
import { BUDGETS } from '../storage/capacity';
const clock = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
const unique = (source: string, condition: string) => `(SELECT COUNT(DISTINCT user_id) FROM ${source} WHERE ${condition})`;
const pair = (numerator: number, denominator: number) => ({ numerator, denominator });
// One SELECT owns the event snapshot, metadata and clock. No event rows leave D1.
export const funnelSql = `WITH
 clock AS (SELECT COALESCE(?1, ${clock}) AS updated_at),
 selected AS (SELECT * FROM events WHERE (?4 IS NULL OR preland_id = ?4)),
 activity AS (SELECT * FROM selected WHERE occurred_at >= ?2 AND occurred_at < ?3),
 offer_activity AS (SELECT * FROM activity WHERE (?5 IS NULL OR offer_id = ?5)),
 question_cohort AS (SELECT user_id, question_id, MIN(occurred_at) AS first_at FROM activity WHERE event_type = 'question_viewed' GROUP BY user_id, question_id),
 start_cohort AS (SELECT user_id, MIN(occurred_at) AS first_at FROM activity WHERE event_type = 'question_viewed' GROUP BY user_id),
 valid_answers AS (SELECT a.*, v.occurred_at AS view_at FROM selected a JOIN events v ON v.event_id = a.view_event_id
   AND v.event_type = 'question_viewed' AND v.user_id = a.user_id AND v.preland_id = a.preland_id
   AND v.question_id = a.question_id AND v.occurred_at <= a.occurred_at WHERE a.event_type = 'answer_confirmed'),
 question_results AS (SELECT DISTINCT c.user_id, c.question_id FROM question_cohort c JOIN valid_answers a
   ON a.user_id = c.user_id AND a.question_id = c.question_id AND a.view_at >= c.first_at),
 completions AS (SELECT a.* FROM start_cohort c JOIN valid_answers a ON a.user_id = c.user_id
   AND a.question_id = 'email' AND a.view_at >= c.first_at),
 quiz_transitions AS (SELECT DISTINCT t.user_id FROM completions a JOIN selected t ON t.completion_event_id = a.event_id
   AND t.user_id = a.user_id AND t.preland_id = a.preland_id AND t.occurred_at >= a.occurred_at
   AND t.event_type = 'offer_transition' AND t.flow_mode = 'quiz'),
 transition_cohort AS (SELECT * FROM offer_activity WHERE event_type = 'offer_transition'),
 transition_results AS (SELECT DISTINCT t.user_id, p.event_type FROM transition_cohort t JOIN events p ON p.click_id = t.click_id
   AND p.user_id = t.user_id AND p.preland_id = t.preland_id AND p.offer_id = t.offer_id AND p.event_type IN ('Lead', 'Purchase'))
 SELECT clock.updated_at, s.history_unverified, s.history_available_from,
 ${unique('activity', "event_type = 'funnel_entered'")} AS entered,
 ${unique('activity', "event_type = 'question_viewed'")} AS started,
 ${unique('activity', "event_type = 'answer_confirmed' AND question_id = 'email'")} AS completed,
 ${reportQuestions.map((q) => `${unique('activity', `event_type = 'question_viewed' AND question_id = '${q}'`)} AS ${q}_viewed,
 ${unique('activity', `event_type = 'answer_confirmed' AND question_id = '${q}'`)} AS ${q}_confirmed,
 ${unique('question_results', `question_id = '${q}'`)} AS ${q}_converted`).join(',\n')},
 ${unique('completions', '1')} AS started_completed,
 ${unique('quiz_transitions', '1')} AS started_offer,
 ${unique('offer_activity', "event_type = 'offer_transition'")} AS transitioned,
 ${unique('offer_activity', "event_type = 'offer_transition' AND flow_mode = 'bypass'")} AS bypass,
 ${unique('offer_activity', "event_type = 'Lead'")} AS leads,
 ${unique('offer_activity', "event_type = 'Purchase'")} AS buyers,
 (SELECT COUNT(*) FROM offer_activity WHERE event_type = 'Purchase') AS purchases,
 ${unique('transition_results', "event_type = 'Lead'")} AS transition_lead,
 ${unique('transition_results', "event_type = 'Purchase'")} AS transition_purchase
 FROM clock LEFT JOIN system_control s ON s.singleton_id = 1`;
export async function readFunnel(db: D1Database, filters: ReportQuery, testNow?: number) {
  const row = await db.prepare(funnelSql).bind(testNow ?? null, Date.parse(filters.from + 'T00:00:00Z'), Date.parse(filters.to + 'T00:00:00Z') + DAY, filters.preland_id ?? null, filters.offer_id ?? null).first<Record<string, number | null>>();
  if (!row || !Number.isSafeInteger(row.updated_at) || ![0, 1].includes(row.history_unverified!)) throw new Error('history_metadata_invalid');
  if (filters.to > utcDay(row.updated_at!)) throw new HttpFailure('validation_failed', 400);
  const base = { updated_at: row.updated_at, filters };
  if (row.history_unverified === 1) return funnelSchema.parse({ ...base, report_status: 'unavailable', reason: 'history_unverified' });
  if (row.history_available_from === null) throw new Error('history_metadata_missing');
  const available_from = utcDay(availableFrom(row.history_available_from, row.updated_at!));
  if (filters.from < available_from) return funnelSchema.parse({ ...base, report_status: 'unavailable', reason: 'period_unavailable', available_from });
  const n = (key: string) => row[key] as number;
  const questionActivity = Object.fromEntries(reportQuestions.map((q) => [q, { viewed: n(q + '_viewed'), confirmed: n(q + '_confirmed') }]));
  const questionConversions = Object.fromEntries(reportQuestions.map((q) => [q, pair(n(q + '_converted'), n(q + '_viewed'))]));
  return funnelSchema.parse({ ...base, report_status: 'ready', available_from, metrics: {
    quiz: { activity: { entered: n('entered'), started: n('started'), questions: questionActivity, completed: n('completed') },
      conversions: { questions: questionConversions, started_completed: pair(n('started_completed'), n('started')), started_offer: pair(n('started_offer'), n('started')) } },
    offers: { activity: { transitioned: n('transitioned'), bypass: n('bypass'), leads: n('leads'), buyers: n('buyers'), purchases: n('purchases') },
      conversions: { transition_lead: pair(n('transition_lead'), n('transitioned')), transition_purchase: pair(n('transition_purchase'), n('transitioned')) } },
  } });
}
export async function readFilters(db: D1Database) {
  const catalog = await getOfferCatalog();
  const rows = (await db.prepare(`WITH ids AS (
    SELECT 'preland' AS kind, preland_id AS id FROM events UNION SELECT 'preland', preland_id FROM clicks
    UNION SELECT 'offer', offer_id FROM events WHERE offer_id IS NOT NULL UNION SELECT 'offer', offer_id FROM clicks
    UNION SELECT 'preland', 'demo') SELECT kind, id, ${clock} AS updated_at FROM ids ORDER BY kind, id`).all<{kind: string; id: string; updated_at: number}>()).results;
  const offers = new Map(catalog.offers.map((o) => [o.id, { id: o.id, name: o.name, status: o.active ? 'active' as const : 'inactive' as const }]));
  const historical = rows.filter((r) => r.kind === 'offer' && !catalog.offers.some((o) => o.id === r.id));
  return filtersSchema.parse({ updated_at: rows[0]?.updated_at, catalog_version: catalog.version, prelands: rows.filter((r) => r.kind === 'preland').map((r) => r.id),
    offers: [...offers.values(), ...historical.map((r) => ({ id: r.id, status: 'historical' }))].sort((a, b) => a.id.localeCompare(b.id)) });
}
export async function readStatus(db: D1Database) {
  const row = await db.prepare(`SELECT ${clock} AS updated_at, s.*,
    (SELECT COUNT(*) FROM event_delivery WHERE status = 'pending') AS pending,
    (SELECT COUNT(*) FROM event_delivery WHERE status = 'in_flight') AS in_flight,
    (SELECT COUNT(*) FROM event_delivery WHERE status = 'delivered') AS delivered,
    (SELECT json_group_array(json_object('key', budget_key, 'used', used_count, 'paused', capacity_paused)) FROM capacity_control) AS budgets
    FROM system_control s WHERE singleton_id = 1`).first<{updated_at: number; integrity_paused: number; history_unverified: number; history_available_from: number | null; pending: number; in_flight: number; delivered: number; budgets: string}>();
  if (!row || ![0, 1].includes(row.integrity_paused) || ![0, 1].includes(row.history_unverified)) throw new Error('control_invalid');
  const budgets = JSON.parse(row.budgets) as {key: keyof typeof BUDGETS; used: number; paused: number}[];
  if (budgets.length !== 4 || new Set(budgets.map((b) => b.key)).size !== 4 || budgets.some((b) => !Object.hasOwn(BUDGETS, b.key) || ![0, 1].includes(b.paused) || b.used > BUDGETS[b.key].limit)) throw new Error('control_invalid');
  let history_metadata: 'missing' | 'confirmed' | 'invalid' = row.history_available_from === null ? 'missing' : 'confirmed';
  if (row.history_available_from !== null) try { availableFrom(row.history_available_from, row.updated_at); } catch { history_metadata = 'invalid'; }
  return reportStatusSchema.parse({ updated_at: row.updated_at, delivery: { pending: row.pending, in_flight: row.in_flight, delivered: row.delivered },
    budgets: budgets.map((b) => ({ key: b.key, used: b.used, limit: BUDGETS[b.key].limit, paused: b.paused === 1 })),
    integrity_paused: row.integrity_paused === 1, history_unverified: row.history_unverified === 1, history_metadata,
    cron: 'not_implemented', export: 'not_implemented' });
}
