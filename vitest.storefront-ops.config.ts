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
      "client/src/lib/pwaUpdateLifecycle.test.ts",
      "client/src/lib/realtime/__tests__/tabCoordinator.test.ts",
      "client/src/components/InteractionDraftSafety.test.ts",
      "client/src/lib/interactionDraft.test.ts",
      "server/config/storefrontProductionReadiness.test.ts",
      "server/middleware/__tests__/storefrontPublicBatchGuard.test.ts",
      "server/realtime/__tests__/sseStream.test.ts",
      "server/realtime/__tests__/pwaQuiesceRouter.test.ts",
      "server/realtime/__tests__/bridge.test.ts",
      "server/services/__tests__/storefrontOrderGate.test.ts",
      "server/services/__tests__/storefrontTurnstile.test.ts",
    ],
  },
});
