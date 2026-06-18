/**
 * CASH-CORE POC tests — ٥ اختبارات حَرِجة تُثبت العَقد الأَساسي قبل التَوسّع.
 *
 * المُغطّى:
 *   T1: idempotency — نَفس clientRequestId مَرَّتَين ⇒ سَجل واحد.
 *   T2: ذرّية — throw داخل tx ⇒ ROLLBACK كامل (لا receipt ولا bucket update).
 *   T3: snapshot balanceAfter صَحيح بَعد عدّة عَمليات.
 *   T4: transfer = pair كامل (OUT + IN بنَفس pairToken).
 *   T5: invariant — SUM(IN)-SUM(OUT) لكل bucket == currentBalance.
 *
 * المَرحلة أ ستُضيف ١٥+ اختبار (RBAC، deadlock، شفت مُغلَق، إلخ).
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { execute, transfer } from "../cashOps";
import { withTx } from "../tx";

const adminActor = { userId: 1, branchId: 1, role: "admin" };

const TABLES = [
  "auditLogs", "receipts", "cashBuckets", "shifts", "branches", "users",
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

async function seed() {
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({ id: 1, openId: "admin", name: "admin", role: "admin", loginMethod: "local", branchId: 1 });
  // أَنشئ bucketَين لاختبار TRANSFER
  await d.insert(s.cashBuckets).values([
    { id: 1, kind: "TREASURY", branchId: 1, ownerUserId: 1, name: "خزينة MAIN", currentBalance: "1000000.00" },
    { id: 2, kind: "BANK", branchId: 1, ownerUserId: 1, name: "حساب البنك", currentBalance: "5000000.00" },
  ]);
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("T1: idempotency — نَفس clientRequestId ⇒ سَجل واحد", () => {
  it("استدعاءان بنَفس المُفتاح يُنشئان receipt واحداً ويُعيدان نَفس النَتيجة", async () => {
    const input = {
      kind: "VOUCHER_RECEIVE" as const,
      bucketId: 1,
      direction: "IN" as const,
      amount: "100.00",
      sourceType: "voucher",
      sourceId: "test-001",
      clientRequestId: "idem-key-001",
    };
    const r1 = await execute(input, adminActor);
    const r2 = await execute(input, adminActor);

    expect(r1.cashTxId).toBe(r2.cashTxId);
    expect(r1.balanceAfter).toBe(r2.balanceAfter);
    expect(r2.idempotent).toBe(true);

    const allReceipts = await db().select().from(s.receipts);
    expect(allReceipts).toHaveLength(1);

    // الرصيد تَحرّك مَرّة واحدة فقط
    const bucket = (await db().select().from(s.cashBuckets).where(eq(s.cashBuckets.id, 1)))[0];
    expect(bucket.currentBalance).toBe("1000100.00");
  });
});

describe("T2: ذرّية — throw داخل tx ⇒ ROLLBACK كامل", () => {
  it("throw بَعد execute(IN) يَلغي الـreceipt والـbucket update", async () => {
    await expect(
      withTx(async (tx) => {
        await execute(
          {
            kind: "VOUCHER_RECEIVE",
            bucketId: 1,
            direction: "IN",
            amount: "500.00",
            sourceType: "voucher",
            sourceId: "rollback-test",
            clientRequestId: "rollback-key",
          },
          adminActor,
          tx,
        );
        throw new Error("simulated failure");
      })
    ).rejects.toThrow(/simulated/);

    // لا receipt ولا bucket update مَحفوظ
    const allReceipts = await db().select().from(s.receipts);
    expect(allReceipts).toHaveLength(0);
    const bucket = (await db().select().from(s.cashBuckets).where(eq(s.cashBuckets.id, 1)))[0];
    expect(bucket.currentBalance).toBe("1000000.00"); // الأَصلي بَلا تَغيير
    expect(bucket.version).toBe(1);
  });
});

describe("T3: balanceAfter snapshot صَحيح بَعد عدّة عَمليات", () => {
  it("٣ عَمليات مُتتالية ⇒ balanceAfter يَتَتبَّع بدقّة", async () => {
    const r1 = await execute(
      {
        kind: "VOUCHER_RECEIVE",
        bucketId: 1,
        direction: "IN",
        amount: "200.00",
        sourceType: "v",
        sourceId: "a",
        clientRequestId: "t3-a",
      },
      adminActor,
    );
    expect(r1.balanceAfter).toBe("1000200.00");

    const r2 = await execute(
      {
        kind: "EXPENSE_CASH",
        bucketId: 1,
        direction: "OUT",
        amount: "50.00",
        sourceType: "exp",
        sourceId: "b",
        clientRequestId: "t3-b",
      },
      adminActor,
    );
    expect(r2.balanceAfter).toBe("1000150.00");

    const r3 = await execute(
      {
        kind: "VOUCHER_PAY",
        bucketId: 1,
        direction: "OUT",
        amount: "100.00",
        sourceType: "v",
        sourceId: "c",
        clientRequestId: "t3-c",
        reason: "دفعة لمورد",
      },
      adminActor,
    );
    expect(r3.balanceAfter).toBe("1000050.00");

    // الـbucket يُطابق آخر snapshot
    const bucket = (await db().select().from(s.cashBuckets).where(eq(s.cashBuckets.id, 1)))[0];
    expect(bucket.currentBalance).toBe("1000050.00");
    expect(bucket.version).toBe(4); // 1 + 3 updates
  });
});

describe("T4: transfer = OUT + IN ذَرّياً بنَفس pairToken", () => {
  it("transfer 300 من bucket 2 إلى bucket 1 ⇒ صَفّان بنَفس pairToken وأَرصدة مُتَّسقة", async () => {
    const t = await transfer(
      2, // BANK
      1, // TREASURY
      "300.00",
      "manual",
      "tr-001",
      "transfer-key",
      "سَحب من البنك للخزينة",
      adminActor,
    );

    expect(t.outTxId).toBeGreaterThan(0);
    expect(t.inTxId).toBeGreaterThan(0);
    expect(t.outTxId).not.toBe(t.inTxId);
    expect(t.pairToken).toMatch(/^TRX-/);

    const allReceipts = await db().select().from(s.receipts).orderBy(s.receipts.id);
    expect(allReceipts).toHaveLength(2);
    // الـpairToken مُتطابق
    expect(allReceipts[0].pairToken).toBe(t.pairToken);
    expect(allReceipts[1].pairToken).toBe(t.pairToken);
    // اتجاهان مُختلفان
    const directions = allReceipts.map((r) => r.direction).sort();
    expect(directions).toEqual(["IN", "OUT"]);

    // الأَرصدة: BANK -300، TREASURY +300
    const bank = (await db().select().from(s.cashBuckets).where(eq(s.cashBuckets.id, 2)))[0];
    expect(bank.currentBalance).toBe("4999700.00");
    const treasury = (await db().select().from(s.cashBuckets).where(eq(s.cashBuckets.id, 1)))[0];
    expect(treasury.currentBalance).toBe("1000300.00");
  });

  it("transfer إلى نَفس الصندوق ⇒ BAD_REQUEST", async () => {
    await expect(
      transfer(1, 1, "100.00", "manual", "tr-002", "k", "test", adminActor)
    ).rejects.toThrow(/نَفس الصندوق/);
  });

  it("transfer بلا reason ⇒ BAD_REQUEST", async () => {
    await expect(
      transfer(1, 2, "100.00", "manual", "tr-003", "k", "", adminActor)
    ).rejects.toThrow(/سبباً/);
  });
});

describe("T5: invariant — SUM(IN)-SUM(OUT) == currentBalance بَعد ١٠ عَمليات عَشوائية", () => {
  it("بَعد ١٠ عَمليات مُختلفة على نَفس bucket: المَجموع المُحسوب = الرصيد المُخزَّن", async () => {
    const ops: Array<{ dir: "IN" | "OUT"; amt: number }> = [
      { dir: "IN", amt: 500 },
      { dir: "OUT", amt: 100 },
      { dir: "IN", amt: 1200 },
      { dir: "OUT", amt: 75 },
      { dir: "IN", amt: 50 },
      { dir: "OUT", amt: 25 },
      { dir: "IN", amt: 300 },
      { dir: "OUT", amt: 200 },
      { dir: "IN", amt: 800 },
      { dir: "OUT", amt: 150 },
    ];
    let i = 0;
    for (const op of ops) {
      await execute(
        {
          kind: op.dir === "IN" ? "VOUCHER_RECEIVE" : "EXPENSE_CASH",
          bucketId: 1,
          direction: op.dir,
          amount: op.amt.toFixed(2),
          sourceType: "test",
          sourceId: `inv-${i}`,
          clientRequestId: `inv-${i++}`,
        },
        adminActor,
      );
    }
    const sumIn = ops.filter((o) => o.dir === "IN").reduce((a, o) => a + o.amt, 0);
    const sumOut = ops.filter((o) => o.dir === "OUT").reduce((a, o) => a + o.amt, 0);
    const expected = 1000000 + sumIn - sumOut;

    const bucket = (await db().select().from(s.cashBuckets).where(eq(s.cashBuckets.id, 1)))[0];
    expect(bucket.currentBalance).toBe(expected.toFixed(2));

    // تَحقُّق من invariant على receipts مُباشرة
    const allReceipts = await db().select().from(s.receipts).where(eq(s.receipts.bucketId, 1));
    const receiptIn = allReceipts.filter((r) => r.direction === "IN").reduce((a, r) => a + Number(r.amount), 0);
    const receiptOut = allReceipts.filter((r) => r.direction === "OUT").reduce((a, r) => a + Number(r.amount), 0);
    expect(receiptIn - receiptOut).toBe(sumIn - sumOut);

    // كل receipt له balanceAfter (لا null)
    for (const r of allReceipts) {
      expect(r.balanceAfter).not.toBeNull();
    }
  });
});
