import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { withTx } from "../tx";
import { assertPeriodOpen, getActiveLock, lockPeriod, unlockLatestPeriod } from "../periodLockService";
import { postEntry } from "../ledgerService";
import { money } from "../money";
import { truncateTables } from "./__testUtils__";

function db() { const d = getDb(); if (!d) throw new Error("DATABASE_URL not set"); return d; }

async function reset() {
  await truncateTables(["accountingEntries", "financialPeriods", "users"]);
}

async function seedUser() {
  const d = db();
  await d.insert(s.users).values({ id: 1, openId: "t", name: "admin", role: "admin", loginMethod: "local" });
}

beforeEach(async () => {
  await reset();
  await seedUser();
});

describe("periodLockService — قفل الفترات المالية", () => {
  it("لا قفل ⇒ getActiveLock يُعيد null + assertPeriodOpen لا يرمي", async () => {
    await withTx(async (tx) => {
      expect(await getActiveLock(tx)).toBeNull();
      await assertPeriodOpen(tx, new Date());
    });
  });

  it("lockPeriod ينشئ قفلاً ⇒ getActiveLock يعيده", async () => {
    const id = await withTx(async (tx) => (await lockPeriod(tx, { cutoffDate: "2025-12-31", lockedBy: 1, notes: "نهاية ٢٠٢٥" })).id);
    expect(id).toBeGreaterThan(0);
    await withTx(async (tx) => {
      const lock = await getActiveLock(tx);
      expect(lock).not.toBeNull();
      expect(lock!.cutoffDate).toBe("2025-12-31");
      expect(lock!.notes).toBe("نهاية ٢٠٢٥");
    });
  });

  it("assertPeriodOpen يرمي FORBIDDEN لـentryDate ≤ cutoffDate", async () => {
    await withTx(async (tx) => {
      await lockPeriod(tx, { cutoffDate: "2025-12-31", lockedBy: 1 });
    });
    // قيد بـ2025-12-31 ⇒ مرفوض
    await expect(
      withTx(async (tx) => assertPeriodOpen(tx, new Date("2025-12-31T12:00:00Z"))),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // قيد بـ2025-12-30 ⇒ مرفوض
    await expect(
      withTx(async (tx) => assertPeriodOpen(tx, new Date("2025-12-30T00:00:00Z"))),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("assertPeriodOpen يسمح لـentryDate > cutoffDate", async () => {
    await withTx(async (tx) => {
      await lockPeriod(tx, { cutoffDate: "2025-12-31", lockedBy: 1 });
    });
    await withTx(async (tx) => assertPeriodOpen(tx, new Date("2026-01-01T00:00:00Z")));
  });

  it("postEntry يطبّق الحارس فعلياً — يرفض القيد التاريخي", async () => {
    await withTx(async (tx) => {
      await lockPeriod(tx, { cutoffDate: "2025-12-31", lockedBy: 1 });
    });
    await expect(
      withTx(async (tx) =>
        postEntry(tx, {
          entryType: "ADJUST",
          amount: money(100),
          entryDate: new Date("2025-06-15T00:00:00Z"),
        }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("postEntry يقبل القيد بعد الـcutoff", async () => {
    await withTx(async (tx) => {
      await lockPeriod(tx, { cutoffDate: "2025-12-31", lockedBy: 1 });
    });
    await withTx(async (tx) =>
      postEntry(tx, {
        entryType: "ADJUST",
        amount: money(100),
        entryDate: new Date("2026-01-15T00:00:00Z"),
      }),
    );
  });

  it("lockPeriod برفض cutoffDate ≤ قفل سابق", async () => {
    await withTx(async (tx) => {
      await lockPeriod(tx, { cutoffDate: "2025-12-31", lockedBy: 1 });
    });
    await expect(
      withTx(async (tx) => lockPeriod(tx, { cutoffDate: "2025-11-30", lockedBy: 1 })),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // نفس التاريخ ⇒ أيضاً مرفوض
    await expect(
      withTx(async (tx) => lockPeriod(tx, { cutoffDate: "2025-12-31", lockedBy: 1 })),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("unlockLatestPeriod يحذف أحدث قفل ⇒ assertPeriodOpen يُسمح", async () => {
    await withTx(async (tx) => {
      await lockPeriod(tx, { cutoffDate: "2025-12-31", lockedBy: 1 });
    });
    const r = await withTx(async (tx) => unlockLatestPeriod(tx));
    expect(r.unlocked).toBe(true);
    await withTx(async (tx) => assertPeriodOpen(tx, new Date("2025-06-15T00:00:00Z")));
  });

  it("unlockLatestPeriod على بلا قفل ⇒ unlocked: false", async () => {
    const r = await withTx(async (tx) => unlockLatestPeriod(tx));
    expect(r.unlocked).toBe(false);
  });
});
