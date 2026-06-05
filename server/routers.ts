import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { invoiceRouter } from "./routers/invoiceRouter";
import { biometricRouter } from "./routers/biometricRouter";
import { productRouter, customerRouter } from "./routers/productRouter";
import { supplierRouter, purchaseRouter, accountsRouter, hrRouter, inventoryRouter } from "./routers/businessRouter";
import { importExportRouter } from "./routers/importExportRouter";
import { dashboardRouter } from "./routers/dashboardRouter";

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
  suppliers: supplierRouter,
  purchases: purchaseRouter,
  accounts: accountsRouter,
  hr: hrRouter,
  importExport: importExportRouter,
  inventory: inventoryRouter,
  dashboard: dashboardRouter,
});

export type AppRouter = typeof appRouter;
