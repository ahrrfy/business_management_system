/**
 * shared/sessionContext.ts — العقدُ المشترك لسياق الجلسة: ما **يشتقّه الخادم** ويعرضه العميل.
 *
 * ── المشكلة المقيسة (قياسُ ٢/٩/٢٦ — رقمٌ يشيخ، أعِد قياسه قبل الاستشهاد به) ────
 * ٢٣٨ عقدَ راوترٍ يطلب `branchId` من العميل بينما الخادم يعرفه أصلاً من `ctx.user.branchId`
 * ويحقن `scopedBranchId` بنفسه. والحقلُ الذي لا معنى له إلّا أن يُرفَض هو حقلٌ يُغري الشاشةَ
 * باختراع قيمة: `useState<number>(1)` في نموذج السند هو الرقم ١ مكتوباً بيد.
 *
 * ── القاعدة الحاكمة (لماذا هذا الملفّ بلا قيمةٍ افتراضية واحدة) ───────────────
 * حارس `check:branch` يمنع `?? 1` لأنّ **الفرع الافتراضيّ الصامت باب IDOR تاريخيّ**: مستخدمٌ
 * بلا فرعٍ مُسنَد كان يكتب صامتاً على الفرع رقم ١. فالعلاجُ ليس «افتراضاً أذكى» بل **استحالةُ
 * الاشتقاق من جهة العميل**:
 *   ١) لا حقلَ في `SessionContext` له قيمةٌ افتراضية، ولا مُعامِلَ دالّةٍ افتراضيّ.
 *   ٢) لا دالّةَ هنا تُرجع فرعاً (أو يوماً تشغيلياً) من لا شيء — الفرعُ يدخل هذا الملفّ من
 *      حمولةٍ خادميّة أو لا يدخل. `composeSessionContext` تُلزم مصدراً صريحاً، و`readSessionContext`
 *      **تفشل مغلقةً** (تُرجع `null`) على أيّ حمولةٍ ناقصة أو متناقضة.
 *   ٣) `requireSessionBranchId` **ترمي** حين لا فرعَ نشط — ولا نظيرَ لها يُرجع بديلاً.
 *      «لا فرعَ نشط» حالةٌ مشروعة (أدمنٌ بلا فرعٍ مُسنَد) يجب أن تنتهي بـ«اختر فرعاً من
 *      قائمةٍ خادميّة»، لا بالفرع ١.
 * ⇒ العميل **يعرض** ما ردّه الخادم فقط. والإنفاذُ النهائيّ يبقى خادمياً دائماً (§٢): هذا
 *   الملفّ يمنع الاختراع ويُظهر التعارض مبكراً، ولا يُغني عن بوّابة الراوتر ولا يحلّ محلّها.
 *
 * ── ما يحمله السياق: الجلسيُّ حقاً وحده ───────────────────────────────────────
 * الحقلُ يدخل هنا إن كان **دالّةً في الجلسة نفسها** (الفاعل وفرعه ويومه وسلطته)، لا في
 * العملية. ⛔ **الوردية ووعاء النقد ليسا منه** — انظر «لماذا لا رايلَ نقدٍ هنا» أدناه؛ عقدٌ
 * أصغرُ صحيحٌ خيرٌ من أوسعَ يكذب، والحارسُ الذي يُنذر كذباً يُتجاوَز فيصير مسرحياً.
 *
 * ── مصادرُ الاشتقاق (بنيةٌ قائمة ومُتحقَّقٌ منها — مُقتبَسةٌ لا مُعادةُ اختراع) ──
 *   • الفرع والرؤية: `branchScopedProcedure` (server/trpc.ts:443-455) — `scopedBranchId` (عزل
 *     الفرع) و`scopedOwnerId` (عزل سجلّات الموظف)، وسلطةُ العبور من `canCrossBranches`
 *     (server/lib/branchAuthority.ts).
 *   • الفاعل: `Actor { userId, branchId, role?, isOwner? }` (server/services/tx.ts:126).
 *   • اليوم التشغيليّ: `baghdadToday()` في **`server/services/businessDay.ts`** (لا `server/lib/`).
 *   • طرق القبض: `INBOUND_ENABLED_PAYMENT_METHODS` (shared/inboundPaymentPolicy.ts) — المصدر
 *     الحاكم الوحيد؛ ⛔ لا تُقفل طريقةً بنصٍّ ثابتٍ في شاشة (درس #596).
 *   • الفئة السعرية: نفس الفئات الثلاث في `shared/offlineCatalog.ts` (نوعٌ مُعاد تصديره لا مكرَّر).
 *
 * ── ⛔ لماذا لا رايلَ نقدٍ (وردية + وعاء) هنا — ثلاثةُ أسبابٍ كلٌّ منها قاتلٌ وحده ──
 * حملت نسخةٌ سابقة من هذا الملفّ حقلَ `cashRail` مُدّعيةً أنّه يقتبس `shiftIdForCashTx`
 * (server/services/shiftService.ts:1265-1290). قراءةُ الدالّة أسقطت الادّعاء:
 *   ١) **الرايل ليس خاصّيةَ جلسة**: `openShiftIdTx` تحلّ لكلّ `(userId, branchId, preferredType)`،
 *      وتعليقُها نفسه يقول إنّ الموظّف قد يملك **ورديتَين مفتوحتَين** (تجزئة + استقبال) يختار
 *      بينهما بـ`preferredType` **لكلّ عملية**. فقيمةٌ واحدةٌ للجلسة إمّا أن تكذب على إحداهما،
 *      أو يُنذر حارسُها كذباً على وردية استقبالٍ مشروعة.
 *   ٢) **`shiftType` لم يكن مُرجَعاً أصلاً**: الدالّة تُرجع `{ shiftId, cashBucket }` فقط،
 *      و`preferredType` معاملُ **دخل** يختاره موقعُ النداء لا خرجٌ للجلسة.
 *   ٣) **الفرعُ الثالث رميٌ لا قيمة**: غيرُ الإداريّ بلا وردية يمرّ بـ`requireOpenShiftIdTx`
 *      فيرمي `PRECONDITION_FAILED`. فـ«لا مسارَ نقدٍ الآن» لم تكن قيمةً يُرجعها الخادم قطّ،
 *      وتمثيلُها هنا يجعل الشاشة تتفرّع على حالةٍ لا تصلها.
 * ⇒ الوردية والوعاء يُحلّان **لكلّ عملية** في الخادم، ورسالةُ «افتح وردية» تأتي من رمي
 *   `requireOpenShiftIdTx` نفسه — وهي أدقّ من أيّ لافتةٍ جلسيّة، لأنّها تعرف نوعَ الوردية
 *   الذي تحتاجه تلك العملية بعينها.
 */

