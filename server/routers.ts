import { publicProcedure, router } from "./trpc";
import { authRouter } from "./routers/authRouter";
import { saleRouter } from "./routers/saleRouter";
import { purchaseRouter } from "./routers/purchaseRouter";
import { inventoryRouter } from "./routers/inventoryRouter";
import { returnRouter } from "./routers/returnRouter";
import { shiftRouter } from "./routers/shiftRouter";
import { catalogRouter } from "./routers/catalogRouter";

/**
 * Root API router. Business module routers are mounted here as they are built.
 */
export const appRouter = router({
  system: router({
    health: publicProcedure.query(() => ({
      ok: true,
      time: new Date().toISOString(),
    })),
  }),
  auth: authRouter,
  sales: saleRouter,
  purchases: purchaseRouter,
  inventory: inventoryRouter,
  returns: returnRouter,
  shifts: shiftRouter,
  catalog: catalogRouter,
});

export type AppRouter = typeof appRouter;
