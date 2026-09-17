import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import {
  normalizeBarcodeScannerInput,
  normalizeKnownSystemBarcode,
} from "@shared/barcodeScanner";

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
}

export interface DeliveryBarcodeLookup {
  code: string;
  namespace: DeliveryBarcodeNamespace;
  numericId: number | null;
}

export interface PreparedDeliveryBarcodeLookup extends DeliveryBarcodeLookup {
  systemCode: string;
  trackingCode: string;
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
  const systemLookup = classifyDeliveryBarcode(systemCode);
  const lookup = systemLookup.namespace === "REFERENCE"
    ? classifyDeliveryBarcode(trackingCode)
    : systemLookup;
  return { ...lookup, systemCode, trackingCode };
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
  const unique = new Map<string, DeliveryBarcodeTarget>();
  for (const candidate of candidates) {
    if (!Number.isSafeInteger(candidate.id) || candidate.id <= 0) continue;
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
