// إلغاء أمر شغل: يعيد المواد المُستهلَكة للمخزون ويسترد العربون المقبوض (إن وُجد).
import { TRPCError } from "@trpc/server";
import { and, desc, eq, isNull, like, notLike, or, sql } from "drizzle-orm";
import { accountingEntries, customers, invoices, orderPayments, receipts, shifts, users, workOrderMaterials, workOrders } from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import type { Tx } from "../../db";
import { applyMovement } from "../inventoryService";
import { lockInventoryVariants } from "../inventory/stockLock";
import { postEntry } from "../ledgerService";
import { createPostingIntent, creditLine, debitLine } from "../accounting/postingEngine";
import { money, round2, toDbMoney } from "../money";
import { appliedCollectionsForWorkOrder } from "../reception/deposits";
import { assertCashOutAvailable, assertNonPhysicalOutReceipt } from "../cash/cashAvailability";
import { type Actor, withTx } from "../tx";
import { assertNoLiveConsignment, assertWorkOrderBranch, loadWorkOrder } from "./helpers";
import { paymentAssetRole } from "../sale/paymentPosting";
import { checkIdempotency, idempotencyHash, recordIdempotencyKey } from "../idempotency";
import { logAuditTx } from "../auditService";
import type { TrpcContext } from "../../context";
import { isDupEntry } from "@shared/errorMap.ar";
import { recordWorkOrderEvent } from "../workOrderEvents";
import type { ApprovedWorkOrderControl } from "./update";
import { workOrderFeeHeldNet } from "./deliveryFeeRefund";
import { computeWorkOrderInvoiceNetPaidInTx } from "./reverseDelivery";

async function resolveLockedReceptionCashShift(
  tx: Tx,
  branchId: number,
  explicitShiftId: number | null,
): Promise<number> {
  const open = await tx
    .select({ id: shifts.id })
    .from(shifts)
    .where(and(eq(shifts.branchId, branchId), eq(shifts.status, "OPEN"), eq(shifts.shiftType, "RECEPTION")));
  const chosen = explicitShiftId != null
    ? open.find((row) => Number(row.id) === explicitShiftId)
    : open.length === 1
      ? open[0]
      : null;
  if (!chosen) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: open.length > 1
        ? "توجد عدة ورديات RECEPTION مفتوحة؛ حدّد درج الاسترداد النقدي صراحةً"
        : "لا توجد وردية RECEPTION مفتوحة لهذا الاسترداد النقدي",
    });
  }
  const locked = (
    await tx
      .select({ id: shifts.id, status: shifts.status, shiftType: shifts.shiftType })
      .from(shifts)
      .where(eq(shifts.id, Number(chosen.id)))
      .for("update")
      .limit(1)
  )[0];
  if (!locked || locked.status !== "OPEN" || locked.shiftType !== "RECEPTION") {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "وردية RECEPTION المستهدفة أُغلقت؛ أعد المحاولة" });
  }
  return Number(locked.id);
}

/** Cancel: restocks consumed materials if status was IN_PROGRESS/READY. */
/**
 * **قرارُ مصير الخامة عند الإلغاء** (ش٤، ١٩/٨) — سطرٌ لكلّ مادّة، تصريحيّاً.
 *
 * `returnBase + wasteBase` **يجب** أن يساوي `baseQuantity` بالضبط: لا كمّيةَ تتبخّر بين
 * الرقمين، ولا فرقَ يُمتصّ صامتاً (§٥). وحذفُ الحقل كلّياً = **رجوعٌ كامل** — أي السلوك
 * القائم حرفياً، فلا تتغيّر نتيجةُ أيّ مستدعٍ لم يُعدَّل.
 */
export interface WorkOrderCancelMaterialDecision {
  workOrderMaterialId: number;
  /** ما يعود للمخزون صالحاً (حركة IN). */
  returnBase: number;
  /** ما تلف فعلاً — يخرج من WIP إلى **خسارة** بلا أيّ حركة مخزون. */
  wasteBase: number;
}

export interface CancelWorkOrderOptions {
  refundShiftId?: number | null;
  clientRequestId?: string | null;
  expectedVersion?: number;
  reason?: string | null;
  materials?: readonly WorkOrderCancelMaterialDecision[] | null;
}

