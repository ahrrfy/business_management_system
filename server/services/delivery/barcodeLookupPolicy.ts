import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import {
  normalizeBarcodeScannerInput,
  normalizeKnownSystemBarcode,
  stripTrackingLeadingZeros,
} from "@shared/barcodeScanner";
import { stripDocPrefix } from "@shared/documentNumber";

export type DeliveryBarcodeNamespace =
  | "CONSIGNMENT"
  | "INVOICE"
  | "WORK_ORDER"
  | "ONLINE_ORDER"
  | "NUMERIC"
  | "REFERENCE";

export type DeliveryBarcodeTargetKind =
  | "CONSIGNMENT"
  | "INVOICE"
  | "WORK_ORDER"
  | "ONLINE_ORDER";

export interface DeliveryBarcodeTarget {
  kind: DeliveryBarcodeTargetKind;
  id: number;
  /** رقم المستند الصريح (100) > مرجع خارجي (50) > معرّف قاعدة بيانات قديم (10). */
  matchRank?: number;
}

export interface DeliveryBarcodeLookup {
  code: string;
  namespace: DeliveryBarcodeNamespace;
  numericId: number | null;
}

export interface PreparedDeliveryBarcodeLookup extends DeliveryBarcodeLookup {
  systemCode: string;
  trackingCode: string;
  strippedTrackingCode: string;
  documentCode: string;
}

/**
 * Internal prefixes own their namespace. A carrier reference that happens to equal
 * INV-/WO-/ORD-/CN- must never shadow the corresponding internal document.
 */
export function classifyDeliveryBarcode(code: string): DeliveryBarcodeLookup {
  if (/^CNS?-/i.test(code)) return { code, namespace: "CONSIGNMENT", numericId: null };
  if (/^INV-/i.test(code)) return { code, namespace: "INVOICE", numericId: null };
  if (/^WO-/i.test(code)) return { code, namespace: "WORK_ORDER", numericId: null };
  if (/^ORD-/i.test(code)) return { code, namespace: "ONLINE_ORDER", numericId: null };
  if (/^\d+$/.test(code)) {
    const numericId = Number(code);
    return {
      code,
      namespace: "NUMERIC",
      numericId: Number.isSafeInteger(numericId) ? numericId : null,
    };
  }
  return { code, namespace: "REFERENCE", numericId: null };
}

/** Keep system-prefix normalization and carrier-reference canonicalization separate. */
export function prepareDeliveryBarcodeLookup(raw: string): PreparedDeliveryBarcodeLookup {
  const systemCode = normalizeKnownSystemBarcode(raw);
  const trackingCode = normalizeBarcodeScannerInput(raw);
  const strippedTrackingCode = stripTrackingLeadingZeros(trackingCode);
  const systemLookup = classifyDeliveryBarcode(systemCode);
  const lookup = systemLookup.namespace === "REFERENCE"
    ? classifyDeliveryBarcode(trackingCode)
    : systemLookup;
  const documentCode = lookup.namespace === "ONLINE_ORDER"
    ? systemCode.replace(/^ORD-(\d+)$/i, "$1")
    : stripDocPrefix(systemCode);
  return { ...lookup, systemCode, trackingCode, strippedTrackingCode, documentCode };
}


export function namespaceAllowsTarget(
  namespace: DeliveryBarcodeNamespace,
  kind: DeliveryBarcodeTargetKind,
): boolean {
  switch (namespace) {
    case "CONSIGNMENT":
      return kind === "CONSIGNMENT";
    case "INVOICE":
      return kind === "INVOICE";
    case "WORK_ORDER":
      return kind === "WORK_ORDER";
    case "ONLINE_ORDER":
      return kind === "ONLINE_ORDER";
    case "NUMERIC":
    case "REFERENCE":
      return true;
  }
}

/**
 * Collapse duplicate joins that point at the same logical target and reject every
 * genuine cross-namespace/cross-record collision instead of relying on query order.
 */
export function resolveUniqueDeliveryBarcodeTarget(
  code: string,
  candidates: readonly DeliveryBarcodeTarget[],
): DeliveryBarcodeTarget | null {
  const valid = candidates.filter((candidate) => Number.isSafeInteger(candidate.id) && candidate.id > 0);
  const highestRank = valid.reduce((highest, candidate) => Math.max(highest, candidate.matchRank ?? 0), 0);
  const unique = new Map<string, DeliveryBarcodeTarget>();
  for (const candidate of valid) {
    if ((candidate.matchRank ?? 0) !== highestRank) continue;
    unique.set(`${candidate.kind}:${candidate.id}`, candidate);
  }

  if (unique.size > 1) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذّر تحديد السجل من الباركود",
        why: `الرمز «${code}» يطابق أكثر من سجل ضمن النطاق المسموح`,
        doThis: "امسح الرمز الداخلي الكامل الذي يبدأ بـ CN أو INV أو WO أو ORD",
      }),
    });
  }

  return unique.values().next().value ?? null;
}
