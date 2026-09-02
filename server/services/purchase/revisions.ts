import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import {
  productUnits,
  productVariants,
  products,
  purchaseOrderEvents,
  purchaseOrderItems,
  purchaseOrderRevisionItems,
  purchaseOrderRevisions,
  purchaseOrders,
} from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import type { Tx } from "../../db";
import { requireDb, type Actor } from "../tx";
import { assertPurchaseBranch } from "./internal";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function dateValue(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

export type PurchaseRevisionAllocationDraft = {
  lineNo: number;
  requisitionItemId: number;
  allocatedBaseQuantity: number;
};

/**
 * ينشئ لقطة ثابتة من projection الحالي. يجب أن يكون المستدعي قد قفل صف الأمر؛ بذلك يكون
 * رقم النسخة والبنود والـprojection وثيقةً ذرية واحدة ولا يمكن لمحررين إنشاء الرقم نفسه.
 */
export async function createPurchaseOrderRevisionTx(
  tx: Tx,
  input: {
    purchaseOrderId: number;
    actorUserId: number;
    reason: string;
    origin?: "NATIVE" | "LEGACY";
  },
) {
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 500) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "سبب مراجعة أمر الشراء إلزامي (3–500 محرف)",
    });
  }
  const [po] = await tx
    .select()
    .from(purchaseOrders)
    .where(eq(purchaseOrders.id, input.purchaseOrderId))
    .limit(1);
  if (!po) {
    throw new TRPCError({ code: "NOT_FOUND", message: "أمر الشراء غير موجود" });
  }

  const rows = await tx
    .select({
      id: purchaseOrderItems.id,
      variantId: purchaseOrderItems.variantId,
      productUnitId: purchaseOrderItems.productUnitId,
      quantity: purchaseOrderItems.quantity,
      baseQuantity: purchaseOrderItems.baseQuantity,
      listUnitPrice: purchaseOrderItems.listUnitPrice,
      unitPrice: purchaseOrderItems.unitPrice,
      total: purchaseOrderItems.total,
      usdListUnitPrice: purchaseOrderItems.usdListUnitPrice,
      usdUnitPrice: purchaseOrderItems.usdUnitPrice,
      usdTotal: purchaseOrderItems.usdTotal,
      productName: products.name,
      variantName: productVariants.variantName,
      sku: productVariants.sku,
      unitName: productUnits.unitName,
    })
    .from(purchaseOrderItems)
    .innerJoin(productVariants, eq(purchaseOrderItems.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(productUnits, eq(purchaseOrderItems.productUnitId, productUnits.id))
    .where(eq(purchaseOrderItems.purchaseOrderId, input.purchaseOrderId))
    .orderBy(purchaseOrderItems.id);
  if (rows.length === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "أمر الشراء بلا أصناف" });
  }

  const [latest] = await tx
    .select({
      id: purchaseOrderRevisions.id,
      revisionNo: purchaseOrderRevisions.revisionNo,
      payloadHash: purchaseOrderRevisions.payloadHash,
    })
    .from(purchaseOrderRevisions)
    .where(eq(purchaseOrderRevisions.purchaseOrderId, input.purchaseOrderId))
    .orderBy(desc(purchaseOrderRevisions.revisionNo))
    .limit(1);

  const items = rows.map((row, index) => ({
    lineNo: index + 1,
    variantId: Number(row.variantId),
    productUnitId: row.productUnitId == null ? null : Number(row.productUnitId),
    quantity: String(row.quantity),
    baseQuantity: Number(row.baseQuantity),
    listUnitPrice: String(row.listUnitPrice ?? row.unitPrice),
    unitPrice: String(row.unitPrice),
    lineTotal: String(row.total),
    usdListUnitPrice:
      row.usdListUnitPrice == null
        ? row.usdUnitPrice == null
          ? null
          : String(row.usdUnitPrice)
        : String(row.usdListUnitPrice),
    usdUnitPrice: row.usdUnitPrice == null ? null : String(row.usdUnitPrice),
    usdLineTotal: row.usdTotal == null ? null : String(row.usdTotal),
    productNameSnapshot: String(row.productName),
    variantNameSnapshot: row.variantName == null ? null : String(row.variantName),
    skuSnapshot: row.sku == null ? null : String(row.sku),
    unitNameSnapshot: row.unitName == null ? null : String(row.unitName),
  }));
  const payload = {
    supplierId: Number(po.supplierId),
    branchId: Number(po.branchId),
    agreedCurrency: po.agreedCurrency,
    agreedRate: po.agreedRate == null ? null : String(po.agreedRate),
    settlementType: po.settlementType,
    expectedDeliveryDate: dateValue(po.expectedDeliveryDate),
    subtotal: String(po.subtotal),
    taxRatePercent: String(po.taxRatePercent),
    taxAmount: String(po.taxAmount),
    shippingCost: String(po.shippingCost),
    customsCost: String(po.customsCost),
    invoiceDiscount: String(po.invoiceDiscount),
    total: String(po.total),
    usdTotal: po.usdTotal == null ? null : String(po.usdTotal),
    usdInvoiceDiscount:
      po.usdInvoiceDiscount == null ? null : String(po.usdInvoiceDiscount),
    notes: po.notes ?? null,
    items,
  };
  const payloadCanonical = canonicalJson(payload);
  const payloadHash = sha256(payloadCanonical);
  if (latest?.payloadHash === payloadHash) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "لم تتغير بيانات أمر الشراء؛ لا تُنشأ مراجعة مطابقة بلا تغيير",
    });
  }
  const [sameHistoricalContent] = await tx
    .select({ revisionNo: purchaseOrderRevisions.revisionNo })
    .from(purchaseOrderRevisions)
    .where(
      and(
        eq(purchaseOrderRevisions.purchaseOrderId, input.purchaseOrderId),
        eq(purchaseOrderRevisions.payloadHash, payloadHash),
      ),
    )
    .limit(1);
  if (sameHistoricalContent) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `البيانات تطابق المراجعة ${sameHistoricalContent.revisionNo}؛ استعمل سجل المراجعات بدلاً من إنشاء نسخة مكررة`,
    });
  }
  const revisionNo = Number(latest?.revisionNo ?? 0) + 1;
  const inserted = await tx.insert(purchaseOrderRevisions).values({
    purchaseOrderId: input.purchaseOrderId,
    revisionNo,
    baseRevisionId: latest?.id ?? null,
    origin: input.origin ?? "NATIVE",
    supplierId: po.supplierId,
    branchId: po.branchId,
    agreedCurrency: po.agreedCurrency,
    agreedRate: po.agreedRate,
    settlementType: po.settlementType,
    expectedDeliveryDate: po.expectedDeliveryDate,
    subtotal: po.subtotal,
    taxAmount: po.taxAmount,
    shippingCost: po.shippingCost,
    customsCost: po.customsCost,
    invoiceDiscount: po.invoiceDiscount,
    total: po.total,
    usdTotal: po.usdTotal,
    notesSnapshot: po.notes,
    payloadCanonical,
    payloadHash,
    revisionReason: reason,
    createdBy: input.actorUserId,
  });
  const revisionId = extractInsertId(inserted);
  const revisionItems: Array<{ id: number; lineNo: number; baseQuantity: number }> = [];
  for (const item of items) {
    const result = await tx.insert(purchaseOrderRevisionItems).values({
      revisionId,
      ...item,
    });
    revisionItems.push({
      id: extractInsertId(result),
      lineNo: item.lineNo,
      baseQuantity: item.baseQuantity,
    });
  }
  return { revisionId, revisionNo, payloadHash, payloadCanonical, revisionItems };
}

