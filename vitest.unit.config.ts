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
      "server/services/__tests__/couponService.test.ts",
      "server/services/__tests__/businessDay.test.ts",
      "server/services/__tests__/permissionParity.test.ts",
    ],
  },
});
