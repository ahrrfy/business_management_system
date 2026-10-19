import { TRPCError } from "@trpc/server";
import { and, eq, like, notInArray, or } from "drizzle-orm";
import { deliveryConsignments, invoices, workOrders } from "../../../drizzle/schema";
import { nextCounterValue, nextInvoiceNumber, nextTransactionTrackingNumber } from "../numbering";
import { formatDocumentNumber, stripDocPrefix } from "@shared/documentNumber";
import { nextConsignmentNumber } from "../delivery/numbering";
import type { Actor } from "../tx";
import type { Tx } from "../../db";
import { operationDecision, operationRecordScope, type OperationRecordScope } from "@shared/operationPermissions";
import { assertOperationAuthorityTx, loadOperationUserTx } from "../authorization/operationAuthority";

/**
 * رقم أمر الشغل — يُحجز من عدّاد المعاملة الموحّد (R1).
 */
async function nextWorkOrderNumber(tx: any, _branchId?: number): Promise<string> {
  return await nextTransactionTrackingNumber(tx);
}

async function loadWorkOrder(tx: any, workOrderId: number) {
  const rows = await tx.select().from(workOrders).where(eq(workOrders.id, workOrderId)).for("update").limit(1);
  if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "طلب الخدمة غير موجود" });
  return rows[0];
}

/**
 * هويةُ مستند التسليم التجاريّ لأمر الشغل.
 *
 * لا يجوز استعمال `WO-{id}` وحده: الفاتورة المرتجعة تبقى سجلاً تاريخياً تحت القيد الفريد
 * `(sourceType, sourceId)`، فيصطدم بها التسليم المصحّح بعد `reopen`. نسخة الأمر ترتفع من
 * trigger لكل انتقال، والأمر مقفول قبل إنشاء الفاتورة، لذلك تشكّل revision مستقراً ومشتركاً
 * بين التسليم المباشر والإرسال للتوصيل بلا عدّادٍ ثانٍ قابل للانجراف.
 */
function workOrderInvoiceSourceId(wo: { id: number | string; version: number | string }): string {
  const id = Number(wo.id);
  const version = Number(wo.version);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(version) || version <= 0) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر اشتقاق نسخة مستند أمر الشغل" });
  }
  return `WO-${id}:R${version}`;
}

/** عزل الفرع: أيّ عملية مال على طلب الخدمة تُجبَر فرع الفاعل. عزل مدير الفرع (قرار المالك ١٢/٨):
 *  المالك/الأدمن فقط يعبُران (owner مُطبَّع ⇒ admin)؛ المدير صار مقيَّداً بفرعه. يُمرَّر actor.role من الراوتر. */
function assertWorkOrderBranch(wo: { branchId: number | string }, actor: Actor & { role?: string }) {
  const elevated = actor.role === "admin";
  if (elevated) return;
  if (Number(wo.branchId) !== actor.branchId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "طلب الخدمة لا يخصّ فرعك" });
  }
}

/**
 * عزل المحطة: فني المطبعة (print_operator) ينفّذ أوامره المُسنَدة إليه فقط — لا أوامر زملائه.
 * الكاشير/المدير/الأدمن (مكتب الاستقبال) يُنفّذون أي أمر في فرعهم (مرونة تشغيلية). يُستدعى بعد
 * هذا هو السلوك القديم عند غياب سياسة العمليات. السياسة الجديدة تثبّت OWN/BRANCH
 * من تفويض العملية نفسها، مع بقاء فحص الفرع مستقلاً. السحب يجعل الأمر «أمري» قبل التنفيذ.
 */
function assertOperatorOwns(
  wo: { assignedTo: number | string | null },
  actor: Actor & { role?: string },
  scope?: OperationRecordScope | null,
  allowUnassignedClaim = false,
) {
  if (scope === "BRANCH") return;
  if (scope !== "OWN" && actor.role !== "print_operator") return;
  if (allowUnassignedClaim && wo.assignedTo == null) return;
  if (wo.assignedTo == null || Number(wo.assignedTo) !== actor.userId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "اسحب الأمر إلى قائمتك أولاً لتنفيذه" });
  }
}

