import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, desc, eq, inArray, or, type SQL } from "drizzle-orm";
import type { AnyMySqlColumn } from "drizzle-orm/mysql-core";
import {
  customers,
  invoices,
  onlineOrderItems,
  onlineOrders,
  products,
  productUnits,
  productVariants,
  receptionDraftLines,
  receptionDrafts,
  workOrders,
} from "../../../drizzle/schema";
import { appErrorMessage } from "@shared/errors";
import {
  isReceptionChannel,
  type ReceptionChannel,
} from "@shared/receptionChannel";
import { orderStatusLabel } from "@shared/onlineOrderStatus";
import {
  WO_ACTIVE_STATUSES,
  workOrderStatusLabel,
} from "@shared/workOrderStatus";
import {
  compareReceptionDuplicateContents,
  type ReceptionDuplicateInput,
  type ReceptionDuplicateKind,
  type ReceptionDuplicateMatch,
  type ReceptionDuplicateResult,
  type ResolvedDuplicateLine,
} from "@shared/receptionDuplicateOrders";
import { canonicalIraqiMobile } from "../../lib/phone";
import { canCrossBranches } from "../../lib/branchAuthority";
import { requireDb, type Actor } from "../tx";

const CANDIDATE_LIMIT = 60;
const EMPTY: ReceptionDuplicateResult = {
  checked: false,
  matches: [],
  truncated: false,
};
type Header = {
  kind: ReceptionDuplicateKind;
  id: number;
  number: string;
  channel: ReceptionChannel;
  createdAt: Date;
  statusLabel: string;
  total: string;
  phones: (string | null)[];
  customerId: number | null;
  draftId: number | null;
  invoiceId: number | null;
  linkedInvoiceIds: number[];
  workLine?: ResolvedDuplicateLine;
};
const customerColumns = {
  phone: customers.phone,
  phone2: customers.phone2,
  phone3: customers.phone3,
  whatsapp: customers.whatsapp,
};
type Phones = {
  phone: string | null;
  phone2: string | null;
  phone3: string | null;
  whatsapp: string | null;
};
const phonesOf = (
  row: Phones,
  contact?: string | null,
  handle?: string | null,
) => [
  contact ?? null,
  handle ?? null,
  row.phone,
  row.phone2,
  row.phone3,
  row.whatsapp,
];

function fail(
  code: "FORBIDDEN" | "NOT_FOUND" | "BAD_REQUEST",
  what: string,
): never {
  throw new TRPCError({
    code,
    message: appErrorMessage({
      what,
      why: "فحص الطلبات يتطلب مرجعاً صحيحاً ضمن الفرع المسموح",
      doThis: "افتح الطلب من قائمة الاستقبال في فرعك وأعد المحاولة",
    }),
  });
}

/** Equality forms use existing phone indexes; no suffix/LIKE scan and no name-only identity. */
export function receptionDuplicatePhoneForms(raw: string): string[] {
  const canonical = canonicalIraqiMobile(raw);
  if (!canonical) return [];
  const national = canonical.slice(4);
  const ascii = [
    canonical,
    canonical.slice(1),
    `00${canonical.slice(1)}`,
    `0${national}`,
  ];
  const arabic = (s: string, digits: string) =>
    s.replace(/\d/g, (d) => digits[Number(d)]);
  return Array.from(
    new Set([
      ...ascii,
      raw.trim(),
      ...ascii.map((s) => arabic(s, "٠١٢٣٤٥٦٧٨٩")),
      ...ascii.map((s) => arabic(s, "۰۱۲۳۴۵۶۷۸۹")),
    ]),
  );
}

async function draftHeaders(
  db: ReturnType<typeof requireDb>,
  where: SQL,
  limit: number,
): Promise<Header[]> {
  const rows = await db
    .select({
      id: receptionDrafts.id,
      number: receptionDrafts.draftNumber,
      channel: receptionDrafts.channel,
      createdAt: receptionDrafts.createdAt,
      total: receptionDrafts.total,
      contact: receptionDrafts.contactPhone,
      handle: receptionDrafts.channelHandle,
      customerId: receptionDrafts.customerId,
      invoiceId: receptionDrafts.committedInvoiceId,
      printInvoiceId: receptionDrafts.committedPrintInvoiceId,
      ...customerColumns,
    })
    .from(receptionDrafts)
    .leftJoin(customers, eq(customers.id, receptionDrafts.customerId))
    .where(where)
    .orderBy(desc(receptionDrafts.id))
    .limit(limit);
  return rows.map((r) => ({
    ...r,
    kind: "DRAFT",
    channel: isReceptionChannel(r.channel) ? r.channel : "OTHER",
    statusLabel: "طلب محفوظ",
    phones: phonesOf(r, r.contact, r.channel === "WHATSAPP" ? r.handle : null),
    draftId: r.id,
    linkedInvoiceIds: [r.invoiceId, r.printInvoiceId].filter(
      (n): n is number => n != null,
    ),
  }));
}

