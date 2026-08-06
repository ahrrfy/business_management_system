import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { ALL_ROLES, moduleAccessAllowed } from "@shared/permissions";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";
import { createSupplier } from "../supplierService";
import { withTx } from "../tx";
import {
  dashboardService, intentService, offeringService, posCardsService,
  pricingService, providerService, studentService, walletOpsService, walletService,
} from "../digitalCards";

/**
 * البطاقات الرقمية — ش١٣: التمتين.
 * يغطّي بنود §١٧ القابلة للأتمتة: عزل الفرع لكل قراءة، تسريب التكلفة وPII،
 * والضغط المتزامن على رصيد المحفظة. (النشر/الاستعادة قرارُ مالكٍ خارج الاختبار.)
 */

const actor = { userId: 1, branchId: 1, role: "cashier" };
const mgr = { userId: 2, branchId: 1, role: "manager" };
const DATE = "2026-07-29";

const TABLES = [
  "digitalWalletReconciliations", "digitalSaleDetails", "digitalSaleExecutionClaims", "digitalSaleIntentItems",
  "digitalWalletReservations", "digitalSaleIntents", "digitalWalletTransactions",
  "digitalCurrentPrices", "digitalPriceVersions", "digitalPriceBatches",
  "digitalOfferingBranches", "digitalOfferings", "digitalWallets", "digitalProviders",
  "accountingEntries", "receipts", "inventoryMovements", "invoiceItems", "invoices", "idempotencyKeys",
  "branchStock", "productPrices", "productUnitBarcodes", "productUnits", "productVariants", "products",
  "shifts", "auditLogs", "studentProfiles", "customers", "suppliers", "categories", "users", "branches",
];

function db() { const d = getDb(); if (!d) throw new Error("DATABASE_URL not set for tests"); return d; }

async function seedBase() {
  await db().insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
  await db().insert(s.users).values([
    { id: 1, openId: "u1", name: "كاشير", role: "cashier", loginMethod: "local" },
    { id: 2, openId: "u2", name: "مدير", role: "manager", loginMethod: "local" },
  ]);
  await db().insert(s.shifts).values({ id: 1, branchId: 1, userId: 1, status: "OPEN", openingBalance: "0" });
}

async function setup(branchId = 1) {
  const { supplierId } = await createSupplier({ name: `مزوّد-${branchId}-${Math.random().toString(36).slice(2, 6)}` }, { userId: 1, branchId: 1 });
  const { providerId } = await withTx((tx) => providerService.createProvider(tx, {
    supplierId, providerType: "TELECOM", settlementMode: "PREPAID", recognitionMode: "PRINCIPAL_GROSS",
    referencePolicy: "OPTIONAL", settlementCycle: "ON_DEMAND",
  }, { userId: 1, branchId: 1 }));
  const { walletId } = await withTx((tx) => walletService.createWallet(tx, {
    providerId, branchId, code: `W${branchId}${Math.random().toString(36).slice(2, 5)}`, name: `محفظة ${branchId}`,
  }, { userId: 1, branchId: 1 }));
  await withTx((tx) => walletOpsService.deposit(tx, {
    walletId, amount: "1000000", paymentMethod: "CASH", clientRequestId: `d-${Math.random().toString(36).slice(2, 12)}`,
  }, mgr));
  const r = await withTx((tx) => offeringService.createOffering(tx, {
    providerId, offeringType: "TELECOM_CARD", name: `كارت-${branchId}`, pricingMode: "FIXED_MARGIN",
    fixedMargin: "850", roundingStep: "0", branches: [{ branchId, walletId }],
  }, { userId: 1, branchId: 1 }));
  const { batchId } = await withTx((tx) =>
    pricingService.createOrGetDraft(tx, { branchId, providerId, businessDate: DATE }, { userId: 1, branchId: 1 }));
  await withTx((tx) => pricingService.saveDraft(tx, {
    batchId, lines: [{ offeringId: r.offeringId, providerShare: "13400" }],
  }, { userId: 1, branchId: 1 }));
  await withTx((tx) => pricingService.publish(tx, { batchId }, { userId: 1, branchId: 1 }));
  const [cp] = await db().select().from(s.digitalCurrentPrices).where(eq(s.digitalCurrentPrices.offeringId, r.offeringId));
  return { providerId, walletId, offeringId: r.offeringId, priceVersionId: Number(cp.priceVersionId) };
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await seedBase();
});

