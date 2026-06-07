import { publicProcedure, router } from "./trpc";
import { authRouter } from "./routers/authRouter";
import { saleRouter } from "./routers/saleRouter";
import { purchaseRouter } from "./routers/purchaseRouter";
import { inventoryRouter } from "./routers/inventoryRouter";
import { returnRouter } from "./routers/returnRouter";
import { shiftRouter } from "./routers/shiftRouter";
import { catalogRouter } from "./routers/catalogRouter";
import { supplierRouter } from "./routers/supplierRouter";
import { branchRouter } from "./routers/branchRouter";
import { workOrderRouter } from "./routers/workOrderRouter";
import { customerRouter } from "./routers/customerRouter";
import { expenseRouter } from "./routers/expenseRouter";
import { reportsRouter } from "./routers/reportsRouter";

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
  suppliers: supplierRouter,
  branches: branchRouter,
  workOrders: workOrderRouter,
  customers: customerRouter,
  expenses: expenseRouter,
  reports: reportsRouter,
});

export type AppRouter = typeof appRouter;
