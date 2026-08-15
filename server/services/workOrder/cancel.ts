// إلغاء أمر شغل: يعيد المواد المُستهلَكة للمخزون ويسترد العربون المقبوض (إن وُجد).
import { TRPCError } from "@trpc/server";
import { and, eq, isNull, notLike, or, sql } from "drizzle-orm";
import { receipts, workOrderMaterials, workOrders } from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { applyMovement } from "../inventoryService";
import { postEntry } from "../ledgerService";
import { money, round2, toDbMoney } from "../money";
import { refundAppliedCollectionsForWorkOrder } from "../reception/deposits";
import { openShiftIdTx, resolveBranchCashShiftTx } from "../shiftService";
import { assertCashOutAvailable } from "../cash/cashAvailability";
import { type Actor, withTx } from "../tx";
import { assertWorkOrderBranch, loadWorkOrder } from "./helpers";

/** Cancel: restocks consumed materials if status was IN_PROGRESS/READY. */
export async function cancelWorkOrder(
  workOrderId: number,
  actor: Actor & { role?: string },
  opts: { refundShiftId?: number | null } = {},
) {
  return withTx(async (tx) => {
    const wo = await loadWorkOrder(tx, workOrderId);
    assertWorkOrderBranch(wo, actor);
    if (wo.status === "DELIVERED" || wo.status === "CANCELLED")
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن إلغاء أمر مُسلَّم أو مُلغى" });
    if (wo.status === "IN_PROGRESS" || wo.status === "READY") {
      const mats = await tx.select().from(workOrderMaterials).where(eq(workOrderMaterials.workOrderId, workOrderId));
      mats.sort((a, b) => Number(a.variantId) - Number(b.variantId));
      for (const m of mats) {
        await applyMovement(tx, {
          variantId: Number(m.variantId),
          branchId: Number(wo.branchId),
          baseQuantity: m.baseQuantity,
          movementType: "IN",
          referenceType: "WORK_ORDER_CANCEL",
          referenceId: workOrderId,
          createdBy: actor.userId,
        });
      }
    }
    // استرداد العربون المقبوض (إن وُجد ولم يُربَط بفاتورة): نقدٌ يخرج من الدُرج الآن ⇒ receipt(OUT)+PAYMENT_OUT
    // يعكس قيد PAYMENT_IN المُسجَّل عند الإنشاء (صافي الدفتر = صفر)، ويظهر خروجاً في Z-report يوم الإلغاء.
    // نعكس فقط ما قُبِض فعلاً (إيصال موجود) — لا نختلق استرداداً لأوامر قديمة لم تُسجِّل العربون كقيد.
    const refundD = round2(money(wo.deposit ?? "0"));
    if (refundD.gt(0)) {
      // ش٠ (V3): الردّ من إيصال العربون **بهويّته** (depositReceiptId) لا بالتقاطٍ ظنّي — كان
      // `.limit(1)` قد يلتقط إيصال أجرة COUNTER (نفس البصمة) فيُردّ للزبون مبلغ الأجرة بدل
      // عربونه. البديل الاحتياطي (ما قبل 0151) يستثني إيصالات الأجرة صراحةً.
      const depRcpt = wo.depositReceiptId != null
        ? (
            await tx
              .select({ amount: receipts.amount, paymentMethod: receipts.paymentMethod })
              .from(receipts)
              .where(eq(receipts.id, Number(wo.depositReceiptId)))
              .limit(1)
          )[0]
        : (
            await tx
              .select({ amount: receipts.amount, paymentMethod: receipts.paymentMethod })
              .from(receipts)
              .where(and(
                eq(receipts.workOrderId, workOrderId),
                eq(receipts.direction, "IN"),
                isNull(receipts.invoiceId),
                or(isNull(receipts.referenceNumber), notLike(receipts.referenceNumber, "DLV-FEE-%")),
              ))
              .limit(1)
          )[0];
      if (depRcpt) {
        const refundAmt = round2(money(depRcpt.amount));
        // استثناء رصيد زين (ش٥، مراجعة عدائية ٦/٨): لا سكّة ردٍّ له — إيصال OUT بTELECOM
        // يُنقص الحساب المشتقّ بينما رصيد زين الحقيقيّ لا يتحرّك ⇒ يُردّ نقداً من الدرج.
        const collectedMethod = depRcpt.paymentMethod ?? "CASH";
        const refundMethod = collectedMethod === "TELECOM" ? "CASH" : collectedMethod;
        // الدرج مورد فرعٍ لا مستخدم — الإلغاء صلاحية مدير (workordersManagerProcedure) قد يختلف عن
        // الكاشير صاحب درج الاستقبال الذي قبض العربون فعلاً. مرآة إصلاح returnService.ts (بلاغ مالك
        // ٢/٨/٢٦): resolveBranchCashShiftTx يبحث في ورديات الفرع المفتوحة كلّها لا وردية الفاعل فقط،
        // ويتحقّق أنّ الدرج المستهدَف يحمل هذا المبلغ الآن فعلاً (نمط cashDropService — لا عجز أثناء العمل).
        let shiftId: number | null;
        if (refundMethod === "CASH") {
          const resolved = await resolveBranchCashShiftTx(tx, Number(wo.branchId), opts.refundShiftId ?? null);
          shiftId = resolved.shiftId;
          await assertCashOutAvailable(tx, {
            branchId: Number(wo.branchId), cashBucket: "DRAWER", shiftId,
            amount: refundAmt, operation: "رد عربون إلغاء أمر الشغل",
          });
        } else {
          shiftId = await openShiftIdTx(tx, actor.userId, Number(wo.branchId), "RECEPTION");
        }
        const rRes = await tx.insert(receipts).values({
          branchId: Number(wo.branchId),
          shiftId,
          workOrderId,
          direction: "OUT",
          amount: toDbMoney(refundAmt),
          paymentMethod: refundMethod,
          // cashBucket='DRAWER' للاسترداد النقدي ⇒ يَخصم من تسوية الدرج/Z-report (مرآة العربون عند القبض).
          cashBucket: refundMethod === "CASH" ? "DRAWER" : null,
          status: "COMPLETED",
          referenceNumber: `WO-CANCEL-REFUND-${workOrderId}`,
          createdBy: actor.userId,
        });
        const refundReceiptId = extractInsertId(rRes);
        await postEntry(tx, {
          entryType: "PAYMENT_OUT",
          branchId: Number(wo.branchId),
          receiptId: refundReceiptId,
          customerId: wo.customerId ?? null,
          amount: refundAmt,
          notes: `استرداد عربون طلب خدمة ملغى #${workOrderId}${collectedMethod === "TELECOM" ? " (أصل القبض: رصيد زين — رُدّ نقداً)" : ""}`,
        });
      }
      // ش٤: حصص العربون المقبوضة **سلفاً** (مسوّدة ⇒ APPLICATION على هذا الأمر) — إيصال
      // depositReceiptId أعلاه يحمل الجزء الجديد N وحده، فردُّه وحدَه يترك حصص P بلا ردّ
      // (وقد يكون N صفراً أصلاً). كلّ حصّة تُردّ بطريقة قبضها + صفّ REFUND مربوط بأمّه (I17).
      await refundAppliedCollectionsForWorkOrder(tx, {
        workOrderId,
        branchId: Number(wo.branchId),
        customerId: wo.customerId != null ? Number(wo.customerId) : null,
        actor,
        refundShiftId: opts.refundShiftId ?? null,
      });
    }

    // تدقيق ٦/٨ (ث٢) — **ردّ أمانة أجرة التوصيل** المقبوضة في الاستقبال (DLV-FEE-WO-x): الطلب
    // أُلغي فلم يقع توصيل ⇒ الأمانة مالُ الزبون. كانت تُستثنى من ردّ العربون (السطر أعلاه) ولا
    // تُعالَج في أيّ موضع آخر ⇒ نقدٌ في الدرج بلا مالكٍ ولا قيد إبراء.
    const feeHeldRow = (
      await tx
        .select({ v: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'IN' THEN ${receipts.amount} ELSE -${receipts.amount} END), 0)` })
        .from(receipts)
        .where(and(
          eq(receipts.workOrderId, workOrderId),
          eq(receipts.referenceNumber, `DLV-FEE-WO-${workOrderId}`),
          eq(receipts.status, "COMPLETED"),
        ))
    )[0];
    const feeHeldNet = round2(money(feeHeldRow?.v ?? "0"));
    if (feeHeldNet.gt(0)) {
      const resolved = await resolveBranchCashShiftTx(tx, Number(wo.branchId), opts.refundShiftId ?? null);
      await assertCashOutAvailable(tx, {
        branchId: Number(wo.branchId), cashBucket: "DRAWER", shiftId: resolved.shiftId,
        amount: feeHeldNet, operation: "رد أمانة أجرة توصيل أمر الشغل",
      });
      const feeOut = await tx.insert(receipts).values({
        branchId: Number(wo.branchId), shiftId: resolved.shiftId, workOrderId,
        direction: "OUT", amount: toDbMoney(feeHeldNet), paymentMethod: "CASH", cashBucket: "DRAWER",
        status: "COMPLETED", partyType: "OTHER",
        referenceNumber: `DLV-FEE-WO-${workOrderId}`,
        description: `ردّ أمانة أجرة توصيل — إلغاء طلب #${workOrderId}`,
        createdBy: actor.userId,
      });
      await postEntry(tx, {
        entryType: "DELIVERY_FEE_HELD",
        dedupeKey: `DELIVERY_FEE_HELD_REFUND:WO:${workOrderId}`,
        branchId: Number(wo.branchId),
        receiptId: extractInsertId(feeOut),
        amount: feeHeldNet.neg(),
        notes: `ردّ أمانة أجرة توصيل — إلغاء طلب #${workOrderId}`,
      });
    }

    await tx.update(workOrders).set({ status: "CANCELLED" }).where(eq(workOrders.id, workOrderId));
    return { workOrderId, status: "CANCELLED" };
  });
}
