import { defineConfig } from "vitest/config";
import { resolve as resolvePath } from "node:path";

/**
 * Keep the mobile application tests self-contained when this project lives
 * beneath the parent ERP repository. Without this file, Vitest discovers the
 * ERP configuration above this directory instead of testing the Expo project.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": resolvePath(process.cwd()),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