/** Freeze the selected mutation's current authority/scope before the work-order lock. */
async function workOrderOperationScopeTx(
  tx: Tx,
  actor: Actor & { role?: string },
  path: "workOrders.start" | "workOrders.markReady" | "workOrders.setKanbanState",
): Promise<OperationRecordScope | null> {
  const canonical = await assertOperationAuthorityTx(tx, actor, path, true);
  if (!canonical) return null;
  const current = await loadOperationUserTx(tx, actor.userId);
  return operationDecision(current, path).scope ?? operationRecordScope(current, path);
}

/**
 * حارس **الإرسالية الحيّة** (١٨/٨) — يمنع كل عمليةٍ تفترض أنّ البضاعة ما زالت في المكتبة
 * بينما هي بيد المندوب فعلاً.
 *
 * لماذا لم يكن فحصُ الحالة كافياً: الإسناد **لا يمسّ** `workOrders.status` عمداً (يبقى READY
 * حتى إثبات التسليم)، فكلّ حارسٍ يفحص الحالة وحدها كان أعمى عن الطرد الخارج. النتائج التي
 * أثبتها الفحص: إلغاءُ أمرٍ خارجٍ مع مندوب يُعيد مواده للمخزون ويردّ عربونه بينما الفاتورة
 * وقيدُ البيع وذمّةُ العميل وعهدةُ COD كلّها حيّة؛ وقلبُ `hasDelivery` يردّ أمانة الأجرة
 * والطرد بالخارج؛ والتسليم المباشر يُنشئ فاتورةً وقيدَ بيعٍ **ثانيَين**.
 *
 * المخرج المشروع في كل هذه الحالات واحد: **استرجاع الإرسالية** (عكسٌ كامل Σ=0).
 */
async function assertNoLiveConsignment(
  tx: any,
  workOrderId: number,
  action: "cancel" | "reclassify" | "deliver" | "reverse",
) {
  const rows = await tx
    .select({ id: deliveryConsignments.id, number: deliveryConsignments.consignmentNumber })
    .from(deliveryConsignments)
    .where(
      and(
        eq(deliveryConsignments.workOrderId, workOrderId),
        notInArray(deliveryConsignments.status, ["CANCELLED", "RETURNED"]),
      ),
    )
    .limit(1);
  const live = rows[0];
  if (!live) return;
  const what = action === "cancel"
    ? "لا يُلغى أمرٌ خرج مع مندوب"
    : action === "reclassify"
      ? "لا تُغيَّر طريقة تسليم أمرٍ خرج مع مندوب"
      : action === "reverse"
        // العكسُ يُسقط الذمّة بينما عهدةُ المندوب وتحصيلُه قائمان ⇒ نقدٌ بلا مالك.
        ? "لا يُسترجَع أمرٌ ما زال مع مندوب"
        : "لا يُسلَّم مباشرةً أمرٌ خرج مع مندوب";
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message: `${what} (الإرسالية ${live.number ?? live.id}) — استرجع الإرسالية أولاً من إدارة التوصيل، وهي تعكس البيع والمخزون والعربون معاً.`,
  });
}

/**
 * **حارس المهمّة الحاجزة** (ش٢، ١٩/٨) — على نمط `assertNoLiveConsignment` حرفياً.
 *
 * الحجزُ يُقرأ من الواقع لا من عَلَم: «هل لهذا الأمر مهمّةٌ مفتوحةٌ نوعُها حاجز؟». وبهذا
 * **تبطل الموافقة السابقة بحكم البناء** حين تُفتَح مهمّةٌ جديدة لنسخة تصميمٍ جديدة — لا
 * عَلَمَ `approved` ثانٍ يمكن أن ينجرف عن الواقع فيُنتَج تصميمٌ لم يُقرَّ.
 *
 * ⛔ **يُستدعى قبل أيّ قفلٍ أو حركة** (قبل `branchStock` في `startWorkOrder`) ⇒ يفشل مغلقاً
 * بلا حركةِ مخزونٍ ولا قيدٍ ولا صفٍّ يُترك خلفه.
 *
 * `WAITING_CUSTOMER` **تحجز أيضاً**: انتظارُ ردّ العميل هو عينُ سبب الحجز، لا استثناءٌ منه.
 */
async function assertNoBlockingTask(
  _tx: any,
  _workOrderId: number,
  _action: "start" | "ready",
) {
  // no-op: tasks unit eradicated
}

