import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { withTx } from "../tx";
import { lockPeriod } from "../periodLockService";
import {
  bootstrapMonthCloseSequence,
  getMonthCloseSequence,
  listSequenceEvents,
} from "../reports/monthCloseSequence";
import { truncateTables } from "./__testUtils__";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set");
  return value;
}

beforeEach(async () => {
  await truncateTables([
    "monthCloseCertificateEvidence",
    "monthCloseEvents",
    "monthCloseCertificates",
    "monthCloseSequence",
    "monthCloseRequests",
    "financialPeriods",
    "branches",
    "users",
  ]);
  await db().insert(s.users).values({
    id: 1,
    openId: "month-close-owner",
    name: "Owner",
    role: "admin",
    loginMethod: "local",
  });
});

describe("month-close bootstrap and immutable evidence boundary", () => {
  it("starts a fresh sequence explicitly and cannot be bootstrapped twice", async () => {
    const result = await withTx((tx) =>
      bootstrapMonthCloseSequence(tx, {
        mode: "START_FRESH",
        firstCloseMonth: "2025-12",
        actorId: 1,
        reason: "Adopt governed monthly close sequence",
        reference: "OWNER-DECISION-1",
        now: new Date("2026-01-02T10:00:00.000Z"),
      }),
    );

    expect(result).toMatchObject({
      status: "READY",
      sequenceStartMonth: "2025-12",
      activeThroughMonth: null,
      nextRequiredMonth: "2025-12",
      version: 1,
    });
    expect(await db().select().from(s.monthCloseCertificates)).toHaveLength(0);
    await expect(
      withTx((tx) =>
        bootstrapMonthCloseSequence(tx, {
          mode: "START_FRESH",
          firstCloseMonth: "2025-12",
          actorId: 1,
          reason: "Second bootstrap must never replace evidence",
          reference: "OWNER-DECISION-2",
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("acknowledges legacy month-end locks but creates no historical certificate", async () => {
    const latestPeriodId = await withTx(async (tx) => {
      await lockPeriod(tx, {
        cutoffDate: "2025-11-30",
        lockedBy: 1,
        notes: "Legacy November lock",
      });
      return (
        await lockPeriod(tx, {
          cutoffDate: "2025-12-31",
          lockedBy: 1,
          notes: "Legacy December lock",
        })
      ).id;
    });

    const result = await withTx((tx) =>
      bootstrapMonthCloseSequence(tx, {
        mode: "ACKNOWLEDGE_LEGACY_LOCK",
        expectedPeriodId: latestPeriodId,
        actorId: 1,
        reason: "Acknowledge pre-certificate close history",
        reference: "LEGACY-ACK-2025",
        now: new Date("2026-01-02T10:00:00.000Z"),
      }),
    );

    expect(result).toMatchObject({
      activeThroughMonth: "2025-12",
      nextRequiredMonth: "2026-01",
      activePeriodId: latestPeriodId,
      activeCertificateId: null,
    });
    const periods = await db().select().from(s.financialPeriods);
    expect(periods.map((row) => row.closeMonth)).toEqual([
      "2025-11",
      "2025-12",
    ]);
    expect(await db().select().from(s.monthCloseCertificates)).toHaveLength(0);
    const event = (await withTx((tx) => listSequenceEvents(tx, 1)))[0];
    expect(event.payloadCanonical).toContain('"certificationClaim":"NONE"');
    await withTx(async (tx) => {
      const state = await getMonthCloseSequence(tx);
      expect(state.activeCertificateId).toBeNull();
    });
  });
});
