import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decidePwaUpdateDelivery } from "./PwaUpdateManager";

describe("PWA update delivery policy", () => {
  it("auto-applies a waiting release for a returning public storefront visitor", () => {
    expect(
      decidePwaUpdateDelivery({
        hostname: "alarabiya.online",
        pathname: "/store",
        hasWaitingWorker: true,
      }),
    ).toBe("AUTO_APPLY");
    expect(
      decidePwaUpdateDelivery({
        hostname: "www.alarabiya.online",
        pathname: "/store/product/1",
        hasWaitingWorker: true,
      }),
    ).toBe("AUTO_APPLY");
  });

  it("does nothing for a fresh visitor without a waiting worker", () => {
    expect(
      decidePwaUpdateDelivery({
        hostname: "alarabiya.online",
        pathname: "/store",
        hasWaitingWorker: false,
      }),
    ).toBe("NONE");
  });

  it("keeps the guarded prompt for internal staff and courier surfaces", () => {
    expect(
      decidePwaUpdateDelivery({
        hostname: "srv1548487.hstgr.cloud",
        pathname: "/pos",
        hasWaitingWorker: true,
      }),
    ).toBe("PROMPT");
    expect(
      decidePwaUpdateDelivery({
        hostname: "alarabiya.online",
        pathname: "/my-deliveries",
        hasWaitingWorker: true,
      }),
    ).toBe("PROMPT");
  });

  it("routes the automatic ticket through the same draft-safe activation path", () => {
    const source = readFileSync(new URL("./PwaUpdateManager.tsx", import.meta.url), "utf8");

    expect(source).toContain("setAutoApplyTicket");
    expect(source).toContain("void applyUpdate()");
    expect(source).toContain("saveInteractionDraft()");
    expect(source).toContain("flushAutosaves()");
    expect(source).toContain("autoAttemptedWorkerRef.current !== waitingWorker");
  });
});
