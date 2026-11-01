import { beforeAll, expect, it } from 'vitest';
import { createOfferCatalog, getOfferCatalog, type OfferCatalog } from '../../src/server/offers/catalog';
import { offerConfig } from '../../src/server/offers/config';
import { returningUserAction, selectOffer, type SelectionState } from '../../src/server/offers/selection';

let catalog: OfferCatalog;
const state: SelectionState = { preferredGender: 'women', preferredEthnicity: 'asia', leads: [] };
beforeAll(async () => { catalog = await getOfferCatalog(); });

it.each([
  ['women', 'asia', '003'], ['men', 'asia', '003'], ['women', 'europe', '004'],
  ['men', 'europe', '005'], ['women', 'latam', '007'], ['men', 'latam', '006'],
])('%s + %s → %s за початковим каталогом', (preferredGender, preferredEthnicity, id) => {
  expect(selectOffer(catalog, { ...state, preferredGender, preferredEthnicity })).toMatchObject({ status: 'selected', offer: { id } });
});

it('EPU tie → minID незалежно від порядку, 007 навіть із більшим EPU не конкурує', async () => {
  const source = structuredClone(offerConfig); source.offers[0].epu_usd = 0.95; source.offers[6].epu_usd = 100;
  expect(selectOffer(await createOfferCatalog({ ...source, offers: source.offers.reverse() }), state))
    .toMatchObject({ status: 'selected', offer: { id: '001' }, reason: 'match' });
});

it('дробовий EPU порівнюється без округлення до центів', async () => {
  const source = structuredClone(offerConfig); source.offers[2].epu_usd = 0.8001;
  expect(selectOffer(await createOfferCatalog(source), state)).toMatchObject({ offer: { id: '003' }, reason: 'match' });
});

it.each(['inactive', 'removed'])('006 %s → fallback, не помилка каталогу', async (mode) => {
  const source = structuredClone(offerConfig);
  if (mode === 'inactive') source.offers[5].active = false;
  else source.offers.splice(5, 1);
  expect(selectOffer(await createOfferCatalog(source), { ...state, preferredGender: 'men', preferredEthnicity: 'latam' }))
    .toMatchObject({ status: 'selected', offer: { id: '007' }, reason: 'fallback' });
});

it('недоступний 007 без збігу → no_offer, але збіг продовжує працювати', async () => {
  for (const offers of [offerConfig.offers.filter((o) => o.id !== '007'), offerConfig.offers.map((o) => ({ ...o, active: o.id !== '007' }))]) {
    const modified = await createOfferCatalog({ ...offerConfig, offers });
    expect(selectOffer(modified, { ...state, preferredEthnicity: 'latam' })).toEqual({ status: 'no_offer' });
    expect(selectOffer(modified, state)).toMatchObject({ status: 'selected', offer: { id: '003' } });
  }
  expect(selectOffer(await createOfferCatalog({ partners: [], offers: [] }), state)).toEqual({ status: 'no_offer' });
  const inactive = await createOfferCatalog({ ...offerConfig, offers: offerConfig.offers.map((o) => ({ ...o, active: false })) });
  const returning = { ...state, leads: [{ offerId: '001', registeredAt: 1 }] };
  expect(returningUserAction(inactive, returning)).toBe('select_offer');
  expect(selectOffer(inactive, returning)).toEqual({ status: 'no_offer' });
});

it('активний Lead перемагає вподобання/EPU і не потребує повних відповідей', () => {
  for (const preferences of [{ preferredGender: 'men', preferredEthnicity: 'latam' }, { preferredGender: null, preferredEthnicity: 'invalid' }]) {
    expect(selectOffer(catalog, { ...preferences, leads: [{ offerId: '001', registeredAt: 100 }] }))
      .toMatchObject({ status: 'selected', offer: { id: '001' }, reason: 'lead' });
  }
});

it('найновіший Lead; рівний час → minID; старий доставлений пізніше не змінює пріоритет', () => {
  const leads = [{ offerId: '004', registeredAt: 200 }, { offerId: '003', registeredAt: 200 }, { offerId: '001', registeredAt: 100 }];
  for (const input of [leads, [...leads].reverse(), [...leads, leads[2]]]) {
    expect(selectOffer(catalog, { ...state, leads: input })).toMatchObject({ offer: { id: '003' }, reason: 'lead' });
  }
  expect(selectOffer(catalog, { ...state, leads: [...leads, { offerId: '007', registeredAt: 201 }] }))
    .toMatchObject({ offer: { id: '007' }, reason: 'lead' });
});

it('новіший inactive/removed Lead пропускається перед вибором активного', async () => {
  const source = structuredClone(offerConfig); source.offers[3].active = false; source.offers = source.offers.filter((o) => o.id !== '003');
  expect(selectOffer(await createOfferCatalog(source), { ...state, leads: [
    { offerId: '001', registeredAt: 1 }, { offerId: '004', registeredAt: 2 }, { offerId: '003', registeredAt: 3 },
  ] })).toMatchObject({ offer: { id: '001' }, reason: 'lead' });
});

it.each([undefined, null, '', 'invalid', 1])('недопустиме вподобання %s без активного Lead → needs_quiz, не 007', (value) => {
  expect(selectOffer(catalog, { ...state, preferredGender: value })).toEqual({ status: 'needs_quiz' });
  expect(selectOffer(catalog, { ...state, preferredEthnicity: value })).toEqual({ status: 'needs_quiz' });
});

it('право bypass відокремлене від підбору; самі відповіді без Lead не пропускають квіз', async () => {
  expect(returningUserAction(catalog, state)).toBe('quiz');
  const source = structuredClone(offerConfig); source.offers[0].active = false;
  const modified = await createOfferCatalog(source);
  for (const offerId of ['001', '099']) {
    const returning = { ...state, leads: [{ offerId, registeredAt: 1 }] };
    expect(returningUserAction(modified, returning)).toBe('select_offer');
    expect(selectOffer(modified, returning)).toMatchObject({ offer: { id: '003' }, reason: 'match' });
    expect(returningUserAction(modified, { ...returning, preferredGender: null })).toBe('quiz');
  }
  expect(returningUserAction(catalog, { preferredGender: null, preferredEthnicity: null, leads: [{ offerId: '001', registeredAt: 1 }] })).toBe('select_offer');
});

it('не мутує профіль/Lead і відхиляє невалідний внутрішній час Lead', () => {
  const input = Object.freeze({ ...state, leads: Object.freeze([Object.freeze({ offerId: '001', registeredAt: 1 })]) });
  expect(selectOffer(catalog, input)).toMatchObject({ offer: { id: '001' } });
  for (const registeredAt of [-1, NaN, Infinity, 0.5]) expect(() => selectOffer(catalog, { ...state, leads: [{ offerId: '001', registeredAt }] })).toThrow('selection_state_invalid');
});
