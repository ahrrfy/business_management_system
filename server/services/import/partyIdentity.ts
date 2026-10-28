type PartyFields = {
  name: string;
  phone?: string | null;
  legacyCode?: string | null;
};
export type PartyIdentity = PartyFields & { id: number };

const legacyKey = (value?: string | null) =>
  value?.trim().toLowerCase() || null;

/** Shared phone numbers are legitimate; only the whole name/phone pair identifies a party. */
export function canonicalPartyKey(party: PartyFields): string {
  return JSON.stringify([
    party.phone?.trim() || null,
    party.name.trim().toLowerCase(),
  ]);
}

export function partyIdentityIndex(candidates: PartyIdentity[]) {
  const byLegacy = new Map<string, PartyIdentity[]>();
  const byCanonical = new Map<string, PartyIdentity[]>();
  // The same database row can be returned by both batched lookup queries.
  for (const party of Array.from(
    new Map(candidates.map((candidate) => [candidate.id, candidate])).values(),
  )) {
    const legacy = legacyKey(party.legacyCode);
    if (legacy) byLegacy.set(legacy, [...(byLegacy.get(legacy) ?? []), party]);
    const canonical = canonicalPartyKey(party);
    byCanonical.set(canonical, [...(byCanonical.get(canonical) ?? []), party]);
  }
  return { byLegacy, byCanonical };
}

const mismatch =
  "IDENTITY_MISMATCH: الرقم القديم والاسم/الهاتف يشيران إلى هويات مختلفة — راجع هوية الطرف في الملف قبل الاستيراد";
const ambiguous =
  "AMBIGUOUS: أكثر من طرف يطابق الاسم والهاتف — حدّد الرقم القديم الصحيح أو صحّح التكرار قبل الاستيراد";

export function resolvePartyIdentity(
  row: PartyFields,
  index: ReturnType<typeof partyIdentityIndex>,
): { id?: number; error?: string } {
  const legacy = legacyKey(row.legacyCode);
  const legacyMatches = legacy ? (index.byLegacy.get(legacy) ?? []) : [];
  const canonicalMatches = index.byCanonical.get(canonicalPartyKey(row)) ?? [];
  if (legacyMatches.length > 1) return { error: ambiguous };
  if (legacyMatches.length === 1) {
    const party = legacyMatches[0];
    // Explicit existing legacy IDs remain authoritative when genuine distinct
    // parties already share the canonical fields. A different-only canonical
    // target is still a conflicting alias, never an automatic merge.
    if (
      canonicalMatches.length &&
      !canonicalMatches.some((candidate) => candidate.id === party.id)
    )
      return { error: mismatch };
    return { id: party.id };
  }
  if (canonicalMatches.length > 1) return { error: ambiguous };
  const party = canonicalMatches[0];
  if (
    party &&
    legacy &&
    legacyKey(party.legacyCode) &&
    legacy !== legacyKey(party.legacyCode)
  )
    return { error: mismatch };
  return { id: party?.id };
}

export const repeatedPartyIdentityMessage =
  "IDENTITY_MISMATCH: صفوف بأرقام قديمة مختلفة تحمل الاسم والهاتف نفسيهما أو تستهدف السجل نفسه — راجع هوية المصدر قبل الاستيراد";
