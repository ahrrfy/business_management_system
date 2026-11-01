import { afterEach, describe, expect, it, vi } from "vitest";
import { runWithResourceTailScope } from "../../lib/resourceAdmission";
const mocks = vi.hoisted(() => ({ execute: vi.fn(), branch: vi.fn() }));
vi.mock("../../db", () => ({ getDb: () => ({ execute: mocks.execute }) }));
vi.mock("../storefrontService", () => ({
  resolveStorefrontBranchId: mocks.branch,
}));
import { recordStoreConversionMetric } from "../storeAdmin/storeConversionMetricsService";
afterEach(() => vi.resetAllMocks());
describe("existing detached conversion origin", () => {
  it.each([false, true])(
    "tracks before first await and preserves best-effort outcome (failure=%s)",
    async (fail) => {
      let finish!: () => void;
      let active = 0;
      const hold = new Promise<void>((resolve) => {
        finish = resolve;
      });
      mocks.branch.mockImplementation(async () => {
        await hold;
        return 1;
      });
      mocks.execute.mockImplementation(async () => {
        if (fail) throw new Error("metric unavailable");
      });
      const pending = runWithResourceTailScope(
        {
          beginWork() {
            active++;
            return () => {
              active--;
            };
          },
        },
        () =>
          recordStoreConversionMetric({
            event: "ORDER_COMPLETED",
            branchId: 1,
          }),
      );
      expect(active).toBe(1);
      finish();
      expect(await pending).toEqual({ ok: true });
      expect(active).toBe(0);
    },
  );
});
