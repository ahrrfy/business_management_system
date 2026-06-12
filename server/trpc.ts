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
/** عمليات البيع/الصندوق: الكاشير فأعلى (توافق خلفي كامل). */
export const cashierProcedure = t.procedure.use(requireRole("cashier", "manager"));
/** عمليات المخزون: أمين المخزن فأعلى (توافق خلفي كامل). */
export const warehouseProcedure = t.procedure.use(requireRole("warehouse", "manager"));

/** هل يُسمح لهذا الدور برؤية التكلفة/هامش الربح؟ (يشمل المحاسب الآن). */
export const canSeeCost = (role: string) => _canSeeCost(role);

// ─── عزل الفروع (منع IDOR عبر branchId) ─────────────────────────────────
export const branchScopedProcedure = protectedProcedure.use(({ ctx, next }) => {
  const elevated = ctx.user.role === "admin" || ctx.user.role === "manager";
  const scopedBranchId = elevated ? null : (ctx.user.branchId ?? -1);
  return next({ ctx: { ...ctx, scopedBranchId } });
});
