import path from "node:path";
import { defineConfig } from "vitest/config";

/** Harness صافي لحدود مسح/ذاكرة كتالوج المتجر؛ لا يحتاج MySQL ولا تنظيف قاعدة التكامل. */
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
      "server/services/__tests__/storefrontPerformance.test.ts",
      "server/lib/imageStore/__tests__/publicProductImageContract.test.ts",
    ],
  },
});
