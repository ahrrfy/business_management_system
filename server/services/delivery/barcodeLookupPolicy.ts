import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import {
  normalizeBarcodeScannerInput,
  normalizeKnownSystemBarcode,
  stripTrackingLeadingZeros,
} from "@shared/barcodeScanner";
import { docBarcode, stripDocPrefix } from "@shared/documentNumber";

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

function unwrapBarcodeEnvelope(raw: string): string {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return "";
  let candidate = trimmed;
  if (/^https?:\/\//i.test(candidate) || candidate.includes("?payload=") || candidate.includes("?order=")) {
    try {
      const url = new URL(candidate, "http://localhost");
      const payload = url.searchParams.get("payload")?.trim();
      const order = url.searchParams.get("order")?.trim();
      if (payload) candidate = payload;
      else if (order) candidate = order;
    } catch {
      // Fall back to raw string when URL parsing fails
    }
  }
  const normalizedCandidate = normalizeKnownSystemBarcode(candidate);
  const pipeMatch = /^(INV|WO|ORD|CNS?|PO|QUO|RV|PV)\|([^|]+)/i.exec(normalizedCandidate);
  if (pipeMatch) {
    const prefix = pipeMatch[1].toUpperCase() === "CNS" ? "CN" : pipeMatch[1].toUpperCase();
    const num = stripDocPrefix(pipeMatch[2].trim()).replace(/^CNS-/i, "CN-");
    return docBarcode(prefix, num);
  }
  return candidate;
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
  const unwrapped = unwrapBarcodeEnvelope(raw);
  const systemCode = normalizeKnownSystemBarcode(unwrapped);
  const trackingCode = normalizeBarcodeScannerInput(unwrapped);
  const strippedTrackingCode = stripTrackingLeadingZeros(trackingCode);
  const systemLookup = classifyDeliveryBarcode(systemCode);
  const lookup = systemLookup.namespace === "REFERENCE"
    ? classifyDeliveryBarcode(trackingCode)
    : systemLookup;
  const documentCode = stripDocPrefix(
    systemLookup.namespace === "REFERENCE" ? lookup.code : systemCode,
  ).replace(/^CNS-/i, "CN-");
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

export interface LinkedDeliveryCandidateSet {
  namespace: DeliveryBarcodeNamespace;
  onlineOrders?: ReadonlyArray<{
    id: number;
    invoiceId?: number | null;
    matchRank?: number;
  }>;
  workOrders?: ReadonlyArray<{
    id: number;
    invoiceId?: number | null;
    matchRank?: number;
  }>;
  invoices?: ReadonlyArray<{
    id: number;
    sourceType?: string | null;
    sourceId?: string | null;
    linkedOnlineOrderId?: number | null;
    linkedWorkOrderId?: number | null;
    matchRank?: number;
  }>;
  consignments?: ReadonlyArray<{
    id: number;
    workOrderId?: number | null;
    invoiceId?: number | null;
    sourceType?: string | null;
    sourceId?: number | null;
    linkedOnlineOrderId?: number | null;
    matchRank?: number;
  }>;
  /**
   * When true (e.g. `workOrders.getByNumber`), a matched consignment always resolves to
   * its parent source record (WORK_ORDER / ONLINE_ORDER / INVOICE).
   * When false (e.g. `dispatchByBarcode`), a matched consignment collapses into its parent
   * only when `namespace !== "CONSIGNMENT"` and that parent also matched in the same lookup.
   */
  mapConsignmentToSource?: boolean;
}

function parseWorkOrderSourceId(sourceType?: string | null, sourceId?: string | null): number | null {
  if (sourceType !== "WORKORDER" || !sourceId) return null;
  const m = /^WO-(\d+)(?::R\d+)?$/i.exec(sourceId.trim());
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function parseOnlineOrderSourceId(sourceType?: string | null, sourceId?: string | null): number | null {
  if (sourceType !== "ONLINE" || !sourceId) return null;
  const m = /^online-dispatch:(\d+)$/i.exec(sourceId.trim());
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Under Unified Transaction Tracking (R1), a single transaction shares the same base tracking
 * number across its lifecycle stages:
 *   - ONLINE_ORDER (`ORD-100034`) -> INVOICE (`100034`) -> CONSIGNMENT (`100034`)
 *   - WORK_ORDER (`100035`) -> INVOICE (`100035`) -> CONSIGNMENT (`100035`)
 *   - INVOICE (`100036`) -> CONSIGNMENT (`100036`)
 *
 * When a bare/numeric code is scanned, those linked child records are stages of the same
 * parent transaction rather than conflicting unrelated records. This helper collapses linked
 * child candidates into their parent candidate while keeping genuinely unrelated records distinct.
 */
export function collapseLinkedDeliveryBarcodeCandidates(
  input: LinkedDeliveryCandidateSet,
): DeliveryBarcodeTarget[] {
  const onlineList = input.onlineOrders ?? [];
  const workOrderList = input.workOrders ?? [];
  const invoiceList = input.invoices ?? [];
  const consignmentList = input.consignments ?? [];

  const matchedOnlineOrderIds = new Set<number>();
  const onlineOrderByInvoiceId = new Map<number, number>();
  for (const ord of onlineList) {
    const id = Number(ord.id);
    if (Number.isSafeInteger(id) && id > 0) {
      matchedOnlineOrderIds.add(id);
      if (ord.invoiceId != null && Number(ord.invoiceId) > 0) {
        onlineOrderByInvoiceId.set(Number(ord.invoiceId), id);
      }
    }
  }

  const matchedWorkOrderIds = new Set<number>();
  const workOrderByInvoiceId = new Map<number, number>();
  for (const wo of workOrderList) {
    const id = Number(wo.id);
    if (Number.isSafeInteger(id) && id > 0) {
      matchedWorkOrderIds.add(id);
      if (wo.invoiceId != null && Number(wo.invoiceId) > 0) {
        workOrderByInvoiceId.set(Number(wo.invoiceId), id);
      }
    }
  }

  const matchedInvoiceIds = new Set<number>();
  const invoiceParentTarget = new Map<number, { kind: "WORK_ORDER" | "ONLINE_ORDER"; id: number }>();

  const targets: DeliveryBarcodeTarget[] = [
    ...onlineList.map((row) => ({
      kind: "ONLINE_ORDER" as const,
      id: Number(row.id),
      matchRank: Number(row.matchRank ?? 0),
    })),
    ...workOrderList.map((row) => ({
      kind: "WORK_ORDER" as const,
      id: Number(row.id),
      matchRank: Number(row.matchRank ?? 0),
    })),
  ];

  for (const inv of invoiceList) {
    const invId = Number(inv.id);
    const rank = Number(inv.matchRank ?? 0);
    if (Number.isSafeInteger(invId) && invId > 0) {
      matchedInvoiceIds.add(invId);
    }

    if (input.namespace !== "INVOICE") {
      const woId =
        workOrderByInvoiceId.get(invId) ??
        (inv.linkedWorkOrderId != null ? Number(inv.linkedWorkOrderId) : null) ??
        parseWorkOrderSourceId(inv.sourceType, inv.sourceId);
      if (woId != null && matchedWorkOrderIds.has(woId)) {
        invoiceParentTarget.set(invId, { kind: "WORK_ORDER", id: woId });
        targets.push({ kind: "WORK_ORDER", id: woId, matchRank: rank });
        continue;
      }

      const ordId =
        onlineOrderByInvoiceId.get(invId) ??
        (inv.linkedOnlineOrderId != null ? Number(inv.linkedOnlineOrderId) : null) ??
        parseOnlineOrderSourceId(inv.sourceType, inv.sourceId);
      if (ordId != null && matchedOnlineOrderIds.has(ordId)) {
        invoiceParentTarget.set(invId, { kind: "ONLINE_ORDER", id: ordId });
        targets.push({ kind: "ONLINE_ORDER", id: ordId, matchRank: rank });
        continue;
      }
    }

    targets.push({ kind: "INVOICE", id: invId, matchRank: rank });
  }

  for (const cn of consignmentList) {
    // Fulfillment source IDs never identify historical invoices or work orders.
    if (cn.sourceType === "AFTERCARE_EXECUTION" || cn.sourceType === "FULFILLMENT_REQUEST") {
      targets.push({ kind: "CONSIGNMENT", id: Number(cn.id), matchRank: cn.matchRank });
      continue;
    }
    const rank = Number(cn.matchRank ?? 0);
    const cnWoId =
      cn.workOrderId != null
        ? Number(cn.workOrderId)
        : cn.sourceType === "WORK_ORDER" && cn.sourceId != null
          ? Number(cn.sourceId)
          : null;
    const cnOrdId =
      cn.sourceType === "ONLINE_ORDER" && cn.sourceId != null
        ? Number(cn.sourceId)
        : cn.linkedOnlineOrderId != null
          ? Number(cn.linkedOnlineOrderId)
          : cn.invoiceId != null
            ? (onlineOrderByInvoiceId.get(Number(cn.invoiceId)) ?? null)
            : null;
    const cnInvId =
      cn.invoiceId != null
        ? Number(cn.invoiceId)
        : cn.sourceType === "INVOICE" && cn.sourceId != null
          ? Number(cn.sourceId)
          : null;

    if (input.mapConsignmentToSource) {
      if (cnWoId != null && cnWoId > 0) {
        targets.push({ kind: "WORK_ORDER", id: cnWoId, matchRank: rank });
      } else if (cnOrdId != null && cnOrdId > 0) {
        targets.push({ kind: "ONLINE_ORDER", id: cnOrdId, matchRank: rank });
      } else if (cnInvId != null && cnInvId > 0) {
        const parent = invoiceParentTarget.get(cnInvId);
        if (parent) {
          targets.push({ kind: parent.kind, id: parent.id, matchRank: rank });
        } else {
          targets.push({ kind: "INVOICE", id: cnInvId, matchRank: rank });
        }
      } else {
        targets.push({ kind: "CONSIGNMENT", id: Number(cn.id), matchRank: rank });
      }
      continue;
    }

    if (input.namespace !== "CONSIGNMENT") {
      if (cnWoId != null && matchedWorkOrderIds.has(cnWoId)) {
        targets.push({ kind: "WORK_ORDER", id: cnWoId, matchRank: rank });
        continue;
      }
      if (cnOrdId != null && matchedOnlineOrderIds.has(cnOrdId)) {
        targets.push({ kind: "ONLINE_ORDER", id: cnOrdId, matchRank: rank });
        continue;
      }
      if (cnInvId != null && matchedInvoiceIds.has(cnInvId)) {
        const parent = invoiceParentTarget.get(cnInvId);
        if (parent) {
          targets.push({ kind: parent.kind, id: parent.id, matchRank: rank });
        } else {
          targets.push({ kind: "INVOICE", id: cnInvId, matchRank: rank });
        }
        continue;
      }
    }

    targets.push({ kind: "CONSIGNMENT", id: Number(cn.id), matchRank: rank });
  }

  return targets;
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

export interface InvoiceBarcodeCandidateRow {
  id: number;
  sourceType?: string | null;
  sourceId?: string | null;
  correctedByInvoiceId?: number | null;
  matchRank?: number;
}

/**
 * يتتبّع سلسلة الفواتير المصحَّحة (`correctedByInvoiceId` حتى ١٦ خطوة مع الحماية من الحلقات)
 * بحيث يحلّ مسح الفاتورة الأصلية المستبدَلة (`100034` أو `INV-100034`) إلى الفاتورة البديلة
 * الفعّالة (`100034-1`) ويطويها مع الإرسالية أو طلب المتجر المُعاد ربطهما بها دون تضارب.
 */
export async function resolveActiveInvoiceCandidates<T extends InvoiceBarcodeCandidateRow>(
  candidates: readonly T[],
  loadById: (id: number) => Promise<Omit<T, "matchRank"> | null | undefined>,
): Promise<T[]> {
  if (candidates.length === 0) return [];
  const byId = new Map<number, T>();
  for (const candidate of candidates) {
    let current: Omit<T, "matchRank"> = candidate;
    const rank = Number(candidate.matchRank ?? 0);
    const visited = new Set<number>();
    while (current.correctedByInvoiceId != null && visited.size < 16) {
      const currentId = Number(current.id);
      const nextId = Number(current.correctedByInvoiceId);
      if (!Number.isSafeInteger(nextId) || nextId <= 0 || visited.has(currentId) || nextId === currentId) {
        break;
      }
      visited.add(currentId);
      const next = await loadById(nextId);
      if (!next) break;
      current = next;
    }
    const resolvedId = Number(current.id);
    const existing = byId.get(resolvedId);
    if (!existing || rank > Number(existing.matchRank ?? 0)) {
      byId.set(resolvedId, {
        ...current,
        matchRank: rank,
      } as T);
    }
  }
  return Array.from(byId.values());
}

