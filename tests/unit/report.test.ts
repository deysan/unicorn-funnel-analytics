import { expect, it } from 'vitest';
import { availableFrom, conversionSchema, DAY, formatConversion, funnelSchema, parseReportQuery, queryString } from '../../src/shared/report';
const now = Date.parse('2026-10-31T12:00:00Z');
it('preserves exact identifiers and UTC inclusive dates', () => {
  const query = parseReportQuery(new URLSearchParams('from=2026-10-30&to=2026-10-31&offer_id=001&preland_id=demo-1'), now);
  expect(query.offer_id).toBe('001'); expect(queryString(query)).toContain('offer_id=001');
});
it.each(['', 'from=2026-10-31', 'from=2026-02-30&to=2026-10-31', 'from=2025-02-29&to=2026-10-31',
  'from=2026-10-31&to=2026-11-01', 'from=2026-10-31&to=2026-10-30', 'from=2026-10-31T00:00:00Z&to=2026-10-31',
  'from=2026-10-31&to=2026-10-31&from=2026-10-31', 'from=2026-10-31&to=2026-10-31&offer_id=',
  'from=2026-10-31&to=2026-10-31&offer_id=1', 'from=2026-10-31&to=2026-10-31&offer_id[]=001',
  'from=2026-10-31&to=2026-10-31&preland_id=Demo', 'from=2026-10-31&to=2026-10-31&preland_id=demo%0A',
  'from=2026-10-31&to=2026-10-31&extra=1', 'from=2026-10-31&to=2026-10-31&offer_id=001&offer_id=003'])('rejects malformed query %s', (query) => {
  expect(() => parseReportQuery(new URLSearchParams(query), now)).toThrow();
});
it('allows valid leap day and historical catalog ids', () => expect(parseReportQuery(new URLSearchParams('from=2024-02-29&to=2024-02-29&offer_id=999'), now).offer_id).toBe('999'));
it('strict retention advances at midnight of now minus 90 days plus five minutes', () => {
  const boundary = Date.parse('2026-01-01'); const pivot = Date.parse('2026-10-31');
  expect(availableFrom(boundary, pivot - 300_001)).toBe(pivot - 90 * DAY);
  expect(availableFrom(boundary, pivot - 300_000)).toBe(pivot - 89 * DAY);
  expect(availableFrom(pivot, pivot + 1)).toBe(pivot);
  for (const b of [-1, 1, pivot + DAY, NaN]) expect(() => availableFrom(b, pivot)).toThrow();
});
it('exact conversion pairs reject corrupt values instead of clamping', () => {
  expect(formatConversion({numerator:0,denominator:0})).toBe('немає даних');
  expect(formatConversion({numerator:0,denominator:3})).toBe('0,0%');
  expect(formatConversion({numerator:1,denominator:3})).toBe('33,3%');
  for(const p of [{numerator:2,denominator:1},{numerator:-1,denominator:2},{numerator:0.1,denominator:2}]) expect(conversionSchema.safeParse(p).success).toBe(false);
});
it('unverified DTO cannot expose metrics or invented history boundary', () => {
  const dto = {report_status:'unavailable',reason:'history_unverified',updated_at:now,filters:{from:'2026-10-31',to:'2026-10-31'}};
  expect(funnelSchema.safeParse(dto).success).toBe(true);
  for(const extra of [{metrics:{}},{available_from:'2026-10-31'},{email:'Synthetic@example.test'}]) expect(funnelSchema.safeParse({...dto,...extra}).success).toBe(false);
});
