import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { postEntry } from "../ledgerService";
import { money } from "../money";
import { openShift } from "../shiftService";
import {
  approveMonthClose,
  requestMonthClose,
} from "../reports/monthCloseRequest";
import { withTx } from "../tx";
import { truncateTables } from "./__testUtils__";

const MONTH = "2026-07";
const ADMIN = 1;
const MANAGER = 2;

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
    "payrollAccountingEvents",
    "payrollObligationAllocations",
    "payrollObligations",
    "payrollRemittanceRequests",
    "payrollItems",
    "payrollRuns",
    "doubleEntrySettings",
    "financialPeriods",
    "journalLines",
    "journalEntries",
    "accountingEntries",
    "receipts",
    "shifts",
    "employees",
    "branches",
    "users",
  ]);
  await db()
    .insert(s.users)
    .values([
      {
        id: ADMIN,
        openId: "gate-admin",
        name: "Owner",
        role: "admin",
        loginMethod: "local",
      },
      {
        id: MANAGER,
        openId: "gate-manager",
        name: "Manager",
        role: "manager",
        loginMethod: "local",
      },
    ]);
  await db().insert(s.branches).values({
    id: 1,
    name: "Main",
    code: "MAIN",
    type: "MAIN",
  });
  await db()
    .insert(s.monthCloseSequence)
    .values({
      id: 1,
      status: "READY",
      sequenceStartMonth: MONTH,
      nextRequiredMonth: MONTH,
      version: 1,
      bootstrappedAt: new Date("2026-07-01T00:00:00.000Z"),
      bootstrappedBy: ADMIN,
      bootstrapReason: "Race test baseline",
      bootstrapReference: "RACE-BASELINE",
    });
});

describe("company month-close gate", () => {
  it("initializes a missing singleton concurrently without a gap-lock deadlock", async () => {
    await db()
      .delete(s.monthCloseSequence)
      .where(eq(s.monthCloseSequence.id, 1));

    await expect(
      Promise.all(Array.from({ length: 8 }, () => withTx(async () => true))),
    ).resolves.toEqual(Array(8).fill(true));

    const rows = await db().select().from(s.monthCloseSequence);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(1);
  });

  it("makes a real branchless ledger writer visible before close can certify", async () => {
    const request = await withTx((tx) =>
      requestMonthClose(tx, { month: MONTH, requestedBy: MANAGER }),
    );
    let writerInserted!: () => void;
    let releaseWriter!: () => void;
    const inserted = new Promise<void>((resolve) => {
      writerInserted = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });

    const writer = withTx(async (tx) => {
      await postEntry(tx, {
        entryType: "ADJUST",
        branchId: null,
        amount: money(0),
        entryDate: new Date("2026-07-31T12:00:00.000Z"),
        dedupeKey: "MONTH-CLOSE-GATE:BRANCHLESS",
      });
      writerInserted();
      await hold;
    });
    await inserted;

    const approval = withTx(
      (tx) =>
        approveMonthClose(tx, {
          requestId: request.id,
          decidedBy: ADMIN,
        }),
      { gate: "GOVERNANCE" },
    );
    const premature = await Promise.race([
      approval.then(() => "closed"),
      new Promise<"blocked">((resolve) =>
        setTimeout(() => resolve("blocked"), 75),
      ),
    ]);
    expect(premature).toBe("blocked");

    releaseWriter();
    await writer;
    await expect(approval).resolves.toMatchObject({ month: MONTH });
    const [source] = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.dedupeKey, "MONTH-CLOSE-GATE:BRANCHLESS"));
    expect(source).toBeDefined();

    await expect(
      withTx((tx) =>
        postEntry(tx, {
          entryType: "ADJUST",
          branchId: null,
          amount: money(0),
          entryDate: new Date("2026-07-31T13:00:00.000Z"),
          dedupeKey: "MONTH-CLOSE-GATE:TOO-LATE",
        }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("blocks the real shift producer behind a close and then rejects its closed-period date", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-31T20:59:00.000Z"));
    try {
      const request = await withTx(
        (tx) =>
          requestMonthClose(tx, {
            month: MONTH,
            requestedBy: MANAGER,
            now: new Date("2026-08-01T00:00:00.000Z"),
          }),
        { gate: "GOVERNANCE" },
      );
      let closePrepared!: () => void;
      let releaseClose!: () => void;
      const prepared = new Promise<void>((resolve) => {
        closePrepared = resolve;
      });
      const hold = new Promise<void>((resolve) => {
        releaseClose = resolve;
      });

      const closing = withTx(
        async (tx) => {
          const result = await approveMonthClose(tx, {
            requestId: request.id,
            decidedBy: ADMIN,
            now: new Date("2026-08-01T00:00:00.000Z"),
          });
          closePrepared();
          await hold;
          return result;
        },
        { gate: "GOVERNANCE" },
      );
      await prepared;

      const writer = openShift(
        { branchId: 1, openingBalance: "0.00", shiftType: "RETAIL" },
        { userId: MANAGER, branchId: 1, role: "manager" },
      );
      const premature = await Promise.race([
        writer.then(
          () => "opened",
          () => "rejected",
        ),
        new Promise<"blocked">((resolve) =>
          setTimeout(() => resolve("blocked"), 75),
        ),
      ]);
      expect(premature).toBe("blocked");

      releaseClose();
      await expect(closing).resolves.toMatchObject({ month: MONTH });
      await expect(writer).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(await db().select().from(s.shifts)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
