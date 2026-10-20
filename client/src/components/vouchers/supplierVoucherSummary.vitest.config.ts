import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(import.meta.dirname, "../../../../shared"),
      "@": path.resolve(import.meta.dirname, "../../"),
    },
  },
  test: {
    environment: "jsdom",
    include: [
      "client/src/components/vouchers/SupplierVoucherSettlementSummary.test.tsx",
    ],
  },
});
