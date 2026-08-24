import { defineConfig } from "vitest/config";

/**
 * Keep the mobile application tests self-contained when this project lives
 * beneath the parent ERP repository. Without this file, Vitest discovers the
 * ERP configuration above this directory instead of testing the Expo project.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
