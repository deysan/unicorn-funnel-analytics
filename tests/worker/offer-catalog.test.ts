import { expect, it } from 'vitest';
import { buildOfferUrl, createOfferCatalog, getOfferCatalog } from '../../src/server/offers/catalog';
import { offerConfig } from '../../src/server/offers/config';
import { returningUserAction, selectOffer } from '../../src/server/offers/selection';

// Незалежно обчислено node:crypto за явними початковими даними, формат 1.
const initialVersion = '3bedf13e48229522c7973558183f9a9c77fcddeca0b819177010522d5a787cd8';
it('workerd отримує той самий каталог/SHA, що Node; URL формується без зовнішнього запиту', async () => {
  const catalog = await getOfferCatalog();
  expect(catalog.version).toBe(initialVersion);
  const result = selectOffer(catalog, { preferredGender: 'women', preferredEthnicity: 'asia', leads: [] });
  expect(result).toMatchObject({ status: 'selected', offer: { id: '003' }, reason: 'match' });
  if (result.status !== 'selected') throw new Error('expected selection');
  expect(buildOfferUrl(result.offer, '00000000-0000-4000-8000-000000000001'))
    .toBe('https://asia-connect.example/?click_id=00000000-0000-4000-8000-000000000001');
});

it('повторне читання кешованого snapshot у workerd не створює нову пару', async () => {
  const a = await getOfferCatalog(); const b = await getOfferCatalog();
  expect(a).toBe(b); expect(b.version).toBe(initialVersion);
  expect(returningUserAction(b, { preferredGender: null, preferredEthnicity: null, leads: [{ offerId: '001', registeredAt: 1 }] })).toBe('select_offer');
});

it('workerd відхиляє весь дефектний каталог, а валідний порожній дає no_offer', async () => {
  await expect(createOfferCatalog({ ...offerConfig, offers: [{ ...offerConfig.offers[0], url: 'https://example.test/?CLICK_ID=bad' }] }))
    .rejects.toThrow('catalog_invalid');
  const empty = await createOfferCatalog({ partners: [], offers: [] });
  expect(selectOffer(empty, { preferredGender: 'women', preferredEthnicity: 'asia', leads: [] })).toEqual({ status: 'no_offer' });
});