import {
  INBOUND_ENABLED_PAYMENT_METHODS,
  type InboundEnabledPaymentMethod,
} from "./inboundPaymentPolicy";
import type { OfflinePriceTier } from "./offlineCatalog";

// ─── الأنواع ────────────────────────────────────────────────────────────────

/** الفئات الثلاث نفسها (RETAIL/WHOLESALE/GOVERNMENT) — مُعادةُ تصديرٍ لا نسخةٌ ثانية تنجرف. */
export type SessionPriceTier = OfflinePriceTier;

/** طرق القبض المسموحة قبضاً — تُشتقّ من سياسة القبض العامّة، ولا تُعرَّف هنا. */
export type SessionPaymentMethod = InboundEnabledPaymentMethod;

/** الفرع النشط — يأتي من الخادم كاملاً (المعرّف والاسم معاً) أو لا يأتي. */
export interface SessionBranch {
  id: number;
  name: string;
}

/**
 * الفاعل — بصمةُ `Actor` (server/services/tx.ts) بفارقَين مقصودَين:
 *  • بلا `branchId`: مكانُه `branch` أدناه (المعرّف والاسم معاً، أو `null` صريحة).
 *  • `role` و`isOwner` **إلزاميّان** هنا وهما اختياريّان هناك — لأنّ هذا الملفّ **يتحقّق**
 *    بهما من `canCrossBranches`، وسياقٌ يجهل دورَ صاحبه لا يستطيع التحقّق من سلطته.
 */
export interface SessionActor {
  userId: number;
  role: string;
  isOwner: boolean;
}

/**
 * نطاقُ الرؤية — مرآةُ ما يحقنه `branchScopedProcedure` حرفياً بنفس الاسمين:
 *  • `scopedBranchId`: `null` = كلّ الفروع (عابرُ الفروع)، وإلّا فرعُ المستخدم (عزل الفرع).
 *  • `scopedOwnerId`: `null` = كلّ سجلّات النطاق (مشرف)، وإلّا معرّفُ المستخدم (يرى ما أنشأه).
 * تُنقَل للعميل كي يشرح للموظّف **لماذا** لا يرى صفّاً، بدل قائمةٍ فارغةٍ صامتة.
 */
