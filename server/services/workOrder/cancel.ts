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
import { appliedCollectionsForWorkOrder } from "../deposits";
import { assertCashOutAvailable, assertNonPhysicalOutReceipt, assertTreasuryOutException } from "../cash/cashAvailability";
import { type Actor, withTx } from "../tx";
import { assertNoLiveConsignment, assertWorkOrderBranch, loadWorkOrder } from "./helpers";
import { paymentAssetRole } from "../sale/paymentPosting";
import { checkIdempotency, idempotencyHash, recordIdempotencyKey } from "../idempotency";
import { logAuditTx } from "../auditService";
import type { TrpcContext } from "../../context";
import { isDupEntry } from "@shared/errorMap.ar";
import { appErrorMessage } from "@shared/errors";
import { refundRailIsImmediate, refundRailNeedsReference, refundRailReceiptShape, type RefundRail } from "@shared/refundRail";
// ⛔ التسمية العربية للحالة من قاموسها الوحيد — لا تُعاد كتابتها هنا (§٨ قواميس حاكمة).
import { workOrderStatusLabel } from "@shared/workOrderStatus";
import { recordWorkOrderEvent } from "../workOrderEvents";
import {
  hasWorkOrderDirectCancelAuthority,
  hasWorkOrderManagerAuthority,
  mayCancelWorkOrderWithoutApproval,
} from "@shared/workOrderControlAuthority";
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
      // ⭐ **قرارُ المستخدم يُقاس أوّلاً** — أمسكته مراجعةٌ عدائية: كان `open.length > 1` هو
      // الفرعَ الأعلى، فمَن سمّى وردية **غير مفتوحة** وهناك ورديتان مفتوحتان يُقال له «اختر
      // الدرج» وهو قد اختار فعلاً. أي أنّ الفرعَ الذي أُضيف لحالةٍ بعينها كان **لا يُبلَغ فيها**.
      // الترتيبُ الآن: اختيارٌ خاطئ ⇐ اختيارٌ ناقصٌ مع تعدّد ⇐ لا وردية أصلاً.
      message: explicitShiftId != null
        ? appErrorMessage({
            what: "تعذّر صرف الاسترداد النقديّ",
            why: `الوردية المحدَّدة رقم ${explicitShiftId} ليست ضمن ورديات الاستقبال المفتوحة في هذا الفرع الآن — أُغلقت أو تخصّ فرعاً آخر`,
            doThis: "اختر وردية استقبالٍ مفتوحة من القائمة، أو افتح وردية استقبال في هذا الفرع ثمّ أعِد التنفيذ",
          })
        : open.length > 1
          ? appErrorMessage({
              what: "تعذّر صرف الاسترداد النقديّ",
              why: `في هذا الفرع ${open.length} ورديات استقبالٍ مفتوحة معاً، والنظام لا يختار درجاً بالنيابة عنك — المال يخرج من درجٍ بعينه ويظهر في تسويته وحده`,
              doThis: "اختر الدرج الذي ستُخرج منه المبلغ من قائمة الورديات في نافذة الإلغاء، ثمّ أعِد التنفيذ",
            })
          : appErrorMessage({
              what: "تعذّر صرف الاسترداد النقديّ",
              why: "لا وردية استقبالٍ مفتوحة في هذا الفرع، ونقد الاسترداد يخرج من درجٍ مفتوحٍ تظهر فيه حركتُه — لا من نقدٍ خارج النظام",
              doThis: "افتح وردية الاستقبال ثمّ أعِد الإلغاء؛ وإن كنت مديراً وخارج ساعات الوردية فاصرف من الخزينة الإدارية باختيار رافد «الخزينة»",
            }),
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
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: "تعذّر صرف الاسترداد النقديّ",
        why: `وردية الاستقبال رقم ${Number(chosen.id)} أُغلقت في اللحظة نفسها — والدرج المُغلق لا يخرج منه نقد، وإلّا ظهر عجزٌ في تسويةٍ أُقفلت سلفاً`,
        doThis: "افتح وردية استقبالٍ جديدة واصرف منها، أو اختر رافد «الخزينة الإدارية» إن كنت مديراً وخارج ساعات الوردية",
      }),
    });
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
  /**
   * **رافدُ ردّ العربون النقديّ** (قرار المالك ١/٩) — الافتراض `DRAWER` فيبقى السلوكُ القائم
   * حرفياً لكلّ مستدعٍ لم يُعدَّل. يُطبَّق **فقط** حين يكون الأصلُ نقدياً (`CASH`/`TELECOM`)؛
   * والمقبوضُ ببطاقةٍ أو تحويلٍ يبقى على مساره غير النقديّ («يُردّ بطريقة قبضه»).
   *
   * الحاجةُ من بلاغٍ حيّ: عربونٌ ٧٠٬٠٠٠ وأوسعُ درجٍ مفتوح ٥٦٬٠٠٠ ⇒ لا درجَ يغطّيه، فالردّ
   * من درجٍ وحده بابٌ مسدود. الفروقُ المحاسبيّة في [`shared/refundRail.ts`](../../../shared/refundRail.ts).
   */
  refundRail?: RefundRail | null;
  /** مرجعُ التنفيذ الخارجيّ — إلزاميّ لرافد `CARD` وحده (إثباتُ الاسترداد على جهاز الدفع). */
  refundReference?: string | null;
  clientRequestId?: string | null;
  expectedVersion?: number;
  reason?: string | null;
  materials?: readonly WorkOrderCancelMaterialDecision[] | null;
}