async function onlineHeaders(
  db: ReturnType<typeof requireDb>,
  where: SQL,
  limit: number,
): Promise<Header[]> {
  const rows = await db
    .select({
      id: onlineOrders.id,
      number: onlineOrders.orderNumber,
      createdAt: onlineOrders.createdAt,
      total: onlineOrders.total,
      status: onlineOrders.status,
      customerId: onlineOrders.customerId,
      invoiceId: onlineOrders.invoiceId,
      ...customerColumns,
    })
    .from(onlineOrders)
    .innerJoin(customers, eq(customers.id, onlineOrders.customerId))
    .where(where)
    .orderBy(desc(onlineOrders.id))
    .limit(limit);
  return rows.map((r) => ({
    ...r,
    kind: "ONLINE",
    channel: "STORE",
    statusLabel: orderStatusLabel(r.status),
    phones: phonesOf(r),
    draftId: null,
    linkedInvoiceIds: r.invoiceId == null ? [] : [r.invoiceId],
  }));
}

async function workHeaders(
  db: ReturnType<typeof requireDb>,
  where: SQL,
  limit: number,
): Promise<Header[]> {
  const rows = await db
    .select({
      id: workOrders.id,
      number: workOrders.orderNumber,
      channel: workOrders.receptionChannel,
      createdAt: workOrders.createdAt,
      total: workOrders.salePrice,
      status: workOrders.status,
      contact: workOrders.contactPhone,
      handle: workOrders.channelHandle,
      customerId: workOrders.customerId,
      draftId: workOrders.draftId,
      invoiceId: workOrders.invoiceId,
      variantId: workOrders.baseVariantId,
      productUnitId: workOrders.baseProductUnitId,
      quantity: workOrders.quantity,
      baseQuantity: workOrders.baseBaseQuantity,
      title: workOrders.title,
      customizationText: workOrders.customizationText,
      ...customerColumns,
    })
    .from(workOrders)
    .leftJoin(customers, eq(customers.id, workOrders.customerId))
    .where(where)
    .orderBy(desc(workOrders.id))
    .limit(limit);
  return rows.map((r) => ({
    ...r,
    kind: "WORK_ORDER",
    channel: isReceptionChannel(r.channel) ? r.channel : "OTHER",
    statusLabel: workOrderStatusLabel(r.status),
    phones: phonesOf(r, r.contact, r.channel === "WHATSAPP" ? r.handle : null),
    linkedInvoiceIds: r.invoiceId == null ? [] : [r.invoiceId],
    workLine: {
      lineKind: "CUSTOM",
      variantId: r.variantId,
      productUnitId: r.productUnitId,
      quantity: String(r.quantity),
      baseQuantity: r.baseQuantity == null ? null : String(r.baseQuantity),
      title: r.title,
      customizationText: r.customizationText,
    },
  }));
}

export function receptionDuplicateSameLineage(
  current: Header,
  candidate: Header,
): boolean {
  return (
    (current.kind === candidate.kind && current.id === candidate.id) ||
    (current.draftId != null && current.draftId === candidate.draftId) ||
    current.linkedInvoiceIds.some((id) =>
      candidate.linkedInvoiceIds.includes(id),
    )
  );
}

