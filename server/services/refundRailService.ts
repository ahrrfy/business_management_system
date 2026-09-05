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
 *  ④ **تجاوزُ إجابةٍ ادّعائية** ⇒ نوعُ مستندٍ مسجَّل في العقد بلا تمهيدٍ فعليّ ⇒ خطأٌ ترجميّ
 *     (`satisfies`) لا رجوعُ `null` صامتٍ يُقفل الحوار.
 *
 * ⭐ **وخامسةٌ (م٢ ذيل):** خريطةُ الروافد `rails` — ما يقبله فعلُ التنفيذ فعلاً لكلّ نوع، ولِمَ
 * لا — من الدالّة النقيّة المشتركة `refundRailAvailability` في `shared/refundRails.ts`؛ كان
 * التمهيدُ يُبطل الخزينةَ **صامتاً** لعكس التسليم وإرجاع الإرسالية (`treasuryCash = null`) فيبقى
 * الرافدُ رقاقةً معروضةً بلا فعلٍ يقبلها.
 *
 * ⚠️ **الخدمةُ لا تقرأ `ctx`.** تستقبل `Actor` صريحاً (§٥). الراوترُ وحده يترجم بصمةَ
 * المستخدم إلى `Actor`، فتبقى الخدمةُ قابلةً للاستعمال من أيّ قناة (أوفلاين، أندرويد،
 * استيراد جماعيّ) بلا تغيير.
 */
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, eq } from "drizzle-orm";
import { appErrorMessage } from "@shared/errors";
import { invoices, shifts, users } from "../../drizzle/schema";
import type { Tx } from "../db";
import type { Actor } from "./tx";
import { canCrossBranches } from "../lib/branchAuthority";
import { maySeeDrawerCash } from "@shared/workOrderControlAuthority";
import type { RefundDrawerCandidate, RefundPreflight } from "@shared/refundPreflight";
import { resolvePermissions, type AccessLevel, type PermissionMap, type RoleKey } from "@shared/permissions";
import {
  REFUND_SOURCE_DOC_LABEL,
  refundRailAvailability,
  type RefundRailContext,
  type RefundRailPreflightResult,
  type RefundSourceDocType,
} from "@shared/refundRails";
import { computeDrawerCashBalance, computeTreasuryCashBalance } from "./cash/cashAvailability";
import { money, round2, toDbMoney } from "./money";
import { loadRefundCaps } from "./returns/refundCaps";
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
  // مرتجعُ البيع يعيش تحت وحدة المبيعات (`returns.getInvoice` بوّابتُه `salesManagerProcedure`).
  SALE_RETURN: { module: "sales", level: "READ" },
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

/** الصرفُ من الخزينة بلا وردية مفتوحة — سلطةُ الإداريّ وحده (مرآةُ `shiftIdForCashTx`). */
function actorMayDrawFromTreasury(actor: RefundRailActor): boolean {
  return actor.role === "admin" || actor.role === "manager" || actor.isOwner === true;
}

export async function refundRailPreflight(
  tx: Tx,
  context: RefundRailContext,
  actor: RefundRailActor,
): Promise<RefundRailPreflightResult> {
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
  const rails = refundRailAvailability(context.sourceDocType, raw, actorMayDrawFromTreasury(actor));
  // رافدٌ لا يقبله فعلُ التنفيذ لا يُعرَض له رصيد: كان الإبطالُ الصامت لخزينة عكس التسليم
  // وإرجاع الإرسالية (Codex #960 P1) يترك الرقاقةَ معروضةً؛ الآن السببُ معلَنٌ في `rails`.
  const treasuryVisible = rails.TREASURY.available;
  return {
    ...raw,
    treasuryCash: treasuryVisible ? raw.treasuryCash : null,
    treasurySufficient: treasuryVisible ? raw.treasurySufficient : false,
    rails,
  };
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
  return handler(tx, ctx, exposeCash);
}

type Dispatcher = (tx: Tx, ctx: RefundRailContext, exposeCash: boolean) => Promise<RefundPreflight | null>;