export async function cancelWorkOrderInTx(
  tx: Tx,
  workOrderId: number,
  actor: Actor & { role?: string; permissionsOverride?: unknown },
  opts: CancelWorkOrderOptions = {},
  control: ApprovedWorkOrderControl = {},
) {
    const reason = opts.reason?.trim() ?? "";
    if (reason.length < 3 || reason.length > 500) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر إلغاء طلب الخدمة",
          why: `سبب الإلغاء إلزاميّ ويقع بين 3 و500 محرف — الوارد ${reason.length} محرفاً؛ وهو ما يُميّز «لم يحضر العميل» عن إلغاءٍ مجهولٍ في تقارير الطلبات`,
          doThis: "اكتب السبب كما وقع فعلاً: «العميل عدل عن الطلب» أو «تعذّر توفير الخامة» أو «خطأ في إدخال الطلب»",
        }),
      });
    }
    if (!Number.isInteger(opts.expectedVersion) || Number(opts.expectedVersion) <= 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر إلغاء طلب الخدمة",
          why: `الطلب وصل بلا رقم نسخة الأمر المتوقَّعة (الوارد «${String(opts.expectedVersion)}») — وهي التي تمنع إلغاء أمرٍ عدّله غيرُك بعد فتحك للصفحة`,
          doThis: "حدّث صفحة أمر الشغل وافتح نافذة الإلغاء من جديد؛ وإن تكرّر الرفض فأبلِغ مسؤول النظام برقم الأمر",
        }),
      });
    }
    const clientRequestId = opts.clientRequestId?.trim() || null;
    const requestFingerprint = clientRequestId
      // القرارُ جزءٌ من البصمة: إعادةُ محاولةٍ بقرارِ هدرٍ مختلف **ليست** نفس الطلب.
      ? idempotencyHash({
          workOrderId,
          refundShiftId: opts.refundShiftId ?? null,
          // الرافدُ جزءٌ من البصمة كذلك: «درج» و«خزينة» و«بطاقة» ثلاثةُ آثارٍ ماليّةٍ مختلفة
          // (دلوٌ مختلف · تسويةٌ مختلفة · معلّقٌ باعتماد) — فإعادةُ محاولةٍ برافدٍ آخر طلبٌ آخر،
          // ولا يجوز أن يُعيد المفتاحُ نتيجةَ الأوّل مكانها.
          refundRail: opts.refundRail ?? null,
          refundReference: (opts.refundReference ?? "").trim() || null,
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
          throw new TRPCError({
            code: "CONFLICT",
            message: appErrorMessage({
              what: "تعذّر إلغاء طلب الخدمة",
              why: `مفتاح هذا الطلب مستعمَلٌ سلفاً لإلغاء أمر الشغل ${existingId}، وأنت تُلغي الأمر ${workOrderId} — الصفحة على الأرجح مفتوحةٌ منذ إلغاءٍ سابق`,
              doThis: "أغلق النافذة وافتح الإلغاء من صفحة أمر الشغل الذي أمامك من جديد",
            }),
          });
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
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: `تعذّر إلغاء طلب الخدمة ${wo.orderNumber}`,
          why: `الأمر تغيّر بعد فتحك للصفحة: نسختك ${Number(opts.expectedVersion)} ونسخته الحالية ${Number(wo.version)} — عدّله موظّفٌ آخر أو تقدّمت حالتُه، وقد تكون خامتُه استُهلكت منذ ذلك`,
          doThis: "حدّث الصفحة لترى حالة الأمر الحالية، ثمّ قرّر الإلغاء على ما هو عليه الآن",
        }),
      });
    }
    if (wo.status === "DELIVERED" || wo.status === "CANCELLED")
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: `تعذّر إلغاء طلب الخدمة ${wo.orderNumber}`,
          why: wo.status === "CANCELLED"
            ? "الأمر ملغى سلفاً: موادُه رُدّت وعربونُه سُوّي في الإلغاء الأوّل، فلا شيء يُلغى ثانيةً"
            : "الأمر سُلِّم للعميل والبضاعة بيده، والإلغاء يفترض أنّ شيئاً لم يخرج — فلا يُعكَس تسليمٌ وقع بإلغاء",
          doThis: wo.status === "CANCELLED"
            ? "راجع سجلّ الأمر لترى ما رُدّ للعميل وما رجع للمخزون؛ وإن بقي مالٌ عالقاً فافتح طلب ردٍّ من صفحة الأمر"
            : "استعمل «استرجاع التسليم» من صفحة أمر الشغل — هو المسار الذي يعكس التسليم والفاتورة والذمّة معاً",
        }),
      });
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
        message: appErrorMessage({
          what: `تعذّر إلغاء طلب الخدمة ${wo.orderNumber}`,
          why: `صدرت للطلب فاتورة (رقمها الداخليّ ${Number(wo.invoiceId)}) وقُيِّد بيعُها وذمّتُها — والإلغاء يردّ المواد ويستردّ العربون ويترك الفاتورة وقيدها قائمَين: إيرادٌ بلا بضاعة وذمّةٌ على عميلٍ لطلبٍ ملغى`,
          doThis: "استعمل «استرجاع التسليم» من صفحة أمر الشغل بدل الإلغاء — هو الذي يعكس الفاتورة والذمّة والمواد معاً في عمليةٍ واحدة",
        }),
      });
    }
    const existingMaterials = await tx
      .select({ id: workOrderMaterials.id })
      .from(workOrderMaterials)
      .where(eq(workOrderMaterials.workOrderId, workOrderId));
    const heldFeeBeforeCancel = await workOrderFeeHeldNet(tx, workOrderId);
    const appliedDepositsBeforeCancel = await appliedCollectionsForWorkOrder(tx, workOrderId);
    /**
     * **بوّابةُ المدير القائمة — لم تُمَسّ حرفاً.** بقيت هي هي بكلّ حدودها المتشدّدة، لأنّ
     * تخفيفَها كان سيوسّع سلطةً قائمةً بلا طلب.
     */
    const riskyCancellation = wo.status !== "RECEIVED"
      || money(wo.deposit ?? "0").gt(0)
      || appliedDepositsBeforeCancel.length > 0
      || existingMaterials.length > 0
      || heldFeeBeforeCancel.gt(0);
    /**
     * **شرطُ الإلغاء المباشر لغير المدير** (فنّي المطبعة/الكاشير — قرار المالك ١/٩/٢٦):
     * أمرٌ لم يبدأ تنفيذُه ولا مالَ فيه. أسطرُ الخامة **المخطَّطة** لا تدخل الحساب: الإلغاء
     * من `RECEIVED` لا يُنتج أيَّ حركة مخزون أصلاً (الاستهلاك يقع في `startWorkOrder`)،
     * ولو حُوسِبت لأُلغِيت الصلاحيةُ عملياً — فأغلبُ أوامر الطباعة يحمل أسطرَها منذ الإنشاء.
     *
     * ⚠️ الحارسُ هنا في **الخدمة** لا في الراوتر وحده: البوّابةُ التي تُقرأ من قناةٍ واحدة
     * تُعمي القنواتِ الأخرى (أوفلاين/أندرويد/استيراد) — §٢ قاعدة الطبقات.
     */
    const moneyAtStake = money(wo.deposit ?? "0").gt(0)
      || appliedDepositsBeforeCancel.length > 0
      || heldFeeBeforeCancel.gt(0);
    const directCancelAllowed = mayCancelWorkOrderWithoutApproval({
      role: actor.role ?? "",
      override: (actor.permissionsOverride ?? null) as never,
      status: wo.status,
      moneyAtStake,
      managerControlRequired: riskyCancellation,
    });
    if (!directCancelAllowed && control.approvedControlRequestId == null) {
      // **٤٠٣ لِمَن ليس له القرار، و٤١٢ لِمَن له القرار وحالةُ الأمر تمنعه** — رمزان مختلفان
      // لسببَين مختلفَين. الكاشير يقع في الأوّل (مسارُه الطلب) ولو كان الأمرُ خالياً من المال.
      if (!hasWorkOrderDirectCancelAuthority(actor.role ?? "", (actor.permissionsOverride ?? null) as never)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: appErrorMessage({
            what: `تعذّر إلغاء طلب الخدمة ${wo.orderNumber} مباشرةً`,
            why: "الإلغاء المباشر ليس من صلاحيات دورك مهما كانت حالة الأمر — لأنّه يردّ مواداً ويمسّ مالاً، فيلزمه قرارُ مديرٍ موثَّق",
            doThis: "اضغط «طلب إلغاء» من صفحة الأمر واكتب السبب؛ يصل الطلب إلى المدير فوراً ويُنفَّذ الإلغاء بمجرّد اعتماده",
          }),
        });
      }
      const isManager = hasWorkOrderManagerAuthority(
        actor.role ?? "",
        (actor.permissionsOverride ?? null) as never,
      );
      // ⭐ الزبون واقفٌ عند الاستقبال: الرسالة تسمّي **ما الذي** أوقف الإلغاء بالأرقام، لا
      //   «عربون أو مواد أو أجرة» مسرودةً احتمالاتٍ يبحث الموظّف فيها عن حالته.
      const heldMoneyNote = [
        money(wo.deposit ?? "0").gt(0) ? `عربون ${round2(money(wo.deposit ?? "0")).toFixed(2)} د.ع` : null,
        appliedDepositsBeforeCancel.length > 0
          ? `${appliedDepositsBeforeCancel.length} حصّة قبضٍ مطبَّقة سلفاً`
          : null,
        heldFeeBeforeCancel.gt(0) ? `أمانة أجرة توصيل ${heldFeeBeforeCancel.toFixed(2)} د.ع` : null,
      ].filter(Boolean).join("، و");
      const blockNote = [
        wo.status !== "RECEIVED" ? `بدأ مساره وحالته الآن «${workOrderStatusLabel(wo.status)}»` : null,
        heldMoneyNote || null,
        existingMaterials.length > 0 ? `عليه ${existingMaterials.length} سطر خامة` : null,
      ].filter(Boolean).join("، و");
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        // رسالةٌ تقول **لِمَ** مُنع وما البديل — لا «غير مسموح» عمياء توقف الموظّف بلا مخرج.
        message: isManager
          ? appErrorMessage({
              what: `تعذّر إلغاء طلب الخدمة ${wo.orderNumber} مباشرةً`,
              why: `${blockNote} — وإلغاءٌ كهذا يردّ مالاً أو مخزوناً، ففصلُ المهام يوجب أن يعتمده مديرٌ غيرُك`,
              doThis: "اضغط «طلب إلغاء» واكتب السبب؛ يعتمده مديرٌ آخر أو المالك فيُنفَّذ الإلغاء بردّ المواد والمال في خطوةٍ واحدة",
            })
          : moneyAtStake
            ? appErrorMessage({
                what: `تعذّر إلغاء طلب الخدمة ${wo.orderNumber} مباشرةً`,
                why: `في الطلب مبلغ مقبوض من العميل (${heldMoneyNote}) — وردُّه يخرج نقداً من الدرج، وهو قرارُ مديرٍ لا كاشير`,
                doThis: "اضغط «طلب إلغاء» واكتب السبب؛ يعتمده المدير ويردّ المبلغ للعميل من درجه أو من الخزينة — وأبلِغ العميل أنّ ردّه ينتظر المدير",
              })
            : appErrorMessage({
                what: `تعذّر إلغاء طلب الخدمة ${wo.orderNumber} مباشرةً`,
                why: `بدأ تنفيذ الطلب (حالته «${workOrderStatusLabel(wo.status)}») وخامتُه خرجت من المخزون فعلاً — ومصيرُها بين الرجوع والهدر قرارُ مدير`,
                doThis: "اضغط «طلب إلغاء» واكتب السبب وصف حالة الخامة كما تراها؛ يقرّر المدير عند الاعتماد كم يعود للمخزون وكم يُسجَّل هدراً",
              }),
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
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: appErrorMessage({
                what: `تعذّر إلغاء طلب الخدمة ${wo.orderNumber}`,
                why: `قرار الخامة يذكر السطر رقم ${id} وهو ليس من أسطر خامة هذا الأمر (أسطرُه ${mats.length}) — النافذة على الأرجح مفتوحةٌ منذ تعديلٍ على المواد`,
                doThis: "حدّث صفحة أمر الشغل وافتح نافذة الإلغاء من جديد، ثمّ حدّد مصير الأسطر المعروضة فيها",
              }),
            });
          }
          if (decisions.has(id)) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: appErrorMessage({
                what: `تعذّر إلغاء طلب الخدمة ${wo.orderNumber}`,
                why: `سطر الخامة ${id} له قراران في الطلب نفسه — وتمريرُهما يجعل مصير المادّة الواحدة غامضاً بين الرجوع والهدر`,
                doThis: "احذف القرار المكرّر واترك قراراً واحداً لكلّ سطر خامة",
              }),
            });
          }
          const ret = Number(d.returnBase);
          const waste = Number(d.wasteBase);
          if (!Number.isInteger(ret) || !Number.isInteger(waste) || ret < 0 || waste < 0) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: appErrorMessage({
                what: `تعذّر إلغاء طلب الخدمة ${wo.orderNumber}`,
                why: `كمّيات سطر الخامة ${id} وصلت «راجع ${d.returnBase} · هدر ${d.wasteBase}» — وهما عددان صحيحان غير سالبين بالوحدة الأساس (لا كسور ولا سالب)`,
                doThis: "صحّح الرقمين في نافذة الإلغاء: ما عاد صالحاً للرفّ في «راجع» وما تلف في «هدر»، وضع صفراً حيث لا شيء",
              }),
            });
          }
          // ⛔ لا فرقَ يُمتصّ صامتاً: ما استُهلك إمّا عاد وإمّا تلف — الرقمان يجمعانه بالضبط.
          if (ret + waste !== consumed) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: appErrorMessage({
                what: `تعذّر إلغاء طلب الخدمة ${wo.orderNumber}`,
                why: `في سطر الخامة ${id}: مجموع الرجوع والهدر ${ret + waste} (راجع ${ret} · هدر ${waste}) لا يساوي المستهلَك ${consumed} — ${ret + waste < consumed ? `ناقص ${consumed - (ret + waste)}` : `زائد ${(ret + waste) - consumed}`}؛ وما استُهلك إمّا عاد للرفّ وإمّا تلف، فلا كمّيةَ تتبخّر بين الرقمين`,
                doThis: `عدّل الرقمين حتى يبلغ مجموعهما ${consumed} بالضبط — ${ret + waste < consumed ? `أضِف الفرق ${consumed - (ret + waste)} إلى الهدر إن لم يعد صالحاً، أو إلى الراجع إن عاد للرفّ` : `أنقص الزيادة ${(ret + waste) - consumed} من الرقم الذي بالغتَ فيه`}`,
              }),
            });
          }
          decisions.set(id, { returnBase: ret, wasteBase: waste });
        }
        const missing = mats.filter((m) => !decisions.has(Number(m.id)));
        if (missing.length > 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: appErrorMessage({
              what: `تعذّر إلغاء طلب الخدمة ${wo.orderNumber}`,
              why: `قرار الخامة ناقص: ${missing.length} من ${mats.length} أسطر بلا قرار (أرقامها ${missing.map((m) => Number(m.id)).join("، ")}) — وسطرٌ بلا قرار يترك مادّةً خرجت من المخزون بلا مصير`,
              doThis: "حدّد لكلّ سطرٍ ناقص كم يعود للرفّ وكم تلف؛ وإن كان السطر كلّه عائداً فضع كمّيته المستهلَكة في «راجع» وصفراً في «هدر»",
            }),
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
        message: appErrorMessage({
          what: `تعذّر إلغاء طلب الخدمة ${wo.orderNumber}`,
          why: `الطلب لم يبدأ تنفيذُه بعد (حالته «${workOrderStatusLabel(wo.status)}») فلا خامة مستهلَكة فيه — وقبولُ قرار رجوعٍ وهدرٍ هنا يُوهمك بأنّه سُجّل وهو لا محلّ له`,
          doThis: "ألغِ الطلب بلا قرار خامة؛ الأسطر المخطَّطة لم تخرج من المخزون أصلاً فلا شيء يعود ولا شيء يُهدَر",
        }),
      });
    }
    // استرداد العربون المقبوض (إن وُجد ولم يُربَط بفاتورة): نقدٌ يخرج من الدُرج الآن ⇒ receipt(OUT)+PAYMENT_OUT
    // يعكس قيد PAYMENT_IN المُسجَّل عند الإنشاء (صافي الدفتر = صفر)، ويظهر خروجاً في Z-report يوم الإلغاء.
    // نعكس فقط ما قُبِض فعلاً (إيصال موجود) — لا نختلق استرداداً لأوامر قديمة لم تُسجِّل العربون كقيد.
    const refundD = round2(money(wo.deposit ?? "0"));
    /**
     * **الرافدُ قرارٌ واحدٌ للعملية كلّها لا للعربون وحده** (مراجعة Codex P1 على #928):
     * الأمرُ قد يجمع عربوناً مباشراً + حصصَ مسوّدةٍ مطبَّقة + أمانةَ أجرة توصيل. وتطبيقُ الرافد
     * على الأوّل وحده يشقّ الردَّ بين الخزينة ودرجٍ صامتاً، أو يُسقطه حين لا يُرسَل
     * `refundShiftId` أصلاً (وهو ما تفعله مسارات الخزينة/البطاقة عمداً).
     */
    const opRail: RefundRail = opts.refundRail ?? "DRAWER";
    const opRailShape = refundRailReceiptShape(opRail);
    /** دلوُ النقد الفوريّ لهذه العملية — درجٌ أو خزينة. */
    const cashSinkBucket: "DRAWER" | "TREASURY" = opRail === "TREASURY" ? "TREASURY" : "DRAWER";
    /** الوردية: للدرج وحده — الخزينةُ بلا وردية. */
    const resolveCashSinkShift = async (): Promise<number | null> =>
      cashSinkBucket === "DRAWER"
        ? await resolveLockedReceptionCashShift(tx, Number(wo.branchId), opts.refundShiftId ?? null)
        : null;
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
            message: appErrorMessage({
              what: `تعذّر ردّ عربون طلب الخدمة ${wo.orderNumber}`,
              why: `إيصال قبض العربون رقم ${Number(depRcpt.id)} ليس قبضاً منفَّذاً معتمَداً (اتّجاهه «${depRcpt.direction}» · حالته «${depRcpt.status}» · اعتماده «${depRcpt.approvalStatus}») — ولا يُردّ مالٌ لم يثبت دخولُه`,
              doThis: "افتح الإيصال من سجلّ الطلب: إن كان معلّقاً باعتمادٍ فاعتمِده أوّلاً ثمّ ألغِ الطلب، وإن كان مُلغىً فلا عربون يُردّ — أكمِل الإلغاء وأبلِغ المدير",
            }),
          });
        }
        const refundAmt = round2(money(depRcpt.amount));
        // استثناء رصيد زين (ش٥، مراجعة عدائية ٦/٨): لا سكّة ردٍّ له — إيصال OUT بTELECOM
        // يُنقص الحساب المشتقّ بينما رصيد زين الحقيقيّ لا يتحرّك ⇒ يُردّ نقداً من الدرج.
        const collectedMethod = depRcpt.paymentMethod ?? "CASH";
        const collectedInCash = collectedMethod === "CASH" || collectedMethod === "TELECOM";
        /**
         * **الرافد** — يُختار فقط حين يكون الأصلُ نقدياً. غيرُ النقديّ يبقى على مساره كما كان
         * (يُردّ بطريقة قبضه)، فلا يتغيّر سلوكُ أيّ مستدعٍ قائم.
         */
        const rail: RefundRail = collectedInCash ? (opts.refundRail ?? "DRAWER") : "DRAWER";
        const railShape = refundRailReceiptShape(rail);
        const refundMethod = collectedInCash ? railShape.paymentMethod : collectedMethod;
        const refundBucket = collectedInCash ? railShape.cashBucket : null;
        const immediate = collectedInCash ? refundRailIsImmediate(rail) : false;
        const refundRef = (opts.refundReference ?? "").trim();
        if (collectedInCash && refundRailNeedsReference(rail) && refundRef.length < 3) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: appErrorMessage({
              what: `تعذّر ردّ عربون طلب الخدمة ${wo.orderNumber} على البطاقة`,
              why: `مرجع تنفيذ الاسترداد من جهاز الدفع لم يصل أو أقصر من 3 محارف (الوارد ${refundRef.length} محرفاً) — وهو الأثر الوحيد على أنّ ${refundAmt.toFixed(2)} د.ع خرجت فعلاً`,
              doThis: "نفّذ الاسترداد على جهاز الدفع أوّلاً وأدخِل رقم عمليته هنا، أو بدّل رافد الردّ إلى الدرج أو الخزينة الإدارية لتسلّمه نقداً الآن",
            }),
          });
        }
        // الدرج مورد فرعٍ لا مستخدم — الإلغاء صلاحية مدير قد يختلف عن كاشير الاستقبال.
        // نختار RECEPTION فقط، نقفلها FOR UPDATE، ثم نتحقّق من النقد المتاح قبل الخروج.
        let shiftId: number | null;
        if (collectedInCash && immediate) {
          // TREASURY: لا درجَ ولا وردية — النقد من خزينة الفرع، والحارسُ نفسه يقيس توفّره.
          shiftId = refundBucket === "DRAWER"
            ? await resolveLockedReceptionCashShift(tx, Number(wo.branchId), opts.refundShiftId ?? null)
            : null;
          // خروجُ الخزينة عكسٌ مقيَّدٌ بمصدره لا صرفٌ جديد ⇒ يُعلَن استثناءً مغلقاً (نظيرَ إلغاء
          // البيع) بدل طابور اعتماد المالك؛ وبلا هذا الإعلان يمرّ عبر assertCashOutAvailable الحيادي
          // فيتسرّب صرفُ خزينةٍ بلا حارسٍ (مراجعة Codex P1 على #930).
          if (refundBucket === "TREASURY") assertTreasuryOutException("WORK_ORDER_CANCELLATION_COMPENSATION");
          await assertCashOutAvailable(tx, {
            branchId: Number(wo.branchId), cashBucket: refundBucket === "DRAWER" ? "DRAWER" : "TREASURY", shiftId,
            amount: refundAmt, operation: `رد عربون إلغاء أمر الشغل (${rail === "TREASURY" ? "خزينة" : "درج"})`,
          });
        } else {
          // **العربونُ العابر (بلا عميلٍ مسجَّل) يُردّ كذلك** (مراجعة Codex P2 على #930): كان الحارسُ
          // يرفضه فيَعلَق الأمرُ الملغى بمالٍ محتجَزٍ بلا مخرج (خرقُ §٥). والأسوأ أنّ `cardRefundAllowed`
          // يُتيح البطاقةَ لعربونٍ نقديٍّ مباشر بلا عميل، فيُنشأ طلبُ تحكّمٍ يتعذّر اعتمادُه. إيصالُ
          // الردّ يقع طرفاً OTHER (أدناه، نظيرَ الحصص المطبَّقة)، ومسارُ الاعتماد
          // `approveWorkOrderCancellationRefund` يقبل الطرفَ الفارغ (0 === 0) فيُبرَّأ المالُ بسندٍ
          // واعتماد مالكٍ ومرجعِ تنفيذٍ خارجيّ.
          shiftId = null;
          assertNonPhysicalOutReceipt({
            classification: "DEFERRED_APPROVAL",
            paymentMethod: refundMethod,
            cashBucket: null,
            approvalStatus: "PENDING_APPROVAL",
            operation: rail === "CARD" && collectedInCash
              ? "طلب رد عربون نقديّ على البطاقة"
              : "طلب رد عربون أمر شغل غير نقدي",
          });
        }
        const rRes = await tx.insert(receipts).values({
          branchId: Number(wo.branchId),
          shiftId,
          workOrderId,
          direction: "OUT",
          amount: toDbMoney(refundAmt),
          paymentMethod: refundMethod,
          // الدلوُ يتبع الرافد: DRAWER يَخصم من تسوية الوردية، وTREASURY من خزينة الفرع،
          // وغيرُ الفوريّ بلا دلوٍ إطلاقاً (لا يمسّ نقداً حتى يُعتمد).
          cashBucket: immediate ? refundBucket : null,
          status: immediate ? "COMPLETED" : "PENDING",
          approvalStatus: immediate ? "APPROVED" : "PENDING_APPROVAL",
          referenceNumber: immediate ? `WO-CANCEL-REFUND-${workOrderId}` : null,
          description: immediate
            ? `استرداد عربون أمر شغل ملغى #${workOrderId}${rail === "TREASURY" ? " (من الخزينة الإدارية)" : ""}`
            : rail === "CARD" && collectedInCash
              ? `طلب استرداد على البطاقة لعربونٍ نقديّ — أمر الشغل #${workOrderId} (مرجع: ${refundRef}) — بلا أثر حتى التنفيذ`
              : `طلب استرداد غير نقدي معلّق لأمر الشغل #${workOrderId} — بلا أثر حتى التنفيذ`,
          partyType: wo.customerId ? "CUSTOMER" : "OTHER",
          partyId: wo.customerId ?? null,
          internalNote: !immediate
            ? `WORK_ORDER_CUSTOMER_REFUND:DIRECT:${workOrderId}:${Number(depRcpt.id)}`
            : null,
          createdBy: actor.userId,
        });
        const refundReceiptId = extractInsertId(rRes);
        if (!immediate) pendingRefundReceiptIds.push(refundReceiptId);
        if (immediate) {
          // الحسابُ يتبع الدلو: CASH للدرج وTREASURY_CASH للخزينة (paymentAssetRole).
          const refundAssetRole = paymentAssetRole(refundMethod, refundBucket, "OUT");
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
            notes: `استرداد عربون طلب خدمة ملغى #${workOrderId}`
              + (collectedMethod === "TELECOM" ? " (أصل القبض: رصيد زين — رُدّ نقداً)" : "")
              + (rail === "TREASURY" ? " (من الخزينة الإدارية لا من الدرج)" : ""),
            postingIntent: createPostingIntent("PAYMENT_OUT_OTHER", "PAYMENT_OUT", [debitLine("OTHER_LIABILITY", refundAmt), creditLine(refundAssetRole, refundAmt)], refundPostingSource),
            postingSourceComponents: refundPostingSource,
          });
        }
      }
    }

    /**
     * **حصصُ العربون المطبَّقة تُردّ ولو كان العمود `deposit` صفراً** (فجوةٌ ماليّة رفعها
     * الفحصُ، وأقرّ المالكُ سدَّها ١/٩): أمرٌ من مسوّدة استقبالٍ قد يحمل حصصَ قبضٍ نقديّةً
     * محتجَزة بينما `workOrders.deposit = 0`. وكانت هذه الحلقةُ داخل `if (refundD.gt(0))`
     * فتُتخطّى ⇒ مالُ العميل يبقى في الدرج بلا مسار خروج، مخالفاً §٥ («لكلّ مالٍ محتجَز
     * مسارُ خروجٍ ممكنٌ دائماً»). أُخرِجت من الحارس فتُصرَف حين توجد حصصٌ فعلاً — لا حين
     * يكون العربونُ المباشر موجباً وحده.
     *
     * وهي idempotent بطبيعتها: كلُّ حصّةٍ تُختَم بصفّ REFUND مربوطٍ بأمّه (I17)، فإعادةُ
     * التشغيل لا تُكرّر ردّاً.
     */
    // ش٤: حصص العربون المقبوضة **سلفاً** (مسوّدة ⇒ APPLICATION على هذا الأمر) — إيصال
    // depositReceiptId أعلاه يحمل الجزء الجديد N وحده، فردُّه وحدَه يترك حصص P بلا ردّ
    // (وقد يكون N صفراً أصلاً). كلّ حصّة تُردّ بطريقة قبضها + صفّ REFUND مربوط بأمّه (I17).
    const appliedParts = await appliedCollectionsForWorkOrder(tx, workOrderId);
    let appliedCashShiftId: number | null = null;
    for (const part of appliedParts) {
      if (part.receiptId == null) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: appErrorMessage({
            what: `تعذّر ردّ مقبوضات طلب الخدمة ${wo.orderNumber}`,
            why: `حصّة قبضٍ مطبَّقة على الطلب بقيمة ${round2(money(part.amount)).toFixed(2)} د.ع بلا إيصالٍ يُثبتها — ولا يُردّ للعميل مالٌ لا يُعرَف من أيّ إيصالٍ دخل`,
            doThis: "أوقف الإلغاء وافتح سجلّ مقبوضات الطلب لتحديد إيصال هذه الحصّة؛ وإن تعذّر فأبلِغ المدير قبل تسليم العميل أيّ مبلغ",
          }),
        });
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
          message: appErrorMessage({
            what: `تعذّر ردّ مقبوضات طلب الخدمة ${wo.orderNumber}`,
            why: source
              ? `إيصال حصّة القبض رقم ${part.receiptId} ليس قبضاً منفَّذاً معتمَداً (اتّجاهه «${source.direction}» · حالته «${source.status}» · اعتماده «${source.approvalStatus}») — فردُّه يُخرج مالاً لم يثبت دخولُه`
              : `إيصال حصّة القبض رقم ${part.receiptId} لم يعد موجوداً في سجلّ الإيصالات`,
            doThis: "أوقف الإلغاء وراجع قبض الطلب في سجلّ الإيصالات: اعتمِد القبض المعلّق إن كان معلّقاً، وأبلِغ المدير إن كان الإيصال مفقوداً — قبل تسليم العميل أيّ مبلغ",
          }),
        });
      }
      const amountD = round2(money(part.amount));
      if (amountD.lte(0)) continue;
      const refundMethod = part.method === "TELECOM" ? "CASH" : part.method;
      let shiftId: number | null = null;
      if (refundMethod === "CASH") {
        if (opRail === "CARD") {
          // ⛔ لا نشقّ ردّاً واحداً بين بطاقةٍ ونقد: البطاقةُ مسارٌ معلّقٌ باعتماد، والحصصُ
          // تُصرَف فوراً — فخلطُهما يُخرج بعضَ المال ويُعلّق بعضَه على مستندٍ واحد. رفضٌ صريح
          // أصدقُ من شقٍّ صامت (§٥).
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: appErrorMessage({
              what: `تعذّر ردّ عربون طلب الخدمة ${wo.orderNumber} على البطاقة`,
              why: `في الطلب حصّةٌ نقديّة مقبوضة سلفاً قيمتها ${amountD.toFixed(2)} د.ع، وردُّ البطاقة معلّقٌ باعتمادٍ بينما الحصّة تُصرَف فوراً — فخلطُهما يُخرج بعض المال ويُعلّق بعضَه على مستندٍ واحد`,
              doThis: "بدّل رافد الردّ إلى «درج الاستقبال» أو «الخزينة الإدارية» ليخرج المبلغ كلّه نقداً في عمليةٍ واحدة",
            }),
          });
        }
        appliedCashShiftId ??= await resolveCashSinkShift();
        shiftId = appliedCashShiftId;
        // نظيرُ المسار المباشر: خروجُ الخزينة يُعلَن استثناءً مغلقاً لا يمرّ حيادياً (Codex P1 #930).
        if (cashSinkBucket === "TREASURY") assertTreasuryOutException("WORK_ORDER_CANCELLATION_COMPENSATION");
        await assertCashOutAvailable(tx, {
          branchId: Number(wo.branchId), cashBucket: cashSinkBucket, shiftId,
          amount: amountD, operation: "رد حصة عربون أمر شغل",
        });
      } else {
        // **الحصّةُ غير النقديّة العابرة (بلا عميلٍ مسجَّل) تُردّ كذلك** (مراجعة Codex P2 على #930):
        // كان الحارسُ يرفضها فيَعلَق الأمرُ الملغى بمالٍ نقديٍّ محتجَزٍ بلا مخرج (خرقُ §٥ — «لكلّ مالٍ
        // محتجَز مسارُ خروجٍ ممكنٌ دائماً»). إيصالُ الردّ يقع طرفاً OTHER (كنظيره النقديّ أدناه)،
        // ومسارُ الاعتماد `approveWorkOrderCancellationRefund` يقبل الطرفَ الفارغ (0 === 0) فيُبرَّأ
        // المالُ بسندٍ واعتماد مالكٍ ومرجعِ تنفيذٍ خارجيّ.
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
        cashBucket: refundMethod === "CASH" ? cashSinkBucket : null,
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
        // الحسابُ يتبع الدلو الفعليّ: CASH للدرج وTREASURY_CASH للخزينة — وإلّا خرج المال
        // من الخزينة وسُجّل على حساب الدرج (قيدٌ يخالف الحركة).
        const refundAssetRole = paymentAssetRole(refundMethod, cashSinkBucket, "OUT");
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
      if (opRail === "CARD") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: appErrorMessage({
            what: `تعذّر ردّ أمانة أجرة التوصيل لطلب الخدمة ${wo.orderNumber}`,
            why: `على الطلب أمانة أجرة توصيل ${feeHeldNet.toFixed(2)} د.ع قُبضت نقداً وتُردّ نقداً، وردُّ البطاقة معلّقٌ باعتماد — فلا يُردّ نقدٌ محتجَز على مسارٍ لا يخرج فيه المال الآن`,
            doThis: "بدّل رافد الردّ إلى «درج الاستقبال» أو «الخزينة الإدارية» ليخرج المبلغ نقداً مع بقيّة مستحقّات العميل",
          }),
        });
      }
      const feeShiftId = await resolveCashSinkShift();
      // نظيرُ المسارين أعلاه: خروجُ الخزينة يُعلَن استثناءً مغلقاً لا يمرّ حيادياً (Codex P1 #930).
      if (cashSinkBucket === "TREASURY") assertTreasuryOutException("WORK_ORDER_CANCELLATION_COMPENSATION");
      await assertCashOutAvailable(tx, {
        branchId: Number(wo.branchId), cashBucket: cashSinkBucket, shiftId: feeShiftId,
        amount: feeHeldNet, operation: "رد أمانة أجرة توصيل أمر الشغل",
      });
      const feeOut = await tx.insert(receipts).values({
        branchId: Number(wo.branchId), shiftId: feeShiftId, workOrderId,
        direction: "OUT", amount: toDbMoney(feeHeldNet), paymentMethod: "CASH", cashBucket: cashSinkBucket,
        status: "COMPLETED", approvalStatus: "APPROVED", partyType: "OTHER",
        referenceNumber: `DLV-FEE-WO-${workOrderId}`,
        description: `ردّ أمانة أجرة توصيل — إلغاء طلب #${workOrderId}`,
        createdBy: actor.userId,
      });
      // الحسابُ يتبع الدلو: خروجٌ من الخزينة يُقيَّد على TREASURY_CASH لا على CASH.
      const feeAssetRole = paymentAssetRole("CASH", cashSinkBucket, "OUT");
      await postEntry(tx, {
        entryType: "DELIVERY_FEE_HELD",
        dedupeKey: `DELIVERY_FEE_HELD_REFUND:WO:${workOrderId}`,
        branchId: Number(wo.branchId),
        receiptId: extractInsertId(feeOut),
        amount: feeHeldNet.neg(),
        notes: `ردّ أمانة أجرة توصيل — إلغاء طلب #${workOrderId}`
          + (cashSinkBucket === "TREASURY" ? " (من الخزينة الإدارية)" : ""),
        postingSourceComponents: {
          roleDebits: { COURIER_PAYABLE: feeHeldNet },
          roleCredits: { [feeAssetRole]: feeHeldNet },
        },
        postingIntent: createPostingIntent("DELIVERY_FEE_HELD_PAYOUT", "DELIVERY_FEE_HELD", [debitLine("COURIER_PAYABLE", feeHeldNet), creditLine(feeAssetRole, feeHeldNet)], {
          roleDebits: { COURIER_PAYABLE: feeHeldNet },
          roleCredits: { [feeAssetRole]: feeHeldNet },
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
  actor: Actor & { role?: string; permissionsOverride?: unknown },
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
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر اعتماد ردّ عربون أمر الشغل",
          why: `مرجع تنفيذ الاسترداد الخارجيّ إلزاميّ ويقع بين 3 و100 محرف — الوارد ${confirmedReference.length} محرفاً؛ وهو ما يُثبت أنّ المال خرج فعلاً من الحساب لا من الشاشة`,
          doThis: "نفّذ الاسترداد على جهاز الدفع أو في تطبيق البنك أوّلاً، ثمّ أدخِل رقم عمليته هنا واعتمِد",
        }),
      });
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
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "تعذّر اعتماد ردّ عربون أمر الشغل",
          why: !approver
            ? "الاعتماد محصورٌ بحساب مالكٍ نشط، وحسابك لم يعد موجوداً في سجلّ المستخدمين"
            : !approver.isActive
              ? "الاعتماد محصورٌ بحساب مالكٍ نشط، وحسابك موقوف الآن"
              : "الاعتماد محصورٌ بحساب مالكٍ نشط، وحسابك بلا صفة المالك — وهذا الردّ يُخرج مالاً خارج النظام فيلزمه إقرارُ صاحبه",
          doThis: "اعرض الطلب على المالك ليعتمده من قائمة «طلبات ردّ العربون»؛ ولا تُسلّم العميل شيئاً قبل الاعتماد",
        }),
      });
    }
    const refund = (
      await tx.select().from(receipts).where(eq(receipts.id, receiptId)).for("update").limit(1)
    )[0];
    if (!refund || !refund.internalNote?.startsWith("WORK_ORDER_CUSTOMER_REFUND:")) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر اعتماد ردّ عربون أمر الشغل",
          why: `لا طلب ردّ عربونٍ بالإيصال رقم ${receiptId} — الإيصال غير موجود أو ليس من طلبات ردّ أوامر الشغل أصلاً`,
          doThis: "افتح قائمة «طلبات ردّ العربون» واختر الطلب منها بدل إدخال رقم الإيصال يدوياً",
        }),
      });
    }
    // ⭐ قرار المالك (٣/٩/٢٦): لا اعتماد ثانٍ بعد المالك — أُزيل شرط «غير صانع الطلب» (كما في
    // approveVoucher/authorizeExternalTreasuryDisbursement). البوّابة أعلاه (isOwner نشط) تبقى.
    if (refund.status === "COMPLETED" && refund.approvalStatus === "APPROVED") {
      if (refund.referenceNumber !== confirmedReference) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر اعتماد ردّ عربون أمر الشغل",
            why: `الطلب معتمَدٌ سلفاً بمرجع «${String(refund.referenceNumber ?? "")}» وأنت تُدخل «${confirmedReference}» — والمرجع المسجَّل لا يُبدَّل بعد الاعتماد وإلّا انفصل القيدُ عن مستنده`,
            doThis: "لا حاجة لاعتمادٍ ثانٍ — المال خرج سلفاً بالمرجع المسجَّل؛ وإن كان المرجع خاطئاً فأبلِغ مسؤول النظام برقم الإيصال ولا تُنشئ ردّاً جديداً",
          }),
        });
      }
      const entry = (
        await tx.select({ id: accountingEntries.id }).from(accountingEntries)
          .where(and(eq(accountingEntries.receiptId, receiptId), eq(accountingEntries.entryType, "PAYMENT_OUT")))
          .limit(1)
      )[0];
      if (!entry) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر اعتماد ردّ عربون أمر الشغل",
            why: `إيصال الردّ رقم ${receiptId} مسجَّلٌ معتمَداً ومنفَّذاً ولا قيد صرفٍ يقابله في الدفتر — مالٌ خرج بلا تبويب`,
            doThis: "أوقف الاعتماد وأبلِغ مسؤول النظام برقم الإيصال فوراً؛ لا تُنشئ ردّاً بديلاً فيُصرَف المبلغ مرّتين",
          }),
        });
      }
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
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر اعتماد ردّ عربون أمر الشغل",
          why: `هذا الإيصال ليس طلبَ ردٍّ غير نقديٍّ ينتظر الاعتماد (اتّجاهه «${refund.direction}» · حالته «${refund.status}» · اعتماده «${refund.approvalStatus}» · طريقته «${String(refund.paymentMethod ?? "")}») — والردّ النقديّ يخرج لحظة الإلغاء ولا يمرّ من هنا`,
          doThis: "افتح قائمة «طلبات ردّ العربون» واعتمِد منها المعلّقة وحدها؛ وإن كان الردّ نقدياً فقد سُلّم للعميل عند الإلغاء ولا اعتماد له",
        }),
      });
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
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر اعتماد ردّ عربون أمر الشغل",
          why: !wo
            ? `أمر الشغل رقم ${workOrderId} المرتبط بطلب الردّ لم يعد موجوداً`
            : `أمر الشغل ${wo.orderNumber} أو طرفُه لم يعد مطابقاً لطلب الردّ (حالته «${workOrderStatusLabel(wo.status)}» · فرعه ${Number(wo.branchId)} مقابل ${Number(refund.branchId)} · عميله ${Number(wo.customerId ?? 0)} مقابل ${Number(refund.partyId ?? 0)}) — واعتمادُ صرفٍ على مستندٍ تبدّل يُخرج مالاً لغير صاحبه`,
          doThis: "أوقف الاعتماد وافتح صفحة أمر الشغل لتعرف ما تغيّر؛ ثمّ أنشئ طلب ردٍّ جديداً على حالته الحالية إن كان المال ما زال مستحقاً للعميل",
        }),
      });
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
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر اعتماد ردّ عربون أمر الشغل",
          why: `بيانات الربط على إيصال الردّ لا تشير إلى هذا الأمر: نوعُ الردّ المسجَّل «${String(refundKind ?? "")}» وأمرُه ${noteWorkOrderId} بينما الإيصال على الأمر ${workOrderId}`,
          doThis: "أوقف الاعتماد وأبلِغ مسؤول النظام برقم الإيصال ورقم الأمر؛ لا يُعتمَد صرفٌ لا يُعرَف مصدره",
        }),
      });
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
            message: appErrorMessage({
              what: "تعذّر اعتماد ردّ عربون أمر الشغل",
              why: `الطلب قديمٌ ولا يحمل هويّة إيصال العربون، وعلى الأمر ${legacySources.length === 0 ? "لا إيصال قبضٍ مطابق" : "أكثر من إيصال قبضٍ مطابق"} — فلا يُعرَف أيّ مبلغٍ يُردّ`,
              doThis: "أوقف الاعتماد وافتح إيصالات الأمر لتحديد العربون الأصليّ؛ ثمّ أنشئ طلب ردٍّ جديداً من صفحة الأمر ليُختَم بإيصاله",
            }),
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
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر اعتماد ردّ حصّة عربون أمر الشغل",
            why: `حصّة القبض رقم ${collectionId} لا تُطابق طلب الردّ: إمّا أنّها ليست قبضاً، أو فرعُها أو عميلُها يخالف الإيصال، أو مبلغُ الردّ لا يساوي المسجَّل عليها، أو أنّها لم تُطبَّق على هذا الأمر`,
            doThis: "أوقف الاعتماد وراجع مقبوضات الأمر في سجلّه؛ ثمّ أنشئ طلب ردٍّ جديداً من الحصّة الصحيحة",
          }),
        });
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
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "تعذّر اعتماد ردّ عربون أمر الشغل",
          why: !source
            ? `إيصال العربون الأصليّ رقم ${sourceReceiptId} لم يعد موجوداً`
            : `إيصال العربون الأصليّ رقم ${sourceReceiptId} لم يعد قبضاً منفَّذاً معتمَداً مطابقاً (اتّجاهه «${source.direction}» · حالته «${source.status}» · اعتماده «${source.approvalStatus}» · مبلغه ${round2(money(source.amount)).toFixed(2)} د.ع مقابل ردٍّ ${round2(money(refund.amount)).toFixed(2)} د.ع)`,
          doThis: "أوقف الاعتماد وراجع إيصالات الأمر: لا يُردّ إلّا ما ثبت دخولُه وبقدره؛ وأبلِغ المدير إن كان الإيصال قد عُدّل أو أُلغي",
        }),
      });
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
        message: appErrorMessage({
          what: "تعذّر اعتماد ردّ عربون أمر الشغل",
          why: `المرجع «${confirmedReference}» مسجَّلٌ سلفاً على طلب ردٍّ آخر بالطريقة نفسها — وتكرارُه يربط عمليةَ استردادٍ واحدة بمستندَين فيبدو المال خارجاً مرّتين`,
          doThis: "أدخِل رقم عملية الاسترداد الخاصّ بهذا الطلب من قسيمة الجهاز؛ وإن لم تنفّذه بعد فنفّذه أوّلاً ثمّ اعتمِد",
        }),
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
          message: appErrorMessage({
            what: "تعذّر اعتماد ردّ عربون أمر الشغل",
            why: `المرجع «${confirmedReference}» حُجز للتوّ لطلب ردٍّ آخر بالطريقة نفسها — اعتمادان متزامنان تسابقا على المرجع ذاته`,
            doThis: "أدخِل رقم عملية الاسترداد الخاصّ بهذا الطلب من قسيمة الجهاز، أو راجع الطلب الآخر إن كان أحدهما مكرّراً",
          }),
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
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "تعذّر عرض طلبات ردّ عربون أوامر الشغل",
          why: "هذه القائمة تعرض مالاً ينتظر الصرف لعملاء، وعرضُها محصورٌ بحساب مالكٍ نشط — وحسابك ليس كذلك الآن",
          doThis: "اطلب من المالك فتح القائمة واعتماد ما فيها؛ وحالةُ ردّ أيّ أمرٍ بعينه تظهر لك في صفحة أمر الشغل نفسه",
        }),
      });
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
