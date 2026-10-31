import path from "node:path";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@": path.resolve(import.meta.dirname, "client/src"),
    },
  },
  test: {
    environment: "node",
    fileParallelism: false,
    testTimeout: 15000,
    env: { VITEST_UNIT_SUITE: "1" },
    include: [
      "client/src/lib/offline/outbox.test.ts",
      "client/src/components/returns/ReturnComposer.recovery.test.tsx",
      "client/src/lib/persistedFinancialIntent.test.ts",
      "client/src/components/invoice/QuickSalesPaymentDialog.current.test.tsx",
      "client/src/components/invoice/InvoiceDetailDrawer.current.test.tsx",
      "client/src/components/purchases/SupplierPaymentsGovernanceWorkspace.recovery.test.tsx",
      "server/services/__tests__/storefrontMobilePushRetirement.unit.test.ts",
    ],
  },
});
