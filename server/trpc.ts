import { NOT_ADMIN_ERR_MSG, TWO_FACTOR_REQUIRED_ROLES, UNAUTHED_ERR_MSG } from "@shared/const";
import { GENERIC_INTERNAL_AR, mysqlCodeFrom, toArabicMessage } from "@shared/errorMap.ar";
import {
  AI_PROVIDER_ERROR_CATEGORIES,
  type AiProviderErrorCategory,
} from "@shared/productContentAi";
import { canSeeCost as _canSeeCost, canUseStation, moduleAccessAllowed, resolvePermissions, type AccessLevel, type RoleKey } from "@shared/permissions";
import {
  capabilityModuleDecision,
  capabilityShadowEnabled,
  classifyCapabilityShadow,
  deriveCapabilityGrants,
} from "@shared/capabilities";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import { isCurrentNativeClient } from "./auth/deviceProof";
import { isCryptoReady } from "./services/cryptoService";
import { canCrossBranches } from "./lib/branchAuthority";
import { logger } from "./logger";
import {
  automaticActorForProcedure,
  buildAutomaticAuditData,
  logAudit,
  withMutationAuditScope,
} from "./services/auditService";

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
    // providerCategory: فئةُ خطأ مزوّد الذكاء (MODEL_NOT_FOUND/SAFETY/QUOTA/...) — يتيح للعميل
    // إظهار رسالةٍ خاصّةٍ بالفئة (AI_PROVIDER_ERROR_PRESENTATION) بدل رسالةٍ عامّة، بلا تسريب
    // نصّ الخادم الخام (السلامة محفوظة). راجع productContentAiService.ts → AiProviderError.
    return {
      ...shape,
      message: arabic,
      data: {
        ...shape.data,
        correlationId,
        dbCode: mysqlCodeFrom(error.cause),
        providerCategory: providerCategoryFrom(error.cause),
      },
    };
  },
});

const AI_PROVIDER_CATEGORY_SET = new Set<string>(AI_PROVIDER_ERROR_CATEGORIES);

/** يستخرج AiProviderErrorCategory من سلسلة cause (يمشي حتى ٥ مستويات). Duck-typing بلا استيرادٍ
 *  متبادل بين server/trpc.ts وproductContentAiService.ts (الأخير يُنشئ AiProviderError داخلياً). */
function providerCategoryFrom(cause: unknown): AiProviderErrorCategory | null {
  let e: any = cause;
  for (let i = 0; i < 5 && e; i++) {
    if (
      e?.name === "AiProviderError" &&
      typeof e.category === "string" &&
      AI_PROVIDER_CATEGORY_SET.has(e.category)
    ) {
      return e.category as AiProviderErrorCategory;
    }
    e = e?.cause;
  }
  return null;
}

export const router = t.router;
export const middleware = t.middleware;
/**
 * العقد العام لتتبّع الحركات: كل mutation ناجحة، وكل محاولة فاشلة لمستخدم موثّق، تحصل على أثرٍ
 * آمن إن لم تكتب سجلاً متخصصاً. رفض الطلب العام قبل المصادقة يبقى في سجلّ الأمن المحدود المعدّل
 * ولا يتحول إلى INSERT لكل عنصر batch؛ مسارات الدخول والقنوات العامة الحساسة تسجل رفضها صراحةً.
 */
const auditMutationOperation = t.middleware(async ({ ctx, type, path, input, getRawInput, next }) => {
  if (type !== "mutation" || path.startsWith("platformAdmin.")) return next();

  // الجذر يسبق محلّل input في سلسلة tRPC؛ نقرأ الخام المخبّأ كي لا نفقد معرّف هدف update/delete.
  const auditInput = input === undefined ? await getRawInput() : input;
  const { value: result, specializedAuditWritten } = await withMutationAuditScope(() => next());
  // فشل المستخدم الموثّق يُسجّل دائماً: قد يكون logAuditTx قد عُلّم ثم تراجعت معاملته.
  // الفشل غير الموثّق لا يكتب سطراً عاماً كي لا يتحول رفض batch رخيص إلى تضخيم I/O عن بُعد.
  const shouldWriteAutomatic = result.ok ? !specializedAuditWritten : ctx.user != null;
  if (shouldWriteAutomatic) {
    const outcome = result.ok ? "SUCCESS" : "FAILURE";
    await logAudit(
      ctx,
      buildAutomaticAuditData(path, auditInput, result.ok ? result.data : undefined, {
        outcome,
        actor: automaticActorForProcedure(path, ctx.user != null),
      }),
    );
  }
  return result;
});

/** الجذر الوحيد لبناء الإجراءات؛ يحرسه اختبار عقدي كي لا تظهر mutation خارج التدقيق العام. */
const auditedProcedure = t.procedure.use(auditMutationOperation);

export const publicProcedure = auditedProcedure;