export async function cancelWorkOrderInTx(
  tx: Tx,
  workOrderId: number,
  actor: Actor & { role?: string },
  opts: CancelWorkOrderOptions = {},
  control: ApprovedWorkOrderControl = {},
) {
    const reason = opts.reason?.trim() ?? "";
    if (reason.length < 3 || reason.length > 500) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "سبب الإلغاء مطلوب (3-500 محرف)" });
    }
    if (!Number.isInteger(opts.expectedVersion) || Number(opts.expectedVersion) <= 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "نسخة أمر الشغل المتوقعة مطلوبة" });
    }
    const clientRequestId = opts.clientRequestId?.trim() || null;
    const requestFingerprint = clientRequestId
      // القرارُ جزءٌ من البصمة: إعادةُ محاولةٍ بقرارِ هدرٍ مختلف **ليست** نفس الطلب.
      ? idempotencyHash({
          workOrderId,
          refundShiftId: opts.refundShiftId ?? null,
          expectedVersion: opts.expectedVersion,
          reason,
          materials: (opts.materials ?? [])
            .map((m) => [Number(m.workOrderMaterialId), Number(m.returnBase), Number(m.wasteBase)])
            .sort((a, b) => a[0] - b[0]),
        })
      : null;
    if (clientRequestId) {
      const existingId = await checkIdempotency(
        tx,
        "workOrder.cancel",
        clientRequestId,
        requestFingerprint,
        { requireStoredHash: true },
      );
      if (existingId != null) {
        if (existingId !== workOrderId) {
          throw new TRPCError({ code: "CONFLICT", message: "معرّف إلغاء أمر الشغل مرتبط بطلب آخر" });
        }
        const pending = await tx
          .select({ id: receipts.id })
          .from(receipts)
          .where(and(
            eq(receipts.workOrderId, workOrderId),
            eq(receipts.direction, "OUT"),
            eq(receipts.status, "PENDING"),
            like(receipts.internalNote, "WORK_ORDER_CUSTOMER_REFUND:%"),
          ));
        return {
          workOrderId,
          status: "CANCELLED" as const,
          pendingRefundReceiptIds: pending.map((row) => Number(row.id)),
          replayed: true as const,
        };
      }
    }
    const pendingRefundReceiptIds: number[] = [];
    const wo = await loadWorkOrder(tx, workOrderId);
    assertWorkOrderBranch(wo, actor);
    if (Number(wo.version) !== opts.expectedVersion) {
      throw new TRPCError({ code: "CONFLICT", message: "تغيّر أمر الشغل منذ فتحه — حدّث الصفحة ثم أعد المحاولة" });
    }
    if (wo.status === "DELIVERED" || wo.status === "CANCELLED")
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن إلغاء أمر مُسلَّم أو مُلغى" });
    // ١٨/٨: الحالة وحدها لا تكفي — الأمر يبقى READY والطرد بيد المندوب. بلا هذا الحارس كان
    // الإلغاء يعيد المواد للمخزون ويردّ العربون بينما الفاتورة وقيد البيع وعهدة COD حيّة.
    await assertNoLiveConsignment(tx, workOrderId, "cancel");
    // ش٤ (١٩/٨): `workOrders.invoiceId` **يُكتَب** عند الإرسال (`delivery/dispatch.ts`) ولا
    // **يُقرأ** في أيّ حارس. فأمرٌ أُرسِلت فاتورتُه ثمّ أُلغيت إرساليّتُه (⇒ `assertNoLiveConsignment`
    // تمرّ) كان يُلغى هنا فتعود المواد ويُردّ العربون **وفاتورتُه وقيدُ بيعها قائمان**: إيرادٌ بلا
    // بضاعة وذمّةٌ على عميلٍ لطلبٍ ملغى. المخرجُ الصحيح استرجاعٌ لا إلغاء.
    if (wo.invoiceId != null) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `صدرت فاتورة لهذا الطلب (#${Number(wo.invoiceId)}) — لا يُلغى بعد الفوترة؛ استعمل الاسترجاع (مرتجع) ليُعكس البيع والذمّة معاً`,
      });
    }
    const existingMaterials = await tx
      .select({ id: workOrderMaterials.id })
      .from(workOrderMaterials)
      .where(eq(workOrderMaterials.workOrderId, workOrderId));
    const heldFeeBeforeCancel = await workOrderFeeHeldNet(tx, workOrderId);
    const appliedDepositsBeforeCancel = await appliedCollectionsForWorkOrder(tx, workOrderId);
    const riskyCancellation = wo.status !== "RECEIVED"
      || money(wo.deposit ?? "0").gt(0)
      || appliedDepositsBeforeCancel.length > 0
      || existingMaterials.length > 0
      || heldFeeBeforeCancel.gt(0);
    if (riskyCancellation && control.approvedControlRequestId == null) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "إلغاء أمرٍ له عربون أو مواد أو أجرة أو بدأ إنتاجه يتطلب طلباً واعتماد مديرٍ آخر",
      });
    }
    if (wo.status === "IN_PROGRESS" || wo.status === "READY") {
      const mats = await tx.select().from(workOrderMaterials).where(eq(workOrderMaterials.workOrderId, workOrderId));
      mats.sort((a, b) => Number(a.variantId) - Number(b.variantId));

      // ── قرارُ مصير الخامة (ش٤) ─────────────────────────────────────────────────
      // بلا قرارٍ صريح: **رجوعٌ كامل** — نفسُ ما كان يفعله هذا المسار حرفياً.
      const decisions = new Map<number, { returnBase: number; wasteBase: number }>();
      if (opts.materials && opts.materials.length > 0) {
        const known = new Map(mats.map((m) => [Number(m.id), Number(m.baseQuantity)]));
        for (const d of opts.materials) {
          const id = Number(d.workOrderMaterialId);
          const consumed = known.get(id);
          if (consumed == null) {
            throw new TRPCError({ code: "BAD_REQUEST", message: `سطر خامة غير موجود في هذا الأمر (#${id})` });
          }
          if (decisions.has(id)) {
            throw new TRPCError({ code: "BAD_REQUEST", message: `سطر الخامة #${id} مكرّر في القرار` });
          }
          const ret = Number(d.returnBase);
          const waste = Number(d.wasteBase);
          if (!Number.isInteger(ret) || !Number.isInteger(waste) || ret < 0 || waste < 0) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "كمّيات الرجوع والهدر أعدادٌ صحيحة غير سالبة" });
          }
          // ⛔ لا فرقَ يُمتصّ صامتاً: ما استُهلك إمّا عاد وإمّا تلف — الرقمان يجمعانه بالضبط.
          if (ret + waste !== consumed) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `مجموع الرجوع والهدر (${ret + waste}) لا يساوي المستهلَك (${consumed}) في سطر الخامة #${id}`,
            });
          }
          decisions.set(id, { returnBase: ret, wasteBase: waste });
        }
        const missing = mats.filter((m) => !decisions.has(Number(m.id)));
        if (missing.length > 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `قرار الخامة ناقص: ${missing.length} سطراً بلا قرار — حدّد مصير كلّ سطر`,
          });
        }
      }

      let returnedCost = money(0);
      await lockInventoryVariants(
        tx,
        mats
          .filter((material) => (decisions.get(Number(material.id))?.returnBase ?? Number(material.baseQuantity)) > 0)
          .map((material) => Number(material.variantId)),
      );
      for (const m of mats) {
        const consumed = Number(m.baseQuantity);
        const d = decisions.get(Number(m.id)) ?? { returnBase: consumed, wasteBase: 0 };
        if (d.returnBase > 0) {
          await applyMovement(tx, {
            variantId: Number(m.variantId),
            branchId: Number(wo.branchId),
            baseQuantity: d.returnBase,
            movementType: "IN",
            referenceType: "WORK_ORDER_CANCEL",
            referenceId: workOrderId,
            createdBy: actor.userId,
          });
        }
        // التكلفةُ بلقطة `unitCost` المختومة عند البدء — لا بتكلفةِ اليوم: الرجوعُ يعيد
        // للمخزون ما خرج منه بقيمته وقتَها، وإلّا حرّك حقوقاً بفرق تقييمٍ لا سببَ له.
        returnedCost = returnedCost.plus(round2(money(m.unitCost ?? "0").times(d.returnBase)));
      }
      returnedCost = round2(returnedCost);

      const materialsCost = round2(money(wo.materialsCost ?? "0"));
      // الهدرُ **باقٍ** لا حاصلَ ضربٍ ثانٍ: `مُهدَر = إجمالي − راجع` ⇒ لا دينارَ يسقط بين
      // التقريبين مهما كثرت الأسطر (§٥). وحين لا هدر، الباقي صفرٌ حسابياً فيبقى السلوك كما كان.
      const wastedCost = round2(materialsCost.minus(returnedCost));
      if (returnedCost.gt(0)) {
        await postEntry(tx, {
          entryType: "ADJUST",
          dedupeKey: `WO-WIP-CANCEL:${workOrderId}`,
          branchId: Number(wo.branchId),
          cost: returnedCost,
          amount: returnedCost,
          notes: `عكس إنتاج تحت التشغيل لأمر الشغل الملغى ${wo.orderNumber}`,
          postingIntent: createPostingIntent("ADJUST_WIP_CANCEL", "ADJUST", [debitLine("INVENTORY", returnedCost), creditLine("WORK_IN_PROGRESS", returnedCost)], { roleDebits: { INVENTORY: returnedCost }, roleCredits: { WORK_IN_PROGRESS: returnedCost } }),
          postingSourceComponents: { roleDebits: { INVENTORY: returnedCost }, roleCredits: { WORK_IN_PROGRESS: returnedCost } },
        });
      }
      if (wastedCost.gt(0)) {
        // ⛔ **بلا حركة مخزون**: المادّة خرجت من المخزون عند البدء (`ADJUST_WIP_CONSUME`)،
        // فرصيدُها في WIP. خصمُها ثانيةً بـ`createStockExpenseTx` خصمٌ مزدوج يُنتج سالباً كاذباً.
        // القيدُ وحده هو الأثر — والثابت: CONSUME − CANCEL − WASTE = 0 لكلّ أمر.
        await postEntry(tx, {
          entryType: "ADJUST",
          dedupeKey: `WO-WIP-WASTE:${workOrderId}`,
          branchId: Number(wo.branchId),
          cost: wastedCost,
          amount: wastedCost,
          notes: `هدر خامة أمر الشغل الملغى ${wo.orderNumber}`,
          postingIntent: createPostingIntent("ADJUST_WIP_WASTE", "ADJUST", [debitLine("LOSSES", wastedCost), creditLine("WORK_IN_PROGRESS", wastedCost)], { roleDebits: { LOSSES: wastedCost }, roleCredits: { WORK_IN_PROGRESS: wastedCost } }),
          postingSourceComponents: { roleDebits: { LOSSES: wastedCost }, roleCredits: { WORK_IN_PROGRESS: wastedCost } },
        });
      }
    } else if (opts.materials && opts.materials.length > 0) {
      // أمرٌ لم يبدأ ⇒ لا خامةَ مستهلَكة أصلاً. قبولُ قرارِ هدرٍ هنا يُوهم الموظّف بأنّه سُجِّل.
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "لا خامة مستهلَكة في هذا الأمر (لم يبدأ التنفيذ) — لا محلّ لقرار الرجوع والهدر",
      });
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
              .select({
                id: receipts.id,
                amount: receipts.amount,
                paymentMethod: receipts.paymentMethod,
                direction: receipts.direction,
                status: receipts.status,
                approvalStatus: receipts.approvalStatus,
              })
              .from(receipts)
              .where(eq(receipts.id, Number(wo.depositReceiptId)))
              .for("update")
              .limit(1)
          )[0]
        : (
            await tx
              .select({
                id: receipts.id,
                amount: receipts.amount,
                paymentMethod: receipts.paymentMethod,
                direction: receipts.direction,
                status: receipts.status,
                approvalStatus: receipts.approvalStatus,
              })
              .from(receipts)
              .where(and(
                eq(receipts.workOrderId, workOrderId),
                eq(receipts.direction, "IN"),
                eq(receipts.status, "COMPLETED"),
                eq(receipts.approvalStatus, "APPROVED"),
                isNull(receipts.invoiceId),
                or(isNull(receipts.referenceNumber), notLike(receipts.referenceNumber, "DLV-FEE-%")),
              ))
              .for("update")
              .limit(1)
          )[0];
      if (depRcpt) {
        if (depRcpt.direction !== "IN" || depRcpt.status !== "COMPLETED" || depRcpt.approvalStatus !== "APPROVED") {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "لا يُرد عربون غير منفذ: يلزم إيصال IN بحالة COMPLETED واعتماد APPROVED",
          });
        }
        const refundAmt = round2(money(depRcpt.amount));
        // استثناء رصيد زين (ش٥، مراجعة عدائية ٦/٨): لا سكّة ردٍّ له — إيصال OUT بTELECOM
        // يُنقص الحساب المشتقّ بينما رصيد زين الحقيقيّ لا يتحرّك ⇒ يُردّ نقداً من الدرج.
        const collectedMethod = depRcpt.paymentMethod ?? "CASH";
        const refundMethod = collectedMethod === "TELECOM" ? "CASH" : collectedMethod;
        // الدرج مورد فرعٍ لا مستخدم — الإلغاء صلاحية مدير قد يختلف عن كاشير الاستقبال.
        // نختار RECEPTION فقط، نقفلها FOR UPDATE، ثم نتحقّق من النقد المتاح قبل الخروج.
        let shiftId: number | null;
        if (refundMethod === "CASH") {
          shiftId = await resolveLockedReceptionCashShift(tx, Number(wo.branchId), opts.refundShiftId ?? null);
          await assertCashOutAvailable(tx, {
            branchId: Number(wo.branchId), cashBucket: "DRAWER", shiftId,
            amount: refundAmt, operation: "رد عربون إلغاء أمر الشغل",
          });
        } else {
          if (wo.customerId == null) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: "رد العربون غير النقدي يحتاج عميلاً مرتبطاً بأمر الشغل كي يمرّ بسند واعتماد مالك",
            });
          }
          shiftId = null;
          assertNonPhysicalOutReceipt({
            classification: "DEFERRED_APPROVAL",
            paymentMethod: refundMethod,
            cashBucket: null,
            approvalStatus: "PENDING_APPROVAL",
            operation: "طلب رد عربون أمر شغل غير نقدي",
          });
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
          status: refundMethod === "CASH" ? "COMPLETED" : "PENDING",
          approvalStatus: refundMethod === "CASH" ? "APPROVED" : "PENDING_APPROVAL",
          referenceNumber: refundMethod === "CASH" ? `WO-CANCEL-REFUND-${workOrderId}` : null,
          description: refundMethod === "CASH"
            ? `استرداد عربون أمر شغل ملغى #${workOrderId}`
            : `طلب استرداد غير نقدي معلّق لأمر الشغل #${workOrderId} — بلا أثر حتى التنفيذ`,
          partyType: wo.customerId ? "CUSTOMER" : "OTHER",
          partyId: wo.customerId ?? null,
          internalNote: refundMethod !== "CASH"
            ? `WORK_ORDER_CUSTOMER_REFUND:DIRECT:${workOrderId}:${Number(depRcpt.id)}`
            : null,
          createdBy: actor.userId,
        });
        const refundReceiptId = extractInsertId(rRes);
        if (refundMethod !== "CASH") pendingRefundReceiptIds.push(refundReceiptId);
        if (refundMethod === "CASH") {
          const refundAssetRole = paymentAssetRole(refundMethod, "DRAWER", "OUT");
          const refundPostingSource = {
            roleDebits: { OTHER_LIABILITY: refundAmt },
            roleCredits: { [refundAssetRole]: refundAmt },
          };
          await postEntry(tx, {
            entryType: "PAYMENT_OUT",
            branchId: Number(wo.branchId),
            receiptId: refundReceiptId,
            customerId: wo.customerId ?? null,
            amount: refundAmt,
            notes: `استرداد عربون طلب خدمة ملغى #${workOrderId}${collectedMethod === "TELECOM" ? " (أصل القبض: رصيد زين — رُدّ نقداً)" : ""}`,
            postingIntent: createPostingIntent("PAYMENT_OUT_OTHER", "PAYMENT_OUT", [debitLine("OTHER_LIABILITY", refundAmt), creditLine(refundAssetRole, refundAmt)], refundPostingSource),
            postingSourceComponents: refundPostingSource,
          });
        }
      }
      // ش٤: حصص العربون المقبوضة **سلفاً** (مسوّدة ⇒ APPLICATION على هذا الأمر) — إيصال
      // depositReceiptId أعلاه يحمل الجزء الجديد N وحده، فردُّه وحدَه يترك حصص P بلا ردّ
      // (وقد يكون N صفراً أصلاً). كلّ حصّة تُردّ بطريقة قبضها + صفّ REFUND مربوط بأمّه (I17).
      const appliedParts = await appliedCollectionsForWorkOrder(tx, workOrderId);
      let appliedCashShiftId: number | null = null;
      for (const part of appliedParts) {
        if (part.receiptId == null) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "حصة عربون مطبقة بلا إيصال قبض قابل للتحقق" });
        }
        const source = (
          await tx
            .select({ direction: receipts.direction, status: receipts.status, approvalStatus: receipts.approvalStatus })
            .from(receipts)
            .where(eq(receipts.id, part.receiptId))
            .for("update")
            .limit(1)
        )[0];
        if (!source || source.direction !== "IN" || source.status !== "COMPLETED" || source.approvalStatus !== "APPROVED") {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "حصة العربون لا تستند إلى إيصال IN منفذ ومعتمد؛ أوقف الإلغاء وراجع القبض",
          });
        }
        const amountD = round2(money(part.amount));
        if (amountD.lte(0)) continue;
        const refundMethod = part.method === "TELECOM" ? "CASH" : part.method;
        let shiftId: number | null = null;
        if (refundMethod === "CASH") {
          appliedCashShiftId ??= await resolveLockedReceptionCashShift(tx, Number(wo.branchId), opts.refundShiftId ?? null);
          shiftId = appliedCashShiftId;
          await assertCashOutAvailable(tx, {
            branchId: Number(wo.branchId), cashBucket: "DRAWER", shiftId,
            amount: amountD, operation: "رد حصة عربون أمر شغل",
          });
        } else {
          const customerId = part.customerId ?? wo.customerId ?? null;
          if (customerId == null) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: "رد حصة العربون غير النقدية يحتاج عميلاً مرتبطاً كي يمرّ بسند واعتماد مالك",
            });
          }
          assertNonPhysicalOutReceipt({
            classification: "DEFERRED_APPROVAL",
            paymentMethod: refundMethod,
            cashBucket: null,
            approvalStatus: "PENDING_APPROVAL",
            operation: "طلب رد حصة عربون أمر شغل غير نقدي",
          });
        }
        const inserted = await tx.insert(receipts).values({
          branchId: Number(wo.branchId),
          shiftId,
          workOrderId,
          direction: "OUT",
          amount: toDbMoney(amountD),
          paymentMethod: refundMethod,
          cashBucket: refundMethod === "CASH" ? "DRAWER" : null,
          status: refundMethod === "CASH" ? "COMPLETED" : "PENDING",
          approvalStatus: refundMethod === "CASH" ? "APPROVED" : "PENDING_APPROVAL",
          referenceNumber: refundMethod === "CASH" ? `WO-CANCEL-REFUND-${workOrderId}` : null,
          description: refundMethod === "CASH"
            ? `ردّ حصة عربون مقبوضة سلفاً — إلغاء طلب #${workOrderId}`
            : `طلب رد غير نقدي معلّق لحصة عربون — إلغاء طلب #${workOrderId}`,
          partyType: (part.customerId ?? wo.customerId) != null ? "CUSTOMER" : "OTHER",
          partyId: part.customerId ?? wo.customerId ?? null,
          internalNote: refundMethod !== "CASH"
            ? `WORK_ORDER_CUSTOMER_REFUND:APPLIED:${workOrderId}:${part.collectionId}`
            : null,
          createdBy: actor.userId,
        });
        const refundReceiptId = extractInsertId(inserted);
        if (refundMethod !== "CASH") pendingRefundReceiptIds.push(refundReceiptId);
        if (refundMethod === "CASH") {
          const refundAssetRole = paymentAssetRole(refundMethod, "DRAWER", "OUT");
          const postingSource = {
            roleDebits: { OTHER_LIABILITY: amountD },
            roleCredits: { [refundAssetRole]: amountD },
          };
          await postEntry(tx, {
            entryType: "PAYMENT_OUT",
            branchId: Number(wo.branchId),
            receiptId: refundReceiptId,
            customerId: part.customerId ?? wo.customerId ?? null,
            amount: amountD,
            notes: `استرداد حصة عربون مقبوضة سلفاً — إلغاء طلب #${workOrderId}`,
            postingIntent: createPostingIntent("PAYMENT_OUT_OTHER", "PAYMENT_OUT", [debitLine("OTHER_LIABILITY", amountD), creditLine(refundAssetRole, amountD)], postingSource),
            postingSourceComponents: postingSource,
          });
        }
        // صفّ REFUND يحجز حصة القبض الملغاة تشغيلياً فور إلغاء الأمر، حتى إن كان إيصال
        // الصرف غير النقدي ما زال PENDING؛ الحالة المالية يحكمها receipt ولا materialize إلا بالاعتماد.
        if (part.draftId != null) {
          await tx.insert(orderPayments).values({
            draftId: part.draftId,
            branchId: Number(wo.branchId),
            customerId: part.customerId ?? wo.customerId ?? null,
            kind: "REFUND",
            amount: toDbMoney(amountD),
            method: refundMethod,
            receiptId: refundReceiptId,
            shiftId,
            parentPaymentId: part.collectionId,
            createdBy: actor.userId,
          });
        }
      }
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
          eq(receipts.approvalStatus, "APPROVED"),
        ))
    )[0];
    const feeHeldNet = round2(money(feeHeldRow?.v ?? "0"));
    if (feeHeldNet.gt(0)) {
      const feeShiftId = await resolveLockedReceptionCashShift(tx, Number(wo.branchId), opts.refundShiftId ?? null);
      await assertCashOutAvailable(tx, {
        branchId: Number(wo.branchId), cashBucket: "DRAWER", shiftId: feeShiftId,
        amount: feeHeldNet, operation: "رد أمانة أجرة توصيل أمر الشغل",
      });
      const feeOut = await tx.insert(receipts).values({
        branchId: Number(wo.branchId), shiftId: feeShiftId, workOrderId,
        direction: "OUT", amount: toDbMoney(feeHeldNet), paymentMethod: "CASH", cashBucket: "DRAWER",
        status: "COMPLETED", approvalStatus: "APPROVED", partyType: "OTHER",
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
        postingSourceComponents: {
          roleDebits: { COURIER_PAYABLE: feeHeldNet },
          roleCredits: { CASH: feeHeldNet },
        },
        postingIntent: createPostingIntent("DELIVERY_FEE_HELD_PAYOUT", "DELIVERY_FEE_HELD", [debitLine("COURIER_PAYABLE", feeHeldNet), creditLine("CASH", feeHeldNet)], {
          roleDebits: { COURIER_PAYABLE: feeHeldNet },
          roleCredits: { CASH: feeHeldNet },
        }),
      });
    }

    await tx.update(workOrders).set({
      status: "CANCELLED",
      // 0237: السببُ على المستند لا في سجلّ التدقيق وحده — الأخير بذلٌ أفضل ومُعقَّم وليس
      // سطحَ قراءةٍ للأعمال، فبلا هذه الأعمدة يذوب «لم يحضر العميل» في إلغاءٍ مجهول.
      cancelReason: reason,
      cancelledAt: new Date(),
      cancelledBy: actor.userId,
    }).where(eq(workOrders.id, workOrderId));
    await recordWorkOrderEvent(tx, {
      workOrderId,
      eventType: "CANCELLED",
      fromStatus: wo.status,
      toStatus: "CANCELLED",
      payload: { reason, controlRequestId: control.approvedControlRequestId ?? null },
      actorUserId: actor.userId,
      branchId: Number(wo.branchId),
    });
    if (clientRequestId) {
      await recordIdempotencyKey(
        tx,
        "workOrder.cancel",
        clientRequestId,
        workOrderId,
        requestFingerprint,
      );
    }
    return { workOrderId, status: "CANCELLED" as const, pendingRefundReceiptIds, replayed: false as const, version: Number(opts.expectedVersion) + 1 };
}

