import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["client/src/components/vouchers/voucherUiPolicy.test.ts"],
  },
});
