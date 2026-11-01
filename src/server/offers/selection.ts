import { validPreferences, type Offer, type OfferCatalog } from './catalog';

export interface Lead { readonly offerId: string; readonly registeredAt: number }
export interface SelectionState {
  readonly preferredGender: unknown;
  readonly preferredEthnicity: unknown;
  // Тільки чинні компактні Lead цього користувача; received_at тут немає.
  readonly leads: readonly Lead[];
}
export type OfferSelection = { status: 'selected'; offer: Offer; reason: 'lead' | 'match' | 'fallback' }
  | { status: 'no_offer' | 'needs_quiz' };

function priorityLead(catalog: OfferCatalog, leads: readonly Lead[]): Offer | undefined {
  let selected: { offer: Offer; time: number } | undefined;
  for (const lead of leads) {
    if (!/^\d{3}$/.test(lead.offerId) || !Number.isSafeInteger(lead.registeredAt) || lead.registeredAt < 0) {
      throw new Error('selection_state_invalid');
    }
    const offer = catalog.offers.find((item) => item.id === lead.offerId && item.active);
    if (offer && (!selected || lead.registeredAt > selected.time
      || (lead.registeredAt === selected.time && offer.id < selected.offer.id))) selected = { offer, time: lead.registeredAt };
  }
  return selected?.offer;
}

export function selectOffer(catalog: OfferCatalog, state: SelectionState): OfferSelection {
  const lead = priorityLead(catalog, state.leads);
  if (lead) return { status: 'selected', offer: lead, reason: 'lead' };
  const preferences = validPreferences(state.preferredGender, state.preferredEthnicity);
  if (!preferences) return { status: 'needs_quiz' };
  let best: Offer | undefined;
  for (const offer of catalog.offers) {
    if (!offer.active || offer.id === '007' || offer.ethnicity !== preferences.ethnicity || !offer.genders.includes(preferences.gender)) continue;
    if (!best || offer.epu_usd > best.epu_usd || (offer.epu_usd === best.epu_usd && offer.id < best.id)) best = offer;
  }
  if (best) return { status: 'selected', offer: best, reason: 'match' };
  const fallback = catalog.offers.find((offer) => offer.id === '007' && offer.active);
  return fallback ? { status: 'selected', offer: fallback, reason: 'fallback' } : { status: 'no_offer' };
}

// Лише підказка повернення, не дозвіл виконати B без її транзакційних guards.
export function returningUserAction(catalog: OfferCatalog, state: SelectionState): 'quiz' | 'select_offer' {
  if (priorityLead(catalog, state.leads)) return 'select_offer';
  return state.leads.length > 0 && validPreferences(state.preferredGender, state.preferredEthnicity)
    ? 'select_offer' : 'quiz';
}
