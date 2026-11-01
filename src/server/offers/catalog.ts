import { z } from 'zod';
import { offerConfig } from './config';

const genderSchema = z.enum(['women', 'men']);
const ethnicitySchema = z.enum(['asia', 'europe', 'latam']);
export type Gender = z.infer<typeof genderSchema>;
export type Ethnicity = z.infer<typeof ethnicitySchema>;
const utf8Length = (value: string) => new TextEncoder().encode(value).length;
const sampleClickId = '00000000-0000-4000-8000-000000000000';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function baseUrl(value: string) {
  if (/[\u0000-\u0020\u007f\\]/.test(value)) throw new Error('catalog_invalid');
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password
    || Array.from(url.searchParams.keys()).some((key) => key.toLowerCase() === 'click_id')) throw new Error('catalog_invalid');
  return url;
}
function targetUrl(value: string, clickId: string) {
  const url = baseUrl(value);
  url.searchParams.append('click_id', clickId);
  if (utf8Length(url.href) > 2048) throw new Error('catalog_invalid');
  return url.href;
}

const offerSchema = z.strictObject({
  id: z.enum(['001', '002', '003', '004', '005', '006', '007']),
  name: z.string().refine((value) => value.trim().length > 0 && utf8Length(value) <= 256),
  ethnicity: z.enum(['asia', 'europe', 'latam', 'any']),
  genders: z.array(genderSchema).min(1).max(2).refine((items) => new Set(items).size === items.length),
  epu_usd: z.number().nonnegative(), active: z.boolean(),
  partner_id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  url: z.string().refine((value) => { try { targetUrl(value, sampleClickId); return true; } catch { return false; } }),
}).refine((offer) => offer.id === '007'
  ? offer.ethnicity === 'any' && offer.genders.length === 2
  : offer.ethnicity !== 'any');
const catalogSchema = z.strictObject({
  partners: z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)),
  offers: z.array(offerSchema).max(7),
}).refine(({ partners, offers }) => new Set(partners).size === partners.length
  && new Set(offers.map((offer) => offer.id)).size === offers.length
  && offers.every((offer) => partners.includes(offer.partner_id)));

type ParsedOffer = z.infer<typeof offerSchema>;
export type Offer = Readonly<Omit<ParsedOffer, 'genders'> & { genders: readonly Gender[] }>;
const validated = Symbol('validated-catalog');
export interface OfferCatalog {
  readonly [validated]: true;
  readonly version: string;
  readonly partners: readonly string[];
  readonly offers: readonly Offer[];
}

export async function createOfferCatalog(input: unknown): Promise<OfferCatalog> {
  const parsed = catalogSchema.safeParse(input);
  // Не віддаємо Zod issues: у конфігу випадково можуть опинитись секрети.
  if (!parsed.success) throw new Error('catalog_invalid');
  const partners = Object.freeze([...parsed.data.partners].sort());
  const offers = Object.freeze(parsed.data.offers.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    .map((offer) => Object.freeze({ ...offer, url: baseUrl(offer.url).href,
      genders: Object.freeze([...offer.genders].sort()) })));
  // Формат 1: фіксований порядок полів; усі дозволені семантичні поля.
  const canonical = JSON.stringify(['unicorn.catalog', 1, partners, offers.map((offer) => [
    offer.id, offer.name, offer.ethnicity, offer.genders, offer.epu_usd, offer.active, offer.partner_id, offer.url,
  ])]);
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(new TextEncoder().encode(canonical)).buffer);
  const version = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return Object.freeze({ [validated]: true as const, partners, offers, version });
}

// Ліниве створення: майбутня B викликає лише після перевірки replay.
// Невдалий конфіг не замінюється попередньою версією або порожнім списком.
let catalog: Promise<OfferCatalog> | undefined;
export function getOfferCatalog(): Promise<OfferCatalog> {
  return catalog ??= createOfferCatalog(offerConfig);
}

export function buildOfferUrl(offer: Offer, clickId: string): string {
  if (!uuid.test(clickId)) throw new Error('click_id_invalid');
  return targetUrl(offer.url, clickId);
}

export function validPreferences(gender: unknown, ethnicity: unknown): { gender: Gender; ethnicity: Ethnicity } | null {
  const g = genderSchema.safeParse(gender); const e = ethnicitySchema.safeParse(ethnicity);
  return g.success && e.success ? { gender: g.data, ethnicity: e.data } : null;
}