// بوابة رمز استعادة كلمة المرور: تظل عامة لأن صاحب الحساب خارج الجلسة، لكنها لا تمرر
// أي طلب إلى قاعدة البيانات ما لم يحمل الشكل المشفّر الكامل للرمز أحادي الاستخدام.
// التحقق الحاسم (hash/expiry/replay/attempts) يبقى ذرياً داخل passwordResetService.
const requirePasswordResetTokenShape = t.middleware(async ({ getRawInput, next }) => {
  const input = (await getRawInput()) as { token?: unknown } | null;
  if (
    !input ||
    typeof input.token !== "string" ||
    !/^PR1-[A-Za-z0-9_-]{16}-[A-Za-z0-9_-]{43}$/.test(input.token.trim())
  ) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "تعذّرت إعادة تعيين كلمة المرور. تحقّق من الرمز أو اطلب رمزاً جديداً من المدير.",
    });
  }
  return next();
});

export const passwordResetTokenProcedure = auditedProcedure.use(requirePasswordResetTokenShape);

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

export const nativeBootstrapProcedure = auditedProcedure.use(requireNativeBootstrapClient);

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

export const protectedProcedure = auditedProcedure.use(requireUser);

/**
 * بوابة المالك الموثّق. هذه قراءة مبكرة لراية الجلسة لتحسين الرفض عند حدود API؛
 * العمليات المالية الحساسة ملزمة بإعادة قراءة isOwner/isActive داخل معاملتها نفسها.
 */
const requireOwnerSession = t.middleware(async ({ ctx, next }) => {
  if (!ctx.user || ctx.user.isOwner !== true) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "هذا الإجراء يتطلب حساب مالك نشطاً",
    });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

export const ownerProcedure = protectedProcedure.use(requireOwnerSession);

/**
 * حدّ قراءة المتجر العام: يبقى بلا جلسة عميل عمداً، لكنه لا يصلح إلا تحت namespace
 * storefront الذي تحميه حدود المعدّل العامة في server/index.ts. الإجراءات الكاتبة لا تستخدمه.
 */
const requireStorefrontPublicPath = t.middleware(({ path, next }) => {
  if (!path.startsWith("storefront.")) {
    throw new TRPCError({ code: "FORBIDDEN", message: "مسار متجر عام غير صالح" });
  }
  return next();
});

export const storefrontPublicReadProcedure = auditedProcedure.use(requireStorefrontPublicPath);

/**
 * كتابة المتجر العامة المنخفضة المخاطر فقط: الحماية الإلزامية تبقى داخل كل معالج
 * (Firebase ID token، Turnstile أحادي الاستخدام، أو رمز جهاز Expo مضبوط) مع حد المعدل
 * الشامل لمسار storefront في index.ts. لا تُستعمل للبيانات الإدارية أو التسعير أو البيع المالي.
 */
export const storefrontPublicWriteProcedure = auditedProcedure.use(requireStorefrontPublicPath);

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

export const adminProcedure = auditedProcedure.use(requireAdmin);

// ─── مدير المنصّة (تعدّد الشركات) — منفصل تماماً عن أدوار أي شركة ──────────
const requirePlatformAdmin = t.middleware(async ({ ctx, next }) => {
  if (!ctx.platformAdmin) throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  return next({ ctx: { ...ctx, platformAdmin: ctx.platformAdmin } });
});

export const platformAdminProcedure = auditedProcedure.use(requirePlatformAdmin);

// ─── تفويض الأدوار (RBAC) ───────────────────────────────────────────────
const FORBIDDEN_MSG = "صلاحيات غير كافية لهذا الإجراء.";

// canCrossBranches: مصدر الحقيقة في server/lib/branchAuthority.ts (وحدة ورقة بلا دورات استيراد).
// نُعيد تصديره هنا ليستورده كودُ الراوترات من "../trpc" كالمعتاد. قرار المالك ١٢/٨: عزل مدير الفرع.
export { canCrossBranches };

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

/**
 * تحقّق القدرات الظِلّيّ (RBAC ش٥ / م٨) — يُستشار **فقط** في وضع الظلّ الموثَّق `AUTHZ_ENGINE=shadow`
 * (معطَّلٌ افتراضياً؛ `capabilityShadowEnabled`)، ولا يغيّر قرار البوّابة القائمة إطلاقاً. يصنّف كلّ بوّابةٍ
 * إلى ثلاثٍ **متمايزة** (`classifyCapabilityShadow`) ويُصدر لكلٍّ حدثاً مناسباً:
 *   · `divergence` — القدراتُ تخالف القرار الحاليّ (الوحدة مُغطّاة) ⇒ `warn` ليُبنى عليه التضييقُ الواعي.
 *   · `uncovered`  — الوحدة/المستوى خارج الكتالوج (كلّ `purchases`، أو `expenses/READ`, `reports/FULL`) ⇒
 *      `debug` كي لا يُحسَب غيرُ المُغطّى **تطابقاً مُتحقَّقاً**؛ لا يُصعَّد خطأً أحمرَ ولا يكسر طلباً.
 *   · `match`      — لا حدث.
 * كلّ حدثٍ يحمل `path` (نقطة النهاية) و`correlationId` (معرِّف الطلب) لتمييز إجراءاتٍ تتشارك بوّابةَ وحدة.
 * ملفوفٌ بـtry/catch: الظلّ **لا يُسقط طلباً أبداً**، فحتى خطأٌ فيه لا يُغيّر السلوك القائم (لا توسيع، لا تضييق).
 */
