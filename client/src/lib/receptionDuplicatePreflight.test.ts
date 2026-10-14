import { describe, expect, it, vi } from "vitest";
import { resolveOnlineDuplicateReference } from "./receptionDuplicatePreflight";

describe("online preparation duplicate reference", () => {
  it("uses the selected order's branch and no account or default branch", async () => {
    const load = vi.fn().mockResolvedValue({ id: 501, branchId: 7 });
    await expect(resolveOnlineDuplicateReference(501, load)).resolves.toEqual({
      branchId: 7,
      reference: { kind: "ONLINE", id: 501 },
    });
    expect(load).toHaveBeenCalledOnce();
  });

  it("refuses a stale different order or missing branch instead of guessing", async () => {
    for (const detail of [
      null,
      undefined,
      { id: 502, branchId: 7 },
      { id: 501 },
      { id: 501, branchId: null },
      { id: 501, branchId: 0 },
      { id: 501, branchId: 1.5 },
    ]) {
      await expect(
        resolveOnlineDuplicateReference(501, async () => detail),
      ).rejects.toThrow();
    }
  });

  it("rejects invalid order identifiers before requesting details", async () => {
    const load = vi.fn().mockResolvedValue({ id: 501, branchId: 7 });
    for (const id of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(resolveOnlineDuplicateReference(id, load)).rejects.toThrow();
    }
    expect(load).not.toHaveBeenCalled();
  });
});
