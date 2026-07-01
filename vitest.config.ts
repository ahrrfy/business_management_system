import path from "node:path";
import "dotenv/config";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@": path.resolve(import.meta.dirname, "client", "src"),
    },
  },
  test: {
    environment: "node",
    include: ["server/**/*.test.ts", "client/src/**/*.test.ts", "shared/**/*.test.ts"],
    setupFiles: ["./server/services/__tests__/__setup__.ts"],
    testTimeout: 30000,
    hookTimeout: 120000,
    fileParallelism: false,
    env: {
      // Integration tests run against a dedicated test database.
      // Each session/agent may set TEST_DATABASE_URL to its own DB to avoid
      // truncation conflicts when running tests concurrently.
      //
      // ⛔ الافتراضي (بلا TEST_DATABASE_URL) يجب ألا يُطابق مطلقاً منفذ erp-mysql-prod
      // (3306 محلياً — مرآة الإنتاج، خط أحمر حسب CLAUDE.md/الذاكرة). يشير الآن لِـ
      // erp-test-db (3310، صندوق القياس المخصَّص) لا 3306 — حادثة حقيقية (١/٧/٢٠٢٦):
      // pre-commit hook شغّل `pnpm test` بلا TEST_DATABASE_URL مُصدَّرة، فسقط صامتاً على
      // الافتراضي القديم (3306) واتّصل فعلياً بحاوية الإنتاج المحلية قبل إيقافه يدوياً (لم
      // يُصِب قاعدة `erp` الحقيقية — الاتصال كان بقاعدة `erp_test` الفارغة على نفس الحاوية
      // فقط، لكن مجرّد الوصول لتلك الحاوية يخرق الخط الأحمر). CI يضبط TEST_DATABASE_URL
      // صراحةً دائماً (راجع .github/workflows/ci.yml) فلا يتأثّر بهذا التغيير.
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "mysql://root:testpw@127.0.0.1:3310/erp_test",
      JWT_SECRET: process.env.JWT_SECRET ?? "test_secret",
    },
  },
});
