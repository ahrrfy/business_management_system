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
import { appErrorMessage } from "@shared/errors";
import type { Tx } from "../db";
import type { Actor } from "./tx";
import { canCrossBranches } from "../lib/branchAuthority";
import { maySeeDrawerCash } from "@shared/workOrderControlAuthority";
import type { RefundPreflight } from "@shared/refundPreflight";
import { resolvePermissions, type AccessLevel, type PermissionMap, type RoleKey } from "@shared/permissions";
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
/**
 * Codex #960 P1: بوّابةُ الوحدة **لكلّ نوعِ مستند** — `treasury:READ` على الراوتر باعثةٌ
 * أدنى، لا تُغني عن سلطةِ الفعل نفسه. الاستفتاءُ يكشفُ رقمَ الردّ ورصيدَ الأدراج، فيتمكّن
 * موظّفٌ بلا `workorders:READ` من عدّ أوامر الشغل وقيمِ ردودها بمجرّد استعراضٍ للمعرّفات.
 * نمنعُ ذلك بحارسٍ سطحٍ ثانٍ يطابق البوّابة التي يستعملها الفعلُ الماديّ في راوتره.
 */
const REQUIRED_MODULE_PER_TYPE: Record<
  RefundSourceDocType,
  { module: string; level: AccessLevel }
> = {
  WORKORDER_CANCEL: { module: "workorders", level: "READ" },
  WORKORDER_REVERSE_DELIVERY: { module: "workorders", level: "READ" },
  CONSIGNMENT_RETURN: { module: "consignments", level: "READ" },
};

/** رتبةٌ رقميّة للمستوى تُقارَن بها البوّابات — نُبقيها هنا مغلقةً حتى لا يُغَيّرها مسارٌ آخر. */
const LEVEL_RANK: Record<AccessLevel, number> = { NONE: 0, READ: 1, FULL: 2 };

function assertActorHasModuleAccess(
  actor: RefundRailActor,
  moduleKey: string,
  minLevel: AccessLevel,
  sourceDocType: RefundSourceDocType,
): void {
  // مالكٌ/أدمن يعبُر — نفس نمطُ `requireModule` في `server/trpc.ts`.
  if (actor.isOwner || actor.role === "admin") return;
  const map = resolvePermissions(
    (actor.role as RoleKey) ?? "user",
    (actor.permissionsOverride ?? null) as PermissionMap | null,
  );
  const grantedLevel: AccessLevel = (map as unknown as Record<string, AccessLevel>)[moduleKey] ?? "NONE";
  if (LEVEL_RANK[grantedLevel] < LEVEL_RANK[minLevel]) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: `الاستفتاءُ عن ردّ ${REFUND_SOURCE_DOC_LABEL[sourceDocType]} يتطلّب سلطةً على وحدةٍ لا تملكها`,
        why: `مطلوبٌ صراحةً: ${moduleKey}:${minLevel} — وسلطتُك على هذه الوحدة اليوم: ${grantedLevel}`,
        doThis: "راجع المدير لمنحك السلطةَ اللازمة، أو افتح المستندَ من الحساب الذي يعتمده عادةً",
      }),
    });
  }
}

export async function refundRailPreflight(
  tx: Tx,
  context: RefundRailContext,
  actor: RefundRailActor,
): Promise<RefundPreflight> {
  // Codex #960 P1: تحقّق سلطةٍ لكلّ نوعِ مستند قبل أيّ قراءةٍ للقاعدة.
  const req = REQUIRED_MODULE_PER_TYPE[context.sourceDocType];
  assertActorHasModuleAccess(actor, req.module, req.level, context.sourceDocType);
  const exposeCash = maySeeDrawerCash(actor.role ?? "", (actor.permissionsOverride ?? null) as PermissionMap | null);
  const raw = await dispatch(tx, context, exposeCash);
  if (!raw) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: `${REFUND_SOURCE_DOC_LABEL[context.sourceDocType]}: المستند رقم ${context.sourceDocId} غير موجود`,
        why: "لعلّه حُذف أو أُلغي منذ فتحك الشاشة، أو المعرّف مكتوبٌ خطأً",
        doThis: "ارجع إلى قائمة المستندات وافتح المستند الصحيح ثمّ أعد المحاولة",
      }),
    });
  }
  if (!canCrossBranches(actor) && raw.branchId !== Number(actor.branchId)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: `${REFUND_SOURCE_DOC_LABEL[context.sourceDocType]} لا يخصّ فرعك`,
        why: "التحويلُ بين الفروع يتطلّب سلطةَ عبورٍ (admin/isOwner) — لا يجوز للكاشير كشفُ أدراج فرعٍ آخر",
        doThis: "راجع المدير لنقل المستند إلى فرعك، أو استعمل حساباً بسلطةٍ عابرة",
      }),
    });
  }
  // Codex #960 P1: الرافدُ «الخزينة» غيرُ مقبولٍ في الفعلَين الماديَّين لهذين النوعَين:
  // `reverseControl` يقبل خطّةَ ردٍّ لكلّ إيصال (بلا خزينة)، و`delivery.returnConsignment`
  // يقبل `refundShiftId` وحده. إعلانُ الخزينة كمتاحٍ للشاشة كان يقود إلى اختيارٍ لن يُنفَّذ
  // (أو ينفَّذ خطأً بدرجٍ افتراضيّ). نُبطلها بضبطها `null` — الشاشةُ لا تعرض التتة نتيجةً.
  const treasuryNotSupportedByOperation =
    context.sourceDocType === "WORKORDER_REVERSE_DELIVERY" ||
    context.sourceDocType === "CONSIGNMENT_RETURN";
  if (treasuryNotSupportedByOperation) {
    return { ...raw, treasuryCash: null, treasurySufficient: false };
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
