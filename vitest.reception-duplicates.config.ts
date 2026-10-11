import path from "node:path";
import { defineConfig } from "vitest/config";

// Focused pure tests; integration coverage remains included by the main CI test config.
export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@": path.resolve(import.meta.dirname, "client", "src"),
    },
  },
  test: {
    environment: "node",
    include: [
      "shared/receptionDuplicateOrders.test.ts",
      "server/services/reception/duplicateOrders.test.ts",
      "client/src/components/reception/ReceptionDuplicateAlert.test.tsx",
      "client/src/pages/__tests__/OrderFulfillment.test.tsx",
    ],
    fileParallelism: false,
  },
});