export interface SessionScope {
  scopedBranchId: number | null;
  scopedOwnerId: number | null;
}

/**
 * منطقةُ اليوم التشغيليّ — للعرض والتوثيق. اليومُ نفسه يشتقّه الخادم بـ`baghdadToday()`
 * (إزاحةٌ ثابتة +03:00؛ العراق بلا توقيت صيفيّ منذ ٢٠١٥ فالإزاحةُ الثابتة والمنطقةُ متطابقتان).
 */
export const SESSION_BUSINESS_DAY_TIMEZONE = "Asia/Baghdad";

/**
 * سياقُ الجلسة كما اشتقّه الخادم. كلّ حقلٍ **إلزاميّ**: حقلٌ اختياريّ يعني «قد يغيب فيُخترع».
 */
export interface SessionContext {
  actor: SessionActor;
  /**
   * الفرع النشط، أو `null` = **لا فرعَ نشط** (أدمن/مالك بلا فرعٍ مُسنَد). ⛔ `null` ليست دعوةً
   * لافتراض فرع: استعمل `requireSessionBranchId` (ترمي) ثمّ اطلب من المستخدم اختياراً صريحاً
   * من قائمةِ فروعٍ خادميّة.
   */
  branch: SessionBranch | null;
  /**
   * اليومُ التشغيليّ `YYYY-MM-DD` بتوقيت بغداد (+03:00) كما حسبه الخادم — اليومُ الذي يعيشه
   * الموظّف خلف الكاونتر (نظيرُ `baghdadToday()` الخادميّة).
   * ⚠️ **ليس حدَّ استعلام**: فلترةُ أعمدة الطوابع تبقى بحدود `server/services/businessDay.ts`
   *   (`utcDayRange`/UTC). خلطُهما يزيح النتائج ثلاث ساعاتٍ قرب منتصف الليل.
   * ⚠️ ولا تُشتقّ من ساعة الجهاز: ساعةُ جهازٍ منحرفة تُنتج يوماً كاذباً على مستنداتٍ ماليّة.
   */
  businessDay: string;
  /** طرق القبض المسموحة في هذه الجلسة — مشتقّةٌ من سياسة القبض، تُعرَض ولا تُعاد اشتقاقاً. */
  allowedPaymentMethods: readonly SessionPaymentMethod[];
  /**
   * الفئة السعرية **الافتراضية** للجلسة (بيعُ العابر). ليست قيداً: عميلٌ جملةٍ يرفع الفئة
   * بقرارٍ صريح ⇒ لذلك هي **خارج فحص التعارض** عمداً (انظر `findSessionContextConflicts`).
   */
  defaultPriceTier: SessionPriceTier;
  /**
   * هل يعبُر هذا الفاعل الفروع؟ — القاعدة `role === "admin" || isOwner === true`
   * (server/lib/branchAuthority.ts). ليست ادّعاءً حرّاً: `readSessionContext` ترفض حمولةً
   * تخالف بها فاعلَها، و`composeSessionContext` **تشتقّها** ولا تقبلها مُدخَلاً — لأنّها
   * مفتاحُ إطفاءٍ لفحص الفرع أدناه، ومفتاحُ إطفاءٍ غيرُ متحقَّقٍ منه = لا فحص. والإنفاذُ
   * النهائيّ يبقى خادمياً.
   */
  canCrossBranches: boolean;
  /** نطاقُ الرؤية المحقون في الراوتر — للشرح لا للإنفاذ. */
  scope: SessionScope;
  /**
   * لحظةُ الاشتقاق، بصيغة ISO-8601 كاملة (`YYYY-MM-DDTHH:mm:ss[.sss](Z|±HH:MM)`) — تُتحقَّق
   * صيغتُها في `readSessionContext` لأنّ نصّاً غيرَ صالح يُنتج `Invalid Date` عند القارئ
   * فلا يشتعل كشفُ التقادم **أبداً وبصمت**.
   * تُستعمَل لكشف سياقٍ متقادم: اليومُ التشغيليّ يتدحرج عند منتصف ليل بغداد، وسلطةُ الفرع
   * أو طرقُ القبض قد تتغيّر تحت تبويبٍ مفتوحٍ منذ ساعات.
   */
  derivedAt: string;
}

