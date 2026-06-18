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
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "mysql://root:erp_root_pw@127.0.0.1:3306/erp_test",
      JWT_SECRET: process.env.JWT_SECRET ?? "test_secret",
    },
  },
});
