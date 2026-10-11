import Decimal from "decimal.js";
import type { ReceptionChannel } from "./receptionChannel";

export type ReceptionDuplicateKind = "DRAFT" | "ONLINE" | "WORK_ORDER";
export type ReceptionDuplicateLine = {
  lineKind?: "GOODS" | "PRINT" | "CUSTOM";
  variantId?: number | null;
  productUnitId?: number | null;
  quantity: string;
  title?: string | null;
  customizationText?: string | null;
  printSpec?: string | null;
};
export type ReceptionDuplicateInput = {
  branchId: number;
  reference?: { kind: ReceptionDuplicateKind; id: number };
  phone?: string;
  /** Existing customer lookup hint; the server must verify that the supplied phone belongs to it. */
  customerId?: number;
  channel?: ReceptionChannel;
  lines?: ReceptionDuplicateLine[];
  total?: string;
  excludeDraftId?: number;
};
export type ReceptionDuplicateMatch = {
  key: string;
  kind: ReceptionDuplicateKind;
  id: number;
  number: string;
  channel: ReceptionChannel;
  createdAt: string;
  statusLabel: string;
  total: string;
  invoice: { id: number; number: string; total: string; status: string } | null;
  matchedLines: number;
  currentLines: number;
  candidateLines: number;
  quantityMatch: boolean;
  contentsMatch: boolean;
  matchLevel: "EXACT" | "PARTIAL";
  customizationNeedsReview: boolean;
  valueDifference: string | null;
  href: string;
};
export type ReceptionDuplicateResult = {
  checked: boolean;
  matches: ReceptionDuplicateMatch[];
  truncated: boolean;
};

/** Internal resolved data only: unit conversion and stored quantities come from the DB. */
export type ResolvedDuplicateLine = ReceptionDuplicateLine & {
  baseQuantity?: string | null;
  conversionFactor?: string | null;
  isService?: boolean;
  customizationSnapshot?: {
    templateId: number;
    values: {
      fieldKey: string;
      value: string;
      label?: string;
      displayValue?: string;
    }[];
  } | null;
};

const text = (value: string | null | undefined) =>
  (value ?? "").normalize("NFC").replace(/\r\n/g, "\n").trim();

/** Preserve production text exactly; delivery arrangements do not describe the product. */
function productionDetails(line: ResolvedDuplicateLine): string {
  if (line.customizationSnapshot) {
    return JSON.stringify({
      templateId: line.customizationSnapshot.templateId,
      values: line.customizationSnapshot.values
        .map((v) => [v.fieldKey, text(v.value)])
        .sort((a, b) => a[0].localeCompare(b[0])),
    });
  }
  let raw = text(line.customizationText);
  if (line.printSpec) {
    try {
      const spec = JSON.parse(line.printSpec) as Record<string, unknown>;
      const structured = [
        typeof spec.size === "string" && spec.size.trim()
          ? `[المقاس] ${spec.size.trim()}`
          : "",
        typeof spec.material === "string" && spec.material.trim()
          ? `[الخامة] ${spec.material.trim()}`
          : "",
      ].filter(Boolean);
      if (!raw)
        raw =
          typeof spec.customizationText === "string"
            ? spec.customizationText.trim()
            : "";
      // Existing reception text already carries these headings; do not repeat them.
      raw = [
        ...structured.filter((heading) => !raw.split("\n").includes(heading)),
        raw,
      ]
        .filter(Boolean)
        .join("\n");
    } catch {
      // An unreadable specification must not turn into a generic service match.
      return `invalid:${line.printSpec}`;
    }
  }
  return raw
    .split("\n")
    .filter((l) => !l.startsWith("[توصيل]") && l.trim() !== "---")
    .join("\n")
    .trim();
}

type ComparableLine = {
  key: string;
  productIdentity: string;
  details: string;
  quantity: Decimal;
  source: ResolvedDuplicateLine;
};

function resolveLine(line: ResolvedDuplicateLine): ComparableLine | null {
  let quantity: Decimal;
  try {
    quantity = new Decimal(line.baseQuantity ?? line.quantity);
    if (line.baseQuantity == null && line.conversionFactor != null) {
      const factor = new Decimal(line.conversionFactor);
      if (factor.gt(0)) quantity = quantity.times(factor);
    }
  } catch {
    return null;
  }
  if (!quantity.isFinite() || !quantity.gt(0)) return null;
  const details = productionDetails(line);
  if (details.startsWith("invalid:")) return null;
  if (
    line.customizationSnapshot &&
    !line.customizationSnapshot.values.some((v) => text(v.value))
  )
    return null;
  const service =
    line.isService || line.lineKind === "PRINT" || line.lineKind === "CUSTOM";
  if (service && !details) return null;
  if (line.variantId == null && (!service || !text(line.title))) return null;
  // Variants retain color/size identity. Bundle quantities cannot be converted through factor=0.
  const unitIdentity =
    line.conversionFactor != null && new Decimal(line.conversionFactor).lte(0)
      ? `:unit:${line.productUnitId}`
      : "";
  const productIdentity =
    line.variantId == null
      ? `service:${text(line.title)}`
      : `variant:${line.variantId}${unitIdentity}`;
  return {
    key: `${productIdentity}:spec:${details}`,
    productIdentity,
    details,
    quantity,
    source: line,
  };
}

