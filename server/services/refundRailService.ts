/**
 * **الخدمةُ الموحَّدة لروافد الردّ** — بوّابةٌ واحدة أمام تمهيدات الردّ المتخصّصة.
 *
 * الشاشةُ لا تعرف تفاصيلَ كل تمهيد (اسم الجدول، طريقةَ حساب النقد، أعمدةَ الإرسالية…) — تعرف
 * فقط أنّ عملية «رفض» جرت على مستندٍ بمعرّفٍ ونوع، فتسأل هذه الخدمة. الخدمةُ تُوزّع الاستفتاء
 * إلى التمهيد المتخصّص المعروف بذلك النوع، وتفرض قواعدَ العزل الأربعة:
 *
 *  ① **وجود المستند** ⇒ `NOT_FOUND` مقروء (بدل «فارغ» صامت).
 *  ② **عزلُ الفرع** ⇒ لا يُكشَف تمهيدُ فرعٍ آخر لمن لا يعبُر الفروع.
 *  ③ **حجبُ رصيد الخزينة/الأدراج** ⇒ عن مَن لا يملك `treasury:READ`.
 *  ④ **تجاوزُ إجابةٍ ادّعائية** ⇒ نوعُ مستندٍ مسجَّل في العقد بلا تمهيدٍ فعليّ ⇒ خطأٌ صريح
 *     يذكر النوعَ والشريحة المسؤولة عن إضافته (م٢ ق١٠ب) بدل رجوعِ `null` صامتٍ يُقفل الحوار.
 *
 * ⚠️ **الخدمةُ لا تقرأ `ctx`.** تستقبل `Actor` صريحاً (§٥). الراوترُ وحده يترجم بصمةَ
 * المستخدم إلى `Actor`، فتبقى الخدمةُ قابلةً للاستعمال من أيّ قناة (أوفلاين، أندرويد،
 * استيراد جماعيّ) بلا تغيير.
 */
import { TRPCError } from "@trpc/server";
import type { Tx } from "../db";
import type { Actor } from "./tx";
import { canCrossBranches } from "../lib/branchAuthority";
import { maySeeDrawerCash } from "@shared/workOrderControlAuthority";
import type { RefundPreflight } from "@shared/refundPreflight";
import type { PermissionMap } from "@shared/permissions";
import {
  REFUND_SOURCE_DOC_LABEL,
  type RefundRailContext,
  type RefundSourceDocType,
} from "@shared/refundRails";
import {
  consignmentReturnPreflight,
  workOrderRefundPreflight,
} from "./workOrder/refundPreflight";

/**
 * صيغةُ `Actor` الموسَّعة التي تحتاجها البوّابة — تُبقي علامة `PermissionMap` صريحةً كي لا
 * ينزلق أحدُ الاستدعاءات إلى تجاهلها فيتلقّى مستخدمٌ بلا `treasury:READ` سطحَ الخزينة.
 */
export type RefundRailActor = Actor & {
  permissionsOverride?: PermissionMap | null;
};

/**
 * **الاستفتاءُ الموحَّد** — يستعمله راوترُ `refundRails.preflight` وحده اليوم، وسيصير كذلك
 * منفذاً لأيّ مستهلكٍ داخليٍّ يحتاج نفس السلوك (استعادةُ حوارٍ من مسار الاعتماد مثلاً).
 */
export async function refundRailPreflight(
  tx: Tx,
  context: RefundRailContext,
  actor: RefundRailActor,
): Promise<RefundPreflight> {
  const exposeCash = maySeeDrawerCash(actor.role ?? "", (actor.permissionsOverride ?? null) as PermissionMap | null);
  const raw = await dispatch(tx, context, exposeCash);
  if (!raw) {
    // المستندُ غير موجود — رسالةٌ عربيةٌ بمصطلحه لا رقمُه العاري (§٥).
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `${REFUND_SOURCE_DOC_LABEL[context.sourceDocType]}: المستند رقم ${context.sourceDocId} غير موجود.`,
    });
  }
  // عزلُ الفرع بنفس سلطة التنفيذ (`canCrossBranches` = admin/isOwner) — التمهيدُ لا يكشف
  // أدراجَ فرعٍ لا يملك الفاعلُ التصرّفَ فيه.
  if (!canCrossBranches(actor) && raw.branchId !== Number(actor.branchId)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `${REFUND_SOURCE_DOC_LABEL[context.sourceDocType]} لا يخصّ فرعك — راجِع المدير للتحويل بين الفروع.`,
    });
  }
  return raw;
}

/**
 * التوزيعُ إلى التمهيد المتخصّص — الجدولُ الوحيد الذي يوسَّع عند إضافة نوعٍ لاحقاً.
 *
 * ⚠️ **الحارسُ التحريريّ:** `satisfies Record<…>` يجبر TypeScript على التذكير إن أُضيف نوعٌ
 * إلى `REFUND_SOURCE_DOC_TYPES` بلا تنفيذٍ هنا — فلا يمرّ نوعٌ ادّعائيّ إلى الإنتاج.
 */
async function dispatch(
  tx: Tx,
  ctx: RefundRailContext,
  exposeCash: boolean,
): Promise<RefundPreflight | null> {
  const handler = DISPATCHERS[ctx.sourceDocType];
  return handler(tx, ctx.sourceDocId, exposeCash);
}

type Dispatcher = (tx: Tx, id: number, exposeCash: boolean) => Promise<RefundPreflight | null>;

const DISPATCHERS = {
  WORKORDER_CANCEL: (tx, id, exposeCash) =>
    workOrderRefundPreflight(tx, id, "CANCEL", { exposeCash }),
  WORKORDER_REVERSE_DELIVERY: (tx, id, exposeCash) =>
    workOrderRefundPreflight(tx, id, "REVERSE_DELIVERY", { exposeCash }),
  CONSIGNMENT_RETURN: (tx, id, exposeCash) =>
    consignmentReturnPreflight(tx, id, { exposeCash }),
} as const satisfies Record<RefundSourceDocType, Dispatcher>;