// ─── التعارض: ما يُرسله العميل مقابل ما اشتقّه الخادم ────────────────────────

/**
 * ادّعاءُ العميل: **كلّ حقلٍ اختياريّ**، و`undefined` = «لم تدّعِ الشاشةُ شيئاً» = لا تعارض.
 * هذا مقصود: الهدفُ أن تختفي هذه الحقول من العقود واحداً واحداً بلا كسر ما لم يُهاجَر بعد.
 * ⚠️ و`undefined` **لا تُملأ بقيمةٍ مشتقّة هنا**: دالّةٌ «تُكمِل» الناقص تُعيد اختراع `?? 1`
 * من بابٍ آخر. الإكمالُ قرارُ الخادم وحده.
 * ⛔ ولا `shiftId` ولا `cashBucket` فيه: لا مُشتَقَّ جلسيّاً يُقارَنان به (انظر الرأس).
 */
export interface SessionContextClaim {
  userId?: number;
  branchId?: number;
  businessDay?: string;
  paymentMethod?: string;
}

export type SessionContextClaimField = keyof SessionContextClaim;

/** تسمياتٌ عربيّة للحقول — تظهر في رسالة التعارض التي يقرأها الموظّف. */
export const SESSION_CLAIM_LABEL_AR: Readonly<
  Record<SessionContextClaimField, string>
> = Object.freeze({
  userId: "المستخدم",
  branchId: "الفرع",
  businessDay: "اليوم التشغيليّ",
  paymentMethod: "طريقة الدفع",
});

export interface SessionContextConflict {
  field: SessionContextClaimField;
  label: string;
  /** القيمة كما أرسلتها الشاشة (نصّاً للعرض — أرقامٌ لاتينية). */
  sent: string;
  /** القيمة كما اشتقّها الخادم (نصّاً للعرض). */
  derived: string;
  /** سببٌ عربيٌّ مختصر يشرح لماذا هذا تعارض. */
  reason: string;
}

/** عرضُ قيمةٍ في الرسالة: أرقامٌ لاتينية دائماً، و«بلا»/«لم يُرسَل» بدل `null`/`undefined` الخام. */
function show(value: unknown): string {
  if (value === undefined) return "لم يُرسَل";
  if (value === null) return "بلا";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.length ? value.join("، ") : "بلا";
  return String(value);
}

/**
 * يُقارن ادّعاءَ العميل بالمُشتَقّ الخادميّ ويُرجع كلّ التعارضات (دالّةٌ نقيّة، لا ترمي).
 *
 * قواعدُ القرار — ولكلٍّ سببُها، فحارسٌ يُنذر كذباً يُتجاوَز فيصير مسرحياً:
 *  • **الفرع**: تعارضٌ فقط لغير عابر الفروع — مرآةُ `branchScopedProcedure` التي تعود مبكراً
 *    على `canCrossBranches`. الأدمن/المالك يختار فرعاً آخر بقصدٍ مشروع، ورفضُه هنا يكسر
 *    تدفّقاتٍ قائمة. و«فرعٌ مُرسَلٌ بلا فرعٍ نشط» تعارضٌ أيضاً — تلك هي لحظةُ الاختراع.
 *  • **اليوم التشغيليّ**: لا يُتجاوَز أبداً — تاريخُ المستند قرارٌ خادميّ.
 *  • **طريقة الدفع**: عضويّةٌ في `allowedPaymentMethods` لا مساواة.
 *  • **المستخدم**: يجب أن يطابق الفاعلَ دائماً — النسبةُ لغيره حقلٌ آخر بقرارٍ صريح
 *    (`attributeToUserId`) لا ادّعاءُ هويّة.
 *  • **الفئة السعرية**: ⛔ **ليست هنا** — الافتراضُ يُرفَع لعميل الجملة بقرارٍ مشروع.
 *  • **الوردية ووعاء النقد**: ⛔ **ليسا هنا** — يُحلّان لكلّ عملية بـ`shiftIdForCashTx`،
 *    والموظّفُ ذو ورديتَين مفتوحتَين كان حارسُهما يُنذر كذباً على وردية الاستقبال (انظر الرأس).
 */