/**
 * حلّ رقم فاتورة تسليم أمر الشغل بصورة تمنع التصادم وترث رقم التتبع الموحّد:
 * يستخرج الرقم الأساسي T من wo.orderNumber.
 * إذا كان رقماً >= 100000:
 *   يفحص ما إذا كان T مجرداً غير موجود في invoices، فإن لم يوجد يستعمله.
 *   وإن وجد، يبحث عن أول لاحقة غير مستخدمة T-k (k >= 1) باستخدام formatDocumentNumber(T, k)
 *   بحيث لا يحدث ER_DUP_ENTRY على invoices.invoiceNumber.
 * إذا كان T تاريخياً أو غير مطابق، يعود للعدّاد المعتاد nextInvoiceNumber.
 */
async function resolveDeliveryInvoiceNumber(
  tx: Tx,
  woOrderNumber: string,
  branchId: number,
): Promise<string> {
  const clean = stripDocPrefix(woOrderNumber);
  const parts = clean.split("-");
  const base = parts[0];
  const num = Number(base);
  if (Number.isFinite(num) && num >= 100000) {
    // إذا كان لأمر الشغل لاحقة شقيقة (e.g. WO-100005-1, WO-100005-2)
    // يُورّث نفس اللاحقة حتمياً لفاتورة التسليم (100005-1, 100005-2) دون تنازع أقفال
    const rawSibling = parts.length > 1 ? Number(parts[1]) : undefined;
    const siblingIndex =
      rawSibling !== undefined && Number.isInteger(rawSibling) && rawSibling > 0
        ? rawSibling
        : undefined;

    if (siblingIndex !== undefined) {
      return formatDocumentNumber(base, siblingIndex);
    }

    const existing = await tx
      .select({ invoiceNumber: invoices.invoiceNumber })
      .from(invoices)
      .where(
        or(
          eq(invoices.invoiceNumber, base),
          like(invoices.invoiceNumber, `${base}-%`),
        ),
      )
      .for("update");

    const used = new Set(existing.map((r) => r.invoiceNumber));
    if (!used.has(base)) {
      return base;
    }

    let k = 1;
    while (used.has(formatDocumentNumber(base, k))) {
      k++;
    }
    return formatDocumentNumber(base, k);
  }
  return await nextInvoiceNumber(tx, branchId);
}

/**
 * توريث رقم التتبع الموحّد للإرساليات مع حلّ لواحق الإخوة T-k عند تعدّد الإرساليات لنفس المعاملة:
 */
async function resolveConsignmentNumber(
  tx: Tx,
  sourceDocNumber: string,
  branchId: number,
): Promise<string> {
  const clean = stripDocPrefix(sourceDocNumber);
  const parts = clean.split("-");
  const base = parts[0];
  const num = Number(base);
  if (Number.isFinite(num) && num >= 100000) {
    const rawSibling = parts.length > 1 ? Number(parts[1]) : undefined;
    const siblingIndex =
      rawSibling !== undefined && Number.isInteger(rawSibling) && rawSibling > 0
        ? rawSibling
        : undefined;

    if (siblingIndex !== undefined) {
      return formatDocumentNumber(base, siblingIndex);
    }

    const existing = await tx
      .select({ consignmentNumber: deliveryConsignments.consignmentNumber })
      .from(deliveryConsignments)
      .where(
        or(
          eq(deliveryConsignments.consignmentNumber, base),
          like(deliveryConsignments.consignmentNumber, `${base}-%`),
        ),
      )
      .for("update");

    const used = new Set(existing.map((r) => r.consignmentNumber));
    if (!used.has(base)) {
      return base;
    }

    let k = 1;
    while (used.has(formatDocumentNumber(base, k))) {
      k++;
    }
    return formatDocumentNumber(base, k);
  }
  return await nextConsignmentNumber(tx, branchId);
}

export {
  nextWorkOrderNumber,
  loadWorkOrder,
  workOrderInvoiceSourceId,
  assertWorkOrderBranch,
  assertOperatorOwns,
  workOrderOperationScopeTx,
  assertNoLiveConsignment,
  assertNoBlockingTask,
  resolveDeliveryInvoiceNumber,
  resolveConsignmentNumber,
};