function aggregate(lines: readonly ResolvedDuplicateLine[]) {
  const quantities = new Map<string, Decimal>();
  const details = new Map<string, ComparableLine>();
  let unresolved = 0;
  for (const line of lines) {
    const resolved = resolveLine(line);
    if (!resolved) {
      unresolved++;
      continue;
    }
    quantities.set(
      resolved.key,
      (quantities.get(resolved.key) ?? new Decimal(0)).plus(resolved.quantity),
    );
    details.set(resolved.key, resolved);
  }
  return { quantities, details, count: quantities.size + unresolved };
}

function normalizeFieldLabel(value: string): string {
  const label = text(value).replace(/\s+/g, " ");
  if (["المقاس", "مقاس", "القياس", "قياس", "الحجم", "حجم"].includes(label))
    return "size";
  if (["الخامة", "خامة", "المادة", "مادة"].includes(label)) return "material";
  return label;
}

/** All snapshot fields and all free-text lines must be accounted for; substrings never qualify. */
function crossFormatCustomization(
  a: ComparableLine,
  b: ComparableLine,
): boolean {
  if (
    a.productIdentity !== b.productIdentity ||
    a.source.variantId == null ||
    b.source.variantId == null
  )
    return false;
  if (
    Boolean(a.source.customizationSnapshot) ===
    Boolean(b.source.customizationSnapshot)
  )
    return false;
  const snapshot =
    a.source.customizationSnapshot ?? b.source.customizationSnapshot;
  const free = a.source.customizationSnapshot ? b : a;
  if (!snapshot?.values.length || !free.details) return false;
  const rows = free.details.split("\n").map((row) => text(row));
  if (rows.length !== snapshot.values.length || rows.some((row) => !row))
    return false;
  const used = new Set<number>();
  for (const field of snapshot.values) {
    const value = text(field.displayValue);
    if (!value || value.includes("\n") || !text(field.label)) return false;
    const matching = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row, index }) => {
        if (used.has(index)) return false;
        if (row === value) return true;
        const labeled =
          row.match(/^\[([^\]]+)\]\s*(.+)$/) ?? row.match(/^([^:]+):\s*(.+)$/);
        return (
          labeled != null &&
          normalizeFieldLabel(labeled[1]) ===
            normalizeFieldLabel(field.label!) &&
          text(labeled[2]) === value
        );
      });
    // Ambiguous duplicate values/labels require a human; do not choose a convenient row.
    if (matching.length !== 1) return false;
    used.add(matching[0].index);
  }
  return used.size === rows.length;
}

/** Phone equality is checked by the server before this deterministic content comparison. */
export function compareReceptionDuplicateContents(
  current: readonly ResolvedDuplicateLine[],
  candidate: readonly ResolvedDuplicateLine[],
  currentTotal?: string,
  candidateTotal?: string,
) {
  const a = aggregate(current);
  const b = aggregate(candidate);
  const common: Array<{ a: string; b: string; review: boolean }> = Array.from(
    a.quantities.keys(),
  )
    .filter((key) => b.quantities.has(key))
    .map((key) => ({ a: key, b: key, review: false }));
  const unmatchedA = Array.from(a.details.values()).filter(
    (line) => !b.quantities.has(line.key),
  );
  const unmatchedB = Array.from(b.details.values()).filter(
    (line) => !a.quantities.has(line.key),
  );
  for (const line of unmatchedA) {
    const matching = unmatchedB.filter((other) =>
      crossFormatCustomization(line, other),
    );
    if (matching.length !== 1) continue;
    const other = matching[0];
    if (
      unmatchedA.filter((reverse) => crossFormatCustomization(reverse, other))
        .length !== 1
    )
      continue;
    common.push({ a: line.key, b: other.key, review: true });
  }
  // Require at least half of both baskets; a lone shared item in a large order is insufficient.
  if (
    !common.length ||
    common.length * 2 < a.count ||
    common.length * 2 < b.count
  )
    return null;
  const customizationNeedsReview = common.some((pair) => pair.review);
  const contentsMatch =
    !customizationNeedsReview &&
    common.length === a.count &&
    common.length === b.count;
  const quantityMatch = common.every((pair) =>
    a.quantities.get(pair.a)!.eq(b.quantities.get(pair.b)!),
  );
  let valueDifference: string | null = null;
  if (currentTotal != null && candidateTotal != null) {
    try {
      const delta = new Decimal(currentTotal).minus(candidateTotal);
      if (delta.isFinite()) valueDifference = delta.toFixed(2);
    } catch {
      /* Unknown value is never represented as equality. */
    }
  }
  return {
    matchedLines: common.length,
    currentLines: a.count,
    candidateLines: b.count,
    contentsMatch,
    quantityMatch,
    customizationNeedsReview,
    matchLevel:
      contentsMatch && quantityMatch
        ? ("EXACT" as const)
        : ("PARTIAL" as const),
    valueDifference,
  };
}
