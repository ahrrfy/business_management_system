import { describe, expect, it, vi } from "vitest";
import {
  createLatestPricingRequestGuard,
  resolveExactBeforeFuzzy,
} from "./productSearchResolution";

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

  it("does not fall back to a fuzzy row after the pricing context becomes stale", async () => {
    const fuzzy = vi.fn(() => "old-context-row");
    await expect(resolveExactBeforeFuzzy(async () => "STALE", fuzzy)).resolves.toEqual({ status: "STALE" });
    expect(fuzzy).not.toHaveBeenCalled();
  });
});

describe("pricing context request guard", () => {
  it("يرفض استجابة A المتأخرة بعد بدء B", async () => {
    const guard = createLatestPricingRequestGuard();
    let currentContext = "customer:A";
    const applied: string[] = [];
    let resolveA!: (value: string) => void;
    let resolveB!: (value: string) => void;
    const responseA = new Promise<string>((resolve) => { resolveA = resolve; });
    const responseB = new Promise<string>((resolve) => { resolveB = resolve; });

    const run = async (context: string, response: Promise<string>) => {
      const token = guard.begin(context);
      const value = await response;
      if (guard.isCurrent(token, currentContext)) applied.push(value);
    };

    const a = run(currentContext, responseA);
    currentContext = "customer:B";
    const b = run(currentContext, responseB);
    resolveB("B");
    await b;
    resolveA("A");
    await a;

    expect(applied).toEqual(["B"]);
  });
});
