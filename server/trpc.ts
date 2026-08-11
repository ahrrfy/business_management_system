import { NOT_ADMIN_ERR_MSG, TWO_FACTOR_REQUIRED_ROLES, UNAUTHED_ERR_MSG } from "@shared/const";
import { GENERIC_INTERNAL_AR, mysqlCodeFrom, toArabicMessage } from "@shared/errorMap.ar";
import { canSeeCost as _canSeeCost, canUseStation, moduleAccessAllowed, resolvePermissions, type AccessLevel, type RoleKey } from "@shared/permissions";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import { isCurrentNativeClient } from "./auth/deviceProof";
import { isCryptoReady } from "./services/cryptoService";
import { logger } from "./logger";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error, ctx, path }) {
    let arabic = toArabicMessage({
      trpcCode: error.code,
      originalMessage: error.message,
      cause: error.cause,
    });
    const correlationId = (ctx?.req as { id?: string } | undefined)?.id ?? null;
    if (error.code === "INTERNAL_SERVER_ERROR") {
      logger.error({ err: error.cause ?? error, path, correlationId }, `tRPC error: ${path}`);
      // ترقية تشخيصية (١٥/٧/٢٦): الخطأ غير المتوقّع يحمل رمز متابعة يطابق سطر الخطأ في
      // سجلّ الخادم (genReqId في index.ts) — المستخدم يرسله للدعم فيُحدَّد موضع الخطأ فوراً.
      // يُلحق بالرسالة العامة فقط: رفض قواعد الأعمال (Error عربي من الخدمات يصعد INTERNAL)
      // رسالتُه مفهومة بذاتها، وإلحاق الرمز به يحوّل رفضاً سليماً لبلاغ عطل (alert fatigue).
      if (correlationId && arabic === GENERIC_INTERNAL_AR) {
        arabic += `\nرمز المتابعة: ${correlationId} — أرسله للدعم لتحديد موضع الخطأ في سجلّ الخادم.`;
      }
    } else if (error.code === "FORBIDDEN" || error.code === "UNAUTHORIZED") {
      // F5 (تدقيق ١٤/٦/٢٦): محاولات التجاوز الفاشلة كانت تمرّ صامتة ⇒ لا أثر forensic.
      // نُسجِّل في pino البنيوي (best-effort، خفيف، بلا i/o إضافي على القاعدة).
      // إن لزم لاحقاً سجلٌّ دائم: interceptor مستقلّ يكتب في auditLogs (errorFormatter sync).
      logger.warn(
        { path, correlationId, userId: ctx?.user?.id ?? null, role: ctx?.user?.role ?? null, code: error.code, message: error.message },
        `authz denied: ${path}`,
      );
    }
    // dbCode: رمز خطأ MySQL (إن وُجد) — يتيح للواجهة تمييز نوع الفشل برمجياً (تكرار/قفل/اتصال).
    return { ...shape, message: arabic, data: { ...shape.data, correlationId, dbCode: mysqlCodeFrom(error.cause) } };
  },
});

export const router = t.router;
export const middleware = t.middleware;
export const publicProcedure = t.procedure;

/**
 * Credential-free bootstrap boundary for the native Android client. This does not authenticate
 * a user or grant a session; it only prevents browsers and obsolete clients from minting device
 * registration challenges outside the current signed-device protocol.
 */
const requireNativeBootstrapClient = t.middleware(async ({ ctx, next }) => {
  if (!isCurrentNativeClient(ctx.req)) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }
  return next({ ctx });
});

export const nativeBootstrapProcedure = t.procedure.use(requireNativeBootstrapClient);

// ─── M9 (تدقيق ٣/٨): إلزام 2FA خادمياً للمدير/المشرف ─────────────────────────
// كانت راية `mustEnroll2FA` توجيهاً واجهياً فقط (ForceTwoFactorEnroll يحجب الشاشة)، فعميلٌ
// غير قياسيّ أو استدعاء API مباشر يتجاهلها ويعمل بكامل الصلاحية بلا عاملٍ ثانٍ. الآن يُحجب أي
// إجراء (عدا مسارات التفعيل) لدور مُلزَم لم يُفعّل 2FA — خادمياً — عبر البوّابات الأربع أدناه.
//
// 🛟 بوّابات إنقاذ الأدمن (منع القفل الدائم خارج الحساب):
//   ١) مسارات التفعيل/الحالة مُستثناة دائماً ⇒ الحساب يُصلِح نفسه بالتفعيل بلا أي وصولٍ آخر.
//   ٢) `isCryptoReady()=false` (لا مفتاح تشفير) ⇒ لا إنفاذ (لا يمكن تفعيل 2FA أصلاً).
//   ٣) مفتاح إيقافٍ بيئيّ `TWO_FACTOR_ENFORCEMENT=off` ⇒ يُعطّل الإنفاذ كلياً (مخرج المالك عند طارئ).
//   + إنقاذ الأدمن القائم `users.resetTwoFactor` (أدمن يصفّر 2FA لمستخدمٍ آخر).
// المسارات المُستثناة تطابق ما يستدعيه ForceTwoFactorEnroll (setupStart/Confirm) + قراءة الحالة.
const TWO_FACTOR_EXEMPT_PATHS = new Set<string>([
  "auth.twoFactorSetupStart",
  "auth.twoFactorSetupConfirm",
  "auth.twoFactorStatus",
]);

