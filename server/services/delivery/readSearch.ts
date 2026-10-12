import { and, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import {
  deliveryPhoneDigits,
  deliverySearchTerms,
  normalizeDeliverySearch,
} from "@shared/deliverySearch";
import { ARABIC_NORMALIZATION_PAIRS } from "@shared/storefrontSearchNormalize";
import { escLike } from "../../lib/sqlLike";
const NON_REFERENCE_CHARACTER = new RegExp("[^\\p{L}\\p{N}]", "gu");

/** SQL mirror of shared delivery search: every token must match, ranked before LIMIT. */
export function deliverySearchSql(
  query: string,
  fields: {
    names?: SQLWrapper[];
    phones?: SQLWrapper[];
    addresses?: SQLWrapper[];
    references?: SQLWrapper[];
  },
): { where: SQL | undefined; score: SQL<number> } {
  const normalize = (field: SQLWrapper): SQL => {
    let value: SQL = sql`LOWER(COALESCE(${field}, ''))`;
    // These literals come from the fixed normalization alphabet, never user input.
    for (const [from, to] of ARABIC_NORMALIZATION_PAIRS)
      value = sql`REPLACE(${value}, ${sql.raw(`'${from}'`)}, ${sql.raw(`'${to}'`)})`;
    return sql`TRIM(REGEXP_REPLACE(REGEXP_REPLACE(REPLACE(${value}, 'ـ', ''), '[ً-ٰٟ]', ''), '[[:space:]]+', ' '))`;
  };
  const texts = [...(fields.names ?? []), ...(fields.addresses ?? [])].map(
    normalize,
  );
  const refs = (fields.references ?? []).map(normalize);
  const phones = (fields.phones ?? []).map((field) => {
    const digits = sql`REGEXP_REPLACE(${normalize(field)}, '[^0-9]', '')`;
    return sql`CASE WHEN ${digits} LIKE '00964%' THEN REGEXP_REPLACE(SUBSTRING(${digits}, 6), '^0', '') WHEN ${digits} LIKE '964%' THEN REGEXP_REPLACE(SUBSTRING(${digits}, 4), '^0', '') ELSE REGEXP_REPLACE(${digits}, '^0', '') END`;
  });
  const contains = (values: SQL[], term: string) =>
    or(
      ...values.map(
        (value) => sql`${value} LIKE ${`%${escLike(term)}%`} ESCAPE '!'`,
      ),
    ) ?? sql`FALSE`;
  const exact = (values: SQL[], term: string) =>
    or(...values.map((value) => sql`${value} = ${term}`)) ?? sql`FALSE`;
  const matches: SQL[] = [];
  const scores: SQL[] = [];
  for (const term of deliverySearchTerms(query)) {
    const compact = term.replace(NON_REFERENCE_CHARACTER, "");
    const compactRefs = refs.map(
      (ref) => sql`REGEXP_REPLACE(${ref}, '[^[:alnum:]]', '')`,
    );
    const exactRef = or(
      exact(refs, term),
      compact ? exact(compactRefs, compact) : sql`FALSE`,
    )!;
    const partialRef = or(
      contains(refs, term),
      compact ? contains(compactRefs, compact) : sql`FALSE`,
    )!;
    const phone = /^\+?\d[\d-]*$/.test(term) ? deliveryPhoneDigits(term) : "";
    const exactPhone = phone ? exact(phones, phone) : sql`FALSE`;
    const partialPhone = phone ? contains(phones, phone) : sql`FALSE`;
    const exactText = exact(texts, term);
    const partialText = contains(texts, term);
    matches.push(
      or(exactRef, exactPhone, partialPhone, partialRef, partialText)!,
    );
    scores.push(
      sql`CASE WHEN ${exactRef} THEN 1000 WHEN ${exactPhone} THEN 800 WHEN ${exactText} THEN 500 WHEN ${partialPhone} THEN 300 WHEN ${partialRef} THEN 200 WHEN ${partialText} THEN 100 ELSE 0 END`,
    );
  }
  if (!scores.length) return { where: undefined, score: sql<number>`0` };
  const phrase = normalizeDeliverySearch(query);
  const formattedPhone = /^[+\d\s().-]+$/.test(phrase)
    ? deliveryPhoneDigits(phrase)
    : "";
  const phoneMatch = formattedPhone
    ? contains(phones, formattedPhone)
    : sql`FALSE`;
  const phoneScore = formattedPhone
    ? sql`CASE WHEN ${exact(phones, formattedPhone)} THEN 800 WHEN ${phoneMatch} THEN 300 ELSE 0 END`
    : sql`0`;
  scores.push(sql`CASE WHEN ${exact(texts, phrase)} THEN 500 ELSE 0 END`);
  const allTerms = and(...matches)!;
  return {
    where: or(allTerms, phoneMatch),
    score: sql<number>`GREATEST(${phoneScore}, CASE WHEN ${allTerms} THEN (${sql.join(scores, sql` + `)}) ELSE 0 END)`,
  };
}
