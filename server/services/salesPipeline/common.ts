import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { invoices, quotations } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { money, toDbMoney } from "../money";
import { payloadHashMatches } from "../idempotency";

export function normalizePipelineKey(
  value: string,
  label = "مفتاح الطلب",
): string {
  const key = value.trim();
  if (key.length < 8 || key.length > 120) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${label} مطلوب (8–120 محرفاً)`,
    });
  }
  return key;
}

export function normalizePipelineReason(
  value: string,
  label = "سبب العملية",
): string {
  const reason = value.trim();
  if (reason.length < 3 || reason.length > 500) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${label} مطلوب (3–500 محرف)`,
    });
  }
  return reason;
}

export function normalizeRequiredText(
  value: string,
  label: string,
  max = 255,
): string {
  const text = value.trim();
  if (!text || text.length > max) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${label} مطلوب وبحد أقصى ${max} محرفاً`,
    });
  }
  return text;
}

export function normalizeOptionalText(
  value: string | null | undefined,
): string | null {
  return value?.trim() || null;
}

export function normalizeExpectedValue(value: string): string {
  const amount = money(value);
  if (amount.isNegative()) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "قيمة الفرصة المتوقعة لا تكون سالبة",
    });
  }
  return toDbMoney(amount);
}

export function normalizeProbability(value: string): string {
  const probability = money(value);
  if (
    probability.isNegative() ||
    probability.gt(100) ||
    probability.decimalPlaces() > 2
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "احتمال الفوز يجب أن يكون بين 0 و100 حتى منزلتين",
    });
  }
  return probability.toFixed(2);
}

export function normalizeExpectedCloseDate(value: string): string {
  const date = value.trim();
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    Number.isNaN(Date.parse(`${date}T00:00:00.000Z`))
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "تاريخ الإغلاق المتوقع غير صالح",
    });
  }
  return date;
}

export async function assertQuotationTx(
  tx: Tx,
  quotationId: number | null | undefined,
  branchId: number,
  customerId: number | null,
): Promise<void> {
  if (quotationId == null) return;
  const [quotation] = await tx
    .select({
      id: quotations.id,
      branchId: quotations.branchId,
      customerId: quotations.customerId,
      status: quotations.status,
    })
    .from(quotations)
    .where(eq(quotations.id, quotationId))
    .limit(1);
  if (!quotation || Number(quotation.branchId) !== branchId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "عرض السعر لا يخص الفرع المحدد",
    });
  }
  if (customerId != null && Number(quotation.customerId ?? 0) !== customerId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "عرض السعر مرتبط بعميل مختلف",
    });
  }
  if (quotation.status === "REJECTED" || quotation.status === "EXPIRED") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "لا يُربط عرض سعر مرفوض أو منتهي بفرصة نشطة",
    });
  }
}

export async function assertWinningInvoiceTx(
  tx: Tx,
  input: {
    invoiceId: number;
    branchId: number;
    customerId: number | null;
    quotationId: number | null;
  },
): Promise<void> {
  const [invoice] = await tx
    .select({
      id: invoices.id,
      branchId: invoices.branchId,
      customerId: invoices.customerId,
      status: invoices.status,
    })
    .from(invoices)
    .where(eq(invoices.id, input.invoiceId))
    .limit(1);
  if (!invoice || Number(invoice.branchId) !== input.branchId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "فاتورة الفوز لا تخص الفرع المحدد",
    });
  }
  if (
    invoice.status === "CANCELLED" ||
    invoice.status === "RETURNED" ||
    invoice.status === "SUPERSEDED"
  ) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "لا تُغلق الفرصة رابحةً بفاتورة ملغاة أو مرتجعة أو مستبدلة",
    });
  }
  if (input.customerId != null && Number(invoice.customerId ?? 0) !== input.customerId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "فاتورة الفوز مرتبطة بعميل مختلف",
    });
  }
  if (input.quotationId != null) {
    const [quotation] = await tx
      .select({ convertedInvoiceId: quotations.convertedInvoiceId })
      .from(quotations)
      .where(
        and(
          eq(quotations.id, input.quotationId),
          eq(quotations.branchId, input.branchId),
        ),
      )
      .limit(1);
    if (!quotation)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "عرض السعر المرتبط غير موجود",
      });
    if (
      quotation.convertedInvoiceId != null &&
      Number(quotation.convertedInvoiceId) !== input.invoiceId
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "عرض السعر تحوّل إلى فاتورة أخرى",
      });
    }
  }
}

export function assertExactReplay(
  row: { payloadHash: string; actorUserId: number | string },
  payloadHash: string,
  actorUserId: number,
): void {
  if (
    !payloadHashMatches(payloadHash, row.payloadHash) ||
    Number(row.actorUserId) !== actorUserId
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "مفتاح الطلب مستخدم لعملية أو حمولة مختلفة",
    });
  }
}