/** هل يجب على هذا المستخدم تفعيل 2FA قبل استعمال النظام؟ (يطابق `mustEnroll2FA` في authRouter.me). */
export function twoFactorEnrollmentRequired(user: { role: string; totpEnabledAt?: Date | string | null }): boolean {
  if (process.env.TWO_FACTOR_ENFORCEMENT === "off") return false; // بوّابة إنقاذ ٣
  if (!isCryptoReady()) return false; // بوّابة إنقاذ ٢
  if (!TWO_FACTOR_REQUIRED_ROLES.includes(user.role)) return false;
  return !user.totpEnabledAt;
}

/** يرمي FORBIDDEN إن كان الإجراء غير مُستثنى ودورُ المستخدم مُلزَمٌ بـ2FA ولم يُفعّلها. */
function assertTwoFactorEnrolled(user: { role: string; totpEnabledAt?: Date | string | null }, path: string): void {
  if (TWO_FACTOR_EXEMPT_PATHS.has(path)) return; // بوّابة إنقاذ ١
  if (twoFactorEnrollmentRequired(user)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "يلزم تفعيل المصادقة الثنائية (2FA) للمتابعة — سياسة إلزامية للمدير/المشرف.",
    });
  }
}

const requireUser = t.middleware(async ({ ctx, next, path }) => {
  if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  assertTwoFactorEnrolled(ctx.user, path);
  return next({ ctx: { ...ctx, user: ctx.user } });
});

export const protectedProcedure = t.procedure.use(requireUser);

/**
 * Self-service boundary for the mobile workspace. Handlers using this
 * procedure must derive the subject from ctx.user and must not accept a
 * caller-supplied user or employee identifier.
 */
export const selfServiceProcedure = protectedProcedure;

/**
 * Permission-aware aggregation boundary for the super-app BFF. It does not
 * grant a module permission by itself: every handler must resolve the current
 * user's permission map and keep all records branch-scoped.
 */
export const superAppProcedure = protectedProcedure;

/**
 * بوابة خدمة ذاتية لمكلّف جرد بحساب النظام. لا تمنح هذه البوابة وصولاً عاماً
 * إلى وحدة المخزون؛ كل handler يستعملها ملزم بربط القراءة/الكتابة بـ userId
 * للتكليف نفسه (مثال: countPortalRouter.mine).
 */
export const stocktakeAssignmentProcedure = protectedProcedure;

const requireAdmin = t.middleware(async ({ ctx, next, path }) => {
  if (!ctx.user || ctx.user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
  }
  assertTwoFactorEnrolled(ctx.user, path);
  return next({ ctx: { ...ctx, user: ctx.user } });
});

export const adminProcedure = t.procedure.use(requireAdmin);

// ─── مدير المنصّة (تعدّد الشركات) — منفصل تماماً عن أدوار أي شركة ──────────
const requirePlatformAdmin = t.middleware(async ({ ctx, next }) => {
  if (!ctx.platformAdmin) throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  return next({ ctx: { ...ctx, platformAdmin: ctx.platformAdmin } });
});

export const platformAdminProcedure = t.procedure.use(requirePlatformAdmin);

// ─── تفويض الأدوار (RBAC) ───────────────────────────────────────────────
const FORBIDDEN_MSG = "صلاحيات غير كافية لهذا الإجراء.";

function requireRole(...allowed: string[]) {
  return t.middleware(async ({ ctx, next, path }) => {
    if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
    if (ctx.user.role !== "admin" && !allowed.includes(ctx.user.role)) {
      throw new TRPCError({ code: "FORBIDDEN", message: FORBIDDEN_MSG });
    }
    assertTwoFactorEnrolled(ctx.user, path);
    return next({ ctx: { ...ctx, user: ctx.user } });
  });
}

