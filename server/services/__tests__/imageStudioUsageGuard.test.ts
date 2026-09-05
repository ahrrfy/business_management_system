/** بوابة تنفيذ مزوّدي الاستوديو: لا حصص استخدام داخلية، مع إبقاء سقف التزامن التقني. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../db";
import {
  __resetImageStudioUsageGuardForTests,
  runGuardedImageStudioCall,
} from "../imageStudioUsageGuard";

describe("imageStudioUsageGuard", () => {
  beforeEach(() => {
    if (!getDb()) throw new Error("DATABASE_URL not set for tests");
    __resetImageStudioUsageGuardForTests();
  });
  afterEach(() => __resetImageStudioUsageGuardForTests());

  it("لا يرفض النداء بسبب عدّاد يومي داخلي؛ الميزانية يحكمها المزوّد", async () => {
    for (let i = 0; i < 25; i += 1) {
      await expect(runGuardedImageStudioCall({ service: i % 2 === 0 ? "REMOVEBG" : "AI", userId: 70, run: async () => "ok" }))
        .resolves.toBe("ok");
    }
  });

  it("يسمح بعدد غير محدود من المحاولات للمستخدم نفسه", async () => {
    for (let i = 0; i < 10; i += 1) {
      await expect(runGuardedImageStudioCall({ service: "AI", userId: 44, run: async () => "ok" })).resolves.toBe("ok");
    }
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
