import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildOfferUrl, createOfferCatalog, getOfferCatalog } from '../../src/server/offers/catalog';
import { offerConfig } from '../../src/server/offers/config';

const clickId = '00000000-0000-4000-8000-000000000001';
const initial = [
  ['001', 'Asia Women', 'asia', ['women'], 0.80, 'https://asia-women.example'],
  ['002', 'Asia Men', 'asia', ['men'], 0.65, 'https://asia-men.example'],
  ['003', 'Asia Connect', 'asia', ['men', 'women'], 0.95, 'https://asia-connect.example'],
  ['004', 'Europe Women', 'europe', ['women'], 1.10, 'https://europe-women.example'],
  ['005', 'Europe Connect', 'europe', ['men', 'women'], 0.70, 'https://europe-connect.example'],
  ['006', 'Latin Men', 'latam', ['men'], 0.60, 'https://latin-men.example'],
  ['007', 'Global Connect', 'any', ['men', 'women'], 0.50, 'https://global-connect.example'],
] as const;

it('початкові сім оферів точно відповідають ТЗ; формат 1 має незалежний SHA-256 вектор', async () => {
  const catalog = await getOfferCatalog();
  expect(catalog.offers.map((o) => [o.id, o.name, o.ethnicity, o.genders, o.epu_usd, o.url]))
    .toEqual(initial.map(([id, name, ethnicity, genders, epu, url]) => [id, name, ethnicity, genders, epu, url + '/']));
  expect(catalog.offers.every((o) => o.active && o.partner_id === 'demo-partner')).toBe(true);
  const canonical = JSON.stringify(['unicorn.catalog', 1, ['demo-partner'],
    initial.map(([id, name, ethnicity, genders, epu, url]) => [id, name, ethnicity, genders, epu, true, 'demo-partner', url + '/'])]);
  expect(catalog.version).toBe(createHash('sha256').update(canonical).digest('hex'));
  expect(await getOfferCatalog()).toBe(catalog);
});

it('порядок оферів/полів/множин і форматування не змінюють version', async () => {
  const source = structuredClone(offerConfig);
  const shuffled = JSON.parse(JSON.stringify({ offers: source.offers.reverse().map((o) => ({
    url: o.url, partner_id: o.partner_id, active: o.active, epu_usd: o.epu_usd, genders: [...o.genders].reverse(),
    ethnicity: o.ethnicity, name: o.name, id: o.id,
  })), partners: source.partners }, null, 4));
  expect((await createOfferCatalog(shuffled)).version).toBe((await getOfferCatalog()).version);
});

it.each([
  { name: 'Renamed' }, { url: 'https://changed.example/?source=demo#fragment' }, { active: false },
  { epu_usd: 0.801 }, { ethnicity: 'europe' }, { genders: ['men'] },
])('зміна поля %j змінює version, повернення змісту відновлює її', async (patch) => {
  const source = structuredClone(offerConfig);
  Object.assign(source.offers[0], patch);
  expect((await createOfferCatalog(source)).version).not.toBe((await getOfferCatalog()).version);
  expect((await createOfferCatalog(offerConfig)).version).toBe((await getOfferCatalog()).version);
});

it('належність партнеру та склад каталогу теж входять у version', async () => {
  const source = structuredClone(offerConfig); source.partners.push('second-partner');
  const added = await createOfferCatalog(source);
  source.offers[0].partner_id = 'second-partner';
  expect((await createOfferCatalog(source)).version).not.toBe(added.version);
  source.offers.pop();
  expect((await createOfferCatalog(source)).version).not.toBe((await getOfferCatalog()).version);
});

it('snapshot не змінюється після мутації джерела і глибоко заморожений', async () => {
  const source = structuredClone(offerConfig); const catalog = await createOfferCatalog(source);
  source.offers[0].active = false; source.offers[0].genders.push('men'); source.partners.push('other');
  expect(catalog.offers[0].active).toBe(true); expect(catalog.offers[0].genders).toEqual(['women']);
  expect(catalog.partners).toEqual(['demo-partner']);
  for (const value of [catalog, catalog.offers, catalog.offers[0], catalog.offers[0].genders, catalog.partners]) expect(Object.isFrozen(value)).toBe(true);
});