/** Read-only advisory: the reception employee keeps the preparation decision. */
export async function getReceptionDuplicateOrders(
  input: ReceptionDuplicateInput,
  actor: Actor,
): Promise<ReceptionDuplicateResult> {
  if (!Number.isSafeInteger(input.branchId) || input.branchId <= 0)
    fail("BAD_REQUEST", "الفرع غير صالح");
  if (!canCrossBranches(actor) && actor.branchId !== input.branchId)
    fail("FORBIDDEN", "الفرع غير مسموح");
  if (!input.reference && !input.lines?.length) return { ...EMPTY };
  const db = requireDb();
  let current: Header | null = null;
  if (input.reference) {
    const { kind, id } = input.reference;
    const headers =
      kind === "DRAFT"
        ? await draftHeaders(
            db,
            and(
              eq(receptionDrafts.id, id),
              eq(receptionDrafts.branchId, input.branchId),
            )!,
            1,
          )
        : kind === "ONLINE"
          ? await onlineHeaders(
              db,
              and(
                eq(onlineOrders.id, id),
                eq(onlineOrders.branchId, input.branchId),
              )!,
              1,
            )
          : await workHeaders(
              db,
              and(
                eq(workOrders.id, id),
                eq(workOrders.branchId, input.branchId),
              )!,
              1,
            );
    current = headers[0] ?? null;
    if (!current) fail("NOT_FOUND", "الطلب غير موجود في الفرع المسموح");
  }
  let excludedDraft: Header | null = null;
  if (input.excludeDraftId != null) {
    excludedDraft =
      (
        await draftHeaders(
          db,
          and(
            eq(receptionDrafts.id, input.excludeDraftId),
            eq(receptionDrafts.branchId, input.branchId),
          )!,
          1,
        )
      )[0] ?? null;
    if (!excludedDraft)
      fail("NOT_FOUND", "الطلب المحفوظ غير موجود في الفرع المسموح");
  }
  const rawPhones = current ? current.phones : [input.phone];
  const canonicalPhones = new Set(
    rawPhones.map(canonicalIraqiMobile).filter((p): p is string => p != null),
  );
  if (!canonicalPhones.size) return { ...EMPTY };
  const forms = Array.from(
    new Set([
      ...Array.from(canonicalPhones).flatMap(receptionDuplicatePhoneForms),
      ...rawPhones
        .filter((p): p is string => canonicalIraqiMobile(p) != null)
        .map((p) => p.trim()),
    ]),
  );
  // Customer primary phone and draft contactPhone have indexes. Linked customer IDs avoid joins scanning history.
  const customerRows = await db
    .select({ id: customers.id, ...customerColumns })
    .from(customers)
    .where(inArray(customers.phone, forms))
    .limit(CANDIDATE_LIMIT + 1);
  let verifiedCustomerId: number | null = null;
  if (
    !current &&
    input.customerId != null &&
    Number.isSafeInteger(input.customerId) &&
    input.customerId > 0
  ) {
    const hint = (
      await db
        .select({ id: customers.id, ...customerColumns })
        .from(customers)
        .where(eq(customers.id, input.customerId))
        .limit(1)
    )[0];
    if (
      hint &&
      phonesOf(hint).some((p) => {
        const canonical = canonicalIraqiMobile(p);
        return canonical != null && canonicalPhones.has(canonical);
      })
    )
      verifiedCustomerId = hint.id;
  }
  const customerIds = Array.from(
    new Set([
      ...customerRows.map((r) => r.id),
      ...(current?.customerId != null ? [current.customerId] : []),
      ...(verifiedCustomerId != null ? [verifiedCustomerId] : []),
    ]),
  );
  const customerCondition = (column: AnyMySqlColumn) =>
    customerIds.length ? inArray(column, customerIds) : undefined;
  const [drafts, online, works] = await Promise.all([
    draftHeaders(
      db,
      and(
        eq(receptionDrafts.branchId, input.branchId),
        eq(receptionDrafts.status, "OPEN"),
        or(
          inArray(receptionDrafts.contactPhone, forms),
          customerCondition(receptionDrafts.customerId),
        ),
      )!,
      CANDIDATE_LIMIT + 1,
    ),
    customerIds.length
      ? onlineHeaders(
          db,
          and(
            eq(onlineOrders.branchId, input.branchId),
            inArray(onlineOrders.status, [
              "PENDING",
              "CONFIRMED",
              "PROCESSING",
              "SHIPPED",
            ]),
            inArray(onlineOrders.customerId, customerIds),
          )!,
          CANDIDATE_LIMIT + 1,
        )
      : Promise.resolve([]),
    // Legacy guest work orders lack a phone index: restrict to the indexed branch and active statuses first.
    workHeaders(
      db,
      and(
        eq(workOrders.branchId, input.branchId),
        inArray(workOrders.status, [...WO_ACTIVE_STATUSES]),
        inArray(workOrders.receptionChannel, [
          "WHATSAPP",
          "INSTAGRAM",
          "PHONE",
          "TIKTOK",
          "OTHER",
        ]),
        or(
          inArray(workOrders.contactPhone, forms),
          inArray(workOrders.channelHandle, forms),
          customerCondition(workOrders.customerId),
        ),
      )!,
      CANDIDATE_LIMIT + 1,
    ),
  ]);
  let truncated =
    customerRows.length > CANDIDATE_LIMIT ||
    [drafts, online, works].some((r) => r.length > CANDIDATE_LIMIT);
  const candidates = [
    ...drafts.slice(0, CANDIDATE_LIMIT),
    ...online.slice(0, CANDIDATE_LIMIT),
    ...works.slice(0, CANDIDATE_LIMIT),
  ]
    .filter((r) =>
      r.phones.some((p) => {
        const canonical = canonicalIraqiMobile(p);
        return canonical != null && canonicalPhones.has(canonical);
      }),
    )
    .filter(
      (r) =>
        (!current || !receptionDuplicateSameLineage(current, r)) &&
        (!excludedDraft || !receptionDuplicateSameLineage(excludedDraft, r)),
    );
  const all = [...candidates, ...(current ? [current] : [])];
  const draftIds = Array.from(
    new Set(all.filter((r) => r.kind === "DRAFT").map((r) => r.id)),
  );
  const onlineIds = Array.from(
    new Set(all.filter((r) => r.kind === "ONLINE").map((r) => r.id)),
  );
  // Narrow, phone-selected candidates only. Images and raw specifications never leave this service.
  const [draftLines, onlineLines] = await Promise.all([
    draftIds.length
      ? db
          .select({
            parentId: receptionDraftLines.draftId,
            lineKind: receptionDraftLines.lineKind,
            variantId: receptionDraftLines.variantId,
            productUnitId: receptionDraftLines.productUnitId,
            quantity: receptionDraftLines.quantity,
            title: receptionDraftLines.title,
            customizationText: receptionDraftLines.customizationText,
            printSpec: receptionDraftLines.printSpec,
          })
          .from(receptionDraftLines)
          .where(inArray(receptionDraftLines.draftId, draftIds))
      : Promise.resolve([]),
    onlineIds.length
      ? db
          .select({
            parentId: onlineOrderItems.onlineOrderId,
            variantId: onlineOrderItems.variantId,
            productUnitId: onlineOrderItems.productUnitId,
            quantity: onlineOrderItems.quantity,
            baseQuantity: onlineOrderItems.baseQuantity,
            customizationSnapshot: onlineOrderItems.customizationSnapshot,
          })
          .from(onlineOrderItems)
          .where(inArray(onlineOrderItems.onlineOrderId, onlineIds))
      : Promise.resolve([]),
  ]);
  const linesByKey = new Map<string, ResolvedDuplicateLine[]>();
  const append = (key: string, line: ResolvedDuplicateLine) => {
    const lines = linesByKey.get(key) ?? [];
    lines.push(line);
    linesByKey.set(key, lines);
  };
  draftLines.forEach((l) => append(`DRAFT:${l.parentId}`, l));
  onlineLines.forEach((l) =>
    append(`ONLINE:${l.parentId}`, {
      ...l,
      baseQuantity: String(l.baseQuantity),
    }),
  );
  all.forEach((h) => {
    if (h.workLine) append(`WORK_ORDER:${h.id}`, h.workLine);
  });
  const currentLines = current
    ? (linesByKey.get(`${current.kind}:${current.id}`) ?? [])
    : (input.lines ?? []);
  if (!currentLines.length) return { ...EMPTY };
  const everyLine = Array.from(linesByKey.values())
    .flat()
    .concat(current ? [] : currentLines);
  const unitIds = Array.from(
    new Set(
      everyLine
        .map((l) => l.productUnitId)
        .filter((id): id is number => id != null),
    ),
  );
  const variantIds = Array.from(
    new Set(
      everyLine
        .map((l) => l.variantId)
        .filter((id): id is number => id != null),
    ),
  );
  const [units, variants] = await Promise.all([
    unitIds.length
      ? db
          .select({
            id: productUnits.id,
            variantId: productUnits.variantId,
            factor: productUnits.conversionFactor,
          })
          .from(productUnits)
          .where(inArray(productUnits.id, unitIds))
      : Promise.resolve([]),
    variantIds.length
      ? db
          .select({ id: productVariants.id, isService: products.isService })
          .from(productVariants)
          .innerJoin(products, eq(products.id, productVariants.productId))
          .where(inArray(productVariants.id, variantIds))
      : Promise.resolve([]),
  ]);
  const byUnit = new Map(units.map((u) => [u.id, u]));
  const byVariant = new Map(variants.map((v) => [v.id, v]));
  const resolve = (lines: ResolvedDuplicateLine[]) =>
    lines.map((l): ResolvedDuplicateLine => {
      const unit =
        l.productUnitId != null ? byUnit.get(l.productUnitId) : undefined;
      if (unit && l.variantId != null && unit.variantId !== l.variantId)
        return { ...l, quantity: "0", baseQuantity: "0" };
      if (l.productUnitId != null && !unit && l.baseQuantity == null)
        return { ...l, quantity: "0" };
      const variantId = unit?.variantId ?? l.variantId;
      return {
        ...l,
        variantId,
        conversionFactor: unit?.factor ?? null,
        isService:
          variantId != null && byVariant.get(variantId)?.isService === true,
      };
    });
  const resolvedCurrent = resolve(currentLines);
  const matches: ReceptionDuplicateMatch[] = [];
  const lineageByKey = new Map<string, string>();
  for (const candidate of candidates) {
    const comparison = compareReceptionDuplicateContents(
      resolvedCurrent,
      resolve(linesByKey.get(`${candidate.kind}:${candidate.id}`) ?? []),
      current?.total ?? input.total,
      candidate.total,
    );
    if (!comparison) continue;
    const lineage =
      candidate.draftId != null
        ? `DRAFT:${candidate.draftId}`
        : candidate.invoiceId != null
          ? `INVOICE:${candidate.invoiceId}`
          : `${candidate.kind}:${candidate.id}`;
    lineageByKey.set(`${candidate.kind}:${candidate.id}`, lineage);
    matches.push({
      ...comparison,
      key: `${candidate.kind}:${candidate.id}`,
      kind: candidate.kind,
      id: candidate.id,
      number: candidate.number,
      channel: candidate.channel,
      createdAt: candidate.createdAt.toISOString(),
      statusLabel: candidate.statusLabel,
      total: candidate.total,
      invoice: null,
      href:
        candidate.kind === "DRAFT"
          ? `/reception/drafts?draftId=${candidate.id}`
          : candidate.kind === "ONLINE"
            ? `/store-admin?tab=orders&orderId=${candidate.id}`
            : `/work-orders/${candidate.id}`,
    });
  }
  matches.sort(
    (a, b) =>
      Number(b.matchLevel === "EXACT") - Number(a.matchLevel === "EXACT") ||
      b.matchedLines / Math.max(b.currentLines, b.candidateLines) -
        a.matchedLines / Math.max(a.currentLines, a.candidateLines) ||
      (a.valueDifference == null
        ? 1
        : b.valueDifference == null
          ? -1
          : new Decimal(a.valueDifference)
              .abs()
              .cmp(new Decimal(b.valueDifference).abs())) ||
      b.createdAt.localeCompare(a.createdAt),
  );
  const seenLineages = new Set<string>();
  const uniqueMatches = matches.filter((match) => {
    const lineage = lineageByKey.get(match.key)!;
    if (seenLineages.has(lineage)) return false;
    seenLineages.add(lineage);
    return true;
  });
  truncated ||= uniqueMatches.length > 3;
  const top = uniqueMatches.slice(0, 3);
  const invoiceIds = Array.from(
    new Set(
      top
        .map(
          (m) =>
            candidates.find((h) => h.kind === m.kind && h.id === m.id)
              ?.invoiceId,
        )
        .filter((id): id is number => id != null),
    ),
  );
  const invoiceRows = invoiceIds.length
    ? await db
        .select({
          id: invoices.id,
          number: invoices.invoiceNumber,
          total: invoices.total,
          status: invoices.status,
        })
        .from(invoices)
        .where(
          and(
            eq(invoices.branchId, input.branchId),
            inArray(invoices.id, invoiceIds),
          ),
        )
    : [];
  const byInvoice = new Map(invoiceRows.map((i) => [i.id, i]));
  for (const match of top) {
    const invoiceId = candidates.find(
      (h) => h.kind === match.kind && h.id === match.id,
    )?.invoiceId;
    match.invoice =
      invoiceId != null ? (byInvoice.get(invoiceId) ?? null) : null;
  }
  return { checked: true, matches: top, truncated };
}
