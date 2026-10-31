import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  database: vi.fn(),
  query: vi.fn(async (sql: string) =>
    sql.trimStart().startsWith("SELECT") ? [[], []] : [{ affectedRows: 0 }, []],
  ),
}));
vi.mock("../../db", () => {
  const connection = {
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release() {},
    execute: (sql: string) => state.query(sql),
  };
  return {
    getDb: () => {
      state.database();
      return {};
    },
    getPool: () => ({
      getConnection: async () => connection,
      execute: (sql: string) => state.query(sql),
    }),
  };
});
vi.mock("../../logger", () => ({ logger: { error: vi.fn(), warn: vi.fn() } }));
import {
  approveStorefrontPushCampaign,
  createStorefrontPushCampaign,
  enqueueStorefrontOrderStatusPush,
  listStorefrontPushCampaigns,
  queueDueStorefrontPushCampaigns,
  registerStorefrontPushDevice,
  runStorefrontPushDeliveryBatch,
  scheduleStorefrontPushCampaign,
  startStorefrontPushCampaignWorker,
  stopStorefrontPushCampaignWorker,
} from "../storeAdmin/storefrontPushCampaignService";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("STOREFRONT_MOBILE_PUSH_ENABLED", "0");
  state.query.mockClear();
  state.database.mockClear();
  vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("external network forbidden"),
  );
});
afterEach(async () => {
  await stopStorefrontPushCampaignWorker();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
describe("retired customer mobile channel resource budget", () => {
  it("registers no timer and performs no database/network work while explicitly disabled", async () => {
    expect(startStorefrontPushCampaignWorker()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await runStorefrontPushDeliveryBatch()).toEqual({
      queuedCampaigns: 0,
      claimed: 0,
      sent: 0,
      retried: 0,
      gone: 0,
      failed: 0,
      errored: 0,
    });
    expect(await queueDueStorefrontPushCampaigns()).toBe(0);
    expect(state.query).not.toHaveBeenCalled();
    expect(state.database).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("suppresses only the mobile order notification without accessing the domain transaction", async () => {
    const untouched = new Proxy(
      {},
      {
        get() {
          throw new Error("disabled channel touched transaction");
        },
      },
    );
    const result = await enqueueStorefrontOrderStatusPush(
      untouched as Parameters<typeof enqueueStorefrontOrderStatusPush>[0],
      { orderId: 1, orderNumber: "LAB-1", customerId: 2, status: "CONFIRMED" },
    );
    expect(result).toEqual({ campaignId: null, recipientCount: 0 });
    expect(state.database).not.toHaveBeenCalled();
  });
  it("refuses new tokens/campaigns and preserves the queue without touching SQL", async () => {
    await expect(
      registerStorefrontPushDevice({
        expoPushToken: "ExpoPushToken[abcdefgh]",
        marketingOptIn: true,
        transactionalOptIn: true,
        platform: "ANDROID",
        appVersion: "1.0.0",
      }),
    ).rejects.toThrow("متوقفة");
    await expect(
      createStorefrontPushCampaign(
        {
          name: "Lab",
          kind: "MARKETING",
          title: "Lab",
          body: "Lab",
          destination: "/orders",
          throttlePerMinute: 10,
        },
        1,
      ),
    ).rejects.toThrow("متوقفة");
    await expect(approveStorefrontPushCampaign(1, 2)).rejects.toThrow("متوقفة");
    await expect(scheduleStorefrontPushCampaign(1, new Date())).rejects.toThrow(
      "متوقفة",
    );
    expect(state.query).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("retains read access to existing campaigns", async () => {
    expect(await listStorefrontPushCampaigns()).toEqual([]);
    expect(state.query).toHaveBeenCalledTimes(1);
  });
  it("restores the existing worker and bounded polling with the rollback setting", async () => {
    vi.stubEnv("STOREFRONT_MOBILE_PUSH_ENABLED", "1");
    expect(startStorefrontPushCampaignWorker()).toBe(true);
    expect(startStorefrontPushCampaignWorker()).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.query).toHaveBeenCalledTimes(48);
    expect(fetch).not.toHaveBeenCalled();
    await stopStorefrontPushCampaignWorker();
    expect(vi.getTimerCount()).toBe(0);
  });
});
