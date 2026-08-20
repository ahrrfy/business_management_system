import path from "node:path";
import { defineConfig } from "vitest/config";

/** اختبارات صافية لقواعد أمن حملات متجر العملاء؛ لا تستدعي قاعدة البيانات ولا ملف إعداد التكامل العام. */
export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@": path.resolve(import.meta.dirname, "client", "src"),
    },
  },
  test: {
    environment: "node",
    include: ["server/services/__tests__/storefrontPushCampaignService.test.ts"],
  },
});
