import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";
import { createSupplier } from "../supplierService";
import { withTx } from "../tx";
import { providerService, walletOpsService, walletService } from "../digitalCards";

/**
 * البطاقات الرقمية — ش٩: الإيداع والسحب والتعديل والكشف والمطابقة.
 * راجع docs/digital-cards-platform-subscriptions-implementation-plan-2026-07-29.md §٦.١ + §٥.١١ + §٩.٣.
 */

const mgrA = { userId: 1, branchId: 1, role: "manager" };
const mgrB = { userId: 2, branchId: 1, role: "manager" };
const admin = { userId: 3, branchId: 1, role: "admin" };

const TABLES = [
  "digitalWalletReconciliations", "digitalWalletTransactions", "digitalWalletReservations",
  "digitalWallets", "digitalProviders", "accountingEntries", "receipts",
  "auditLogs", "suppliers", "users", "branches",
];

function db() { const d = getDb(); if (!d) throw new Error("DATABASE_URL not set for tests"); return d; }

async function seedBase() {
  await db().insert(s.branches).values({ id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values([
    { id: 1, openId: "m1", name: "مدير أ", role: "manager", loginMethod: "local" },
    { id: 2, openId: "m2", name: "مدير ب", role: "manager", loginMethod: "local" },
    { id: 3, openId: "a1", name: "أدمن", role: "admin", loginMethod: "local" },
  ]);
}

async function mkWallet(threshold = "0") {
  const { supplierId } = await createSupplier({ name: "آسياسيل" }, { userId: 1, branchId: 1 });
  const { providerId } = await withTx((tx) => providerService.createProvider(tx, {
    supplierId, providerType: "TELECOM", settlementMode: "PREPAID", recognitionMode: "PRINCIPAL_GROSS",
    referencePolicy: "OPTIONAL", settlementCycle: "ON_DEMAND", lowBalanceThreshold: threshold,
  }, { userId: 1, branchId: 1 }));
  const { walletId } = await withTx((tx) =>
    walletService.createWallet(tx, { providerId, branchId: 1, code: "W1", name: "جهاز الكاشير" }, { userId: 1, branchId: 1 }));
  return { walletId, providerId, supplierId };
}

async function wallet(id: number) {
  const [w] = await db().select().from(s.digitalWallets).where(eq(s.digitalWallets.id, id));
  return w;
}

let seq = 0;
const rid = () => `req-${++seq}-${Math.random().toString(36).slice(2, 10)}`;

beforeEach(async () => {
  await truncateTables(TABLES);
  await seedBase();
  seq = 0;
});

describe("ش٩ — الإيداع (§٦.١)", () => {
  it("يرفع الرصيد + سند صرف OUT من الخزينة + قيد أصلٍ بصفر أثر P&L", async () => {
    const { walletId } = await mkWallet();
    const r = await withTx((tx) => walletOpsService.deposit(tx, {
      walletId, amount: "1000000", paymentMethod: "CASH", clientRequestId: rid(),
    }, mgrA));

    expect(r.balanceAfter).toBe("1000000.00");
    expect((await wallet(walletId)).currentBalance).toBe("1000000.00");

    const [rec] = await db().select().from(s.receipts).where(eq(s.receipts.id, r.receiptId));
    expect(rec.direction).toBe("OUT");
    expect(rec.cashBucket).toBe("TREASURY");
    expect(rec.amount).toBe("1000000.00");

    const [entry] = await db().select().from(s.accountingEntries)
      .where(eq(s.accountingEntries.entryType, "DIGITAL_WALLET_DEPOSIT"));
    expect(entry.amount).toBe("1000000.00");
    expect(entry.revenue).toBe("0.00");
    expect(entry.cost).toBe("0.00");
    expect(entry.profit).toBe("0.00");
    expect(Number(entry.digitalWalletId)).toBe(walletId);

    const [mv] = await db().select().from(s.digitalWalletTransactions);
    expect(mv.type).toBe("DEPOSIT");
    expect(mv.direction).toBe("IN");
    expect(mv.balanceAfter).toBe("1000000.00");
  });

  it("مبلغ صفر أو سالب مرفوض", async () => {
    const { walletId } = await mkWallet();
    for (const amount of ["0", "-5"]) {
      await expect(withTx((tx) => walletOpsService.deposit(tx, {
        walletId, amount, paymentMethod: "CASH", clientRequestId: rid(),
      }, mgrA))).rejects.toThrow(/أكبر من صفر/);
    }
  });

  it("إيداع بنفس clientRequestId مرّتين يفشل (قيد المحفظة الفريد)", async () => {
    const { walletId } = await mkWallet();
    const key = rid();
    await withTx((tx) => walletOpsService.deposit(tx, { walletId, amount: "1000", paymentMethod: "CASH", clientRequestId: key }, mgrA));
    await expect(withTx((tx) => walletOpsService.deposit(tx, { walletId, amount: "1000", paymentMethod: "CASH", clientRequestId: key }, mgrA)))
      .rejects.toThrow();
    expect((await wallet(walletId)).currentBalance).toBe("1000.00");
  });
});

describe("ش٩ — السحب", () => {
  it("يخفض الرصيد بسند قبض IN وقيد أصلٍ صفريّ", async () => {
    const { walletId } = await mkWallet();
    await withTx((tx) => walletOpsService.deposit(tx, { walletId, amount: "50000", paymentMethod: "CASH", clientRequestId: rid() }, mgrA));
    const r = await withTx((tx) => walletOpsService.withdraw(tx, { walletId, amount: "20000", paymentMethod: "CASH", clientRequestId: rid() }, mgrA));

    expect(r.balanceAfter).toBe("30000.00");
    const [rec] = await db().select().from(s.receipts).where(eq(s.receipts.id, r.receiptId));
    expect(rec.direction).toBe("IN");
    const wdr = await db().select().from(s.accountingEntries)
      .where(eq(s.accountingEntries.entryType, "DIGITAL_WALLET_WITHDRAWAL"));
    expect(wdr[0].profit).toBe("0.00");
  });

  it("لا سحب يجعل الرصيد سالباً ولا يهبط تحت المحجوز", async () => {
    const { walletId } = await mkWallet();
    await withTx((tx) => walletOpsService.deposit(tx, { walletId, amount: "10000", paymentMethod: "CASH", clientRequestId: rid() }, mgrA));

    await expect(withTx((tx) => walletOpsService.withdraw(tx, { walletId, amount: "20000", paymentMethod: "CASH", clientRequestId: rid() }, mgrA)))
      .rejects.toThrow(/سالباً/);

    await db().update(s.digitalWallets).set({ reservedBalance: "8000" }).where(eq(s.digitalWallets.id, walletId));
    await expect(withTx((tx) => walletOpsService.withdraw(tx, { walletId, amount: "5000", paymentMethod: "CASH", clientRequestId: rid() }, mgrA)))
      .rejects.toThrow(/تحت الرصيد المحجوز/);
    expect((await wallet(walletId)).currentBalance).toBe("10000.00");
  });
});

describe("ش٩ — التعديل بفصل المهام", () => {
  async function funded() {
    const { walletId } = await mkWallet();
    await withTx((tx) => walletOpsService.deposit(tx, { walletId, amount: "100000", paymentMethod: "CASH", clientRequestId: rid() }, mgrA));
    return walletId;
  }

  it("الطلب لا يمسّ الرصيد إطلاقاً", async () => {
    const walletId = await funded();
    await withTx((tx) => walletOpsService.requestAdjustment(tx, {
      walletId, amount: "5000", direction: "OUT", reason: "عجز جهاز", clientRequestId: rid(),
    }, mgrA));

    expect((await wallet(walletId)).currentBalance).toBe("100000.00");
    const pend = await db().select().from(s.digitalWalletTransactions)
      .where(eq(s.digitalWalletTransactions.status, "PENDING_APPROVAL"));
    expect(pend).toHaveLength(1);
    // ولا يدخل حساب الرصيد المُعاد إنتاجه.
    expect(await walletOpsService.reproduceBalance(db(), walletId)).toBe("100000.00");
  });

  it("لا يعتمد التعديل من طلبه؛ ومديرٌ آخر يعتمده فيتحرّك الرصيد", async () => {
    const walletId = await funded();
    const { transactionId } = await withTx((tx) => walletOpsService.requestAdjustment(tx, {
      walletId, amount: "5000", direction: "OUT", reason: "عجز جهاز", clientRequestId: rid(),
    }, mgrA));

    await expect(withTx((tx) => walletOpsService.approveAdjustment(tx, { transactionId }, mgrA)))
      .rejects.toThrow(/لا يعتمد التعديل من طلبه/);
    expect((await wallet(walletId)).currentBalance).toBe("100000.00");

    const r = await withTx((tx) => walletOpsService.approveAdjustment(tx, { transactionId }, mgrB));
    expect(r.balanceAfter).toBe("95000.00");
    expect((await wallet(walletId)).currentBalance).toBe("95000.00");

    const [entry] = await db().select().from(s.accountingEntries)
      .where(eq(s.accountingEntries.entryType, "DIGITAL_WALLET_ADJUSTMENT"));
    expect(entry.profit).toBe("0.00");
    expect(await walletOpsService.assertBalanceReproducible(db(), walletId)).toBe(true);
  });

  it("admin يعتمد طلبه للتصحيح الإداريّ", async () => {
    const walletId = await funded();
    const { transactionId } = await withTx((tx) => walletOpsService.requestAdjustment(tx, {
      walletId, amount: "1000", direction: "IN", reason: "تصحيح", clientRequestId: rid(),
    }, admin));
    const r = await withTx((tx) => walletOpsService.approveAdjustment(tx, { transactionId }, admin));
    expect(r.balanceAfter).toBe("101000.00");
  });

  it("الاعتماد مرّتين مرفوض، والرفض لا يمسّ الرصيد", async () => {
    const walletId = await funded();
    const a = await withTx((tx) => walletOpsService.requestAdjustment(tx, {
      walletId, amount: "5000", direction: "OUT", reason: "عجز", clientRequestId: rid(),
    }, mgrA));
    await withTx((tx) => walletOpsService.approveAdjustment(tx, { transactionId: a.transactionId }, mgrB));
    await expect(withTx((tx) => walletOpsService.approveAdjustment(tx, { transactionId: a.transactionId }, mgrB)))
      .rejects.toThrow(/عولِج مسبقاً/);

    const b = await withTx((tx) => walletOpsService.requestAdjustment(tx, {
      walletId, amount: "7000", direction: "OUT", reason: "آخر", clientRequestId: rid(),
    }, mgrA));
    const before = (await wallet(walletId)).currentBalance;
    await withTx((tx) => walletOpsService.rejectAdjustment(tx, { transactionId: b.transactionId }, mgrB));
    expect((await wallet(walletId)).currentBalance).toBe(before);
  });
});

describe("ش٩ — معيار الخروج: الرصيد يُعاد إنتاجه من الحركات", () => {
  it("سلسلة عمليات مختلطة ⇒ الرصيد المخزَّن = مجموع الحركات الفعّالة", async () => {
    const { walletId } = await mkWallet();
    await withTx((tx) => walletOpsService.deposit(tx, { walletId, amount: "1000000", paymentMethod: "CASH", clientRequestId: rid() }, mgrA));
    await withTx((tx) => walletOpsService.withdraw(tx, { walletId, amount: "150000", paymentMethod: "TRANSFER", clientRequestId: rid() }, mgrA));
    await withTx((tx) => walletOpsService.deposit(tx, { walletId, amount: "25000", paymentMethod: "TRANSFER", clientRequestId: rid() }, mgrA));
    const adj = await withTx((tx) => walletOpsService.requestAdjustment(tx, {
      walletId, amount: "3400", direction: "OUT", reason: "فرق مطابقة", clientRequestId: rid(),
    }, mgrA));
    await withTx((tx) => walletOpsService.approveAdjustment(tx, { transactionId: adj.transactionId }, mgrB));
    // طلبٌ معلّق لا يدخل الحساب.
    await withTx((tx) => walletOpsService.requestAdjustment(tx, {
      walletId, amount: "999999", direction: "OUT", reason: "معلّق", clientRequestId: rid(),
    }, mgrA));

    // 1,000,000 − 150,000 + 25,000 − 3,400 = 871,600
    expect(await walletOpsService.reproduceBalance(db(), walletId)).toBe("871600.00");
    expect((await wallet(walletId)).currentBalance).toBe("871600.00");
    expect(await walletOpsService.assertBalanceReproducible(db(), walletId)).toBe(true);

    // وكل حركة تحمل balanceAfter متّسقاً مع تسلسلها.
    const st = await walletOpsService.statement(db(), { walletId });
    const active = st.filter((r) => r.status === "ACTIVE").reverse();
    expect(active.map((r) => r.balanceAfter)).toEqual([
      "1000000.00", "850000.00", "875000.00", "871600.00",
    ]);
  });
});

describe("ش٩ — المطابقة اليومية (§٥.١١)", () => {
  async function funded(amount = "100000") {
    const { walletId } = await mkWallet();
    await withTx((tx) => walletOpsService.deposit(tx, { walletId, amount, paymentMethod: "CASH", clientRequestId: rid() }, mgrA));
    return walletId;
  }

  it("تطابقٌ تامّ ⇒ MATCHED بفرق صفر ولا تمسّ الرصيد", async () => {
    const walletId = await funded();
    const r = await withTx((tx) => walletOpsService.reconcile(tx, {
      walletId, businessDate: "2026-07-29", actualBalance: "100000",
    }, mgrA));
    expect(r.status).toBe("MATCHED");
    expect(r.variance).toBe("0.00");
    expect((await wallet(walletId)).currentBalance).toBe("100000.00");
  });

  it("عجزٌ ⇒ VARIANCE_OPEN بفرقٍ سالب، والرصيد **لا يتغيّر**", async () => {
    const walletId = await funded();
    const r = await withTx((tx) => walletOpsService.reconcile(tx, {
      walletId, businessDate: "2026-07-29", actualBalance: "96600",
    }, mgrA));
    expect(r.status).toBe("VARIANCE_OPEN");
    expect(r.expectedBalance).toBe("100000.00");
    expect(r.variance).toBe("-3400.00");
    expect((await wallet(walletId)).currentBalance).toBe("100000.00"); // لم تُعدَّل
  });

  it("مطابقة ثانية لنفس اليوم مرفوضة", async () => {
    const walletId = await funded();
    await withTx((tx) => walletOpsService.reconcile(tx, { walletId, businessDate: "2026-07-29", actualBalance: "100000" }, mgrA));
    await expect(withTx((tx) => walletOpsService.reconcile(tx, { walletId, businessDate: "2026-07-29", actualBalance: "99000" }, mgrA)))
      .rejects.toThrow(/سُجّلت مطابقة/);
  });

  it("معالجة الفرق تلزمها تسويةٌ معتمَدة، ثم تُقفل المطابقة", async () => {
    const walletId = await funded();
    const rec = await withTx((tx) => walletOpsService.reconcile(tx, {
      walletId, businessDate: "2026-07-29", actualBalance: "96600",
    }, mgrA));

    const adj = await withTx((tx) => walletOpsService.requestAdjustment(tx, {
      walletId, amount: "3400", direction: "OUT", reason: "عجز مطابقة", clientRequestId: rid(),
    }, mgrA));

    // تعديلٌ لم يُعتمَد بعد ⇒ لا يُقفل الفرق.
    await expect(withTx((tx) => walletOpsService.resolveVariance(tx, {
      reconciliationId: rec.reconciliationId, adjustmentTransactionId: adj.transactionId,
    }, mgrB))).rejects.toThrow(/تعديلٌ معتمَد/);

    await withTx((tx) => walletOpsService.approveAdjustment(tx, { transactionId: adj.transactionId }, mgrB));
    await withTx((tx) => walletOpsService.resolveVariance(tx, {
      reconciliationId: rec.reconciliationId, adjustmentTransactionId: adj.transactionId,
    }, mgrB));

    const [row] = await db().select().from(s.digitalWalletReconciliations)
      .where(eq(s.digitalWalletReconciliations.id, rec.reconciliationId));
    expect(row.status).toBe("RESOLVED");
    // وبعد التسوية صار الرصيد مطابقاً للفعليّ المعدود.
    expect((await wallet(walletId)).currentBalance).toBe("96600.00");
    expect(await walletOpsService.assertBalanceReproducible(db(), walletId)).toBe(true);
  });
});

describe("ش٩ — تنبيه الرصيد المنخفض", () => {
  it("يظهر عند نزول المتاح تحت حدّ المزوّد ويختفي بالإيداع", async () => {
    const { walletId } = await mkWallet("50000");
    await withTx((tx) => walletOpsService.deposit(tx, { walletId, amount: "40000", paymentMethod: "CASH", clientRequestId: rid() }, mgrA));
    expect(await walletOpsService.lowBalanceWallets(db(), 1)).toHaveLength(1);

    await withTx((tx) => walletOpsService.deposit(tx, { walletId, amount: "100000", paymentMethod: "CASH", clientRequestId: rid() }, mgrA));
    expect(await walletOpsService.lowBalanceWallets(db(), 1)).toHaveLength(0);
  });

  it("المحجوز يُحتسب: رصيدٌ كافٍ ومحجوزٌ كبير ⇒ تنبيه", async () => {
    const { walletId } = await mkWallet("50000");
    await withTx((tx) => walletOpsService.deposit(tx, { walletId, amount: "80000", paymentMethod: "CASH", clientRequestId: rid() }, mgrA));
    expect(await walletOpsService.lowBalanceWallets(db(), 1)).toHaveLength(0);

    await db().update(s.digitalWallets).set({ reservedBalance: "40000" }).where(eq(s.digitalWallets.id, walletId));
    expect(await walletOpsService.lowBalanceWallets(db(), 1)).toHaveLength(1);
  });
});