/** سلسلة أحداث محكمة البصمة. صف الأمر يجب أن يكون مقفلاً قبل الاستدعاء. */
export async function appendPurchaseOrderEventTx(
  tx: Tx,
  input: {
    eventKey: string;
    purchaseOrderId: number;
    revisionId?: number | null;
    requestId?: number | null;
    branchId: number;
    eventType: string;
    reason?: string | null;
    actorUserId?: number | null;
    payload: unknown;
  },
) {
  const payloadCanonical = canonicalJson({
    purchaseOrderId: input.purchaseOrderId,
    revisionId: input.revisionId ?? null,
    requestId: input.requestId ?? null,
    branchId: input.branchId,
    eventType: input.eventType,
    reason: input.reason ?? null,
    actorUserId: input.actorUserId ?? null,
    payload: input.payload,
  });
  const [existing] = await tx
    .select()
    .from(purchaseOrderEvents)
    .where(eq(purchaseOrderEvents.eventKey, input.eventKey))
    .limit(1);
  if (existing) {
    if (existing.payloadCanonical !== payloadCanonical) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "مفتاح حدث أمر الشراء مستعمل بحمولة مختلفة",
      });
    }
    return { eventId: Number(existing.id), eventHash: existing.eventHash, idempotent: true as const };
  }
  const [previous] = await tx
    .select({ eventHash: purchaseOrderEvents.eventHash })
    .from(purchaseOrderEvents)
    .where(eq(purchaseOrderEvents.purchaseOrderId, input.purchaseOrderId))
    .orderBy(desc(purchaseOrderEvents.id))
    .limit(1);
  const previousEventHash = previous?.eventHash ?? null;
  const eventHash = sha256(`${previousEventHash ?? "GENESIS"}\n${payloadCanonical}`);
  const result = await tx.insert(purchaseOrderEvents).values({
    eventKey: input.eventKey,
    purchaseOrderId: input.purchaseOrderId,
    revisionId: input.revisionId ?? null,
    requestId: input.requestId ?? null,
    branchId: input.branchId,
    eventType: input.eventType,
    reason: input.reason ?? null,
    actorUserId: input.actorUserId ?? null,
    payloadCanonical,
    previousEventHash,
    eventHash,
  });
  return { eventId: extractInsertId(result), eventHash, idempotent: false as const };
}

