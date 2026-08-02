import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { invoices, shifts } from "../../drizzle/schema";
import type { SaleLineInput, PaymentMethod } from "./sale/types";
import { createSaleInTx } from "./sale/create";
import type { PrintSaleLineInput } from "./printSaleService";
import { createPrintSaleInTx } from "./printSaleService";
import type { CreateWorkOrderInput } from "./workOrder/types";
import { createWorkOrderInTx } from "./workOrder/create";
import { withTx, type Actor } from "./tx";
import { findIdempotentRefId } from "./idempotency";
import { money, round2 } from "./money";

export interface ReceptionCheckoutInput {
  branchId: number;
  shiftId: number;
  customerId?: number | null;
  paymentMethod: Extract<PaymentMethod, "CASH" | "CARD" | "TRANSFER">;
  paymentReference?: string | null;
  /** المبلغ المطبّق على الطلب كله. البيع المباشر يُغطّى أولاً، ثم أوامر الشغل بالترتيب. */
  paidAmount?: string | null;
  clientRequestId: string;
  regularSale?: { lines: SaleLineInput[]; amount: string } | null;
  printSale?: { lines: PrintSaleLineInput[]; amount: string } | null;
  workOrders?: Array<Omit<CreateWorkOrderInput, "branchId" | "customerId" | "clientRequestId">>;
  priceOverrideApproved?: boolean;
}

async function isCompleteReplay(tx: Parameters<Parameters<typeof withTx>[0]>[0], input: ReceptionCheckoutInput) {
  if (input.regularSale) {
    const row = await tx.select({ id: invoices.id }).from(invoices)
      .where(eq(invoices.sourceId, `${input.clientRequestId}-sale`)).limit(1);
    if (!row[0]) return false;
  }
  if (input.printSale) {
    const row = await tx.select({ id: invoices.id }).from(invoices)
      .where(eq(invoices.sourceId, `${input.clientRequestId}-print`)).limit(1);
    if (!row[0]) return false;
  }
  for (let index = 0; index < (input.workOrders?.length ?? 0); index += 1) {
    const id = await findIdempotentRefId(tx, "workOrder.create", `${input.clientRequestId}-wo-${index}`);
    if (!id) return false;
  }
  return true;
}

/**
 * The reception commit boundary. A mixed basket is one business operation:
 * inventory sale, print-service sale, work orders, deposits, receipts and ledger
 * entries either all commit or all roll back.
 */
export async function checkoutReception(input: ReceptionCheckoutInput, actor: Actor) {
  return withTx(async (tx) => {
    // إعادة ردّ عملية سبق التزامها لا تحتاج وردية ما زالت مفتوحة. هذا مهم إذا وصل الالتزام
    // إلى القاعدة ثم انقطع الرد وأُغلقت الوردية قبل إعادة المحاولة. أي عملية جديدة/ناقصة تمرّ
    // بالحارس الصارم أدناه؛ والحالة الناقصة لا يمكن أن تنتج عن هذه الخدمة لأن الالتزام ذرّي.
    const completeReplay = await isCompleteReplay(tx, input);
    if (!completeReplay) {
      const shift = await tx.select().from(shifts).where(eq(shifts.id, input.shiftId)).for("update").limit(1);
      const current = shift[0];
      if (!current || current.status !== "OPEN" || Number(current.branchId) !== input.branchId) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "وردية الاستقبال مغلقة أو لا تخص هذا الفرع",
        });
      }
      if (current.shiftType !== "RECEPTION") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "يجب استخدام وردية استقبال لتنفيذ هذه العملية" });
      }
      if (actor.role !== "admin" && actor.role !== "manager" && Number(current.userId) !== Number(actor.userId)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا تستطيع التسجيل على وردية مستخدم آخر" });
      }
    }

    let normalizedWorkOrders = input.workOrders ?? [];
    if (input.paidAmount != null) {
      const directTotal = round2(
        money(input.regularSale?.amount ?? "0").plus(money(input.printSale?.amount ?? "0")),
      );
      const workTotal = round2(normalizedWorkOrders.reduce(
        (sum, order) => sum.plus(money(order.salePrice)),
        money("0"),
      ));
      const grandTotal = round2(directTotal.plus(workTotal));
      const applied = round2(money(input.paidAmount));
      if (applied.lt(directTotal)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `المبلغ المقبوض يجب أن يغطي البيع المباشر أولاً (${directTotal.toFixed(2)})`,
        });
      }
      if (applied.gt(grandTotal)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "المبلغ المطبق يتجاوز إجمالي الطلب" });
      }

      let remainingForWork = applied.minus(directTotal);
      normalizedWorkOrders = normalizedWorkOrders.map((order) => {
        const orderTotal = round2(money(order.salePrice));
        const deposit = remainingForWork.lte(0)
          ? money("0")
          : round2(remainingForWork.gte(orderTotal) ? orderTotal : remainingForWork);
        remainingForWork = round2(remainingForWork.minus(deposit));
        return {
          ...order,
          deposit: deposit.toFixed(2),
          paymentMethod: deposit.gt(0) ? input.paymentMethod : null,
          paymentReference: deposit.gt(0) && input.paymentMethod !== "CASH"
            ? input.paymentReference?.trim() || null
            : null,
        };
      });
    }

    const regularSale = input.regularSale
      ? await createSaleInTx(tx, {
          branchId: input.branchId,
          shiftId: input.shiftId,
          customerId: input.customerId ?? null,
          sourceType: "POS",
          lines: input.regularSale.lines,
          payment: {
            amount: input.regularSale.amount,
            method: input.paymentMethod,
            reference: input.paymentReference?.trim() || null,
          },
          clientRequestId: `${input.clientRequestId}-sale`,
          creditApproved: false,
          priceOverrideApproved: input.priceOverrideApproved === true,
        }, actor)
      : null;

    const printSale = input.printSale
      ? await createPrintSaleInTx(tx, {
          branchId: input.branchId,
          shiftId: input.shiftId,
          customerId: input.customerId ?? null,
          lines: input.printSale.lines,
          payment: {
            amount: input.printSale.amount,
            method: input.paymentMethod,
            reference: input.paymentReference?.trim() || null,
          },
          clientRequestId: `${input.clientRequestId}-print`,
          creditApproved: false,
          priceOverrideApproved: input.priceOverrideApproved === true,
        }, actor)
      : null;

    const workOrders = [] as Array<Awaited<ReturnType<typeof createWorkOrderInTx>>>;
    for (let index = 0; index < normalizedWorkOrders.length; index += 1) {
      const order = normalizedWorkOrders[index];
      workOrders.push(await createWorkOrderInTx(tx, {
        ...order,
        branchId: input.branchId,
        customerId: input.customerId ?? null,
        clientRequestId: `${input.clientRequestId}-wo-${index}`,
      }, actor));
    }

    return { regularSale, printSale, workOrders };
  });
}
