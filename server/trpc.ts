import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from "@shared/const";
import { toArabicMessage } from "@shared/errorMap.ar";
import { canSeeCost as _canSeeCost, resolvePermissions, type AccessLevel, type RoleKey } from "@shared/permissions";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import { logger } from "./logger";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error, ctx, path }) {
    const arabic = toArabicMessage({
      trpcCode: error.code,
      originalMessage: error.message,
      cause: error.cause,
    });
    const correlationId = (ctx?.req as { id?: string } | undefined)?.id ?? null;
    if (error.code === "INTERNAL_SERVER_ERROR") {
      logger.error({ err: error.cause ?? error, path, correlationId }, `tRPC error: ${path}`);
    } else if (error.code === "FORBIDDEN" || error.code === "UNAUTHORIZED") {
      // F5 (تدقيق ١٤/٦/٢٦): محاولات التجاوز الفاشلة كانت تمرّ صامتة ⇒ لا أثر forensic.
      // نُسجِّل في pino البنيوي (best-effort، خفيف، بلا i/o إضافي على القاعدة).
      // إن لزم لاحقاً سجلٌّ دائم: interceptor مستقلّ يكتب في auditLogs (errorFormatter sync).
      logger.warn(
        { path, correlationId, userId: ctx?.user?.id ?? null, role: ctx?.user?.role ?? null, code: error.code, message: error.message },
        `authz denied: ${path}`,
      );
    }
    return { ...shape, message: arabic, data: { ...shape.data, correlationId } };
  },
});

export const router = t.router;
export const middleware = t.middleware;
export const publicProcedure = t.procedure;

const requireUser = t.middleware(async ({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  return next({ ctx: { ...ctx, user: ctx.user } });
});

export const protectedProcedure = t.procedure.use(requireUser);

const requireAdmin = t.middleware(async ({ ctx, next }) => {
  if (!ctx.user || ctx.user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

export const adminProcedure = t.procedure.use(requireAdmin);

// ─── تفويض الأدوار (RBAC) ───────────────────────────────────────────────
const FORBIDDEN_MSG = "صلاحيات غير كافية لهذا الإجراء.";

function requireRole(...allowed: string[]) {
  return t.middleware(async ({ ctx, next }) => {
    if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
    if (ctx.user.role !== "admin" && !allowed.includes(ctx.user.role)) {
      throw new TRPCError({ code: "FORBIDDEN", message: FORBIDDEN_MSG });
    }
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

/** عمليات إدارية/مالية: المدير فأعلى (توافق خلفي كامل). */
export const managerProcedure = t.procedure.use(requireRole("manager"));
export const managerBranchScopedProcedure = managerProcedure.use(({ ctx, input, next }) => {
  if (ctx.user.role === "admin") return next({ ctx });
  const requestedBranch = (input as any)?.branchId;
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
/**
 * تنفيذ أوامر الشغل في المحطة (سحب/بدء/تجهيز): الكاشير/المدير + **فني المطبعة** (print_operator)،
 * بفرع مُسنَد إلزامي لغير المدير. لا يشمل التسليم/الفوترة (cashierProcedure حصراً — مالٌ ونقد).
 * عزلٌ إضافي في الخدمة: فني المطبعة يعمل على أوامره المُسنَدة إليه فقط (لا أوامر زملائه).
 */
export const workOrderExecProcedure = t.procedure
  .use(requireRole("cashier", "manager", "print_operator"))
  .use(requireOwnBranch);

/** هل يُسمح لهذا الدور برؤية التكلفة/هامش الربح؟ (يشمل المحاسب الآن). */
export const canSeeCost = (role: string) => _canSeeCost(role);

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
  return next({ ctx: { ...ctx, scopedBranchId } });
});
