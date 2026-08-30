/**
 * اختبارات شبكة إعادة المحاولة الموحّدة (فحص معمارية الحمل ٣٠/٨/٢٦):
 * التكرار يُعاد فوراً، وضحيّة deadlock/مهلة القفل تُعاد بعد تراجعٍ قصير — بكل أشكال
 * الخطأ (code نصّي / errno رقمي / ملفوف بسلسلة cause)، وغير القابل للإعادة يخرج فوراً.
 */
import { describe, expect, it } from "vitest";
import { pauseIfRetryableDbError, retryOnDup } from "../retryDup";

const dupErr = () => Object.assign(new Error("dup"), { code: "ER_DUP_ENTRY" });
const deadlockErrnoOnly = () => Object.assign(new Error("dl"), { errno: 1213 });
const wrappedLockWait = () => new Error("wrapped", { cause: { code: "ER_LOCK_WAIT_TIMEOUT" } });

describe("pauseIfRetryableDbError", () => {
  it("تكرار المفتاح ⇒ true فوراً (بلا تراجع ملموس)", async () => {
    const t0 = Date.now();
    expect(await pauseIfRetryableDbError(dupErr())).toBe(true);
    expect(Date.now() - t0).toBeLessThan(10);
  });
  it("deadlock بـerrno وحده ⇒ true بعد تراجعٍ قصير (15-75ﻡﺛ)", async () => {
    const t0 = Date.now();
    expect(await pauseIfRetryableDbError(deadlockErrnoOnly())).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(10);
  });
  it("مهلة قفل ملفوفة بـcause ⇒ محاولة إضافية واحدة فقط (attempt 0 نعم، 1 لا)", async () => {
    expect(await pauseIfRetryableDbError(wrappedLockWait(), 0)).toBe(true);
    expect(await pauseIfRetryableDbError(wrappedLockWait(), 1)).toBe(false);
  });
  it("deadlock يُعاد في كل المحاولات (بخلاف مهلة القفل)", async () => {
    expect(await pauseIfRetryableDbError(deadlockErrnoOnly(), 1)).toBe(true);
  });
  it("خطأ عاديّ ⇒ false", async () => {
    expect(await pauseIfRetryableDbError(new Error("boom"))).toBe(false);
  });
});

describe("retryOnDup", () => {
  it("ينجح من أول مرة بلا إعادة", async () => {
    let calls = 0;
    expect(
      await retryOnDup(async () => {
        calls += 1;
        return "ok";
      }),
    ).toBe("ok");
    expect(calls).toBe(1);
  });

  it("يعيد على deadlock (errno فقط) حتى النجاح", async () => {
    let calls = 0;
    const result = await retryOnDup(async () => {
      calls += 1;
      if (calls < 3) throw deadlockErrnoOnly();
      return "won";
    });
    expect(result).toBe("won");
    expect(calls).toBe(3);
  });

  it("يستنفد المحاولات الثلاث ثم يرمي الخطأ الأخير", async () => {
    let calls = 0;
    await expect(
      retryOnDup(async () => {
        calls += 1;
        throw dupErr();
      }),
    ).rejects.toThrow("dup");
    expect(calls).toBe(3);
  });

  it("غير القابل للإعادة يخرج من أول محاولة", async () => {
    let calls = 0;
    await expect(
      retryOnDup(async () => {
        calls += 1;
        throw new Error("business rule");
      }),
    ).rejects.toThrow("business rule");
    expect(calls).toBe(1);
  });
});
