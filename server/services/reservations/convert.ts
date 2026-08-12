// Reservation-to-sale conversion is a single transaction: invoice, stock reservation release,
// and reservation lifecycle transition commit or roll back together.
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { productUnits, reservationEvents, reservationLines, reservations, shifts } from "../../../drizzle/schema";
import { createSaleInTx, notifySaleCustomerAfterCommit } from "../sale/create";
import { logger } from "../../logger";
import type { PaymentMethod } from "../sale/types";
import { openShiftIdTx } from "../shiftService";
import { withTx, type Actor } from "../tx";
import { assertReservationBranch, loadReservation } from "./helpers";
import { adjustReservedStock } from "./stock";

export interface ConvertReservationInput {
  reservationId: number;
  /** وردية مساحة العمل النشطة إن عُرفَت في الواجهة (الاستقبال يمرّر RECEPTION صراحةً). */
  shiftId?: number | null;
  payment?: { amount: string; method: PaymentMethod; reference?: string | null } | null;
}

export interface ConvertReservationResult {
  reservationId: number;
  invoiceId: number;
  invoiceNumber: string;
  shiftId: number | null;
  total: string;
  status: "PENDING" | "PARTIALLY_PAID" | "PAID";
  idempotentReplay?: boolean;
}

export async function convertReservationToSale(input: ConvertReservationInput, actor: Actor): Promise<ConvertReservationResult> {
  if (input.payment && input.payment.method !== "CASH" && !input.payment.reference?.trim()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "مرجع الدفع غير النقدي مطلوب" });
  }

  const result = await withTx(async (tx) => {
    // All closing paths (cancel, release, expiry) lock this row too, so they cannot
    // leave a successfully created invoice detached from a now-closed reservation.
    const res = await loadReservation(tx, input.reservationId);
    assertReservationBranch(res, actor);
    if (res.status !== "ACTIVE" && res.status !== "PARTIALLY_FULFILLED") {
      throw new TRPCError({ code: "BAD_REQUEST", message: `لا يمكن تحويل حجز حالته ${res.status}` });
    }
    if (new Date(res.expiresAt).getTime() <= Date.now()) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "انتهت مدّة الحجز — لا يمكن تحويله" });
    }

    const lines = await tx.select().from(reservationLines).where(eq(reservationLines.reservationId, input.reservationId));
    const remaining = lines.filter((line) => line.baseQuantity - line.fulfilledBase > 0);
    if (!remaining.length) throw new TRPCError({ code: "BAD_REQUEST", message: "لا كميات متبقّية للتحويل" });

    // مساحة الاستقبال قد تتعايش مع وردية RETAIL للفاعل نفسه؛ لذلك تمرّر الواجهة معرّف مساحة العمل
    // الفعلي. نتحقق منه تحت القفل (المستخدم/الفرع/OPEN) ولا نثق بالمدخل حتى للمدير. عند غيابه فقط
    // نستعمل قاعدة RETAIL الافتراضية للتدفق المستقل.
    let shiftId: number | null;
    if (input.shiftId === null) {
      // null صريح من مساحة عمل مضمّنة يعني «لا وردية في هذه المساحة»؛ لا نستبدله سراً
      // بورديّة RETAIL أخرى للموظف نفسه.
      shiftId = null;
    } else if (input.shiftId !== undefined) {
      const requestedShift = (await tx
        .select({ id: shifts.id, userId: shifts.userId, branchId: shifts.branchId, status: shifts.status })
        .from(shifts)
        .where(eq(shifts.id, input.shiftId))
        .for("update")
        .limit(1))[0];
      if (
        !requestedShift ||
        requestedShift.status !== "OPEN" ||
        Number(requestedShift.userId) !== Number(actor.userId) ||
        Number(requestedShift.branchId) !== Number(res.branchId)
      ) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "وردية مساحة العمل أُغلقت أو لا تخص الموظف والفرع الحاليين — أعد فتح المساحة",
        });
      }
      shiftId = Number(requestedShift.id);
    } else {
      shiftId = await openShiftIdTx(tx, actor.userId, Number(res.branchId));
    }
    if (input.payment?.method === "CASH" && Number(input.payment.amount) > 0) {
      if (shiftId == null) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "افتح وردية أولاً لتحصيل دفعة نقدية عند التحويل" });
      }
    }

    const saleLines: Array<{ variantId: number; productUnitId: number; baseQty: number; lineId: number; toFulfilled: number }> = [];
    for (const line of remaining) {
      const baseUnit = (await tx
        .select({ id: productUnits.id })
        .from(productUnits)
        .where(and(eq(productUnits.variantId, Number(line.variantId)), eq(productUnits.isBaseUnit, true)))
        .limit(1))[0];
      if (!baseUnit) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `لا وحدة أساس للمتغيّر ${line.variantId}` });
      }
      saleLines.push({
        variantId: Number(line.variantId),
        productUnitId: Number(baseUnit.id),
        baseQty: line.baseQuantity - line.fulfilledBase,
        lineId: Number(line.id),
        toFulfilled: line.baseQuantity,
      });
    }

    const sale = await createSaleInTx(tx, {
      branchId: Number(res.branchId),
      shiftId,
      customerId: res.customerId ? Number(res.customerId) : null,
      sourceType: "ORDER",
      clientRequestId: `RES-${res.id}`,
      lines: saleLines.map((line) => ({
        variantId: line.variantId,
        productUnitId: line.productUnitId,
        quantity: String(line.baseQty),
      })),
      payment: input.payment ?? null,
      notes: `محوّل من الحجز ${res.reservationNumber}`,
      // الحجز وعدٌ لعميل محدد: لا يرث سماح السالب المؤقت لـORDER في وضع الافتتاح. يفحص
      // applyMovement الرصيد تحت قفله وفي ترتيب نواة البيع، فيغلق سباق refetch→commit أيضاً.
      strictStock: true,
    }, actor);

    for (const line of saleLines) {
      await tx.update(reservationLines).set({ fulfilledBase: line.toFulfilled }).where(eq(reservationLines.id, line.lineId));
      await adjustReservedStock(tx, line.variantId, Number(res.branchId), -line.baseQty);
    }
    await tx.update(reservations)
      .set({ status: "FULFILLED", fulfilledInvoiceId: sale.invoiceId })
      .where(eq(reservations.id, input.reservationId));
    await tx.insert(reservationEvents).values({
      reservationId: input.reservationId,
      eventType: "FULFILL",
      fromStatus: res.status,
      toStatus: "FULFILLED",
      note: `فاتورة ${sale.invoiceNumber}`,
      userId: actor.userId,
    });

    return {
      result: {
        reservationId: input.reservationId,
        invoiceId: sale.invoiceId,
        invoiceNumber: sale.invoiceNumber,
        shiftId: sale.shiftId ?? null,
        total: sale.total,
        status: sale.status,
        idempotentReplay: sale.idempotentReplay,
      },
      notificationInput: {
        branchId: Number(res.branchId),
        customerId: res.customerId != null ? Number(res.customerId) : null,
      },
    };
  });

  // Match normal sale behaviour without allowing a notification outage to undo a committed sale.
  try {
    await notifySaleCustomerAfterCommit({
      branchId: result.notificationInput.branchId,
      customerId: result.notificationInput.customerId,
      sourceType: "ORDER",
      lines: [],
    }, result.result);
  } catch (error) {
    logger.warn({ err: error instanceof Error ? error.message : String(error), invoiceId: result.result.invoiceId }, "reservation: customer sale notification failed");
  }
  return result.result;
}
