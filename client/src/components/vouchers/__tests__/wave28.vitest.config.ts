import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(process.cwd(), "client/src"),
      "@shared": path.resolve(process.cwd(), "shared"),
    },
  },
  test: {
    environment: "node",
    include: [
      "client/src/components/returns/SalesReturnPortal.unpaid.test.tsx",
      "client/src/components/returns/ReturnComposer.recovery.test.tsx",
      "client/src/components/vouchers/__tests__/voucherFormBehavior.test.tsx",
    ],
  },
});
