import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(import.meta.dirname, "../../shared"),
      "@": path.resolve(import.meta.dirname, "../../client/src"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/stress/**/*.test.ts"],
  },
});
