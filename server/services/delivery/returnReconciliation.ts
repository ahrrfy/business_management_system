/**
 * تسوية إرساليات التوصيل تلقائياً عند إرجاع الفاتورة (R1 & R2).
 *
 * عند تسجيل مرتجع مبيعات (كامل أو جزئي) لفاتورة مرتبطة بإرسالية توصيل نشطة:
 * 1. حساب المتبقي الحي غير المحصل:
 *    `liveRemaining = max(0, codAmount - collectedAmount - counterSettledAmount)`.
 * 2. تحرير تعرّض الـ COD المتبقي عبر قيد `COD_RELEASED` في `deliveryLedgerEntries`.
 * 3. تحديث `counterSettledAmount` على الإرسالية.
 * 4. في المرتجع الكامل:
 *    - للطرود قيد التوصيل (OUT_FOR_DELIVERY / PICKED_UP / ACCEPTED / ASSIGNED / FAILED):
 *      `parcelStatus = "RETURNED"`, `status = "RETURNED"`, `returnedAt = now`, `settledAt = now`.
 *      `moneyStatus = (collectedAmount > 0 ? "SETTLED" : "CANCELLED")`.
 *    - للطرود المسلّمة (DELIVERED):
 *      `parcelStatus = "DELIVERED"`, `status = "DELIVERED"`, `moneyStatus = "SETTLED"`, `settledAt = now`.
 * 5. في المرتجع الجزئي:
 *    - تحرير تعرّض الـ COD بنسبة ما أُرجع.
 *    - إذا كان الطرد مسلماً (DELIVERED) وصار المتبقي الحي صفراً، تتسوى حالة المال (`SETTLED`).
 * 6. توثيق حدث `RETURN_SETTLEMENT` في `deliveryEvents`.
 * 7. صفر حركات مخزنية هنا (إعادة المخزون تتولاها returnSaleInTx حصراً).
 */