describe("ش١٣ — عزل الفرع على كل قراءة", () => {
  it("لا قراءة تتسرّب عبر الفروع: الشبكة والأسعار والصحة والداشبورد", async () => {
    const b1 = await setup(1);
    const b2 = await setup(2);

    // شبكة الكاشير
    expect((await posCardsService.listCards(db(), { branchId: 1 })).map((c) => c.offeringId)).toEqual([b1.offeringId]);
    expect((await posCardsService.listCards(db(), { branchId: 2 })).map((c) => c.offeringId)).toEqual([b2.offeringId]);
    // تأكيد بطاقة فرعٍ آخر مرفوض
    await expect(posCardsService.confirmCard(db(), { branchId: 1, offeringId: b2.offeringId }))
      .rejects.toThrow(/غير متاحة في هذا الفرع/);

    // كشف أسعار الصباح
    const sheet1 = await pricingService.getMorningSheet(db(), { branchId: 1, providerId: b2.providerId, businessDate: DATE });
    expect(sheet1.rows).toHaveLength(0); // مزوّد الفرع ٢ بلا بطاقات في الفرع ١

    // صحة الأسعار
    expect((await dashboardService.priceHealth(db(), 1)).total).toBe(1);
    expect((await dashboardService.priceHealth(db(), 2)).total).toBe(1);

    // أرصدة المحافظ
    expect((await dashboardService.providerBalances(db(), 1)).wallets.map((w) => w.walletId)).toEqual([b1.walletId]);
    expect((await dashboardService.providerBalances(db(), 2)).wallets.map((w) => w.walletId)).toEqual([b2.walletId]);
  });

  it("النيّة لا تُعَدّ لفرعٍ غير فرعها، ووردية فرعٍ آخر مرفوضة", async () => {
    const b2 = await setup(2);
    await expect(withTx((tx) => intentService.prepare(tx, {
      clientRequestId: "cross-branch-1", branchId: 2, shiftId: 1, paymentMethod: "CASH", cartFingerprint: "fp",
      lines: [{ lineKey: "lk", offeringId: b2.offeringId, priceVersionId: b2.priceVersionId, expectedSellPrice: "14250.00" }],
    }, actor))).rejects.toThrow(/تخصّ فرعاً آخر/);
  });
});

describe("ش١٣ — تسريب التكلفة وPII", () => {
  it("مخرَج الكاشير خالٍ من التكلفة والهامش والرصيد", async () => {
    const b1 = await setup(1);
    const cards = await posCardsService.listCards(db(), { branchId: 1 });
    const blob = JSON.stringify(cards);
    for (const forbidden of ["13400", "providerShare", "marginAmount", "fixedMargin", "minimumMargin", "currentBalance", "reservedBalance", "settlementMode"]) {
      expect(blob, `تسريب ${forbidden}`).not.toContain(forbidden);
    }
    expect(cards[0].sellPrice).toBe("14250.00");
    expect(b1.offeringId).toBeGreaterThan(0);
  });

  it("الداشبورد بلا صلاحية تكلفة لا يحمل الحصة ولا الربح", async () => {
    await setup(1);
    const sum = await dashboardService.summary(db(), { from: "2026-01-01", to: "2027-01-01", branchId: 1, includeCost: false });
    expect(sum.providerShare).toBeNull();
    expect(sum.profit).toBeNull();
    expect(JSON.stringify(sum)).not.toContain("13400");
  });

  it("رسائل أخطاء الطالب لا تحمل بياناته (PII)", async () => {
    const bad = { studentName: "مريم", studentPhone: "123", guardianPhone: "07709998888", address: "بغداد", mode: "UPDATE_PROFILE" as const };
    await expect(withTx((tx) => studentService.commitStudent(tx, bad, mgr))).rejects.toThrow(/غير صالح/);
    try {
      await withTx((tx) => studentService.commitStudent(tx, bad, mgr));
    } catch (e) {
      const msg = String((e as Error).message);
      expect(msg).not.toContain("123");
      expect(msg).not.toContain("مريم");
      expect(msg).not.toContain("07709998888");
    }
  });

  it("بحث الطلاب لا يعيد أرقاماً مالية للعميل", async () => {
    await withTx((tx) => studentService.commitStudent(tx, {
      studentName: "مريم", studentPhone: "07713334444", guardianPhone: "07705556666", address: "بغداد", mode: "UPDATE_PROFILE",
    }, mgr));
    const found = await studentService.searchStudents(db(), { studentPhone: "07713334444" });
    expect(found).toHaveLength(1);
    for (const k of ["currentBalance", "creditLimit", "totalPurchases"]) {
      expect(Object.keys(found[0]), `تسريب ${k}`).not.toContain(k);
    }
  });
});