export function findSessionContextConflicts(
  sent: SessionContextClaim,
  derived: SessionContext,
): SessionContextConflict[] {
  const conflicts: SessionContextConflict[] = [];
  const add = (
    field: SessionContextClaimField,
    sentValue: unknown,
    derivedValue: unknown,
    reason: string,
  ) =>
    conflicts.push({
      field,
      label: SESSION_CLAIM_LABEL_AR[field],
      sent: show(sentValue),
      derived: show(derivedValue),
      reason,
    });

  if (
    sent.userId !== undefined &&
    Number(sent.userId) !== derived.actor.userId
  ) {
    add(
      "userId",
      sent.userId,
      derived.actor.userId,
      "لا تُنسَب العملية لمستخدمٍ آخر",
    );
  }

  if (sent.branchId !== undefined && !derived.canCrossBranches) {
    if (derived.branch === null) {
      // دفاعٌ في العمق: `readSessionContext` و`composeSessionContext` ترفضان «غيرُ عابرٍ بلا فرع»
      // أصلاً (كما يرفضها الراوتر بـFORBIDDEN)، فلا يبلغ هذا السطرُ سياقاً مرّ بهما. يبقى
      // للسياق المبنيّ يدوياً في موقع نداءٍ ما — وإسقاطُه يجعل الفحص يمرّ صامتاً هناك.
      add(
        "branchId",
        sent.branchId,
        null,
        "لا فرعَ نشطٌ في الجلسة — اختر فرعاً صراحةً",
      );
    } else if (Number(sent.branchId) !== derived.branch.id) {
      add(
        "branchId",
        sent.branchId,
        derived.branch.id,
        "لا يمكن العمل على بيانات فرعٍ آخر",
      );
    }
  }

  if (
    sent.businessDay !== undefined &&
    sent.businessDay !== derived.businessDay
  ) {
    add(
      "businessDay",
      sent.businessDay,
      derived.businessDay,
      "تاريخ المستند يشتقّه الخادم",
    );
  }

  if (
    sent.paymentMethod !== undefined &&
    !isSessionPaymentMethodAllowed(derived, sent.paymentMethod)
  ) {
    add(
      "paymentMethod",
      sent.paymentMethod,
      derived.allowedPaymentMethods,
      "طريقة الدفع خارج الطرق المسموحة في هذه الجلسة",
    );
  }

  return conflicts;
}

/** رمزُ الخطأ — يُطابقه الراوتر ليردّ `CONFLICT` بدل ابتلاعه بـ`INTERNAL_SERVER_ERROR`. */
export const SESSION_CONTEXT_CONFLICT_CODE = "SESSION_CONTEXT_CONFLICT";

/**
 * خطأُ التعارض. صنفُ `Error` عاديّ عمداً: هذا الملفّ مشتركٌ مع العميل، واستيرادُ
 * `TRPCError` هنا يجرّ `@trpc/server` إلى حزمة المتصفّح. الخادمُ يلتقطه ويترجمه.
 */
export class SessionContextConflictError extends Error {
  readonly code = SESSION_CONTEXT_CONFLICT_CODE;
  readonly conflicts: readonly SessionContextConflict[];

  constructor(conflicts: readonly SessionContextConflict[]) {
    super(formatSessionContextConflicts(conflicts));
    this.name = "SessionContextConflictError";
    this.conflicts = conflicts;
  }
}

/** رسالةٌ عربيّة تذكر **القيمتين معاً** لكلّ تعارض — «لا يطابق» وحدها رسالةٌ عمياء. */
export function formatSessionContextConflicts(
  conflicts: readonly SessionContextConflict[],
): string {
  const details = conflicts
    .map(
      (c) =>
        `${c.label}: أُرسل ${c.sent} والمُشتَقّ خادمياً ${c.derived} (${c.reason})`,
    )
    .join(" · ");
  return `تعارضٌ بين ما أرسلته الشاشة وما اشتقّه الخادم — ${details}`;
}

/**
 * ترمي `SessionContextConflictError` إن خالف ادّعاءُ العميل المُشتَقّ الخادميّ.
 * تُستعمَل في الطبقتين: الخادمُ يفرضها، والشاشةُ تستدعيها قبل الإرسال فتكشف الانحراف
 * عند مصدره بدل رسالةٍ عامّة بعد رحلةِ شبكة.
 */
export function assertMatchesDerived(
  sent: SessionContextClaim,
  derived: SessionContext,
): void {
  const conflicts = findSessionContextConflicts(sent, derived);
  if (conflicts.length > 0) throw new SessionContextConflictError(conflicts);
}

