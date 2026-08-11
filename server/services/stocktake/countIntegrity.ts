import { TRPCError } from "@trpc/server";
import { eq, inArray } from "drizzle-orm";
import Decimal from "decimal.js";
import { productUnitBarcodes, productUnits } from "../../../drizzle/schema";
import { chunk, type DbLike } from "./internal";
import type { ReviewRow } from "./reviewCore";

export type CountInputAnomaly = {
  variantId: number;
  productName: string;
  variantName: string | null;
  sku: string;
  rawCount: number;
  matchedCodeKind: "BARCODE" | "ALIAS" | "SKU";
};

function prefixOf(code: string | null | undefined): number | null {
  const digits = String(code ?? "").replace(/\D/g, "");
  if (digits.length < 8) return null;
  const prefix = Number(digits.slice(0, 7));
  return Number.isSafeInteger(prefix) ? prefix : null;
}

function parseStoredBreakdown(raw: string | null): {
  quantities: Record<string, number>;
  guardedQty: number | null;
} {
  if (!raw) return { quantities: {}, guardedQty: null };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 0
      )
        result[key] = value;
    }
    const guard = parsed.__stocktakeScannerGuard;
    const guardedQty =
      typeof guard === "object" &&
      guard != null &&
      (guard as Record<string, unknown>).version === 1 &&
      typeof (guard as Record<string, unknown>).qty === "number" &&
      Number.isSafeInteger((guard as Record<string, unknown>).qty) &&
      typeof (guard as Record<string, unknown>).candidateDigest === "string" &&
      /^[a-f0-9]{64}$/.test(
        String((guard as Record<string, unknown>).candidateDigest),
      )
        ? Number((guard as Record<string, unknown>).qty)
        : null;
    return { quantities: result, guardedQty };
  } catch {
    return { quantities: {}, guardedQty: null };
  }
}

/** Detects an effective count that exactly matches the scanner-input truncation signature. */
export async function findCountInputAnomalies(
  db: DbLike,
  rows: ReviewRow[],
): Promise<CountInputAnomaly[]> {
  const ids = rows.map((row) => row.variantId);
  if (!ids.length) return [];
  const candidates = new Map<
    number,
    {
      code: string;
      factor: string;
      unitName: string;
      kind: "BARCODE" | "ALIAS";
    }[]
  >();
  for (const part of chunk(ids)) {
    const units = await db
      .select({
        variantId: productUnits.variantId,
        factor: productUnits.conversionFactor,
        unitName: productUnits.unitName,
        barcode: productUnits.barcode,
      })
      .from(productUnits)
      .where(inArray(productUnits.variantId, part));
    for (const unit of units) {
      if (!unit.barcode) continue;
      const id = Number(unit.variantId);
      const list = candidates.get(id) ?? [];
      list.push({
        code: unit.barcode,
        factor: String(unit.factor),
        unitName: unit.unitName,
        kind: "BARCODE",
      });
      candidates.set(id, list);
    }
    const aliases = await db
      .select({
        variantId: productUnits.variantId,
        factor: productUnits.conversionFactor,
        unitName: productUnits.unitName,
        barcode: productUnitBarcodes.barcode,
      })
      .from(productUnitBarcodes)
      .innerJoin(
        productUnits,
        eq(productUnitBarcodes.productUnitId, productUnits.id),
      )
      .where(inArray(productUnits.variantId, part));
    for (const alias of aliases) {
      const id = Number(alias.variantId);
      const list = candidates.get(id) ?? [];
      list.push({
        code: alias.barcode,
        factor: String(alias.factor),
        unitName: alias.unitName,
        kind: "ALIAS",
      });
      candidates.set(id, list);
    }
  }

  const anomalies: CountInputAnomaly[] = [];
  for (const row of rows) {
    if (row.rawCount == null) continue;
    const storedBreakdown = parseStoredBreakdown(row.countUnitBreakdown);
    // New requests carry an append-only server attestation in the matching
    // count operation. It proves the scanner candidates were checked at write
    // time even if a catalog alias is deleted later.
    if (row.countGuardAttested && storedBreakdown.guardedQty === row.rawCount)
      continue;
    const breakdown = storedBreakdown.quantities;
    const list = [
      ...(candidates.get(row.variantId) ?? []),
      { code: row.sku, factor: "1", unitName: "", kind: "SKU" as const },
    ];
    const match = list.find((candidate) => {
      const prefix = prefixOf(candidate.code);
      if (prefix == null) return false;
      if (candidate.unitName && breakdown?.[candidate.unitName] === prefix)
        return true;
      const expected = new Decimal(prefix).times(candidate.factor);
      return (
        expected.isInteger() &&
        expected.abs().lte(Number.MAX_SAFE_INTEGER) &&
        expected.toNumber() === row.rawCount
      );
    });
    if (!match) continue;
    anomalies.push({
      variantId: row.variantId,
      productName: row.productName,
      variantName: row.variantName,
      sku: row.sku,
      rawCount: row.rawCount,
      matchedCodeKind: match.kind,
    });
  }
  return anomalies;
}

export function assertNoCountInputAnomalies(
  anomalies: CountInputAnomaly[],
): void {
  if (!anomalies.length) return;
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message:
      `حُجب الاعتماد: ${anomalies.length} كمية تطابق بصمة إدخال باركود داخل حقل العدد. ` +
      "يلزم إعادة عد مستقلة أو حسم العد التحققي قبل المتابعة.",
  });
}
