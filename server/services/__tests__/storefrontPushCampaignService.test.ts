import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  STOREFRONT_PUSH_WORKER_LIMITS,
  createStorefrontPushWorkerRuntime,
  runStorefrontPushSettled,
  validateExpoPushToken,
  validateStorefrontPushDestination,
  StorefrontPushValidationError,
} from "../storeAdmin/storefrontPushCampaignService";

describe("storefront push campaign validation", () => {
  it("accepts Expo tokens and internal storefront paths only", () => {
    expect(validateExpoPushToken("ExponentPushToken[Abcdefghijk_123456789]")).toContain("ExponentPushToken[");
    expect(validateStorefrontPushDestination("/product/42")).toBe("/product/42");
    expect(validateStorefrontPushDestination("/orders")).toBe("/orders");
  });

  it("rejects arbitrary URLs and malformed device tokens", () => {
    expect(() => validateStorefrontPushDestination("https://attacker.example")).toThrow(StorefrontPushValidationError);
    expect(() => validateStorefrontPushDestination("//attacker.example")).toThrow(StorefrontPushValidationError);
    expect(() => validateExpoPushToken("not-a-device-token")).toThrow(StorefrontPushValidationError);
  });
});

describe("storefront push worker reliability budgets", () => {
  it("يشغّل كل العناصر بـallSettled ولا يتجاوز حد التزامن حتى مع فشل عنصر", async () => {
    let active = 0;
    let maxActive = 0;
    const worker = vi.fn(async (value: number) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      if (value === 7) throw new Error("isolated failure");
      return value * 2;
    });

    const settled = await runStorefrontPushSettled(
      Array.from({ length: 17 }, (_, index) => index + 1),
      STOREFRONT_PUSH_WORKER_LIMITS.maxConcurrency,
      worker,
    );

    expect(worker).toHaveBeenCalledTimes(17);
    expect(settled).toHaveLength(17);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(maxActive).toBeLessThanOrEqual(STOREFRONT_PUSH_WORKER_LIMITS.maxConcurrency);
    expect(STOREFRONT_PUSH_WORKER_LIMITS.maxConcurrency).toBeLessThanOrEqual(4);
  });

  it("يمسك خطأ tick وينتظر stop الدورة الجارية فعلياً", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const onError = vi.fn();
    const runtime = createStorefrontPushWorkerRuntime({
      intervalMs: 60_000,
      runBatch: async () => gate,
      onError,
    });

    expect(runtime.start()).toBe(true);
    let stopped = false;
    const stopping = runtime.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
    expect(onError).not.toHaveBeenCalled();

    const rejected = createStorefrontPushWorkerRuntime({
      intervalMs: 60_000,
      runBatch: async () => { throw new Error("tick failed"); },
      onError,
    });
    rejected.start();
    await rejected.stop();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("لا يزيد attemptCount أثناء claim ويزيده فقط عند إنهاء محاولة بدأت", () => {
    const source = readFileSync(
      new URL("../storeAdmin/storefrontPushCampaignService.ts", import.meta.url),
      "utf8",
    );
    const claim = source.slice(source.indexOf("async function claimDeliveries"), source.indexOf("async function sendExpoPush"));
    expect(claim).not.toContain("attemptCount = attemptCount + 1");
    expect(source).toContain("attemptCount = attemptCount + 1");
    expect(source).toContain("Promise.allSettled");
  });
});