// ─── قراءةُ السياق: مصدرٌ خادميٌّ أو لا شيء ───────────────────────────────────

/** هل الطريقة مسموحةٌ في هذه الجلسة؟ (fail-closed على المجهول). */
export function isSessionPaymentMethodAllowed(
  ctx: SessionContext,
  method: string | null | undefined,
): method is SessionPaymentMethod {
  return (ctx.allowedPaymentMethods as readonly string[]).includes(
    method as string,
  );
}

/**
 * معرّفُ الفرع النشط — **ترمي** حين لا فرعَ نشط. ⛔ لا نظيرَ لها يُرجع بديلاً أو `null`
 * قابلاً لـ`?? 1`: هذه هي النقطة التي كان الفرعُ يُخترع فيها.
 */
export function requireSessionBranchId(
  ctx: SessionContext | null | undefined,
): number {
  if (!ctx || ctx.branch === null) {
    throw new Error(
      "لا فرعَ نشطٌ في هذه الجلسة — اختر فرعاً من قائمة الفروع قبل المتابعة (لا فرعَ افتراضيّ).",
    );
  }
  return ctx.branch.id;
}

const BUSINESS_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** صيغةُ اليوم + وجودُه فعلاً (لا 2026-02-31) — تحقّقٌ بلا رمي، للقارئ الفاشل مغلقاً. */
export function isBusinessDayYmd(value: unknown): value is string {
  if (typeof value !== "string" || !BUSINESS_DAY_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return (
    probe.getUTCFullYear() === y &&
    probe.getUTCMonth() === m - 1 &&
    probe.getUTCDate() === d
  );
}

const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * طابعٌ زمنيٌّ ISO-8601 صالحٌ **فعلاً**. ثلاثةُ فحوصٍ لأنّ أيّاً منها وحده يمرّ عليه مزيّف:
 *  ١) الصيغة — `Date.parse("2026-09-02")` ينجح على تاريخٍ بلا وقت، وليس طابعاً.
 *  ٢) وجودُ اليوم — قِيس: `Date.parse("2026-02-31T00:00:00Z")` **ينجح** ويتدحرج إلى ٣ مارس
 *     (V8 يرفض الشهر ٢٥:٠٠ والشهر ١٣ ولا يرفض اليوم ٣١ من شباط) ⇒ نُعيد استعمال
 *     `isBusinessDayYmd` على شقّ التاريخ بدل تقويمٍ ثانٍ مكتوبٍ بيد.
 *  ٣) `Date.parse` — يمسك الساعة/الشهر خارج المدى.
 */
function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_TIMESTAMP_RE.test(value)) return false;
  if (!isBusinessDayYmd(value.slice(0, 10))) return false;
  return Number.isFinite(Date.parse(value));
}

/**
 * جردٌ **شاملٌ بالنوع** للفئات السعرية: `Record<SessionPriceTier, true>` يُفشل `tsc` على
 * مفتاحٍ ناقصٍ أو زائد ⇒ إضافةُ فئةٍ رابعة إلى `OfflinePriceTier` تكسر البناء هنا بدل أن
 * تنجرف قائمةٌ منسوخةٌ بيد. (والاختبارُ يربط `OfflinePriceTier` نفسه بـ`drizzle/schema.ts`.)
 */
const PRICE_TIER_MEMBERS: Readonly<Record<SessionPriceTier, true>> =
  Object.freeze({
    RETAIL: true,
    WHOLESALE: true,
    GOVERNMENT: true,
  });
const PRICE_TIERS = Object.keys(
  PRICE_TIER_MEMBERS,
) as readonly SessionPriceTier[];

const isPositiveInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v > 0;
const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

/**
 * سلطةُ عبور الفروع مشتقّةً من الفاعل — نسخةُ سطرٍ واحدٍ من `canCrossBranches`
 * (server/lib/branchAuthority.ts). لا تُستورَد الأصليّةُ هنا لأنّ اتّجاه الطبقات
 * `server → shared` لا العكس (استيرادُها يجرّ مساراً خادمياً إلى حزمة المتصفّح)؛
 * ويربط الاختبارُ الدالّتَين **سلوكياً** على مصفوفة الأدوار بدل مقارنةِ نصّ.
 */
function actorCanCrossBranches(actor: SessionActor): boolean {
  return actor.role === "admin" || actor.isOwner === true;
}

