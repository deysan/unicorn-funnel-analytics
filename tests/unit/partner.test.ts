import { describe, expect, it } from 'vitest';
import { partnerEventSchema, partnerTime } from '../../src/shared/partner';
const lead = { event_type: 'Lead', partner_event_id: 'Order:A.1_x-2', click_id: 'ABCDEF00-0000-4000-8000-000000000001', occurred_at: '2026-10-31T12:00:00.123Z' };
describe('partner strict DTO and time', () => {
  it('normalizes UUID case and equivalent instants while keeping opaque ID case', () => {
    const parsed = partnerEventSchema.parse(lead); expect(parsed.click_id).toBe(lead.click_id.toLowerCase()); expect(parsed.partner_event_id).toBe(lead.partner_event_id);
    expect(partnerTime('2026-10-31T14:00:00.123+02:00')).toBe(parsed.occurred_at);
    expect(partnerTime('2026-10-31T10:00:00.123-02:00')).toBe(parsed.occurred_at);
    expect(partnerTime('2024-02-29T00:00:00Z')).toBe(Date.UTC(2024, 1, 29));
  });
  for (const value of ['2026-02-29T12:00:00Z','2026-04-31T12:00:00Z','2026-10-31T24:00:00Z','2026-10-31T12:60:00Z','2026-10-31T12:00:60Z','2026-10-31t12:00:00Z','2026-10-31T12:00:00z','2026-10-31T12:00:00-00:00','2026-10-31T12:00:00+24:00','2026-10-31T12:00:00+01:60','2026-10-31T12:00:00.1234Z','2026-10-31T12:00:00.Z','2026-10-31T12:00:00Z\n',' 2026-10-31T12:00:00Z','1969-12-31T23:59:59Z']) {
    it(`rejects time ${JSON.stringify(value)}`, () => expect(partnerTime(value)).toBeUndefined());
  }
  for (const value of [null, [], { ...lead, user_id: 'foreign' }, { ...lead, email: 'Synthetic@example.test' }, { ...lead, click_id: lead.click_id + '\n' }, { ...lead, click_id: lead.click_id.replace('-4000-', '-1000-') }, { ...lead, partner_event_id: '' }, { ...lead, partner_event_id: 'x\n' }, { ...lead, partner_event_id: ' x' }, { ...lead, partner_event_id: 'é' }, { ...lead, partner_event_id: 'x'.repeat(129) }, { ...lead, occurred_at: 1 }, { ...lead, amount_minor: 1, currency: 'USD' }, { ...lead, event_type: 'Purchase', amount_minor: 1 }, { ...lead, event_type: 'Purchase', currency: 'USD' }, { ...lead, event_type: 'Purchase', amount_minor: null, currency: null }, { ...lead, event_type: 'Purchase', amount_minor: '1', currency: 'USD' }, { ...lead, event_type: 'Purchase', amount_minor: 0, currency: 'USD' }, { ...lead, event_type: 'Purchase', amount_minor: 1.5, currency: 'USD' }, { ...lead, event_type: 'Purchase', amount_minor: 1_000_001, currency: 'USD' }, { ...lead, event_type: 'Purchase', amount_minor: 1, currency: 'EUR' }]) {
    it('rejects malformed DTO without coercion', () => expect(partnerEventSchema.safeParse(value).success).toBe(false));
  }
  it('accepts purchase with absent money or complete bounded pair', () => {
    for (const amount of [undefined,1,1_000_000]) expect(partnerEventSchema.safeParse({ ...lead, event_type:'Purchase', ...(amount === undefined ? {} : {amount_minor:amount,currency:'USD'}) }).success).toBe(true);
  });
});