/** إنفاذ وحدة بمستوى وصول — يستخدم الخريطة المحسوبة (قالب + override). */
export function requireModule(moduleKey: string, minLevel: AccessLevel) {
  return t.middleware(async ({ ctx, next }) => {
    if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
    if (ctx.user.role === "admin") return next({ ctx: { ...ctx, user: ctx.user } });
    const override = (ctx.user as any).permissionsOverride as Record<string, AccessLevel> | null;
    const map = resolvePermissions(ctx.user.role as RoleKey, override);
    const level = map[moduleKey] ?? "NONE";
    const allowed = level === "FULL" || (minLevel === "READ" && level === "READ");
    if (!allowed) throw new TRPCError({ code: "FORBIDDEN", message: FORBIDDEN_MSG });
    return next({ ctx: { ...ctx, user: ctx.user } });
  });
}

/**
 * بوّابة الوحدة الموحّدة (٦/٧/٢٦) — إصلاح «فتحتُ صلاحيات لحساب ولم تُطبَّق»:
 * كانت requireRole تُنفَّذ قبل requireModule وترفض أي دور خارج قائمتها حتى لو مُنح
 * الوحدة صراحةً عبر مصفوفة الصلاحيات (override فردي أو دور مخصّص) ⇒ المنح ميت.
 * القاعدة الآن (moduleAccessAllowed في shared/permissions — مشتركة مع الواجهة):
 * admin يمرّ؛ دور القائمة يمرّ إن حقّقت خريطته المحلولة المستوى (F2 كما هو)؛
 * دور خارج القائمة يمرّ فقط بمنح **صريح** للوحدة بالمستوى المطلوب.
 * ملاحظة أمنية: المنح الصريح FULL يفتح كل إجراءات الوحدة (بما فيها ما كان مديرياً
 * كالإلغاءات) — هذا هو معنى «كامل» المعروض للمالك في المصفوفة، والمنح قرار أدمن.
 */
function requireModuleGate(allowedRoles: readonly string[], moduleKey: string, minLevel: AccessLevel) {
  return t.middleware(async ({ ctx, next, path }) => {
    if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
    const override = (ctx.user as { permissionsOverride?: unknown }).permissionsOverride as
      | Record<string, AccessLevel>
      | null
      | undefined;
    if (!moduleAccessAllowed(ctx.user.role, override, moduleKey, minLevel, allowedRoles)) {
      throw new TRPCError({ code: "FORBIDDEN", message: FORBIDDEN_MSG });
    }
    assertTwoFactorEnrolled(ctx.user, path);
    return next({ ctx: { ...ctx, user: ctx.user } });
  });
}

/** عمليات إدارية/مالية: المدير فأعلى (توافق خلفي كامل). */
export const managerProcedure = t.procedure.use(requireRole("manager"));

/**
 * RBAC-REPORTS (تدقيق ٢/٧ + ٦/٧): بوّابة الوحدة الموحّدة على التقارير — تُعامَل «reports»
 * كأي وحدة أخرى عبر requireModuleGate: الأدوار المالية القالبية (manager/accountant/auditor)
 * تمرّ بخريطتها، وأي دور آخر يمرّ **بمنحٍ صريح** فقط (override reports≥READ) — يفتح شكوى المالك
 * «فتحتُ الصلاحية ولم تُطبَّق».
 * ⚠️ حاسم: لا نُسقِط بوّابة الدور إلى requireModule العاري — إذ يفتح ذلك تقارير التكلفة/الربح
 * (P&L/الأستاذ/تقييم المخزون) لقوالب warehouse/purchasing/user (reports=READ، canSeeCost=false)
 * فيخرق ثابت «حجب التكلفة عن غير أدواره» (§٥، مراجعة عدائية ٦/٧). القائمة تُبقي القالب الافتراضي
 * لتلك الأدوار محجوباً، ويظلّ المنح الصريح قرار المالك الواعي (لا وحدة «تكلفة» منفصلة في المصفوفة).
 */
export const reportViewerProcedure = t.procedure
  .use(requireModuleGate(["manager", "accountant", "auditor"], "reports", "READ"))
  .use(async ({ ctx, getRawInput, next }) => {
    // عزل الفرع: admin يعبُر أي فرع؛ غير الأدمن يُرفَض إن طلب فرعاً غير فرعه (أثر forensic صريح
    // بدل قصٍّ صامت) — مرآةٌ لِمنطق managerBranchScopedProcedure الذي كان يحرس هذه التقارير.
    if (!ctx.user || ctx.user.role === "admin") return next({ ctx });
    const raw = (await getRawInput()) as { branchId?: number | string } | undefined;
    const requestedBranch = raw?.branchId;
    if (requestedBranch !== undefined && Number(requestedBranch) !== Number(ctx.user.branchId)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن قراءة بيانات فرع آخر" });
    }
    return next({ ctx });
  });