/**
 * يقرأ حمولةً خادميّة إلى `SessionContext` — **يفشل مغلقاً**: أيّ حقلٍ ناقصٍ أو متناقض
 * يُرجع `null`، ولا يُكمِل نقصاً بقيمةٍ مخترعة. هذه هي بوّابةُ العميل الوحيدة إلى السياق.
 */
export function readSessionContext(raw: unknown): SessionContext | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const actorRaw = r.actor as Record<string, unknown> | undefined;
  if (!actorRaw || typeof actorRaw !== "object") return null;
  if (!isPositiveInt(actorRaw.userId) || !isNonEmptyString(actorRaw.role))
    return null;
  if (typeof actorRaw.isOwner !== "boolean") return null;
  const actor: SessionActor = {
    userId: actorRaw.userId,
    role: actorRaw.role,
    isOwner: actorRaw.isOwner,
  };

  let branch: SessionBranch | null = null;
  if (r.branch !== null) {
    const b = r.branch as Record<string, unknown> | undefined;
    if (!b || typeof b !== "object") return null;
    if (!isPositiveInt(b.id) || !isNonEmptyString(b.name)) return null;
    branch = { id: b.id, name: b.name };
  }

  if (!isBusinessDayYmd(r.businessDay)) return null;

  if (!Array.isArray(r.allowedPaymentMethods)) return null;
  // fail-closed على المجهول (سياسةُ القبض): قيمةٌ خارج القائمة الحاكمة ⇒ الحمولةُ كلّها مرفوضة،
  // لا تصفيةٌ صامتة تُنقص طريقةً كان الخادم يسمح بها فعلاً.
  const allowed = r.allowedPaymentMethods as unknown[];
  if (
    !allowed.every((m) =>
      (INBOUND_ENABLED_PAYMENT_METHODS as readonly string[]).includes(
        m as string,
      ),
    )
  ) {
    return null;
  }
  const allowedPaymentMethods = Array.from(
    new Set(allowed),
  ) as SessionPaymentMethod[];

  if (!PRICE_TIERS.includes(r.defaultPriceTier as SessionPriceTier))
    return null;

  if (typeof r.canCrossBranches !== "boolean") return null;
  // مفتاحُ إطفاءٍ يُتحقَّق منه: `canCrossBranches` تُعطّل فحصَ الفرع في `findSessionContextConflicts`،
  // فقبولُها ادّعاءً حرّاً يعني أنّ حمولةً بـ`true` تُسكِت الفحصَ لكاشير. تُقارَن بالفاعل في
  // الاتّجاهين: `true` كاذبةٌ تُطفئ الفحص، و`false` كاذبةٌ تُشعله على أدمنٍ يعبُر بقصدٍ مشروع.
  if (r.canCrossBranches !== actorCanCrossBranches(actor)) return null;

  const scopeRaw = r.scope as Record<string, unknown> | undefined;
  if (!scopeRaw || typeof scopeRaw !== "object") return null;
  const scopedBranchId = scopeRaw.scopedBranchId;
  const scopedOwnerId = scopeRaw.scopedOwnerId;
  if (scopedBranchId !== null && !isPositiveInt(scopedBranchId)) return null;
  if (scopedOwnerId !== null && !isPositiveInt(scopedOwnerId)) return null;
  // `scopedOwnerId = supervisor ? null : Number(ctx.user.id)` ⇒ غيرُ الفارغة **هي** معرّفُ
  // الفاعل حتماً. ⚠️ ولا نفرض العكس (فارغةٌ ⇔ مشرف): «المشرف» يشمل المدير، ولا مصدرَ مشتركاً
  // لتلك القاعدة يُستورَد هنا — ونسخُها بيد هو الانجرافُ الذي يوجد هذا الملفّ لمنعه.
  if (scopedOwnerId !== null && scopedOwnerId !== actor.userId) return null;

  if (!isIsoTimestamp(r.derivedAt)) return null;

  const ctx: SessionContext = {
    actor,
    branch,
    businessDay: r.businessDay,
    allowedPaymentMethods,
    defaultPriceTier: r.defaultPriceTier as SessionPriceTier,
    canCrossBranches: r.canCrossBranches,
    scope: {
      scopedBranchId: scopedBranchId as number | null,
      scopedOwnerId: scopedOwnerId as number | null,
    },
    derivedAt: r.derivedAt,
  };
  return violatesScopeInvariant(ctx) ? null : ctx;
}