export async function cancelWorkOrder(
  workOrderId: number,
  actor: Actor & { role?: string },
  opts: CancelWorkOrderOptions = {},
) {
  return withTx((tx) => cancelWorkOrderInTx(tx, workOrderId, actor, opts));
}

/**
 * Materialize a non-cash work-order cancellation refund after an owner confirms the
 * external payout. The counter-account is OTHER_LIABILITY (the original deposit),
 * never AR; this is intentionally separate from generic customer vouchers.
 */
export async function approveWorkOrderCancellationRefund(
  receiptId: number,
  actor: Actor & { isOwner?: boolean },
  confirmationReference: string,
  auditContext: Pick<TrpcContext, "user" | "req">,
) {
  return withTx(async (tx) => {
    const confirmedReference = confirmationReference.trim();
    if (confirmedReference.length < 3 || confirmedReference.length > 100) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "مرجع تنفيذ الاسترداد الخارجي مطلوب (3-100 محرف)" });
    }
    const approver = (
      await tx
        .select({ isActive: users.isActive, isOwner: users.isOwner })
        .from(users)
        .where(eq(users.id, actor.userId))
        .for("share")
        .limit(1)
    )[0];
    if (!approver?.isActive || !approver.isOwner) {
      throw new TRPCError({ code: "FORBIDDEN", message: "اعتماد رد عربون أمر الشغل محصور بمالك نشط" });
    }
    const refund = (
      await tx.select().from(receipts).where(eq(receipts.id, receiptId)).for("update").limit(1)
    )[0];
    if (!refund || !refund.internalNote?.startsWith("WORK_ORDER_CUSTOMER_REFUND:")) {
      throw new TRPCError({ code: "NOT_FOUND", message: "طلب رد عربون أمر الشغل غير موجود" });
    }
    if (refund.createdBy != null && Number(refund.createdBy) === actor.userId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "لا يجوز لمن أنشأ طلب الرد اعتماده" });
    }
    if (refund.status === "COMPLETED" && refund.approvalStatus === "APPROVED") {
      if (refund.referenceNumber !== confirmedReference) {
        throw new TRPCError({ code: "CONFLICT", message: "مرجع تنفيذ الاسترداد لا يطابق الاعتماد السابق" });
      }
      const entry = (
        await tx.select({ id: accountingEntries.id }).from(accountingEntries)
          .where(and(eq(accountingEntries.receiptId, receiptId), eq(accountingEntries.entryType, "PAYMENT_OUT")))
          .limit(1)
      )[0];
      if (!entry) throw new TRPCError({ code: "CONFLICT", message: "طلب الرد معتمد بلا قيد PAYMENT_OUT" });
      return { receiptId, status: "COMPLETED" as const, approvalStatus: "APPROVED" as const, replayed: true as const };
    }
    if (
      refund.direction !== "OUT" ||
      refund.status !== "PENDING" ||
      refund.approvalStatus !== "PENDING_APPROVAL" ||
      refund.cashBucket != null ||
      refund.workOrderId == null ||
      refund.paymentMethod === "CASH" ||
      refund.paymentMethod === "TELECOM"
    ) {
      throw new TRPCError({ code: "CONFLICT", message: "طلب رد العربون ليس طلباً غير نقدي صالحاً للاعتماد" });
    }
    const workOrderId = Number(refund.workOrderId);
    const wo = (
      await tx.select().from(workOrders).where(eq(workOrders.id, workOrderId)).for("update").limit(1)
    )[0];
    if (
      !wo ||
      (wo.status !== "CANCELLED" && wo.status !== "READY") ||
      Number(wo.branchId) !== Number(refund.branchId) ||
      Number(wo.customerId ?? 0) !== Number(refund.partyId ?? 0)
    ) {
      throw new TRPCError({ code: "CONFLICT", message: "أمر الشغل أو طرف طلب الرد تغيّر؛ أوقف الاعتماد" });
    }

    const noteParts = refund.internalNote.split(":");
    const refundKind = noteParts[1];
    const noteWorkOrderId = Number(noteParts[2] ?? 0);
    /**
     * ٢٠/٨ (تصويب مراجعة Codex) — `reverseDelivery` يُنشئ ردوداً غير نقدية بنوعَي
     * `REVERSE_LIABILITY`/`REVERSE_AR`، وكان هذا الحارس يرفض كلَّ ما ليس DIRECT/APPLIED
     * بـCONFLICT ⇒ **لا تصير COMPLETED أبداً ولا تُرحَّل قيداً**: مالُ الزبون محتجَزٌ إلى
     * الأبد وفاتورتُه مرتجعةٌ سلفاً. وهما يسلكان مسار DIRECT نفسه (مصدرٌ مُشفَّرٌ بهويّته
     * ومبلغٌ مطابق) ويختلفان في **الحساب المقابل** وحده.
     */
    const REVERSE_KINDS = ["REVERSE_LIABILITY", "REVERSE_AR"] as const;
    const isReverseKind = (REVERSE_KINDS as readonly string[]).includes(String(refundKind));
    /** المصدرُ مُشفَّرٌ بهويّته في NOTE — كما في DIRECT تماماً. */
    const resolvesLikeDirect = refundKind === "DIRECT" || isReverseKind;
    if (
      noteWorkOrderId !== workOrderId ||
      (refundKind !== "DIRECT" && refundKind !== "APPLIED" && !isReverseKind)
    ) {
      throw new TRPCError({ code: "CONFLICT", message: "رابط طلب الرد بأمر الشغل غير صحيح" });
    }

    let sourceReceiptId = 0;
    if (resolvesLikeDirect) {
      const encodedSourceReceiptId = Number(noteParts[3] ?? 0);
      sourceReceiptId = encodedSourceReceiptId > 0
        ? encodedSourceReceiptId
        : Number(wo.depositReceiptId ?? 0);
      // Backward compatibility for pending rows created before the source receipt
      // was encoded in internalNote. Fail closed if the legacy lookup is ambiguous.
      if (sourceReceiptId <= 0) {
        const legacySources = await tx
          .select({ id: receipts.id })
          .from(receipts)
          .where(and(
            eq(receipts.workOrderId, workOrderId),
            eq(receipts.direction, "IN"),
            eq(receipts.status, "COMPLETED"),
            eq(receipts.approvalStatus, "APPROVED"),
            isNull(receipts.invoiceId),
            or(isNull(receipts.referenceNumber), notLike(receipts.referenceNumber, "DLV-FEE-%")),
          ))
          .for("update")
          .limit(2);
        if (legacySources.length !== 1) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "تعذّر تحديد إيصال مصدر العربون القديم بشكل وحيد؛ أوقف الاعتماد وراجع الإيصالات",
          });
        }
        sourceReceiptId = Number(legacySources[0]!.id);
      }
    } else {
      const collectionId = Number(noteParts[3] ?? 0);
      const collection = (
        await tx
          .select({
            branchId: orderPayments.branchId,
            customerId: orderPayments.customerId,
            kind: orderPayments.kind,
            receiptId: orderPayments.receiptId,
          })
          .from(orderPayments)
          .where(eq(orderPayments.id, collectionId))
          .for("update")
          .limit(1)
      )[0];
      const refundLink = (
        await tx
          .select({ amount: orderPayments.amount })
          .from(orderPayments)
          .where(and(
            eq(orderPayments.kind, "REFUND"),
            eq(orderPayments.receiptId, receiptId),
            eq(orderPayments.parentPaymentId, collectionId),
          ))
          .for("update")
          .limit(1)
      )[0];
      const application = (
        await tx
          .select({ id: orderPayments.id })
          .from(orderPayments)
          .where(and(
            eq(orderPayments.kind, "APPLICATION"),
            eq(orderPayments.parentPaymentId, collectionId),
            eq(orderPayments.appliedKind, "WORKORDER"),
            eq(orderPayments.appliedId, workOrderId),
          ))
          .for("update")
          .limit(1)
      )[0];
      if (
        !collection ||
        collection.kind !== "COLLECTION" ||
        collection.receiptId == null ||
        Number(collection.branchId) !== Number(refund.branchId) ||
        Number(collection.customerId ?? 0) !== Number(refund.partyId ?? 0) ||
        !refundLink ||
        !round2(money(refundLink.amount)).eq(round2(money(refund.amount))) ||
        !application
      ) {
        throw new TRPCError({ code: "CONFLICT", message: "حصة العربون المراد ردها غير مرتبطة بالطلب بشكل صحيح" });
      }
      sourceReceiptId = Number(collection.receiptId);
    }
    const source = (
      await tx.select({
        amount: receipts.amount,
        branchId: receipts.branchId,
        direction: receipts.direction,
        status: receipts.status,
        approvalStatus: receipts.approvalStatus,
      }).from(receipts).where(eq(receipts.id, sourceReceiptId)).for("update").limit(1)
    )[0];
    if (
      !source ||
      Number(source.branchId) !== Number(refund.branchId) ||
      source.direction !== "IN" ||
      source.status !== "COMPLETED" ||
      source.approvalStatus !== "APPROVED" ||
      (refundKind === "DIRECT" && !round2(money(source.amount)).eq(round2(money(refund.amount)))) ||
      (isReverseKind && round2(money(refund.amount)).gt(round2(money(source.amount))))
    ) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "مصدر العربون لم يعد إيصال IN منفذاً ومعتمداً" });
    }

    const amount = round2(money(refund.amount));
    const assetRole = paymentAssetRole(refund.paymentMethod, null, "OUT");
    const confirmationOperation = `workOrder.refund.confirmation.${refund.paymentMethod}`;
    const confirmationFingerprint = idempotencyHash({
      receiptId,
      workOrderId,
      paymentMethod: refund.paymentMethod,
      confirmationReference: confirmedReference,
    });
    const existingConfirmation = await checkIdempotency(
      tx,
      confirmationOperation,
      confirmedReference,
      confirmationFingerprint,
    );
    if (existingConfirmation != null) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "مرجع تنفيذ الاسترداد مستخدم لطلب رد آخر بالطريقة نفسها",
      });
    }
    try {
      // Reserve before any financial mutation. The unique (operation,key) index is
      // the race arbiter; a loser rolls back without touching receipt or journal.
      await recordIdempotencyKey(
        tx,
        confirmationOperation,
        confirmedReference,
        receiptId,
        confirmationFingerprint,
      );
    } catch (error) {
      if (isDupEntry(error)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "مرجع تنفيذ الاسترداد مستخدم لطلب رد آخر بالطريقة نفسها",
        });
      }
      throw error;
    }
    // الحسابُ المقابل يتبع نوعَ الردّ: العربونُ أمانةٌ تُبرَّأ، ودفعةُ التسليم ذمّةٌ تعود.
    // `PAYMENT_OUT_OTHER` لا يقبل `AR` مديناً، ولذلك يُختار profile بحسب النوع لا بتوسيعه.
    const refundIsAr = refundKind === "REVERSE_AR";
    const counterRole = refundIsAr ? "AR" : "OTHER_LIABILITY";
    const refundProfile = refundIsAr ? "PAYMENT_OUT_CUSTOMER_REFUND" : "PAYMENT_OUT_OTHER";
    const postingSource = {
      roleDebits: { [counterRole]: amount },
      roleCredits: { [assetRole]: amount },
    };
    await tx.update(receipts).set({
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      approvedBy: actor.userId,
      approvedAt: new Date(),
      referenceNumber: confirmedReference,
    }).where(eq(receipts.id, receiptId));
    await postEntry(tx, {
      entryType: "PAYMENT_OUT",
      branchId: Number(refund.branchId),
      invoiceId: refund.invoiceId != null ? Number(refund.invoiceId) : null,
      receiptId,
      customerId: refund.partyId != null ? Number(refund.partyId) : null,
      amount,
      paymentMethod: refund.paymentMethod,
      notes: `اعتماد رد عربون أمر شغل ملغى #${workOrderId}`,
      postingIntent: createPostingIntent(
        refundProfile,
        "PAYMENT_OUT",
        [debitLine(counterRole, amount), creditLine(assetRole, amount)],
        postingSource,
      ),
      postingSourceComponents: postingSource,
    });
    // رأس الفاتورة لا يسبق النقد: الرد غير النقدي لا يخفض paidAmount وهو PENDING،
    // ويُشتق الصافي من IN المنفذ ناقص OUT المنفذ لحظة الاعتماد فقط.
    if (refund.invoiceId != null) {
      const paidAmount = await computeWorkOrderInvoiceNetPaidInTx(
        tx,
        workOrderId,
        Number(refund.invoiceId),
        wo.deposit,
      );
      await tx.update(invoices).set({ paidAmount }).where(eq(invoices.id, Number(refund.invoiceId)));
    }
    await logAuditTx(tx, auditContext, {
      action: "workOrder.refund.approve",
      entityType: "receipt",
      entityId: receiptId,
      oldValue: {
        status: "PENDING",
        approvalStatus: "PENDING_APPROVAL",
      },
      newValue: {
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        workOrderId,
        sourceReceiptId,
        amount: toDbMoney(amount),
        paymentMethod: refund.paymentMethod,
        confirmationReference: confirmedReference,
        accountingEntryType: "PAYMENT_OUT",
      },
    });
    return { receiptId, status: "COMPLETED" as const, approvalStatus: "APPROVED" as const, replayed: false as const };
  });
}