export const managerBranchScopedProcedure = managerProcedure.use(async ({ ctx, getRawInput, next }) => {
  if (ctx.user.role === "admin") return next({ ctx });
  // G7 (تدقيق ٢٣/٦/٢٦): `input` في middleware يَأتي parsed بعد `.input()` فقط. هذا middleware
  // يُسجَّل قبل `.input()` ⇒ `input` كان `undefined` دائماً والفحص يَمرّ صامتاً ⇒ المدير يَطلب
  // فرع آخر فيُعاد له بيانات فرعه (لا تَسريب فعلي بفضل scopedBranchId في الـhandler، لكن لا
  // FORBIDDEN forensic). `getRawInput()` يَصل للحمولة الخام قبل التحليل ⇒ الفحص يَعمل بحقّ.
  const raw = (await getRawInput()) as { branchId?: number | string } | undefined;
  const requestedBranch = raw?.branchId;
  if (requestedBranch !== undefined && Number(requestedBranch) !== Number(ctx.user.branchId)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "مدير الفرع لا يَستطيع قراءة بيانات فرع آخر" });
  }
  return next({ ctx });
});
// G3 (تدقيق ١٩/٦/٢٦): الكاشير والمخزن **يجب** أن يكون لهما فرع مُسنَد — لا معنى
// لتشغيل وردية/استلام بضاعة بلا فرع. كان غياب الفحص يتفاعل مع `?? 1` في الراوترات
// فيصبح المستخدم بلا فرع يكتب صامتاً على الفرع رقم ١ (IDOR). المدير/الأدمن مستثنيان
// لأن لهما حالات شرعية للعمل عبر الفروع.
const requireOwnBranch = t.middleware(async ({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  if (ctx.user.role === "admin" || ctx.user.role === "manager") return next({ ctx: { ...ctx, user: ctx.user } });
  if (ctx.user.branchId == null) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

/** عمليات البيع/الصندوق: الكاشير فأعلى (مع فحص branchId إلزامي لغير المدير). */
export const cashierProcedure = t.procedure.use(requireRole("cashier", "manager")).use(requireOwnBranch);
/** عمليات المخزون: أمين المخزن فأعلى (مع فحص branchId إلزامي لغير المدير). */
export const warehouseProcedure = t.procedure.use(requireRole("warehouse", "manager")).use(requireOwnBranch);
// ش٢: حُذف `workOrderExecProcedure` (المفرد) — كان مُصدَّراً ميّتاً (مرجعه الوحيد تعليقٌ في
// workOrderRouter.ts:391، صفر استعمال فعليّ). المستعمَل هو `workordersExecProcedure` (الجمع، عبر
// moduleProcedure/workorders). إبقاء ميّتٍ يمنح cashier/print_operator وصولاً ثابتاً يتجاوز خريطة
// workorders = خطرُ ربطٍ مستقبليّ صامت يخرق النموذج الموحّد.

/** هل يُسمح لهذا الدور برؤية التكلفة/هامش الربح؟ (يشمل المحاسب الآن). */
export const canSeeCost = (role: string) => _canSeeCost(role);

/**
 * RBAC-COST (تدقيق ٢/٧): رؤية التكلفة/الربح لمستخدمٍ بعينه — تحترم خريطة الدور المخصّص لا القالب فقط.
 * كان canSeeCost(role) يتبع baseRole ⇒ دور مخصّص أساسه manager يرى التكلفة رغم تقييد خريطته. الآن:
 * القالب لا يرى ⇒ لا (كما هو)، وإن كان دوراً مخصّصاً (له override) فالرؤية مشروطة بأن صلاحية «التقارير»
 * (نطاق التكلفة/الربح) ليست NONE. الأدوار القالبية (بلا override) بلا تغيير.
 */
export function canSeeCostForUser(user: { role: string; permissionsOverride?: unknown }): boolean {
  if (!_canSeeCost(user.role)) return false;
  const override = user.permissionsOverride as Record<string, AccessLevel> | null | undefined;
  if (!override) return true;
  const map = resolvePermissions(user.role as RoleKey, override);
  return (map.reports ?? "NONE") !== "NONE";
}

/**
 * هل يُسمح لهذا المستخدم برؤية أرقام التقارير المالية (AR/إيراد)؟ — **نفس بوّابة**
 * `reportViewerProcedure` بالضبط عبر `moduleAccessAllowed` (قائمة manager/accountant/auditor +
 * منح صريح reports≥READ لأي دور آخر). مستعملة حين يكون endpoint نفسه متاحاً للجميع لكن **جزءاً**
 * من حمولته ماليّاً يجب حجبه عن أدوار reports=NONE (dashboardMetrics: overdueAR/salesPulse) —
 * فلا نُسقِط الإجراء كلّه إلى reportViewerProcedure (يُخفي lowStock التشغيليّ عن الكاشير/المخزن).
 * ملاحظة أمنية: هذا قرار خادميّ — الواجهة تعيد الفحص نفسه لإخفاء البطاقة، لكن الخادم هو الحاجز.
 */
export function canViewReports(user: { role: string; permissionsOverride?: unknown }): boolean {
  const override = user.permissionsOverride as Record<string, AccessLevel> | null | undefined;
  return moduleAccessAllowed(user.role, override, "reports", "READ", ["manager", "accountant", "auditor"]);
}

// ─── عزل الفروع (منع IDOR عبر branchId) ─────────────────────────────────
// F1 (تدقيق ١٤/٦/٢٦): استُبدِل magic value `-1` برميٍ صريح لـFORBIDDEN حين يحاول
// مستخدم غير-elevated الوصول وهو بلا فرع مُسنَد. كان `-1` يجعل الاستعلامات تُرجع
// `[]` صامتاً (المستخدم يرى «لا بيانات» بدل «ممنوع») ⇒ لا أثر forensic + سلوك مضلّل.
// الآن: المسار آمن، والـauthz failure يُسجَّل في pino عبر errorFormatter (F5).
export const branchScopedProcedure = protectedProcedure.use(({ ctx, next }) => {
  const elevated = ctx.user.role === "admin" || ctx.user.role === "manager";
  if (!elevated && ctx.user.branchId == null) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
  }
  const scopedBranchId = elevated ? null : Number(ctx.user.branchId);
  // ─── عزل سجلّات الموظف («يرى ما يخصّه فقط») — سياسة المالك (٢٤/٦/٢٦) ───
  // غير المرتفعين (كاشير/مندوب/فني…) يرون ما أنشأوه فقط في القوائم الترانزاكشنية
  // (فواتير/عروض/مصروفات/حركات مخزون/أوامر شغل). admin|manager = null = كل بيانات الفرع.
  // (نفس مجموعة elevated في عزل الفرع ⇒ اتّساق.) لا يشمل الكتالوج المشترك (منتجات/عملاء/موردون).
  const scopedOwnerId = elevated ? null : Number(ctx.user.id);
  return next({ ctx: { ...ctx, scopedBranchId, scopedOwnerId } });
});

// ─── F2 (تدقيق ٢/٧) + بوّابة المنح الصريح (٦/٧) — إجراءات module-gated ─────────
// F2: خريطة الدور (قالب + override) تُنفَّذ على أدوار القائمة (override مُقيِّد يُطاع).
// ٦/٧: أي دور خارج القائمة مُنح الوحدة **صراحةً** بالمستوى المطلوب يمرّ أيضاً
// (requireModuleGate أعلاه) — كان requireRole يرفضه قبل استشارة المنح إطلاقاً.
// توسيعات قوائم مستهدفة (وعود قوالب كانت مكسورة): purchasing⇐المشتريات/الموردون،
// accountant⇐الخزينة/إدخال المصروفات، sales_rep⇐كتابة العملاء الأساسية،
// warehouse⇐كتابة الموردين. الاصطلاح: query ⇒ READ، mutation ⇒ FULL.

/** بوّابة وحدة + إلزام فرع مُسنَد لغير admin/manager (G3) — الأساس لكل إجراءات الكتابة أدناه. */
function moduleProcedure(allowedRoles: readonly string[], moduleKey: string, minLevel: AccessLevel) {
  return t.procedure.use(requireModuleGate(allowedRoles, moduleKey, minLevel)).use(requireOwnBranch);
}

// pos (نقطة بيع خدمات الطباعة — printPos)
export const posCashierProcedure = moduleProcedure(["cashier", "manager"], "pos", "FULL");
// sales
export const salesReadProcedure = branchScopedProcedure.use(requireModule("sales", "READ"));
export const salesCashierProcedure = moduleProcedure(["cashier", "manager"], "sales", "FULL");
export const salesManagerProcedure = moduleProcedure(["manager"], "sales", "FULL");
// عرض/طباعة فاتورةٍ واحدة (طلب المالك — خدمة العملاء تطبع/تعيد طباعة فواتيرها): يسمح بـsales≥READ
// **أو** صلاحية الاستقبال (workorders:FULL). مشغّل الاستقبال يُنشئ الفواتير فيطبعها، بلا فتح وحدة
// المبيعات كاملةً (عروض الأسعار تبقى محميّة على salesReadProcedure). محميّة بالفرع (branchScoped +
// فلتر الفرع داخل الاستعلام يُرجِع null لفاتورة فرعٍ آخر ⇒ لا IDOR). دورٌ-محايد: يعمل لأيّ دور استقبال.
export function invoiceViewScopeForUser(
  user: { role: string; permissionsOverride?: unknown },
): "sales" | "reception" | null {
  if (user.role === "admin") return "sales";
  const override = user.permissionsOverride as Record<string, AccessLevel> | null | undefined;
  const map = resolvePermissions(user.role as RoleKey, override);
  if (map.sales === "FULL" || map.sales === "READ") return "sales";
  if (map.workorders === "FULL") return "reception";
  return null;
}

export const invoiceViewProcedure = branchScopedProcedure.use(
  t.middleware(async ({ ctx, next }) => {
    if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
    if (!invoiceViewScopeForUser(ctx.user)) {
      throw new TRPCError({ code: "FORBIDDEN", message: FORBIDDEN_MSG });
    }
    return next({ ctx: { ...ctx, user: ctx.user } });
  }),
);
// purchases — «مسؤول مشتريات» قالبه purchases=FULL ووصفه المعلن «أوامر شراء وموردون».
export const purchasesReadProcedure = branchScopedProcedure.use(requireModule("purchases", "READ"));
export const purchasesManagerProcedure = moduleProcedure(["manager", "purchasing"], "purchases", "FULL");
export const purchasesWarehouseProcedure = moduleProcedure(["warehouse", "manager", "purchasing"], "purchases", "FULL");
// inventory (يشمل production/stocktake — كلاهما يُحرّك المخزون)
export const inventoryReadProcedure = branchScopedProcedure.use(requireModule("inventory", "READ"));
export const inventoryWarehouseProcedure = moduleProcedure(["warehouse", "manager"], "inventory", "FULL");
export const inventoryManagerProcedure = moduleProcedure(["manager"], "inventory", "FULL");
/** إنقاذ مخزني شديد الحساسية: بوابة inventory:FULL ثم admin و2FA مركزياً. */
export const inventoryAdminProcedure = inventoryManagerProcedure.use(requireAdmin);
// أسماء توافقية للراوترات القائمة؛ سلطة ملف العميل انتقلت فعلياً إلى وحدة CRM.
export const customersReadProcedure = protectedProcedure.use(requireModule("crm", "READ"));
// print_operator (٧/٨): مرآة POS_STATION_GATES.RECEPTION بالضبط (shared/permissions.ts) — نفس
// الدور الذي يفتح محطة الاستقبال فعلياً (كاشير/مدير/فنّي المطبعة) يحتاج إنشاء عميلٍ من طلب قناة
// (واتساب/انستغرام/تيك توك/اتصال) دون رفض FORBIDDEN — كان مفقوداً هنا رغم وجوده في CHANNEL_READ_ROLES
// وبوّابة محطة الاستقبال، فيرى الموظّف القناة ولا يقدر يحفظ عميلها.
export const customersCashierProcedure = moduleProcedure(["cashier", "manager", "sales_rep", "print_operator"], "crm", "FULL");
export const customersManagerProcedure = moduleProcedure(["manager"], "crm", "FULL");

// CRM هو مالك رحلة العميل؛ تبقى وحدات المبيعات/القنوات/الخزينة مزوّدات أحداث عبر حدود واضحة.
export const crmReadProcedure = branchScopedProcedure.use(requireModule("crm", "READ"));
export const crmWriteProcedure = moduleProcedure(["cashier", "manager", "sales_rep"], "crm", "FULL");
export const campaignsReadProcedure = branchScopedProcedure.use(requireModule("campaigns", "READ"));
export const campaignsManagerProcedure = moduleProcedure(["manager"], "campaigns", "FULL");
export const collectionsReadProcedure = branchScopedProcedure.use(requireModule("collections", "READ"));
export const collectionsManagerProcedure = moduleProcedure(["manager", "accountant"], "collections", "FULL");

// ─── نظام المهام الموحّد «tasks» (S2 — مركز واتساب الأعمال) — تذكرة موحّدة لأي طلب خدمة/دعم/
// استفسار/متابعة/داخلية بغضّ النظر عن قناة الورود (واتساب/إنستغرام/متجر/هاتف/حضوري). الكتابة
// اليومية (إنشاء/سحب/تعليق/انتظار/استئناف/حلّ) بأدوار التنفيذ التي تستقبل طلبات الزبائن فعلياً
// (كاشير/مندوب مبيعات/فني مطبعة) + المدير؛ العمليات الإشرافية (إسناد قسري/إعادة فتح/إلغاء) مديرية حصراً.
export const tasksReadProcedure = branchScopedProcedure.use(requireModule("tasks", "READ"));
export const tasksWriteProcedure = moduleProcedure(["cashier", "manager", "sales_rep", "print_operator"], "tasks", "FULL");
export const tasksManagerProcedure = moduleProcedure(["manager"], "tasks", "FULL");

// المتجر الإلكتروني (وحدة store): قراءة الطلبات/البنرات، تثبيت الطلبات وطباعة الملصقات (تشغيلي)،
// وإدارة البنرات/الإعدادات (مديري). branchScopedProcedure للقراءة ⇒ عزل فرع لغير المرتفعين.
export const storeReadProcedure = branchScopedProcedure.use(requireModule("store", "READ"));
export const storeFulfillProcedure = moduleProcedure(["manager", "cashier", "sales_rep"], "store", "FULL");
// الإرسال (فاتورة COD + خصم مخزون + إسناد مندوب) يستعمل storeManagerProcedure: المدير يُقرّ
// ائتمان COD المؤقّت للزبون النقدي (managerOverrideByUserId يجب أن يكون مديراً مُتحقَّقاً).
export const storeManagerProcedure = moduleProcedure(["manager"], "store", "FULL");
// courier (١٢/٧): شاشة المندوب الذاتية «توصيلاتي» — القراءة/التأكيد يحلّان partyId من ctx.user
// (deliveryParties.userId) لا من الفرع. **بلا requireOwnBranch** عمداً: العزل بالمندوب (userId) لا
// بالفرع، والمندوب قد يخدم عدّة فروع (عابرٌ لفروع طلباته) فيُنشأ أحياناً بلا فرع مُسنَد — فرضُ الفرع
// كان يقفل الميزة كلّها عليه (مراجعة عدائية ١٢/٧). الدور courier فقط (admin يعبُر البوّابة لكنه بلا
// جهة مرتبطة ⇒ النقاط الذاتية تعيد linked:false برشاقة).
export const courierProcedure = t.procedure.use(requireModuleGate(["courier"], "courier", "FULL"));
// قراءات مركز التوصيل (/delivery) — مقيّدة بوحدة store: كل مستعملي الشاشة (manager/cashier FULL،
// accountant/auditor READ، admin يعبُر) يملكون store≥READ، بينما courier=NONE ⇒ محجوبٌ من قراءة
// عهدة/بيانات جهات أخرى وPII زبائن الإرساليات (مراجعة عدائية ١٢/٧: branchScoped وحده لا يستشير
// خريطة الصلاحيات فيسرّبها لأي مستخدم مصادَق ذي فرع). branchScoped ⇒ يبقى scopedBranchId للعزل.
export const deliveryReadProcedure = branchScopedProcedure.use(requireModule("store", "READ"));
// suppliers — القراءة بالخريطة وحدها (كالعملاء): قوالب warehouse/purchasing/auditor/user تعِد
// بها وكان managerProcedure يصدّها. الكتابة: warehouse/purchasing قالباهما FULL.
export const suppliersReadProcedure = protectedProcedure.use(requireModule("suppliers", "READ"));
export const suppliersManagerProcedure = moduleProcedure(["manager", "warehouse", "purchasing"], "suppliers", "FULL");
// بضاعة الأمانة «consignments» (ش٢): سندات الإيداع/السحب — أمين المخزن يسجّلها (استلام فعليّ) + المدير + المحاسب.
// مقصورة على الفرع (requireOwnBranch عبر moduleProcedure) — السند لفرعه؛ admin يعبر عبر البوّابة.
export const consignmentWriteProcedure = moduleProcedure(["warehouse", "manager", "accountant"], "consignments", "FULL");
// القراءة مقصورة بالفرع (تدقيق ٢٥/٧): كانت protectedProcedure عاريةً ⇒ أيّ مستخدم بصلاحية consignments READ
// يقرأ سندات كلّ الفروع (تسريب PII المودِع عبر get + قوائم عبر-الفرعية)، بينما الكتابة تفرض requireOwnBranch.
// branchScopedProcedure يوفّر scopedBranchId (null لـadmin/manager، فرع المستخدم لغيرهم) فتتماثل القراءة مع الكتابة.
export const consignmentReadProcedure = branchScopedProcedure.use(requireModule("consignments", "READ"));
// products (catalog)
export const productsReadProcedure = protectedProcedure.use(requireModule("products", "READ"));
export const productsManagerProcedure = moduleProcedure(["manager"], "products", "FULL");
// forPurchase (بحث منتجات جانب الشراء — يكشف التكلفة): أدوار الشراء التي تبني/تستلم أوامر الشراء
// (purchasing/warehouse) تحتاجه لإضافة سطور PO، وكان محصوراً بالمدير فتعذّر عليها بناء أمر الشراء
// رغم تخويلها إنشاءه (purchasesManagerProcedure)/استلامه (purchasesWarehouseProcedure). قراءة فقط،
// ومحصور بأدوار الشراء + المدير ⇒ لا تتسرّب التكلفة للكاشير/المندوب/المستخدم العام.
export const productsPurchaseProcedure = moduleProcedure(["manager", "warehouse", "purchasing"], "products", "READ");
// expenses — «محاسب» قالبه expenses=FULL ⇒ يدخل بوّابة الإدخال (الإلغاء يبقى مديرياً).
export const expensesReadProcedure = branchScopedProcedure.use(requireModule("expenses", "READ"));
export const expensesCashierProcedure = moduleProcedure(["cashier", "manager", "accountant"], "expenses", "FULL");
export const expensesManagerProcedure = moduleProcedure(["manager"], "expenses", "FULL");
// workorders (خدمة العملاء)
export const workordersReadProcedure = branchScopedProcedure.use(requireModule("workorders", "READ"));
export const workordersCashierProcedure = moduleProcedure(["cashier", "manager"], "workorders", "FULL");
export const workordersExecProcedure = moduleProcedure(["cashier", "manager", "print_operator"], "workorders", "FULL");
export const workordersManagerProcedure = moduleProcedure(["manager"], "workorders", "FULL");

// ─── F7 (تدقيق ٢/٧): بوّابات الوحدة المالية «treasury» ─────────────────────────
// «محاسب» قالبه treasury=FULL ووصفه المعلن يشمل الخزينة والسندات — كان مصدوداً.
// **الورديات بمستوى READ** لأن قالب cashier treasury=READ (فتح/إغلاق الوردية سلوك كاشير قائم).
export const treasuryManagerProcedure = moduleProcedure(["manager", "accountant"], "treasury", "FULL");
export const treasuryManagerReadProcedure = moduleProcedure(["manager", "accountant"], "treasury", "READ");
export const treasuryReadProcedure = branchScopedProcedure.use(requireModule("treasury", "READ"));
export const treasuryCashierProcedure = moduleProcedure(["cashier", "manager"], "treasury", "READ");

// ─── الأهداف والعمولات «commissions» — خطط/أهداف شهرية/تشغيلات عمولات البائعين ───
// الكتابة (خطط/إسناد/أهداف/احتساب/اعتماد) مديرية بقالبها + منح صريح عبر البوّابة
// الموحّدة؛ القراءة بالخريطة (accountant/auditor قالباهما READ). العرض الذاتي «أدائي»
// لا يمرّ من هاتين البوّابتين إطلاقاً — protectedProcedure بهوية ctx.user حصراً
// (بلا مدخل employeeId) داخل راوتر الوحدة، اتّساقاً مع عزل scopedOwnerId.
export const commissionsManagerProcedure = moduleProcedure(["manager"], "commissions", "FULL");
export const commissionsReadProcedure = protectedProcedure.use(requireModule("commissions", "READ"));

// ─── البطاقات الرقمية والاشتراكات «digital_cards» ────────────────────────────
// قالب الوحدة يمنح الكاشير READ **لأجل شبكة بطاقات نقطة البيع** (pos.* — بلا تكلفة ولا هامش
// ولا رصيد محفظة)، لا لأجل شاشة الإعداد. لذلك بوّابتان مختلفتان للقراءة:
//   • Pos: requireModule العاري (أي حامل digital_cards≥READ، الكاشير منهم).
//   • AdminRead: قائمة manager/accountant/auditor عبر البوّابة الموحّدة ⇒ الكاشير محجوب
//     (قالبه READ لا يضعه في القائمة، ولا يعبُر إلا بمنح **صريح** — قرار أدمن واعٍ).
// الكتابة (إنشاء/تعديل مزوّد أو محفظة أو بطاقة، ونشر السعر) مديرية حصراً — §١١ من وثيقة التصميم.
/**
 * Digital-card selling is a RETAIL-POS operation. A print/reception cashier
 * may share the cashier base template (including digital_cards=READ), but must
 * not be able to invoke the retail sale endpoints directly.
 */
const requireDigitalCardsRetailStation = t.middleware(async ({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  const override = (ctx.user as { permissionsOverride?: unknown }).permissionsOverride as
    | Record<string, AccessLevel>
    | null
    | undefined;
  if (!canUseStation("RETAIL", ctx.user.role, override)) {
    throw new TRPCError({ code: "FORBIDDEN", message: FORBIDDEN_MSG });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

export const digitalCardsPosProcedure = branchScopedProcedure
  .use(requireModule("digital_cards", "READ"))
  .use(requireDigitalCardsRetailStation);
export const digitalCardsAdminReadProcedure = branchScopedProcedure.use(
  requireModuleGate(["manager", "accountant", "auditor"], "digital_cards", "READ")
);
export const digitalCardsManagerProcedure = moduleProcedure(["manager"], "digital_cards", "FULL");

// ─── priceSanity L2 — تدقيق شذوذ الكتالوج ──────────────────────────────────
// القراءة: manager/accountant/auditor (نفس بوّابة التقارير). الكتابة (markIntentional/markIgnored):
// manager فقط — الاستثناءات قرارٌ إداريّ.
export const catalogAnomaliesReadProcedure = protectedProcedure.use(
  requireModuleGate(["manager", "accountant", "auditor"], "catalogAnomalies", "READ")
);
export const catalogAnomaliesManagerProcedure = moduleProcedure(["manager"], "catalogAnomalies", "FULL");
