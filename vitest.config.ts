import path from "node:path";
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
    include: ["server/**/*.test.ts", "client/src/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
    env: {
      // Integration tests run against a dedicated test database.
      DATABASE_URL: "mysql://root:erp_root_pw@127.0.0.1:3306/erp_test",
      JWT_SECRET: "test_secret",
    },
  },
});
