/** Owner-confirmed historical withholding: correct treasury overstatement, never collect COD again. */
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { appErrorMessage } from "@shared/errors";
import {
  accountingEntries,
  auditLogs,
  deliveryConsignments,
  deliveryLedgerEntries,
  deliveryRemittanceLines,
  deliveryRemittances,
  invoices,
  receipts,
  shifts,
} from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import {
  assertCashOutAvailable,
  assertTreasuryOutException,
  lockCashSourceForUpdate,
} from "../cash/cashAvailability";
import { money, toDbMoney } from "../money";
import { withTx } from "../tx";
import { deliveryParties } from "../../../drizzle/schema";
import { ledgerFeeDue, postFeePayment } from "./fees";
import type { DeliveryTxActor } from "./types";

export interface HistoricalFeeWithholdingTarget {
  consignmentId: number;
  remittanceId: number;
  receiptInId: number;
  shiftId: number;
  fee: string;
  batchGross: string;
  actualBatchNet: string;
}

const repairKey = (t: HistoricalFeeWithholdingTarget) =>
  `HISTORICAL-NET-FEE:${t.remittanceId}:${t.consignmentId}`;
function fail(why: string): never {
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message: appErrorMessage({
      what: "تعذر تصحيح حسم أجرة تاريخية",
      why,
      doThis: "راجع التوريد الأصلي ودليل صافي النقد؛ لا تنشئ سند دفع بديل",
    }),
  });
}