const DISPATCHERS = {
  WORKORDER_CANCEL: (tx, ctx, exposeCash) =>
    workOrderRefundPreflight(tx, ctx.sourceDocId, "CANCEL", { exposeCash }),
  WORKORDER_REVERSE_DELIVERY: (tx, ctx, exposeCash) =>
    workOrderRefundPreflight(tx, ctx.sourceDocId, "REVERSE_DELIVERY", { exposeCash }),
  CONSIGNMENT_RETURN: (tx, ctx, exposeCash) =>
    consignmentReturnPreflight(tx, ctx.sourceDocId, { exposeCash }),
  SALE_RETURN: (tx, ctx, exposeCash) => saleReturnPreflight(tx, ctx, exposeCash),
} as const satisfies Record<RefundSourceDocType, Dispatcher>;

/**
 * **تمهيدُ مرتجع البيع** — بنفس المصدرَين اللذين يحكمان التنفيذ:
 *  · الوعاءُ وسقوفُ الطرق من `loadRefundCaps` (ما يقبله `returnSaleInTx` عند الحفظ حرفياً)؛
 *  · الأدراجُ **أيُّ وردية مفتوحة بالفرع** (نمط `resolveBranchCashShiftTx` الذي يقفله المرتجع)،
 *    والخزينةُ مخرجُ الإداريّ حين لا وردية (`shiftIdForCashTx`) — توفّرُها يقرّره `rails`.
 *
 * المبلغُ: ما أرسله الموظّف (`amount`) مقصوصاً بالوعاء، أو الوعاءُ كلُّه — الكفايةُ تُقاس به.
 * والبطاقةُ تُباح لعميلٍ مسجَّل حين يوجد سقفٌ لها؛ الزبونُ العابر نقدٌ فقط (عقد الخدمة).
 */
async function saleReturnPreflight(tx: Tx, ctx: RefundRailContext, exposeCash: boolean): Promise<RefundPreflight | null> {
  const inv = (
    await tx
      .select({ id: invoices.id, branchId: invoices.branchId, customerId: invoices.customerId })
      .from(invoices)
      .where(eq(invoices.id, ctx.sourceDocId))
      .limit(1)
  )[0];
  if (!inv) return null;
  const branchId = Number(inv.branchId);
  const caps = await loadRefundCaps(tx, ctx.sourceDocId);
  const requested = ctx.amount != null ? money(ctx.amount) : caps.pool;
  const cashOut = round2(Decimal.min(requested, caps.pool));
  const needsCashDrawer = cashOut.gt(0);
  const isWalkIn = inv.customerId == null;
  const cardCap = caps.capByMethod.get("CARD") ?? money(0);
  const drawers = needsCashDrawer ? await openDrawers(tx, branchId, cashOut, exposeCash) : [];
  const treasury = needsCashDrawer
    ? await computeTreasuryCashBalance(tx, branchId)
    : money(0);
  return {
    needsCashDrawer,
    estimatedCashOut: toDbMoney(cashOut),
    branchId,
    drawers,
    treasuryCash: needsCashDrawer && exposeCash ? toDbMoney(round2(treasury)) : null,
    treasurySufficient: needsCashDrawer ? treasury.gte(cashOut) : false,
    cardRefundAllowed: !isWalkIn && cardCap.gt(0),
  };
}

/** الأدراجُ المفتوحة بالفرع (أيُّ نوع) بنفس صيغة `assertCashOutAvailable` — الرقمُ لمن يملك الخزينة. */
async function openDrawers(tx: Tx, branchId: number, needed: Decimal, exposeCash: boolean): Promise<RefundDrawerCandidate[]> {
  const rows = await tx
    .select({
      shiftId: shifts.id,
      userId: shifts.userId,
      userName: users.name,
      shiftType: shifts.shiftType,
      openingBalance: shifts.openingBalance,
    })
    .from(shifts)
    .leftJoin(users, eq(users.id, shifts.userId))
    .where(and(eq(shifts.branchId, branchId), eq(shifts.status, "OPEN")));
  const out: RefundDrawerCandidate[] = [];
  for (const r of rows) {
    const available = await computeDrawerCashBalance(tx, Number(r.shiftId), r.openingBalance ?? "0");
    out.push({
      shiftId: Number(r.shiftId),
      userId: Number(r.userId),
      userName: String(r.userName ?? ""),
      shiftType: String(r.shiftType ?? ""),
      ...(exposeCash ? { expectedCash: toDbMoney(round2(available)) } : {}),
      sufficient: available.gte(needed),
    });
  }
  return out;
}