describe('цілісна валідація каталогу', () => {
  it.each([
    { id: '1' }, { id: '008' }, { id: ' 001' }, { partner_id: 'unknown' }, { partner_id: 'Demo-partner' },
    { name: '' }, { name: '  ' }, { name: 'я'.repeat(129) }, { epu_usd: -0.1 }, { epu_usd: Infinity }, { epu_usd: NaN },
    { epu_usd: '0.8' }, { active: 'true' }, { active: null }, { genders: [] }, { genders: ['women', 'women'] },
    { genders: ['other'] }, { ethnicity: 'any' }, { extra: true },
    { url: 'http://example.test' }, { url: 'https://secret:token@example.test' }, { url: 'https://example.test/a b' },
    { url: 'https://example.test/\\path' }, { url: 'https://example.test/\npath' },
    ...['click_id', 'CLICK_ID', '%63lick_id', '%43LICK_%49D'].map((key) => ({ url: `https://example.test/?${key}=existing` })),
  ])('один дефект %j відхиляє весь каталог, навіть для inactive офера', async (patch) => {
    const source = structuredClone(offerConfig);
    Object.assign(source.offers[0], { active: false }, patch);
    await expect(createOfferCatalog(source)).rejects.toThrow('catalog_invalid');
  });

  it('відхиляє дублікати, невідомі поля та неправильний fallback', async () => {
    await expect(createOfferCatalog({ ...offerConfig, offers: [offerConfig.offers[0], offerConfig.offers[0]] })).rejects.toThrow('catalog_invalid');
    await expect(createOfferCatalog({ ...offerConfig, partners: ['demo-partner', 'demo-partner'] })).rejects.toThrow('catalog_invalid');
    await expect(createOfferCatalog({ ...offerConfig, secret: 'synthetic' })).rejects.toThrow('catalog_invalid');
    await expect(createOfferCatalog({ ...offerConfig, offers: [{ ...offerConfig.offers[6], ethnicity: 'asia' }] })).rejects.toThrow('catalog_invalid');
    await expect(createOfferCatalog({ ...offerConfig, offers: [{ ...offerConfig.offers[6], genders: ['women'] }] })).rejects.toThrow('catalog_invalid');
  });

  it('дозволяє підмножину/порожній каталог, zero і дробовий EPU без округлення', async () => {
    expect((await createOfferCatalog({ partners: [], offers: [] })).offers).toEqual([]);
    const catalog = await createOfferCatalog({ ...offerConfig, offers: [{ ...offerConfig.offers[0], epu_usd: 0.000123 }, { ...offerConfig.offers[1], epu_usd: 0 }] });
    expect(catalog.offers.map((o) => o.epu_usd)).toEqual([0.000123, 0]);
  });
});

it('URL зберігає статичні query/fragment, додає лише click_id й не змінює офер', async () => {
  const catalog = await createOfferCatalog({ ...offerConfig, offers: [{ ...offerConfig.offers[0], url: 'https://example.test/path?tag=a&tag=b&label=hello%20world#finish' }] });
  const offer = catalog.offers[0]; const target = new URL(buildOfferUrl(offer, clickId));
  expect(target.searchParams.getAll('tag')).toEqual(['a', 'b']); expect(target.searchParams.get('label')).toBe('hello world');
  expect(target.searchParams.getAll('click_id')).toEqual([clickId]); expect(target.hash).toBe('#finish');
  expect([...target.searchParams.keys()]).toEqual(['tag', 'tag', 'label', 'click_id']);
  expect(offer.url).not.toContain('click_id');
  expect(() => buildOfferUrl(offer, 'not-a-uuid')).toThrow('click_id_invalid');
});

it('перевіряє 2048 байтів готового URL і 256 байтів назви на точній межі', async () => {
  const prefix = 'https://example.test/'; const query = `?click_id=${clickId}`;
  const url = prefix + 'a'.repeat(2048 - prefix.length - query.length);
  const source = { ...offerConfig, offers: [{ ...offerConfig.offers[0], url, name: 'я'.repeat(128) }] };
  const catalog = await createOfferCatalog(source);
  expect(new TextEncoder().encode(buildOfferUrl(catalog.offers[0], clickId)).length).toBe(2048);
  await expect(createOfferCatalog({ ...source, offers: [{ ...source.offers[0], url: url + 'a' }] })).rejects.toThrow('catalog_invalid');
  await expect(createOfferCatalog({ ...source, offers: [{ ...source.offers[0], url: prefix + 'я'.repeat(340) }] })).rejects.toThrow('catalog_invalid');
});