function auditCapabilityShadow(
  ctx: { user?: { id?: number | string; role?: string } | null; req?: { id?: unknown } | null },
  gate: "requireModule" | "requireModuleGate",
  moduleKey: string,
  minLevel: AccessLevel,
  moduleMap: Record<string, AccessLevel>,
  gateAllowed: boolean,
  path: string,
): void {
  try {
    // req.id = ReqId (string|number من pino-http) — نُطبّعه نصّاً كما في errorFormatter.
    const rawCorrelationId = ctx.req?.id;
    const correlationId = rawCorrelationId == null ? null : String(rawCorrelationId);
    const grants = deriveCapabilityGrants(moduleMap);
    const capabilityAllowed = capabilityModuleDecision(moduleMap, grants, moduleKey, minLevel);
    const outcome = classifyCapabilityShadow(gateAllowed, capabilityAllowed);
    if (outcome === "match") return;
    const fields = {
      gate,
      path,
      moduleKey,
      minLevel,
      gateAllowed,
      capabilityAllowed,
      correlationId,
      userId: ctx.user?.id ?? null,
      role: ctx.user?.role ?? null,
    };
    if (outcome === "divergence") {
      logger.warn(fields, `RBAC capability shadow divergence: ${moduleKey}/${minLevel} @ ${path}`);
    } else {
      // فوات تغطية: ليس خطأً ولا يكسر طلباً — `debug` (كثيرٌ ومتوقَّع؛ أغلبُ المرور غيرُ مُغطّى بالكتالوج).
      logger.debug(fields, `RBAC capability shadow uncovered gate: ${moduleKey}/${minLevel} @ ${path}`);
    }
  } catch (err) {
    logger.warn({ err, gate, path, moduleKey, minLevel }, "RBAC capability shadow check failed (ignored)");
  }
}

/** إنفاذ وحدة بمستوى وصول — يستخدم الخريطة المحسوبة (قالب + override). */
export function requireModule(moduleKey: string, minLevel: AccessLevel) {
  return t.middleware(async ({ ctx, next, path }) => {
    if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
    if (ctx.user.role === "admin") return next({ ctx: { ...ctx, user: ctx.user } });
    const override = (ctx.user as any).permissionsOverride as Record<string, AccessLevel> | null;
    const map = resolvePermissions(ctx.user.role as RoleKey, override);
    const level = map[moduleKey] ?? "NONE";
    const allowed = level === "FULL" || (minLevel === "READ" && level === "READ");
    // م٨: تحقّق القدرات الظِلّيّ في وضع الظلّ الموثَّق (AUTHZ_ENGINE=shadow) — لا يغيّر `allowed` (صفر انحدار).
    if (capabilityShadowEnabled()) auditCapabilityShadow(ctx, "requireModule", moduleKey, minLevel, map, allowed, path);
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
    const gateAllowed = moduleAccessAllowed(ctx.user.role, override, moduleKey, minLevel, allowedRoles);
    // م٨: تحقّق القدرات الظِلّيّ في وضع الظلّ الموثَّق (AUTHZ_ENGINE=shadow) — لا يغيّر `gateAllowed` (صفر
    // انحدار). admin مُستثنى (يعبُر البوّابة دائماً وقدراتُه مُطابِقة تلقائياً، فلا معنى لبناء خريطته للمقارنة).
    if (capabilityShadowEnabled() && ctx.user.role !== "admin") {
      const map = resolvePermissions(ctx.user.role as RoleKey, override);
      auditCapabilityShadow(ctx, "requireModuleGate", moduleKey, minLevel, map, gateAllowed, path);
    }
    if (!gateAllowed) {
      throw new TRPCError({ code: "FORBIDDEN", message: FORBIDDEN_MSG });
    }
    assertTwoFactorEnrolled(ctx.user, path);
    return next({ ctx: { ...ctx, user: ctx.user } });
  });
}

/** إدارة هويات المستخدمين: admin فعلي + بوابة users/FULL صريحة لأدوات الجرد الساكن. */
export const usersAdminProcedure = auditedProcedure
  .use(requireAdmin)
  .use(requireModuleGate(["admin"], "users", "FULL"));

/** إعدادات حاكمة على مستوى الشركة: admin فعلي + settings/FULL + 2FA، لا مدير فرع ولو مُنح override. */
export const settingsAdminProcedure = auditedProcedure
  .use(requireAdmin)
  .use(requireModuleGate(["admin"], "settings", "FULL"));

