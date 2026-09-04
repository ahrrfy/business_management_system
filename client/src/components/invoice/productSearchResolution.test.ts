import { describe, expect, it, vi } from "vitest";
import { resolveExactBeforeFuzzy } from "./productSearchResolution";

describe("product search resolution order", () => {
  it("does not read fuzzy results after an exact match", async () => {
    const fuzzy = vi.fn(() => "fuzzy");
    await expect(resolveExactBeforeFuzzy(async () => "FOUND", fuzzy)).resolves.toEqual({ status: "FOUND" });
    expect(fuzzy).not.toHaveBeenCalled();
  });

  it("uses fuzzy results only after authoritative NOT_FOUND", async () => {
    const fuzzy = vi.fn(() => "fuzzy");
    await expect(resolveExactBeforeFuzzy(async () => "NOT_FOUND", fuzzy)).resolves.toEqual({ status: "NOT_FOUND", fuzzy: "fuzzy" });
    expect(fuzzy).toHaveBeenCalledOnce();
  });

  it("does not bypass blocked ambiguity or inactive collisions", async () => {
    const fuzzy = vi.fn(() => "wrong-owner");
    await expect(resolveExactBeforeFuzzy(async () => "BLOCKED", fuzzy)).resolves.toEqual({ status: "BLOCKED" });
    expect(fuzzy).not.toHaveBeenCalled();
  });
});
