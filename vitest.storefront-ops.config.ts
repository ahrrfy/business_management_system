import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
    },
  },
  test: {
    environment: "node",
    fileParallelism: false,
    include: [
      "client/src/lib/storefrontRequestPolicy.test.ts",
      "client/src/sentry.test.ts",
      "client/src/components/PwaUpdateManager.test.ts",
      "server/config/storefrontProductionReadiness.test.ts",
      "server/middleware/__tests__/storefrontPublicBatchGuard.test.ts",
      "server/services/__tests__/storefrontOrderGate.test.ts",
      "server/services/__tests__/storefrontTurnstile.test.ts",
    ],
  },
});