import Decimal from "decimal.js";
import { eq } from "drizzle-orm";
import {
  deliveryConsignments,
  onlineOrders,
  workOrders,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { money, round2, toDbMoney } from "../money";
import type { Actor } from "../tx";
import { appendDeliveryEvent, appendDeliveryLedgerEntry } from "./lifecycle";

export interface ReconcileDeliveryOnReturnInput {
  invoiceId: number;
  returnedTotal: Decimal | string;
  isFullReturn: boolean;
  actor: Actor;
  clientRequestId?: string | null;
}

export interface ReconcileDeliveryOnReturnResult {
  reconciled: boolean;
  consignmentId?: number;
  amountReleased?: string;
  liveRemaining?: string;
  parcelStatus?: string;
  moneyStatus?: string;
  status?: string;
}

export async function reconcileDeliveryOnReturnTx(
  tx: Tx,
  input: ReconcileDeliveryOnReturnInput,
): Promise<ReconcileDeliveryOnReturnResult | null> {
  const cnRows = await tx
    .select()
    .from(deliveryConsignments)
    .where(eq(deliveryConsignments.invoiceId, input.invoiceId))
    .for("update");

  if (!cnRows.length) return null;

  // فحص الإرساليات الحية التي تحتاج إلى تسوية
  const activeConsignments = cnRows.filter((cn) => {
    // ملغاة كلياً: مغلقة مسبقاً
    if (
      cn.status === "CANCELLED" &&
      cn.parcelStatus === "CANCELLED" &&
      cn.moneyStatus === "CANCELLED"
    ) {
      return false;
    }
    // راجعة ومسواة/ملغاة مالياً
    if (
      cn.status === "RETURNED" &&
      cn.parcelStatus === "RETURNED" &&
      (cn.moneyStatus === "CANCELLED" || cn.moneyStatus === "SETTLED")
    ) {
      return false;
    }
    // مسلمة ومسواة مالياً
    if (
      cn.status === "DELIVERED" &&
      cn.parcelStatus === "DELIVERED" &&
      cn.moneyStatus === "SETTLED"
    ) {
      return false;
    }
    return true;
  });

  if (!activeConsignments.length) return null;

  let lastResult: ReconcileDeliveryOnReturnResult | null = null;

  for (const cn of activeConsignments) {
    const liveRemainingBefore = round2(
      Decimal.max(
        0,
        money(cn.codAmount)
          .minus(money(cn.collectedAmount ?? "0"))
          .minus(money(cn.counterSettledAmount ?? "0")),
      ),
    );

    const amountToRelease = input.isFullReturn
      ? liveRemainingBefore
      : round2(
          Decimal.min(
            liveRemainingBefore,
            Decimal.max(0, money(input.returnedTotal)),
          ),
        );

    const newCounterSettled = round2(
      money(cn.counterSettledAmount ?? "0").plus(amountToRelease),
    );
    const liveRemainingAfter = round2(
      liveRemainingBefore.minus(amountToRelease),
    );

    const keySuffix = input.clientRequestId
      ? `${input.clientRequestId}-${cn.id}`
      : `ret-${input.invoiceId}-${cn.id}-${cn.counterSettledAmount ?? "0"}-${Date.now()}`;

    if (amountToRelease.gt(0)) {
      await appendDeliveryLedgerEntry(tx, {
        eventKey: `CN:${Number(cn.id)}:COD_RELEASED:RETURN_SALE:${keySuffix}`,
        partyId: Number(cn.partyId),
        consignmentId: Number(cn.id),
        branchId: Number(cn.branchId ?? input.actor.branchId),
        entryType: "COD_RELEASED",
        amount: toDbMoney(amountToRelease),
        actorUserId: input.actor.userId,
        notes: `تحرير تعرّض إرسالية ${cn.consignmentNumber} عند مرتجع بيع الفاتورة ${input.invoiceId}`,
      });
    }

    const now = new Date();
    let targetParcelStatus = cn.parcelStatus;
    let targetStatus = cn.status;
    let targetMoneyStatus = cn.moneyStatus;
    let targetReturnedAt = cn.returnedAt;
    let targetSettledAt = cn.settledAt;

    if (input.isFullReturn) {
      if (cn.parcelStatus === "DELIVERED") {
        targetParcelStatus = "DELIVERED";
        targetStatus = "DELIVERED";
        targetMoneyStatus = "SETTLED";
        targetSettledAt = now;
      } else {
        // طرد قيد التوصيل (OUT_FOR_DELIVERY / PICKED_UP / ACCEPTED / ASSIGNED / FAILED)
        targetParcelStatus = "RETURNED";
        targetStatus = "RETURNED";
        const hasCollected = money(cn.collectedAmount ?? "0").gt(0);
        targetMoneyStatus = hasCollected ? "SETTLED" : "CANCELLED";
        targetReturnedAt = now;
        targetSettledAt = now;

        if (cn.workOrderId != null) {
          await tx
            .update(workOrders)
            .set({ status: "CANCELLED" })
            .where(eq(workOrders.id, Number(cn.workOrderId)));
        }
        if (cn.sourceType === "ONLINE_ORDER") {
          await tx
            .update(onlineOrders)
            .set({ status: "CANCELLED" })
            .where(eq(onlineOrders.id, Number(cn.sourceId)));
        }
      }
    } else {
      // مرتجع جزئي
      if (cn.parcelStatus === "DELIVERED" && liveRemainingAfter.lte(0)) {
        targetStatus = "DELIVERED";
        targetMoneyStatus = "SETTLED";
        targetSettledAt = now;
      }
    }

    await tx
      .update(deliveryConsignments)
      .set({
        counterSettledAmount: toDbMoney(newCounterSettled),
        parcelStatus: targetParcelStatus,
        status: targetStatus,
        moneyStatus: targetMoneyStatus,
        returnedAt: targetReturnedAt,
        settledAt: targetSettledAt,
      })
      .where(eq(deliveryConsignments.id, Number(cn.id)));

    await appendDeliveryEvent(tx, {
      eventKey: `CN:${Number(cn.id)}:RETURN_SETTLEMENT:${keySuffix}`,
      consignmentId: Number(cn.id),
      eventType: "RETURN_SETTLEMENT",
      fromParcelStatus: cn.parcelStatus,
      toParcelStatus: targetParcelStatus,
      fromMoneyStatus: cn.moneyStatus,
      toMoneyStatus: targetMoneyStatus,
      actorUserId: input.actor.userId,
      payload: {
        invoiceId: input.invoiceId,
        amountReleased: toDbMoney(amountToRelease),
        liveRemaining: toDbMoney(liveRemainingAfter),
        isFullReturn: input.isFullReturn,
        returnedTotal: toDbMoney(input.returnedTotal),
      },
    });

    lastResult = {
      reconciled: true,
      consignmentId: Number(cn.id),
      amountReleased: toDbMoney(amountToRelease),
      liveRemaining: toDbMoney(liveRemainingAfter),
      parcelStatus: targetParcelStatus,
      moneyStatus: targetMoneyStatus,
      status: targetStatus,
    };
  }

  return lastResult;
}