async function assertReadablePurchaseOrder(purchaseOrderId: number, actor: Actor) {
  const db = requireDb();
  const [po] = await db
    .select({ id: purchaseOrders.id, branchId: purchaseOrders.branchId })
    .from(purchaseOrders)
    .where(eq(purchaseOrders.id, purchaseOrderId))
    .limit(1);
  if (!po) throw new TRPCError({ code: "NOT_FOUND", message: "أمر الشراء غير موجود" });
  assertPurchaseBranch(po, actor);
  return po;
}

export async function listPurchaseOrderRevisions(purchaseOrderId: number, actor: Actor) {
  await assertReadablePurchaseOrder(purchaseOrderId, actor);
  return requireDb()
    .select()
    .from(purchaseOrderRevisions)
    .where(eq(purchaseOrderRevisions.purchaseOrderId, purchaseOrderId))
    .orderBy(desc(purchaseOrderRevisions.revisionNo));
}

export async function getPurchaseOrderRevision(
  input: { purchaseOrderId: number; revisionId: number },
  actor: Actor,
) {
  await assertReadablePurchaseOrder(input.purchaseOrderId, actor);
  const db = requireDb();
  const [revision] = await db
    .select()
    .from(purchaseOrderRevisions)
    .where(
      and(
        eq(purchaseOrderRevisions.id, input.revisionId),
        eq(purchaseOrderRevisions.purchaseOrderId, input.purchaseOrderId),
      ),
    )
    .limit(1);
  if (!revision) {
    throw new TRPCError({ code: "NOT_FOUND", message: "مراجعة أمر الشراء غير موجودة" });
  }
  const items = await db
    .select()
    .from(purchaseOrderRevisionItems)
    .where(eq(purchaseOrderRevisionItems.revisionId, input.revisionId))
    .orderBy(purchaseOrderRevisionItems.lineNo);
  return { ...revision, items };
}

export type PurchaseRevisionComparable = Awaited<ReturnType<typeof getPurchaseOrderRevision>>;

/** فرقٌ منظم للواجهة: حقول الرأس والأسطر المضافة/المحذوفة/المعدلة. */
export function diffPurchaseOrderRevisions(
  from: PurchaseRevisionComparable,
  to: PurchaseRevisionComparable,
) {
  const headFields = [
    "supplierId",
    "agreedCurrency",
    "agreedRate",
    "settlementType",
    "expectedDeliveryDate",
    "subtotal",
    "taxAmount",
    "shippingCost",
    "customsCost",
    "invoiceDiscount",
    "total",
    "usdTotal",
    "notesSnapshot",
  ] as const;
  const head = headFields.flatMap((field) =>
    String(from[field] ?? "") === String(to[field] ?? "")
      ? []
      : [{ field, before: from[field] ?? null, after: to[field] ?? null }],
  );
  const fromItems = new Map(from.items.map((item) => [Number(item.lineNo), item]));
  const toItems = new Map(to.items.map((item) => [Number(item.lineNo), item]));
  const lineNos = Array.from(
    new Set([...Array.from(fromItems.keys()), ...Array.from(toItems.keys())]),
  ).sort((a, b) => a - b);
  const items = lineNos.flatMap((lineNo) => {
    const before = fromItems.get(lineNo) ?? null;
    const after = toItems.get(lineNo) ?? null;
    if (canonicalJson(before) === canonicalJson(after)) return [];
    return [{ lineNo, before, after }];
  });
  return { fromRevisionId: Number(from.id), toRevisionId: Number(to.id), head, items };
}

export async function getPurchaseOrderRevisionDiff(
  input: { purchaseOrderId: number; fromRevisionId: number; toRevisionId: number },
  actor: Actor,
) {
  const [from, to] = await Promise.all([
    getPurchaseOrderRevision(
      { purchaseOrderId: input.purchaseOrderId, revisionId: input.fromRevisionId },
      actor,
    ),
    getPurchaseOrderRevision(
      { purchaseOrderId: input.purchaseOrderId, revisionId: input.toRevisionId },
      actor,
    ),
  ]);
  return diffPurchaseOrderRevisions(from, to);
}
