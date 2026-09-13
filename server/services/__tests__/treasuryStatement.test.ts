// كشف حركة الخزينة النقدية (رصيدٌ جارٍ) — الثابت الحاكم:
//   الرصيد الختاميّ ≡ computeTreasuryCashBalance عند نفس التاريخ (شرح كل دينار، لا رقمٌ ثانٍ ينجرف).
// نُثبت: الافتتاحيّ من قبل الفترة، تراكم الرصيد الجارٍ، مطابقة الرصيد القانونيّ، تعليم المعكوس،
// عزل الفرع، واستبعاد غير النقد.
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { getTreasuryStatement } from "../reportsTreasuryService";
import { withTx } from "../tx";
import { computeTreasuryCashBalance } from "../cash/cashAvailability";
import { toDbMoney } from "../money";

const TABLES = [
  "idempotencyKeys", "accountingEntries", "receipts", "expenses",
  "shifts", "branches", "users", "auditLogs",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values({
    id: 1, openId: "admin", name: "أحمد المدير", role: "admin", loginMethod: "local", branchId: 1,
  });
}

// إيصال خزينة نقديّ — الحدث النقديّ = createdAt (لا approvedAt) كي نتحكّم بالفترة.
async function tRec(o: {
  dir: "IN" | "OUT";
  amount: string;
  date: string;
  branchId?: number;
  ref?: string | null;
  voucherNumber?: string | null;
  status?: "COMPLETED" | "REVERSED";
}) {
  await db().insert(s.receipts).values({
    branchId: o.branchId ?? 1,
    shiftId: null,
    cashBucket: "TREASURY",
    direction: o.dir,
    amount: o.amount,
    paymentMethod: "CASH",
    status: o.status ?? "COMPLETED",
    approvalStatus: "APPROVED",
    referenceNumber: o.ref ?? null,
    voucherNumber: o.voucherNumber ?? null,
    createdAt: new Date(o.date),
    createdBy: 1,
  });
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("كشف حركة الخزينة النقدية — رصيدٌ جارٍ", () => {
  it("الافتتاحيّ من قبل الفترة، والرصيد الجارٍ يتراكم، والختاميّ = افتتاحيّ + وارد − صادر", async () => {
    await tRec({ dir: "IN", amount: "1000000", date: "2026-08-31T09:00:00Z", ref: "TF-1" }); // قبل الفترة
    await tRec({ dir: "IN", amount: "500000", date: "2026-09-02T09:00:00Z", ref: "CH-1" });
    await tRec({ dir: "OUT", amount: "200000", date: "2026-09-03T09:00:00Z", ref: "SF-1" });
    await tRec({ dir: "OUT", amount: "50000", date: "2026-09-04T09:00:00Z", voucherNumber: "PV-1-20260904-00001" });

    const r = await getTreasuryStatement({ from: "2026-09-01", to: "2026-09-30", branchId: 1 });

    expect(r.openingBalance).toBe("1000000.00");
    expect(r.totalIn).toBe("500000.00");
    expect(r.totalOut).toBe("250000.00");
    expect(r.closingBalance).toBe("1250000.00");
    expect(r.count).toBe(3);
    expect(r.shownCount).toBe(3);
    expect(r.truncated).toBe(false);

    expect(r.movements.map((m) => m.runningBalance)).toEqual([
      "1500000.00",
      "1300000.00",
      "1250000.00",
    ]);
    expect(r.movements.map((m) => m.reason)).toEqual([
      "توريد إغلاق وردية",
      "عهدة افتتاح وردية",
      "سند صرف",
    ]);
  });

  it("الرصيد الختاميّ ≡ computeTreasuryCashBalance (شرح كل دينار)", async () => {
    await tRec({ dir: "IN", amount: "1000000", date: "2026-08-15T09:00:00Z", ref: "TF-1" });
    await tRec({ dir: "OUT", amount: "300000", date: "2026-09-05T09:00:00Z", ref: "SF-1" });
    await tRec({ dir: "IN", amount: "120000", date: "2026-09-10T09:00:00Z", ref: "CH-1" });

    const r = await getTreasuryStatement({ from: "2026-09-01", to: "2026-09-30", branchId: 1 });
    const canonical = await withTx((tx) => computeTreasuryCashBalance(tx, 1));

    expect(r.closingBalance).toBe(toDbMoney(canonical));
    expect(r.closingBalance).toBe("820000.00");
  });

  it("الأصل المعكوس يُعلَّم reversed ويبقى في الكشف بدلالة الرصيد القانونيّ (صافٍ صفر مع تعويضِه)", async () => {
    await tRec({ dir: "OUT", amount: "70000", date: "2026-09-06T09:00:00Z", voucherNumber: "PV-1-20260906-00002", status: "REVERSED" });
    await tRec({ dir: "IN", amount: "70000", date: "2026-09-06T10:00:00Z", ref: "CANCEL-VCH-1" });

    const r = await getTreasuryStatement({ from: "2026-09-01", to: "2026-09-30", branchId: 1 });
    const canonical = await withTx((tx) => computeTreasuryCashBalance(tx, 1));

    expect(r.closingBalance).toBe("0.00");
    expect(r.closingBalance).toBe(toDbMoney(canonical));
    expect(r.movements.some((m) => m.reversed)).toBe(true);
    expect(r.movements.some((m) => m.reasonKey === "CANCEL_VOUCHER")).toBe(true);
  });

  it("عزل الفرع: حركة فرعٍ آخر لا تدخل كشف الفرع", async () => {
    await db().insert(s.branches).values([{ id: 2, name: "SALES", code: "SALES", type: "MAIN" }]);
    await tRec({ dir: "IN", amount: "500000", date: "2026-09-02T09:00:00Z", ref: "TF-1", branchId: 1 });
    await tRec({ dir: "IN", amount: "900000", date: "2026-09-02T09:00:00Z", ref: "TF-2", branchId: 2 });

    const r1 = await getTreasuryStatement({ from: "2026-09-01", to: "2026-09-30", branchId: 1 });
    expect(r1.closingBalance).toBe("500000.00");
    expect(r1.count).toBe(1);
  });

  it("غير النقد لا يدخل كشف الخزينة النقديّة", async () => {
    await tRec({ dir: "IN", amount: "500000", date: "2026-09-02T09:00:00Z", ref: "TF-1" });
    await db().insert(s.receipts).values({
      branchId: 1, shiftId: null, cashBucket: null, direction: "IN", amount: "999000",
      paymentMethod: "TRANSFER", status: "COMPLETED", approvalStatus: "APPROVED",
      createdAt: new Date("2026-09-03T09:00:00Z"), createdBy: 1,
    });

    const r = await getTreasuryStatement({ from: "2026-09-01", to: "2026-09-30", branchId: 1 });
    expect(r.closingBalance).toBe("500000.00");
    expect(r.count).toBe(1);
  });
});