/** Owner queue for non-cash work-order refunds awaiting external execution. */
export async function listPendingWorkOrderCancellationRefunds(
  actor: Actor & { isOwner?: boolean },
) {
  return withTx(async (tx) => {
    const approver = (
      await tx
        .select({ isActive: users.isActive, isOwner: users.isOwner })
        .from(users)
        .where(eq(users.id, actor.userId))
        .for("share")
        .limit(1)
    )[0];
    if (!approver?.isActive || !approver.isOwner) {
      throw new TRPCError({ code: "FORBIDDEN", message: "عرض طلبات رد عربون أمر الشغل محصور بمالك نشط" });
    }
    return tx
      .select({
        receiptId: receipts.id,
        workOrderId: receipts.workOrderId,
        orderNumber: workOrders.orderNumber,
        amount: receipts.amount,
        paymentMethod: receipts.paymentMethod,
        customerId: receipts.partyId,
        customerName: customers.name,
        createdBy: receipts.createdBy,
        creatorName: users.name,
        createdAt: receipts.createdAt,
        status: receipts.status,
        approvalStatus: receipts.approvalStatus,
        confirmationReference: receipts.referenceNumber,
        description: receipts.description,
      })
      .from(receipts)
      .innerJoin(workOrders, eq(workOrders.id, receipts.workOrderId))
      .leftJoin(customers, eq(customers.id, receipts.partyId))
      .leftJoin(users, eq(users.id, receipts.createdBy))
      .where(and(
        eq(receipts.direction, "OUT"),
        eq(receipts.status, "PENDING"),
        eq(receipts.approvalStatus, "PENDING_APPROVAL"),
        like(receipts.internalNote, "WORK_ORDER_CUSTOMER_REFUND:%"),
      ))
      .orderBy(desc(receipts.createdAt), desc(receipts.id));
  });
}

