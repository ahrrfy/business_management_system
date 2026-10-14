import { normalizeArabicSearch, tokenizeSearchTerms } from "./storefrontSearchNormalize";

const NON_REFERENCE_CHARACTER = new RegExp("[^\\p{L}\\p{N}]", "gu");

/** Search-only normalization; stored customer and document values remain unchanged. */
export function normalizeDeliverySearch(value: string): string {
  return normalizeArabicSearch(value).replace(/ـ/g, "");
}

export function deliverySearchTerms(value: string): string[] {
  return Array.from(new Set(tokenizeSearchTerms(normalizeDeliverySearch(value))));
}

export function deliveryPhoneDigits(value: string): string {
  const digits = normalizeDeliverySearch(value).replace(/\D/g, "");
  if (digits.startsWith("00964")) return digits.slice(5).replace(/^0/, "");
  if (digits.startsWith("964")) return digits.slice(3).replace(/^0/, "");
  return digits.startsWith("0") ? digits.slice(1) : digits;
}

export interface DeliverySearchTarget {
  names?: Array<string | null | undefined>;
  phones?: Array<string | null | undefined>;
  addresses?: Array<string | null | undefined>;
  references?: Array<string | number | null | undefined>;
}

export function scoreDeliverySearch(target: DeliverySearchTarget, query: string): number {
  const terms = deliverySearchTerms(query);
  if (!terms.length) return 0;
  const textFields = [...(target.names ?? []), ...(target.addresses ?? [])]
    .filter((v): v is string => !!v).map(normalizeDeliverySearch);
  const refs = (target.references ?? []).filter((v) => v != null)
    .map((v) => normalizeDeliverySearch(String(v)));
  const phones = (target.phones ?? []).filter((v): v is string => !!v)
    .map(deliveryPhoneDigits).filter(Boolean);
  // Keep numeric cross-field terms, with an alternate interpretation for pasted phones.
  const normalizedQuery = normalizeDeliverySearch(query);
  const formattedPhone = /^[+\d\s().-]+$/.test(normalizedQuery) ? deliveryPhoneDigits(normalizedQuery) : "";
  const phoneQueryScore = formattedPhone && phones.some((value) => value === formattedPhone) ? 800
    : formattedPhone && phones.some((value) => value.includes(formattedPhone)) ? 300 : 0;
  let score = 0;
  for (const term of terms) {
    const compact = term.replace(NON_REFERENCE_CHARACTER, "");
    const numeric = /^\+?\d[\d-]*$/.test(term);
    const phone = numeric ? deliveryPhoneDigits(term) : "";
    const exactRef = refs.some((v) => v === term || (compact && v.replace(NON_REFERENCE_CHARACTER, "") === compact));
    const exactPhone = !!phone && phones.some((v) => v === phone);
    const partialPhone = !!phone && phones.some((v) => v.includes(phone));
    const partialRef = refs.some((v) => v.includes(term) || (compact && v.replace(NON_REFERENCE_CHARACTER, "").includes(compact)));
    const exactText = textFields.some((v) => v === term);
    const partialText = textFields.some((v) => v.includes(term));
    if (!exactRef && !exactPhone && !partialPhone && !partialRef && !partialText) return phoneQueryScore;
    score += exactRef ? 1000 : exactPhone ? 800 : exactText ? 500 : partialPhone ? 300 : partialRef ? 200 : 100;
  }
  const phrase = normalizeDeliverySearch(query);
  return Math.max(phoneQueryScore, score + (textFields.some((value) => value === phrase) ? 500 : 0));
}

export function matchesDeliverySearch(target: DeliverySearchTarget, query: string): boolean {
  return !deliverySearchTerms(query).length || scoreDeliverySearch(target, query) > 0;
}
