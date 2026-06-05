import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { invoiceRouter } from "./routers/invoiceRouter";
import { biometricRouter } from "./routers/biometricRouter";
import { productRouter, customerRouter } from "./routers/productRouter";

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),
  invoices: invoiceRouter,
  biometric: biometricRouter,
  products: productRouter,
  customers: customerRouter,
});

export type AppRouter = typeof appRouter;