/** Durable, least-privilege status used by work-order details after refresh. */
export async function getWorkOrderCancellationRefundStatus(
  workOrderId: number,
  scope: { branchId: number | null; ownerId: number | null },
) {
  return withTx(async (tx) => {
    const access = [eq(workOrders.id, workOrderId)];
    if (scope.branchId != null) access.push(eq(workOrders.branchId, scope.branchId));
    if (scope.ownerId != null) {
      access.push(or(
        eq(workOrders.createdBy, scope.ownerId),
        eq(workOrders.assignedTo, scope.ownerId),
      )!);
    }
    const visible = (
      await tx
        .select({ id: workOrders.id })
        .from(workOrders)
        .where(and(...access))
        .limit(1)
    )[0];
    if (!visible) return null;

    const rows = await tx
      .select({
        amount: receipts.amount,
        status: receipts.status,
        approvalStatus: receipts.approvalStatus,
      })
      .from(receipts)
      .where(and(
        eq(receipts.workOrderId, workOrderId),
        eq(receipts.direction, "OUT"),
        like(receipts.internalNote, "WORK_ORDER_CUSTOMER_REFUND:%"),
      ));
    const relevant = rows.filter((row) =>
      (row.status === "PENDING" && row.approvalStatus === "PENDING_APPROVAL") ||
      (row.status === "COMPLETED" && row.approvalStatus === "APPROVED"));
    const amount = relevant.reduce(
      (sum, row) => sum.plus(money(row.amount)),
      money(0),
    );
    const hasPending = relevant.some((row) =>
      row.status === "PENDING" && row.approvalStatus === "PENDING_APPROVAL");
    const hasApproved = relevant.some((row) =>
      row.status === "COMPLETED" && row.approvalStatus === "APPROVED");
    return {
      workOrderId,
      status: hasPending ? "PENDING" as const : hasApproved ? "APPROVED" as const : "NONE" as const,
      amount: toDbMoney(round2(amount)),
    };
  });
}