/** One transaction, stable source identity, explicit owner evidence, preview by default. */
export async function repairHistoricalFeeWithholding(
  targets: HistoricalFeeWithholdingTarget[],
  actor: DeliveryTxActor,
  options: { apply?: boolean; evidence: string },
) {
  if (
    actor.role !== "admin" ||
    !options.evidence.trim() ||
    !targets.length ||
    new Set(targets.map((t) => t.remittanceId)).size !== targets.length
  ) {
    fail("يلزم مسؤول النظام ودليل صريح ودفعات أصلية غير مكررة");
  }
  return withTx(async (tx) => {
    const result = [];
    for (const target of [...targets].sort(
      (a, b) => a.remittanceId - b.remittanceId,
    )) {
      const key = repairKey(target);
      const preview = (
        await tx
          .select()
          .from(deliveryRemittances)
          .where(eq(deliveryRemittances.id, target.remittanceId))
          .limit(1)
      )[0];
      if (!preview) fail("التوريد الأصلي غير موجود");
      const branchId = Number(preview.branchId);
      // Original closed drawers and approved handovers remain immutable. The overstated asset is now treasury.
      if (options.apply)
        await lockCashSourceForUpdate(tx, {
          branchId,
          cashBucket: "TREASURY",
          shiftId: null,
        });
      await tx
        .select({ id: deliveryParties.id })
        .from(deliveryParties)
        .where(eq(deliveryParties.id, Number(preview.partyId)))
        .for("update");
      const cn = (
        await tx
          .select()
          .from(deliveryConsignments)
          .where(eq(deliveryConsignments.id, target.consignmentId))
          .for("update")
          .limit(1)
      )[0];
      if (!cn) fail("الإرسالية الأصلية غير موجودة");
      const inv = (
        await tx
          .select()
          .from(invoices)
          .where(eq(invoices.id, Number(cn.invoiceId)))
          .for("update")
          .limit(1)
      )[0];
      const rm = (
        await tx
          .select()
          .from(deliveryRemittances)
          .where(eq(deliveryRemittances.id, target.remittanceId))
          .for("update")
          .limit(1)
      )[0];
      const line = (
        await tx
          .select()
          .from(deliveryRemittanceLines)
          .where(
            and(
              eq(deliveryRemittanceLines.remittanceId, target.remittanceId),
              eq(deliveryRemittanceLines.consignmentId, target.consignmentId),
            ),
          )
          .for("update")
          .limit(1)
      )[0];
      const receipt = (
        await tx
          .select()
          .from(receipts)
          .where(eq(receipts.id, target.receiptInId))
          .for("share")
          .limit(1)
      )[0];
      const shift = (
        await tx
          .select()
          .from(shifts)
          .where(eq(shifts.id, target.shiftId))
          .for("share")
          .limit(1)
      )[0];
      const fee = money(target.fee);
      const oldGross = money(target.batchGross);
      const net = money(target.actualBatchNet);
      if (
        fee.lte(0) ||
        !oldGross.minus(fee).eq(net) ||
        !rm ||
        !line ||
        !inv ||
        !receipt ||
        !shift ||
        Number(rm.branchId) !== branchId ||
        Number(rm.partyId) !== Number(cn.partyId) ||
        Number(cn.branchId) !== branchId ||
        Number(cn.remittanceId) !== target.remittanceId ||
        cn.sourceType !== "ONLINE_ORDER" ||
        cn.feeCollection !== "SHOP" ||
        cn.parcelStatus !== "DELIVERED" ||
        cn.moneyStatus !== "SETTLED" ||
        !money(inv.paidAmount).eq(
          money(inv.total).minus(money(inv.returnedTotal ?? "0")),
        ) ||
        Number(rm.receiptInId) !== target.receiptInId ||
        Number(rm.shiftId) !== target.shiftId ||
        !money(rm.collectedTotal).eq(oldGross) ||
        rm.status !== "BALANCED" ||
        !money(rm.shortfallTotal).isZero() ||
        !money(rm.deductionsTotal).isZero() ||
        receipt.direction !== "IN" ||
        receipt.cashBucket !== "DRAWER" ||
        receipt.paymentMethod !== "CASH" ||
        receipt.status !== "COMPLETED" ||
        receipt.approvalStatus !== "APPROVED" ||
        Number(receipt.shiftId) !== target.shiftId ||
        Number(receipt.branchId) !== branchId ||
        !money(receipt.amount).eq(oldGross) ||
        shift.status !== "CLOSED" ||
        Number(shift.branchId) !== branchId
      )
        fail("تغيرت هوية الدفعة أو شروط التصحيح المثبتة");
      const existing = (
        await tx
          .select()
          .from(deliveryLedgerEntries)
          .where(
            eq(deliveryLedgerEntries.eventKey, `CN:${cn.id}:FEE_OFFSET:${key}`),
          )
          .for("share")
          .limit(1)
      )[0];
      if (existing) {
        const paid = (
          await tx
            .select()
            .from(accountingEntries)
            .where(
              eq(
                accountingEntries.dedupeKey,
                `DELIVERY_FEE_OFFSET:${cn.id}:${key}`,
              ),
            )
            .limit(1)
        )[0];
        const out =
          rm.receiptOutId == null
            ? null
            : (
                await tx
                  .select()
                  .from(receipts)
                  .where(eq(receipts.id, Number(rm.receiptOutId)))
                  .limit(1)
              )[0];
        if (
          !money(existing.amount).eq(fee) ||
          existing.entryType !== "FEE_OFFSET" ||
          Number(existing.remittanceId) !== target.remittanceId ||
          !paid ||
          !out ||
          Number(paid.receiptId) !== Number(out.id) ||
          !money(paid.amount).eq(fee) ||
          !money(paid.cost).isZero() ||
          out.referenceNumber !== key ||
          out.direction !== "OUT" ||
          out.cashBucket !== "TREASURY" ||
          out.shiftId != null ||
          !money(out.amount).eq(fee) ||
          !money(rm.feesTotal).eq(fee) ||
          !money(rm.netRemitted).eq(net) ||
          !money(line.feeOffset).eq(fee) ||
          !money(line.cashReceived).eq(money(line.grossApplied).minus(fee)) ||
          cn.feeSettledAt == null ||
          !(await ledgerFeeDue(tx, Number(cn.id))).isZero()
        )
          fail("التصحيح السابق غير متطابق؛ أوقف إعادة التنفيذ");
        result.push({
          consignmentId: Number(cn.id),
          remittanceId: Number(rm.id),
          fee: toDbMoney(fee),
          net: toDbMoney(net),
          receiptOutId: Number(out.id),
          status: "REPLAY_VERIFIED",
        });
        continue;
      }
      if (
        rm.receiptOutId != null ||
        !money(rm.feesTotal).isZero() ||
        !money(rm.netRemitted).eq(oldGross) ||
        !money(line.feeOffset).isZero() ||
        !money(line.cashReceived).eq(money(line.grossApplied)) ||
        money(line.grossApplied).lt(fee) ||
        !money(line.writtenOffAmount).isZero() ||
        !(await ledgerFeeDue(tx, Number(cn.id))).eq(fee)
      )
        fail("الأجرة أو السند سبق تسويته أو لم يعد يطابق الحالة المدققة");
      if (!options.apply) {
        result.push({
          consignmentId: Number(cn.id),
          remittanceId: Number(rm.id),
          fee: toDbMoney(fee),
          net: toDbMoney(net),
          receiptOutId: null,
          status: "PREVIEW",
        });
        continue;
      }
      assertTreasuryOutException("DELIVERY_REMITTANCE_CLEARING");
      await assertCashOutAvailable(tx, {
        branchId,
        cashBucket: "TREASURY",
        shiftId: null,
        amount: fee,
        operation: "تصحيح نقد توريد سابق زيد بأجرة محسومة",
      });
      const inserted = await tx
        .insert(receipts)
        .values({
          branchId,
          shiftId: null,
          direction: "OUT",
          cashBucket: "TREASURY",
          paymentMethod: "CASH",
          status: "COMPLETED",
          approvalStatus: "APPROVED",
          amount: toDbMoney(fee),
          partyType: "OTHER",
          referenceNumber: key,
          description: `تصحيح نقد دفتري: أجرة حسمت سابقاً من ${rm.remittanceNumber}؛ لا صرف فعلي جديد`,
          createdBy: actor.userId,
        });
      const receiptOutId = extractInsertId(inserted);
      await postFeePayment(tx, cn, fee, true, receiptOutId, key, actor, null, {
        cashBucket: "TREASURY",
        remittanceId: Number(rm.id),
      });
      await tx
        .update(deliveryRemittances)
        .set({
          feesTotal: toDbMoney(fee),
          netRemitted: toDbMoney(net),
          receiptOutId,
          notes: [rm.notes, `${key}: ${options.evidence.trim()}`]
            .filter(Boolean)
            .join(" | "),
        })
        .where(eq(deliveryRemittances.id, Number(rm.id)));
      await tx
        .update(deliveryRemittanceLines)
        .set({
          feeOffset: toDbMoney(fee),
          cashReceived: toDbMoney(money(line.grossApplied).minus(fee)),
        })
        .where(eq(deliveryRemittanceLines.id, Number(line.id)));
      await tx
        .insert(auditLogs)
        .values({
          userId: actor.userId,
          action: "delivery.historicalFeeWithholding",
          entityType: "deliveryRemittance",
          entityId: String(rm.id),
          oldValue: {
            feesTotal: rm.feesTotal,
            netRemitted: rm.netRemitted,
            receiptOutId: rm.receiptOutId,
            cashReceived: line.cashReceived,
          },
          newValue: {
            key,
            consignmentId: Number(cn.id),
            fee: toDbMoney(fee),
            net: toDbMoney(net),
            receiptOutId,
            evidence: options.evidence.trim(),
            newCustomerCollection: "0.00",
            newDeliveryExpense: "0.00",
            physicalCashDisbursement: "0.00",
          },
        });
      result.push({
        consignmentId: Number(cn.id),
        remittanceId: Number(rm.id),
        fee: toDbMoney(fee),
        net: toDbMoney(net),
        receiptOutId,
        status: "APPLIED",
      });
    }
    return result;
  });
}