describe("ش١٣ — الضغط المتزامن على رصيد المحفظة", () => {
  it("نيّتان متزامنتان على آخر رصيدٍ متاح: واحدة تنجح والأخرى تُرفض — لا رصيد سالب", async () => {
    const { providerId, walletId, offeringId, priceVersionId } = await setup(1);
    // نُنزل الرصيد إلى ما يكفي كرتاً واحداً فقط (13,400).
    await withTx((tx) => walletOpsService.withdraw(tx, {
      walletId, amount: "986600", paymentMethod: "CASH", clientRequestId: `w-${Math.random().toString(36).slice(2, 12)}`,
    }, mgr));
    const [w0] = await db().select().from(s.digitalWallets).where(eq(s.digitalWallets.id, walletId));
    expect(w0.currentBalance).toBe("13400.00");

    const attempt = (key: string) =>
      withTx((tx) => intentService.prepare(tx, {
        clientRequestId: key, branchId: 1, shiftId: 1, paymentMethod: "CASH", cartFingerprint: key,
        lines: [{ lineKey: `${key}-l`, offeringId, priceVersionId, expectedSellPrice: "14250.00" }],
      }, actor)).then(() => "ok" as const).catch(() => "rejected" as const);

    const results = await Promise.all([attempt("race-aaaa-1111"), attempt("race-bbbb-2222")]);
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r === "rejected")).toHaveLength(1);

    // ✦ الثابت: المحجوز لا يتجاوز الرصيد أبداً، ولا رصيد سالب.
    const [w1] = await db().select().from(s.digitalWallets).where(eq(s.digitalWallets.id, walletId));
    expect(Number(w1.reservedBalance)).toBeLessThanOrEqual(Number(w1.currentBalance));
    expect(Number(w1.currentBalance)).toBeGreaterThanOrEqual(0);
    expect(w1.reservedBalance).toBe("13400.00");
    expect(providerId).toBeGreaterThan(0);
  });

  it("إيداعات متزامنة كلها تُحتسب والرصيد يظلّ قابلاً لإعادة الإنتاج", async () => {
    const { walletId } = await setup(1);
    const [before] = await db().select().from(s.digitalWallets).where(eq(s.digitalWallets.id, walletId));

    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        withTx((tx) => walletOpsService.deposit(tx, {
          walletId, amount: "1000", paymentMethod: "CASH", clientRequestId: `conc-dep-${i}-${Math.random().toString(36).slice(2, 8)}`,
        }, mgr)),
      ),
    );

    const [after] = await db().select().from(s.digitalWallets).where(eq(s.digitalWallets.id, walletId));
    expect(Number(after.currentBalance)).toBe(Number(before.currentBalance) + 5000);
    expect(await walletOpsService.assertBalanceReproducible(db(), walletId)).toBe(true);
  });
});

describe("ش١٣ — بوّابات الصلاحيات", () => {
  it("قالب الكاشير يفتح شبكة البطاقات ويُغلق القراءة الإدارية", () => {
    const posGate = (role: string) => moduleAccessAllowed(role, null, "digital_cards", "READ", ALL_ROLES);
    const adminGate = (role: string) => moduleAccessAllowed(role, null, "digital_cards", "READ", ["manager", "accountant", "auditor"]);
    const writeGate = (role: string) => moduleAccessAllowed(role, null, "digital_cards", "FULL", ["manager"]);

    expect(posGate("cashier")).toBe(true);
    expect(adminGate("cashier")).toBe(false);
    expect(writeGate("cashier")).toBe(false);

    for (const role of ["manager", "accountant", "auditor"]) expect(adminGate(role)).toBe(true);
    for (const role of ["warehouse", "purchasing", "sales_rep", "user"]) {
      expect(posGate(role), `${role} × الشبكة`).toBe(false);
      expect(adminGate(role), `${role} × الإدارية`).toBe(false);
      expect(writeGate(role), `${role} × الكتابة`).toBe(false);
    }
    // admin يعبُر كل البوّابات (تجاوز فوقيّ ثابت).
    expect(ALL_ROLES.includes("admin")).toBe(true);
    expect(writeGate("admin")).toBe(true);
  });
});

describe("ش١٣ — فهارس الاستعلامات الثقيلة", () => {
  it("الجداول الساخنة تحمل فهارسها المتوقَّعة", async () => {
    const rows = await db().execute(sql`
      SELECT TABLE_NAME AS t, INDEX_NAME AS i
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME IN ('digitalSaleDetails','digitalCurrentPrices','digitalOfferingBranches',
                           'digitalWalletTransactions','digitalSaleIntents','digitalPriceVersions')
    `);
    const list = (Array.isArray(rows) ? (rows[0] as unknown as { t: string; i: string }[]) : []) ?? [];
    const have = new Set(list.map((r) => `${r.t}.${r.i}`));

    // مفاتيح/فهارس تعتمد عليها قراءات الشبكة والداشبورد والكشوف.
    expect(have.has("digitalCurrentPrices.PRIMARY")).toBe(true);          // (branchId, offeringId)
    expect(have.has("digitalOfferingBranches.PRIMARY")).toBe(true);       // (offeringId, branchId)
    expect(have.has("digitalWalletTransactions.idx_dwt_wallet")).toBe(true);
    expect(have.has("digitalSaleIntents.idx_dsi_status")).toBe(true);
    expect(have.has("digitalPriceVersions.idx_dpv_offering")).toBe(true);
  });
});
