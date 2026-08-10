import path from "node:path";
import { defineConfig } from "vitest/config";

/** اختبارات منطقية خالصة لا تحتاج قاعدة MySQL؛ تبقى منفصلة عن حزمة التكامل التي تنظف قاعدة الاختبار. */
export default defineConfig({
  resolve: { alias: { "@shared": path.resolve(import.meta.dirname, "shared"), "@": path.resolve(import.meta.dirname, "client", "src") } },
  test: {
    environment: "node",
    include: [
      "client/src/lib/printing/couponCard.test.ts",
      "client/src/lib/printing/barcode.test.ts",
      "client/src/lib/printing/labelDesign.test.ts",
      "client/src/lib/printing/labelLayout.test.ts",
      "client/src/lib/printing/labelItem.test.ts",
      "client/src/lib/printing/labelSize.test.ts",
      "client/src/lib/commissions/example.test.ts",
      "client/src/lib/navVisibility.test.ts",
      "client/src/lib/cartDraft.test.ts",
      "client/src/lib/pwaUpdateLifecycle.test.ts",
      "client/src/components/scan/BarcodeSearchCue.test.ts",
      "server/services/__tests__/couponService.test.ts",
      "server/services/__tests__/businessDay.test.ts",
      "server/services/__tests__/reconcileSummary.test.ts",
      "server/services/__tests__/permissionParity.test.ts",
      "server/services/__tests__/globalSearchRbac.test.ts",
      "server/services/hrDevices/__tests__/bridgeSecurity.test.ts",
      "server/services/hrDevices/__tests__/bridgeGate.test.ts",
      "server/routers/__tests__/superAppAuthority.test.ts",
    ],
  },
});
