/** حراس تكلفة/تحمل استوديو الصور: السقف اليومي محفوظ، والتزامن/المعدل يمنعان الإغراق. */
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { imageStudioUsageDaily, users } from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  __resetImageStudioUsageGuardForTests,
  IMAGE_STUDIO_DAILY_LIMITS,
  reserveDailyImageStudioUse,
  runGuardedImageStudioCall,
} from "../imageStudioUsageGuard";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function reset() {
  await db().execute(sql`TRUNCATE TABLE \`imageStudioUsageDaily\``);
  await db().execute(sql`TRUNCATE TABLE \`imageStudioUserRateState\``);
  await db().insert(users).values([1, 2, 3, 44, 70, 71].map((id) => ({
    id,
    openId: `image-studio-guard-${id}`,
    name: `Guard ${id}`,
  }))).onDuplicateKeyUpdate({ set: { openId: sql`${users.openId}` } });
  __resetImageStudioUsageGuardForTests();
}

describe("imageStudioUsageGuard", () => {
  beforeEach(reset);
  afterEach(() => __resetImageStudioUsageGuardForTests());

  it("يحجز الاستخدام اليومي ذرّياً ويرفض النداء الذي يتجاوز السقف", async () => {
    const now = new Date("2030-01-02T12:00:00.000Z");
    const first = await reserveDailyImageStudioUse("AI", now);
    expect(first.requestCount).toBe(1);

    await db().insert(imageStudioUsageDaily).values({
      usageDate: first.usageDate,
      service: "REMOVEBG",
      requestCount: IMAGE_STUDIO_DAILY_LIMITS.REMOVEBG - 1,
      lastRequestedAt: now,
    });
    await expect(reserveDailyImageStudioUse("REMOVEBG", now)).resolves.toMatchObject({
      requestCount: IMAGE_STUDIO_DAILY_LIMITS.REMOVEBG,
    });
    await expect(reserveDailyImageStudioUse("REMOVEBG", now)).rejects.toMatchObject({ kind: "DAILY_BUDGET_EXHAUSTED" });
  });

  it("يمنع أكثر من ثلاث محاولات للمستخدم نفسه في الدقيقة", async () => {
    for (let i = 0; i < 3; i += 1) {
      await expect(runGuardedImageStudioCall({ service: "AI", userId: 44, run: async () => "ok" })).resolves.toBe("ok");
    }
    await expect(runGuardedImageStudioCall({ service: "AI", userId: 44, run: async () => "no" })).rejects.toMatchObject({ kind: "RATE_LIMITED" });
  });

  it("لا يسمح بأكثر من اتصالين خارجيين عبر اتصالات MySQL المستقلة ويعيد الخانة بعد التحرير", async () => {
    let releaseFirst: (() => void) | undefined;
    let releaseSecond: (() => void) | undefined;
    let firstStarted!: () => void;
    let secondStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => { firstStarted = resolve; });
    const secondStartedPromise = new Promise<void>((resolve) => { secondStarted = resolve; });
    const first = runGuardedImageStudioCall({
      service: "AI",
      userId: 1,
      run: () => new Promise<string>((resolve) => { releaseFirst = () => resolve("first"); firstStarted(); }),
    });
    await firstStartedPromise;
    const second = runGuardedImageStudioCall({
      service: "REMOVEBG",
      userId: 2,
      run: () => new Promise<string>((resolve) => { releaseSecond = () => resolve("second"); secondStarted(); }),
    });
    await secondStartedPromise;

    await expect(runGuardedImageStudioCall({ service: "AI", userId: 3, run: async () => "third" })).rejects.toMatchObject({ kind: "BUSY" });
    releaseFirst?.();
    releaseSecond?.();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    await expect(runGuardedImageStudioCall({ service: "AI", userId: 3, run: async () => "third-after-release" }))
      .resolves.toBe("third-after-release");
  });

  it("يحرر القفل العالمي إذا رمى المزود خطأ", async () => {
    await expect(runGuardedImageStudioCall({
      service: "AI",
      userId: 70,
      run: async () => { throw new Error("provider failed"); },
    })).rejects.toThrow("provider failed");
    await expect(runGuardedImageStudioCall({ service: "AI", userId: 71, run: async () => "recovered" }))
      .resolves.toBe("recovered");
  });
});
