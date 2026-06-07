import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from "@shared/const";
import { toArabicMessage } from "@shared/errorMap.ar";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import { logger } from "./logger";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  /**
   * يحوّل كل خطأ إلى رسالة عربية مفهومة + correlationId يطابق سجلّ pino،
   * فيرى المستخدم رسالة واضحة بدل رمز فنّي، ويستطيع المالك ذكر الرقم للدعم.
   */
  errorFormatter({ shape, error, ctx, path }) {
    const arabic = toArabicMessage({
      trpcCode: error.code,
      originalMessage: error.message,
      cause: error.cause,
    });
    // معرّف ربط: من pino-http (req.id) إن توفّر.
    const correlationId = (ctx?.req as { id?: string } | undefined)?.id ?? null;

    // سجّل أخطاء النظام (لا أخطاء الإدخال المتوقّعة) للتشخيص.
    if (error.code === "INTERNAL_SERVER_ERROR") {
      logger.error({ err: error.cause ?? error, path, correlationId }, `tRPC error: ${path}`);
    }

    return {
      ...shape,
      message: arabic,
      data: {
        ...shape.data,
        correlationId,
      },
    };
  },
});

export const router = t.router;
export const middleware = t.middleware;
export const publicProcedure = t.procedure;

const requireUser = t.middleware(async ({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }
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