/** عمليات إدارية/مالية: المدير فأعلى (توافق خلفي كامل). */
export const managerProcedure = auditedProcedure.use(requireRole("manager"));

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
export const reportViewerProcedure = auditedProcedure
  .use(requireModuleGate(["manager", "accountant", "auditor"], "reports", "READ"))
  .use(async ({ ctx, getRawInput, next }) => {
    // عزل الفرع: المالك/الأدمن يعبُران أي فرع؛ غير العابر (بما فيه مدير الفرع) يُرفَض إن طلب فرعاً
    // غير فرعه (أثر forensic صريح بدل قصٍّ صامت) — مرآةٌ لِمنطق managerBranchScopedProcedure.
    if (!ctx.user || canCrossBranches(ctx.user)) return next({ ctx });
    const raw = (await getRawInput()) as { branchId?: number | string } | undefined;
    const requestedBranch = raw?.branchId;
    if (requestedBranch !== undefined && Number(requestedBranch) !== Number(ctx.user.branchId)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن قراءة بيانات فرع آخر" });
    }
    return next({ ctx });
  });
export const managerBranchScopedProcedure = managerProcedure.use(async ({ ctx, getRawInput, next }) => {
  if (canCrossBranches(ctx.user)) return next({ ctx });
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
// فيصبح المستخدم بلا فرع يكتب صامتاً على الفرع رقم ١ (IDOR). **المالك/الأدمن وحدهما**
// مستثنيان (عبور الفروع)؛ مدير الفرع صار مقيَّداً بفرعه — قرار المالك ١٢/٨/٢٦.
const requireOwnBranch = t.middleware(async ({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  // المالك/الأدمن يعبُران الفروع. قرار المالك ١٢/٨: مدير الفرع لم يعُد عابراً — يسقط لفحص «فرعٌ مُسنَد»
  // كالكاشير. **فرضُ فرعه في الكتابة يتمّ داخل الـhandler** (elevated=admin في كل مسار) لا هنا؛ لا نرفض
  // input.branchId الأجنبيّ في هذه البوّابة حفاظاً على سلوك «القصر الصامت على الفرع» القائم للكاشير/المخزن
  // (رفضٌ هنا كان يكسر تدفّقاتٍ مشروعة تمرّر branchId الجهاز — كاشير الأوفلاين/فتح الوردية).
  if (canCrossBranches(ctx.user)) return next({ ctx: { ...ctx, user: ctx.user } });
  if (ctx.user.branchId == null) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

/** عمليات البيع/الصندوق: الكاشير فأعلى (مع فحص branchId إلزامي لغير المدير). */
export const cashierProcedure = auditedProcedure.use(requireRole("cashier", "manager")).use(requireOwnBranch);
/** عمليات المخزون: أمين المخزن فأعلى (مع فحص branchId إلزامي لغير المدير). */
export const warehouseProcedure = auditedProcedure.use(requireRole("warehouse", "manager")).use(requireOwnBranch);
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
  // قرار المالك (١٢/٨/٢٦): عزل مدير الفرع. **فصلُ مُسنَدَين** كانا مدموجَين في «elevated» واحد:
  //   • crossBranch (عبور الفروع) = المالك/الأدمن فقط ⇒ scopedBranchId=null (كلّ الفروع).
  //     كان المدير هنا ⇒ يرى كلّ الفروع؛ الآن يُقيَّد بفرعه المُسنَد (scopedBranchId=فرعه).
  //   • supervisor (يرى كلّ سجلّات فرعه لا ما أنشأه هو فقط) = المالك/الأدمن **والمدير**.
  const crossBranch = canCrossBranches(ctx.user);
  const supervisor = crossBranch || ctx.user.role === "manager";
  if (!crossBranch && ctx.user.branchId == null) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
  }
  const scopedBranchId = crossBranch ? null : Number(ctx.user.branchId);
  // ─── عزل سجلّات الموظف («يرى ما يخصّه فقط») — سياسة المالك (٢٤/٦/٢٦) ───
  // غير المشرفين (كاشير/مندوب/فني…) يرون ما أنشأوه فقط في القوائم الترانزاكشنية
  // (فواتير/عروض/مصروفات/حركات مخزون/أوامر شغل). المالك/الأدمن/المدير = null = كلّ سجلّات النطاق
  // (المدير مشرفُ فرعه فيرى سجلّات موظّفيه داخل فرعه). لا يشمل الكتالوج المشترك (منتجات/عملاء/موردون).
  const scopedOwnerId = supervisor ? null : Number(ctx.user.id);
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
  return auditedProcedure.use(requireModuleGate(allowedRoles, moduleKey, minLevel)).use(requireOwnBranch);
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
): InvoiceScope | null {
  if (user.role === "admin") return "sales";
  const override = user.permissionsOverride as Record<string, AccessLevel> | null | undefined;
  const map = resolvePermissions(user.role as RoleKey, override);
  if (map.sales === "FULL" || map.sales === "READ") return "sales";
  if (map.workorders === "FULL") return "reception";
  // ١٨/٨: كاشير الطباعة (`pos:FULL`, `sales:NONE`) لم يكن يفتح **حتى فاتورته المفردة** — نطاقه
  // كان null. نطاقٌ ثالثٌ يحصره في فواتير وردية PRINT_SERVICES: يرى ما أصدره، ولا يُفتَح له
  // بابٌ على مبيعات التجزئة ولا على عروض الأسعار (تبقى على salesReadProcedure).
  if (map.pos === "FULL") return "print";
  return null;
}

/**
 * نطاق رؤية الفواتير — ثلاثة أوجه لبابٍ واحد:
 *  · `sales`     — وحدة المبيعات (مدير/محاسب/كاشير تجزئة/موظف استقبال بعد 0148): بلا حصر قناة.
 *  · `reception` — صلاحية الاستقبال (`workorders:FULL`): فواتير وردية RECEPTION وحدها.
 *  · `print`     — كاشير الطباعة (`pos:FULL`): فواتير وردية PRINT_SERVICES وحدها.
 */
export type InvoiceScope = "sales" | "reception" | "print";

/**
 * بوّابة **قوائم** الفواتير (١٨/٨) — كانت البوّابة المزدوجة مُطبَّقةً على المستند المفرد
 * (`invoiceViewProcedure`) ولم تُطبَّق قطّ على قائمة: `sales.list` على `salesReadProcedure`
 * وحده ⇒ فنّي المطبعة وكاشير الطباعة (`sales:NONE`) يتلقّون ٤٠٣، وموظف الاستقبال يمرّ بحكم
 * منحةٍ لاحقة (هجرة 0148) لا بحكم التصميم. الآن القائمة والمستند على **نفس المفردة**، ونطاقُ
 * القائمة يُحقن في السياق فتُقصّه شروط الاستعلام (مرآة `sales.get` حرفياً).
 *
 * البديل المرفوض: منح `sales:READ` لأدوار الطباعة عبر هجرةٍ كـ0148 — يفتح **عروض الأسعار**
 * (`quotationRouter` جالسٌ على `salesReadProcedure`) وهو تسريبٌ أُغلق عمداً.
 */
export const invoiceListProcedure = branchScopedProcedure.use(
  t.middleware(async ({ ctx, next }) => {
    if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
    const invoiceListScope = invoiceViewScopeForUser(ctx.user);
    if (!invoiceListScope) throw new TRPCError({ code: "FORBIDDEN", message: FORBIDDEN_MSG });
    return next({ ctx: { ...ctx, user: ctx.user, invoiceListScope } });
  }),
);

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
// inventory (يشمل production/stocktake — كلاهما يُحرّك المخزون)
export const inventoryReadProcedure = branchScopedProcedure.use(requireModule("inventory", "READ"));
export const inventoryWarehouseProcedure = moduleProcedure(["warehouse", "manager"], "inventory", "FULL");
export const inventoryManagerProcedure = moduleProcedure(["manager"], "inventory", "FULL");
/** إنقاذ مخزني شديد الحساسية: بوابة inventory:FULL ثم admin و2FA مركزياً. */
export const inventoryAdminProcedure = inventoryManagerProcedure.use(requireAdmin);
/** طلبات الإقفال الشهري/السنوي: مديرٌ ذو reports:FULL (مع احترام السحب/المنح الصريحين). عمليةٌ **شركةٌ
 *  لا فرع** ⇒ بلا requireOwnBranch (كان moduleProcedure يُلزم فرعاً بعد عزل مدير الفرع ١٢/٨، فيُرفَض
 *  مديرٌ بلا فرع من إقفالٍ لا يخصّ فرعاً بعينه — قرار المالك ١٢/٨ يخصّ عمليات الفرع لا الإقفال الشركيّ). */
export const reportsManagerProcedure = protectedProcedure
  .use(requireModuleGate(["manager"], "reports", "FULL"))
  .use(async ({ ctx, next }) => {
    // الأدوار القياسية (admin/manager) تعبُر بلا فرع — الإقفال شركيٌّ لا يخصّ فرعاً (متّسقٌ مع قرار
    // المالك ١٢/٨: العزل لعمليات الفرع لا للإقفال الشركيّ)؛ دورٌ غير قياسيّ مُنِح reports:FULL صراحةً
    // يبقى مقيَّداً بفرعٍ مُسنَد (تصميم #565 — منحُ التقارير لا يوسّع الحدَّ الفرعيّ لغير المدير).
    if (ctx.user.role === "admin" || ctx.user.role === "manager") return next({ ctx });
    if (ctx.user.branchId == null) {
      throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
    }
    return next({ ctx });
  });
/** اعتماد/رفض الإقفال: بوابة reports:FULL ثم admin و2FA مركزياً. */
export const reportsAdminProcedure = reportsManagerProcedure.use(requireAdmin);
// أسماء توافقية للراوترات القائمة؛ سلطة ملف العميل انتقلت فعلياً إلى وحدة CRM.
export const customersReadProcedure = protectedProcedure.use(requireModule("crm", "READ"));
// print_operator (٧/٨): مرآة POS_STATION_GATES.RECEPTION بالضبط (shared/permissions.ts) — نفس
// الدور الذي يفتح محطة الاستقبال فعلياً (كاشير/مدير/فنّي المطبعة) يحتاج إنشاء عميلٍ من طلب قناة
// (واتساب/انستغرام/تيك توك/اتصال) دون رفض FORBIDDEN — كان مفقوداً هنا رغم وجوده في CHANNEL_READ_ROLES
// وبوّابة محطة الاستقبال، فيرى الموظّف القناة ولا يقدر يحفظ عميلها.
export const customersCashierProcedure = moduleProcedure(["cashier", "manager", "sales_rep", "print_operator"], "crm", "FULL");
export const customersManagerProcedure = moduleProcedure(["manager"], "crm", "FULL");

// (١٢/٨، اصلاح عاجل بطلب المالك): بوّابةُ إنشاء العميل من محطة الاستقبال — تقبل مَن يملك
// crm=FULL (البوّابة القياسية) أو workorders=FULL (بوّابة محطة الاستقبال). السبب: كاشير
// الاستقبال يستقبل طلبات الزبائن ويحتاج حتماً إلى ربطها بسجلٍّ دائم لإكمال الطلب/الحجز/التسليم؛
// وأدوار الاستقبال المخصّصة (حين تُعدَّل crm يدوياً إلى READ) كانت تنكسر رغم إبقاء workorders=FULL.
// هذا هو نفس تعايُش (sales‖workorders) في invoiceViewProcedure أعلاه — قرارٌ متعمَّد بأنّ الوصول
// لمحطة الاستقبال يستتبع القدرة على حفظ عميلها.
export function userHasCrmWriteAccess(user: {
  role: string;
  permissionsOverride?: unknown;
}): boolean {
  if (user.role === "admin") return true;
  const override = user.permissionsOverride as Record<string, AccessLevel> | null | undefined;
  return moduleAccessAllowed(user.role, override, "crm", "FULL", ["cashier", "manager", "sales_rep", "print_operator"]);
}

export function customerReceptionCreateAllowed(user: {
  role: string;
  permissionsOverride?: unknown;
}): boolean {
  if (user.role === "admin") return true;
  if (userHasCrmWriteAccess(user)) return true;
  const override = user.permissionsOverride as Record<string, AccessLevel> | null | undefined;
  // (١٢/٨، قرار المالك العاجل — يُلغي حاجز crm≥READ من مراجعة Codex P1): كاشير الاستقبال بدور
  // مخصّص crm=NONE + workorders=FULL يمرّ أيضاً. سبب: قرار المالك «كاشير الاستقبال يحفظ العميل
  // ويبيع بلا عربون» صريحٌ ومطلق. حالة CONFLICT الهاتف (Codex P1-٢) نظرية: تحدث فقط عند تكرار
  // هاتفٍ حرفياً، ورسالة الخادم «العميل موجود بنفس الرقم» تُعلم الموظّف صراحةً فيُصعّد للمدير.
  // POS_STATION_GATES.RECEPTION.allowedRoles = ["cashier", "manager", "print_operator"]
  return moduleAccessAllowed(user.role, override, "workorders", "FULL", ["cashier", "manager", "print_operator"]);
}

export const customersReceptionCreateProcedure = branchScopedProcedure.use(
  t.middleware(async ({ ctx, next }) => {
    if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
    if (!customerReceptionCreateAllowed(ctx.user)) {
      throw new TRPCError({ code: "FORBIDDEN", message: FORBIDDEN_MSG });
    }
    return next({ ctx: { ...ctx, user: ctx.user } });
  }),
);

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
export const courierProcedure = auditedProcedure.use(requireModuleGate(["courier"], "courier", "FULL"));
// قراءات مركز التوصيل (/delivery) — مقيّدة بوحدة store: كل مستعملي الشاشة (manager/cashier FULL،
// accountant/auditor READ، admin يعبُر) يملكون store≥READ، بينما courier=NONE ⇒ محجوبٌ من قراءة
// عهدة/بيانات جهات أخرى وPII زبائن الإرساليات (مراجعة عدائية ١٢/٧: branchScoped وحده لا يستشير
// خريطة الصلاحيات فيسرّبها لأي مستخدم مصادَق ذي فرع). branchScoped ⇒ يبقى scopedBranchId للعزل.
export const deliveryReadProcedure = branchScopedProcedure.use(requireModule("store", "READ"));
// Supervisory delivery mutations are part of the store/delivery back office,
// but must still honor explicit module grants and branch scope. Keep the cash
// operation narrower than storeFulfillProcedure: only cashier/manager may pay
// a courier fee from a drawer.
export const deliveryManagerProcedure = moduleProcedure(["manager"], "store", "FULL");
/** عمليات توصيل شديدة الحساسية: بوابة store:FULL ثم admin و2FA مركزياً. */
export const deliveryAdminProcedure = deliveryManagerProcedure.use(requireAdmin);
export const deliveryCashierProcedure = moduleProcedure(["cashier", "manager"], "store", "FULL");
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
// forPurchase (بحث منتجات جانب الشراء — يكشف التكلفة): مسؤول الشراء يبني الفاتورة، وأمين المخزن
// يحتاج قراءة بيانات الوحدة/التكلفة لأعمال الجرد والتحقيق. قراءة فقط،
// ومحصور بأدوار الشراء + المدير ⇒ لا تتسرّب التكلفة للكاشير/المندوب/المستخدم العام.
export const productsPurchaseProcedure = moduleProcedure(["manager", "warehouse", "purchasing"], "products", "READ");
// استوديو المنتجات وحدة مستقلة: العامل يقرأ/يكتب الصور والمحتوى المقترح فقط، ولا يعبر بوابة
// products التي تكشف السعر/التكلفة/المخزون. المدير يملك الإسناد والاعتماد النهائي.
export const productStudioReadProcedure = branchScopedProcedure.use(requireModule("productStudio", "READ"));
export const productStudioWriteProcedure = branchScopedProcedure.use(requireModule("productStudio", "FULL"));
// الاعتماد/الرفض/الإسناد سلطة إشرافية فعلية: منح FULL لموظف يفتح أدوات التنفيذ فقط ولا يحوّله
// إلى مدير. خدمة الاستوديو تعيد الفحص أيضاً؛ هذه البوابة تمنع حتى بلوغها وتوحّد عقد الواجهة.
export const productStudioManagerProcedure = managerProcedure.use(requireModule("productStudio", "FULL"));
/**
 * إعدادات مزوّد الصور المدفوع (حصص الفروع): بوّابة `productStudio:FULL` **ثمّ** admin —
 * نظيرُ `inventoryAdminProcedure`. لماذا لا `adminProcedure` عارياً: سلطةٌ بلا بوّابة وحدة
 * لا تظهر في خريطة الصلاحيات ولا يمكن سحبُها بمنحٍ صريح، ويرفضها حارس CI التفاضليّ.
 *
 * وبلا `requireOwnBranch`: العملية **شركةٌ لا فرع** (تضبط حصص كل الفروع معاً)، فإلزامُ
 * فرعٍ مُسنَد يرفض مديراً عاماً بلا فرع — نفس علّة الإقفال الشهريّ ونفس علاجها.
 */
export const productStudioAdminProcedure = protectedProcedure
  .use(requireModuleGate(["manager"], "productStudio", "FULL"))
  .use(requireAdmin);
// expenses — «محاسب» قالبه expenses=FULL ⇒ يدخل بوّابة الإدخال (الإلغاء يبقى مديرياً).
export const expensesReadProcedure = branchScopedProcedure.use(requireModule("expenses", "READ"));
export const expensesCashierProcedure = moduleProcedure(["cashier", "manager", "accountant"], "expenses", "FULL");
export const expensesManagerProcedure = moduleProcedure(["manager"], "expenses", "FULL");
/**
 * فئات المصروفات — بياناتٌ مرجعية عامّة (الجدول بلا `branchId`)، فلا معنى لاشتراط فرعٍ مُسنَد
 * ولا لعزلٍ فرعيّ. القراءة بخريطة الوحدة وحدها كي يراها **كل من يُنشئ مصروفاً** (الكاشير منهم،
 * وقالبه expenses=FULL) وإلّا ظهر له منتقٍ فارغ؛ والكتابة بقائمة الإدارة (مدير/محاسب) + المنح
 * الصريح. نظير `treasuryGlobal*` لفئات السندات — راجع تعليقها لسبب فصل «العامّ» عن المقصور بالفرع.
 */
export const expensesGlobalReadProcedure = protectedProcedure.use(requireModule("expenses", "READ"));
export const expensesGlobalProcedure = auditedProcedure.use(
  requireModuleGate(["manager", "accountant"], "expenses", "FULL"),
);
// workorders (خدمة العملاء)
export const workordersReadProcedure = branchScopedProcedure.use(requireModule("workorders", "READ"));
export const workordersCashierProcedure = moduleProcedure(["cashier", "manager"], "workorders", "FULL");
export const workordersExecProcedure = moduleProcedure(["cashier", "manager", "print_operator"], "workorders", "FULL");
export const workordersManagerProcedure = moduleProcedure(["manager"], "workorders", "FULL");
/**
 * **الإلغاءُ المباشر لأمر الشغل** — مدير **أو فنّي مطبعة** (قرار المالك ١/٩/٢٦: الفنّي أوّلُ من
 * يتحدّث مع العميل وإليه يتّصل ليُلغي). والحدُّ الفاصل بعد البوّابة هو **المال**: الخدمة ترفض
 * أيَّ إلغاءٍ مباشر فيه عربونٌ أو مقبوضٌ أو أمانةُ أجرة، أو بدأ إنتاجُه.
 *
 * ⛔ **الكاشير ليس منها عمداً**: مساره `requestControl` كما كان قبل هذه الشريحة. توسيعُه إلى
 * `workordersExecProcedure` كان سيسحبه معه صامتاً وينقض عقد RBAC المُختبَر («الكاشير ممنوع من
 * العمليات الإدارية: لا يلغي أمر شغل») — والمالكُ طلب صلاحيةً للفنّي لا إعادةَ توزيعٍ للسلطة.
 * والبوّابةُ هنا لا في الخدمة وحدها: عقدُ RBAC يتوقّع `FORBIDDEN` **قبل** تحقّق المدخلات.
 */
export const workordersDirectCancelProcedure = moduleProcedure(["manager", "print_operator"], "workorders", "FULL");

// ─── F7 (تدقيق ٢/٧): بوّابات الوحدة المالية «treasury» ─────────────────────────
// «محاسب» قالبه treasury=FULL ووصفه المعلن يشمل الخزينة والسندات — كان مصدوداً.
// **الورديات بمستوى READ** لأن قالب cashier treasury=READ (فتح/إغلاق الوردية سلوك كاشير قائم).
export const treasuryManagerProcedure = moduleProcedure(["manager", "accountant"], "treasury", "FULL");
export const treasuryManagerReadProcedure = moduleProcedure(["manager", "accountant"], "treasury", "READ");
export const treasuryReadProcedure = branchScopedProcedure.use(requireModule("treasury", "READ"));
export const treasuryCashierProcedure = moduleProcedure(["cashier", "manager"], "treasury", "READ");
/**
 * قائمة مستلمي عهد النقد تخدم الكاشير عند إغلاق الوردية، وتخدم المدير أو
 * المحاسب عند إعادة إسناد عهدة معلّقة. فصلها عن بوابة الكاشير يمنع توسيع
 * بقية طفرات الوردية للمحاسب، مع إبقاء المنح الصريح وعزل الفرع.
 */
export const treasuryHandoverRecipientsProcedure = moduleProcedure(
  ["cashier", "manager", "accountant"],
  "treasury",
  "READ",
);
/**
 * بيانات مرجعية عامّة للخزينة (فئات السندات) — **بلا اشتراط فرعٍ مُسنَد**.
 *
 * `moduleProcedure` يُلحق `requireOwnBranch` بكل إجراءاته، وهو الصواب لكل ما يمسّ صندوق فرعٍ
 * أو سنداً. لكن `voucherCategories` جدولٌ عالميّ بلا عمود `branchId` أصلاً؛ فربطُ إدارته
 * بالفرع كان يمنع محاسب الإدارة (بلا فرعٍ مُسنَد — وهو وضعٌ مشروع: يخدم الفرعين) من إنشاء
 * فئةٍ أو تعديلها برسالة «لا فرع مُسنَد لهذا المستخدم»، بينما نفس الحساب يقرأ/يكتب في وحدة
 * الخزينة. البوّابة الأمنية نفسها (treasury FULL/READ لـmanager/accountant + منح صريح) بلا
 * تخفيف — الفارق الوحيد إسقاطُ شرطٍ لا معنى له لبيانات غير مقصورة بفرع.
 * ⚠️ لا تستعملها لأيّ إجراءٍ يقرأ/يكتب `receipts` (المعالجة التاريخية والدمج يبقيان مقصورين).
 */
export const treasuryGlobalProcedure = auditedProcedure.use(
  requireModuleGate(["manager", "accountant"], "treasury", "FULL"),
);
export const treasuryGlobalReadProcedure = auditedProcedure.use(
  requireModuleGate(["manager", "accountant"], "treasury", "READ"),
);

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

// ─── إعلانات الموظفين «announcements» — الإدارة تنشئ/تستهدف/تتابع الإقرار ────────────
// الإنشاء والإدارة مديريّ (manager+ أو منح صريح announcements:FULL)؛ القراءة الذاتيّة للموظف
// (mine/markRead/acknowledge) تمرّ عبر protectedProcedure داخل الراوتر — أيّ موظف مصادَق يقرأ
// إعلاناته المستهدَفة فقط (الحارس في الخدمة يتحقّق من الجمهور، منعاً لـIDOR).
export const announcementsManagerProcedure = moduleProcedure(["manager"], "announcements", "FULL");
// القراءة الإدارية (قائمة/تفاصيل/إحصاء القرّاء): announcements≥READ — يشمل المدقّق (auditor READ) للرقابة.
export const announcementsReadProcedure = protectedProcedure.use(requireModule("announcements", "READ"));
