import { TRPCError } from "@trpc/server";
import { asc, eq } from "drizzle-orm";
import { invoiceItems, invoices } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { idempotencyHash } from "../idempotency";

export interface InvoiceControlHeader {
  invoiceId: number;
  branchId: number;
  status: string;
  total: string;
  paidAmount: string;
  returnedTotal: string;
  dueDate: string | null;
  customerId: number | null;
  sourceType: string;
  createdBy: number | null;
  correctedByInvoiceId: number | null;
  updatedAt: string;
}

export interface InvoiceControlSnapshot {
  header: InvoiceControlHeader;
  items: Array<{
    id: number;
    variantId: number;
    productUnitId: number | null;
    baseQuantity: number;
    returnedBaseQuantity: number;
    returnedRestockedBaseQuantity: number;
    unitPrice: string;
    discountAmount: string;
    total: string;
  }>;
}

function dateOnly(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

export function invoiceControlHeaderFromRow(row: typeof invoices.$inferSelect): InvoiceControlHeader {
  return {
    invoiceId: Number(row.id),
    branchId: Number(row.branchId),
    status: row.status,
    total: String(row.total),
    paidAmount: String(row.paidAmount ?? "0"),
    returnedTotal: String(row.returnedTotal ?? "0"),
    dueDate: dateOnly(row.dueDate),
    customerId: row.customerId == null ? null : Number(row.customerId),
    sourceType: row.sourceType,
    createdBy: row.createdBy == null ? null : Number(row.createdBy),
    correctedByInvoiceId:
      row.correctedByInvoiceId == null ? null : Number(row.correctedByInvoiceId),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function loadInvoiceControlSnapshotTx(
  tx: Tx,
  invoiceId: number,
): Promise<{ invoice: typeof invoices.$inferSelect; snapshot: InvoiceControlSnapshot; hash: string }> {
  const invoice = (
    await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1)
  )[0];
  if (!invoice) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة غير موجودة" });
  const items = await tx
    .select({
      id: invoiceItems.id,
      variantId: invoiceItems.variantId,
      productUnitId: invoiceItems.productUnitId,
      baseQuantity: invoiceItems.baseQuantity,
      returnedBaseQuantity: invoiceItems.returnedBaseQuantity,
      returnedRestockedBaseQuantity: invoiceItems.returnedRestockedBaseQuantity,
      unitPrice: invoiceItems.unitPrice,
      discountAmount: invoiceItems.discountAmount,
      total: invoiceItems.total,
    })
    .from(invoiceItems)
    .where(eq(invoiceItems.invoiceId, invoiceId))
    .orderBy(asc(invoiceItems.id));
  const snapshot: InvoiceControlSnapshot = {
    header: invoiceControlHeaderFromRow(invoice),
    items: items.map((item) => ({
      id: Number(item.id),
      variantId: Number(item.variantId),
      productUnitId: item.productUnitId == null ? null : Number(item.productUnitId),
      baseQuantity: Number(item.baseQuantity),
      returnedBaseQuantity: Number(item.returnedBaseQuantity ?? 0),
      returnedRestockedBaseQuantity: Number(item.returnedRestockedBaseQuantity ?? 0),
      unitPrice: String(item.unitPrice),
      discountAmount: String(item.discountAmount ?? "0"),
      total: String(item.total),
    })),
  };
  return { invoice, snapshot, hash: idempotencyHash(snapshot) };
}

/** يُستدعى بعد قفل الفاتورة في خدمة الأثر، فيغلق سباق التغيير بين فحص الطلب والتنفيذ. */
export function assertInvoiceControlHeader(
  lockedInvoice: typeof invoices.$inferSelect,
  expected: InvoiceControlHeader | null | undefined,
): void {
  if (!expected) return;
  if (
    idempotencyHash(invoiceControlHeaderFromRow(lockedInvoice)) !== idempotencyHash(expected)
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "تغيّرت الفاتورة منذ طلب الإجراء — حدّثها وافتح طلباً جديداً",
    });
  }
}

/** يثبت اللقطة الكاملة بعد قفل رأس الفاتورة، ويقفل البنود قبل مطابقتها. */
export async function assertLockedInvoiceControlSnapshotTx(
  tx: Tx,
  lockedInvoice: typeof invoices.$inferSelect,
  expected: InvoiceControlSnapshot | null | undefined,
): Promise<void> {
  if (!expected) return;
  assertInvoiceControlHeader(lockedInvoice, expected.header);
  const items = await tx
    .select({
      id: invoiceItems.id,
      variantId: invoiceItems.variantId,
      productUnitId: invoiceItems.productUnitId,
      baseQuantity: invoiceItems.baseQuantity,
      returnedBaseQuantity: invoiceItems.returnedBaseQuantity,
      returnedRestockedBaseQuantity: invoiceItems.returnedRestockedBaseQuantity,
      unitPrice: invoiceItems.unitPrice,
      discountAmount: invoiceItems.discountAmount,
      total: invoiceItems.total,
    })
    .from(invoiceItems)
    .where(eq(invoiceItems.invoiceId, Number(lockedInvoice.id)))
    .orderBy(asc(invoiceItems.id))
    .for("update");
  const current: InvoiceControlSnapshot = {
    header: invoiceControlHeaderFromRow(lockedInvoice),
    items: items.map((item) => ({
      id: Number(item.id),
      variantId: Number(item.variantId),
      productUnitId: item.productUnitId == null ? null : Number(item.productUnitId),
      baseQuantity: Number(item.baseQuantity),
      returnedBaseQuantity: Number(item.returnedBaseQuantity ?? 0),
      returnedRestockedBaseQuantity: Number(item.returnedRestockedBaseQuantity ?? 0),
      unitPrice: String(item.unitPrice),
      discountAmount: String(item.discountAmount ?? "0"),
      total: String(item.total),
    })),
  };
  if (idempotencyHash(current) !== idempotencyHash(expected)) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "تغيّرت بنود الفاتورة منذ طلب الإجراء — حدّثها وافتح طلباً جديداً",
    });
  }
}