/**
 * ثابتُ العزل — مرآةُ `branchScopedProcedure` حرفياً:
 *   `scopedBranchId = crossBranch ? null : Number(ctx.user.branchId)`، وغيرُ العابر بلا فرعٍ
 *   مُسنَد يُرفَض بـFORBIDDEN أصلاً.
 * ⇒ حمولةٌ تقول «غيرُ عابرٍ وبلا فرع» أو «غيرُ عابرٍ ونطاقُه فرعٌ آخر» **مستحيلةٌ خادمياً**،
 *   فقبولُها هنا يعني قبولَ سياقٍ ملفَّقٍ يُسكِت العزل. تُرفَض بدل تصحيحها.
 */
function violatesScopeInvariant(ctx: SessionContext): boolean {
  if (ctx.canCrossBranches) return ctx.scope.scopedBranchId !== null;
  if (ctx.branch === null) return true;
  return ctx.scope.scopedBranchId !== ctx.branch.id;
}

// ─── التركيب الخادميّ ────────────────────────────────────────────────────────

/**
 * مدخلُ التركيب: كلّ حقلٍ **إلزاميّ وبلا افتراض** — بما فيه `branch` الذي يجب أن يأتي من
 * `ctx.user.branchId` (وقد يكون `null` للعابر). لا توجد صيغةُ استدعاءٍ تُنتج فرعاً من لا شيء.
 * ⛔ ولا `canCrossBranches` هنا: تُشتقّ من `actor` داخل الدالّة فلا يستطيع مستدعٍ منحَ نفسه
 *    عبورَ الفروع (كما لا يستطيع تمريرَ `scopedBranchId` يخالف فرعه).
 */
export interface SessionContextSource {
  actor: SessionActor;
  branch: SessionBranch | null;
  businessDay: string;
  allowedPaymentMethods: readonly SessionPaymentMethod[];
  defaultPriceTier: SessionPriceTier;
  scopedOwnerId: number | null;
}

/**
 * يبني السياق من مصادرَ خادميّة صريحة. `canCrossBranches` و`scopedBranchId` **يُشتقّان** هنا
 * بنفس سطرَي الراوتر (`canCrossBranches(user)` ثمّ `crossBranch ? null : branch.id`) فلا يستطيع
 * مستدعٍ أن يمنح نفسه سلطةً أو يُمرّر نطاقاً يخالف فرعه.
 * ترمي حين يخالف المدخلُ ثابتاً خادمياً — نفس ما يفعله الراوتر بـFORBIDDEN — وكلُّ ما تُنتجه
 * يجب أن يقبله `readSessionContext` (ثابتٌ يحرسه الاختبار: تركيبٌ ثمّ قراءةٌ تُرجعان المتطابق).
 */
export function composeSessionContext(
  source: SessionContextSource,
  now: Date,
): SessionContext {
  const canCross = actorCanCrossBranches(source.actor);
  let scopedBranchId: number | null = null;
  if (!canCross) {
    if (source.branch === null) throw new Error("لا فرع مُسنَد لهذا المستخدم");
    scopedBranchId = source.branch.id;
  }
  if (!isBusinessDayYmd(source.businessDay)) {
    throw new Error("صيغة اليوم التشغيليّ غير صالحة (المتوقَّع YYYY-MM-DD)");
  }
  if (
    source.scopedOwnerId !== null &&
    source.scopedOwnerId !== source.actor.userId
  ) {
    throw new Error("نطاقُ الموظّف يجب أن يكون الفاعلَ نفسه أو فارغاً");
  }
  // `toISOString()` على تاريخٍ غير صالح يرمي `RangeError` بلا سياق — نُبلغ بالعربية بدلاً منه.
  if (Number.isNaN(now.getTime())) {
    throw new Error("لحظةُ اشتقاق السياق غير صالحة");
  }
  return {
    actor: source.actor,
    branch: source.branch,
    businessDay: source.businessDay,
    allowedPaymentMethods: source.allowedPaymentMethods,
    defaultPriceTier: source.defaultPriceTier,
    canCrossBranches: canCross,
    scope: { scopedBranchId, scopedOwnerId: source.scopedOwnerId },
    derivedAt: now.toISOString(),
  };
}

/** ⚠️ مصدرُ الحقيقة الوحيد لسياق الجلسة — أيّ نسخةٍ في شاشةٍ أو خدمة تُعيد بابَ الفرع الافتراضيّ. */
