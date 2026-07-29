import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";
import { createSupplier } from "../supplierService";
import { withTx } from "../tx";
import { offeringService, providerService, walletService } from "../digitalCards";

/**
 * البطاقات الرقمية والاشتراكات — ش٣: المزوّد والمحفظة والعرض.
 * راجع docs/digital-cards-platform-subscriptions-implementation-plan-2026-07-29.md §٥ + §١٧.
 */

const actor = { userId: 1, branchId: 1 };

const TABLES = [
  "digitalOfferingBranches", "digitalOfferings", "digitalWallets", "digitalProviders",
  "productPrices", "productUnitBarcodes", "productUnits", "productVariants", "products",
  "auditLogs", "suppliers", "categories", "users", "branches",
];

function db() { const d = getDb(); if (!d) throw new Error("DATABASE_URL not set for tests"); return d; }

async function seedBase() {
  await db().insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
  await db().insert(s.users).values({ id: 1, openId: "local_test", name: "admin", role: "admin", loginMethod: "local" });
}

async function mkSupplier(name: string) {
  const { supplierId } = await createSupplier({ name }, actor);
  return supplierId;
}

async function mkProvider(opts: { name: string; settlementMode: "PREPAID" | "POSTPAID" }) {
  const supplierId = await mkSupplier(opts.name);
  const { providerId } = await withTx((tx) =>
    providerService.createProvider(tx, {
      supplierId,
      providerType: "TELECOM",
      settlementMode: opts.settlementMode,
      recognitionMode: "PRINCIPAL_GROSS",
      referencePolicy: "OPTIONAL",
      settlementCycle: "ON_DEMAND",
    }, actor),
  );
  return { providerId, supplierId };
}

function offeringInput(providerId: number, over: Partial<Parameters<typeof offeringService.createOffering>[1]> = {}) {
  return {
    providerId,
    offeringType: "TELECOM_CARD",
    name: "كارت آسياسيل ١٠ آلاف",
    pricingMode: "FIXED_MARGIN",
    fixedMargin: "500",
    roundingStep: "250",
    branches: [{ branchId: 1 }],
    ...over,
  } as Parameters<typeof offeringService.createOffering>[1];
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await seedBase();
});

describe("ش٣ — المزوّد", () => {
  it("ينشئ مزوّداً مرتبطاً بمورّد ويخزّن حقول التسوية", async () => {
    const { providerId, supplierId } = await mkProvider({ name: "آسياسيل", settlementMode: "PREPAID" });
    const row = await providerService.getProvider(db(), providerId);
    expect(row.supplierId).toBe(supplierId);
    expect(row.supplierName).toBe("آسياسيل");
    expect(row.settlementMode).toBe("PREPAID");
    expect(row.lowBalanceThreshold).toBe("0.00");
    expect(row.isActive).toBe(true);
  });

  it("يرفض مورّداً غير موجود", async () => {
    await expect(
      withTx((tx) => providerService.createProvider(tx, {
        supplierId: 999999, providerType: "TELECOM", settlementMode: "PREPAID",
        recognitionMode: "PRINCIPAL_GROSS", referencePolicy: "NONE", settlementCycle: "DAILY",
      }, actor)),
    ).rejects.toThrow(/المورّد غير موجود/);
  });

  it("مورّد واحد لا يحمل مزوّدَين (قيد فريد supplierId)", async () => {
    const { supplierId } = await mkProvider({ name: "زين", settlementMode: "POSTPAID" });
    await expect(
      withTx((tx) => providerService.createProvider(tx, {
        supplierId, providerType: "TELECOM", settlementMode: "PREPAID",
        recognitionMode: "PRINCIPAL_GROSS", referencePolicy: "NONE", settlementCycle: "DAILY",
      }, actor)),
    ).rejects.toThrow();
  });

  it("التعديل لا يمسّ supplierId ويكتب أثراً في التدقيق", async () => {
    const { providerId, supplierId } = await mkProvider({ name: "كورك", settlementMode: "PREPAID" });
    await withTx((tx) => providerService.updateProvider(tx, {
      id: providerId, lowBalanceThreshold: "50000", referencePolicy: "REQUIRED",
    }, actor));
    const row = await providerService.getProvider(db(), providerId);
    expect(row.supplierId).toBe(supplierId);
    expect(row.lowBalanceThreshold).toBe("50000.00");
    expect(row.referencePolicy).toBe("REQUIRED");
    const logs = await db().select().from(s.auditLogs)
      .where(eq(s.auditLogs.action, "digitalCards.provider.update"));
    expect(logs).toHaveLength(1);
  });
});

describe("ش٣ — المحفظة", () => {
  it("تُنشأ برصيد صفر ومحجوز صفر لمزوّد مسبق الدفع", async () => {
    const { providerId } = await mkProvider({ name: "آسياسيل", settlementMode: "PREPAID" });
    const { walletId } = await withTx((tx) =>
      walletService.createWallet(tx, { providerId, branchId: 1, code: "DEV-1", name: "جهاز الكاشير" }, actor),
    );
    const w = await walletService.getWallet(db(), walletId);
    expect(w.currentBalance).toBe("0.00");
    expect(w.reservedBalance).toBe("0.00");
    expect(w.currency).toBe("IQD");
    expect(w.branchId).toBe(1);
  });

  it("تُرفض لمزوّد آجل (POSTPAID) — المحافظ للمسبق فقط", async () => {
    const { providerId } = await mkProvider({ name: "زين", settlementMode: "POSTPAID" });
    await expect(
      withTx((tx) => walletService.createWallet(tx, { providerId, branchId: 1, code: "X", name: "y" }, actor)),
    ).rejects.toThrow(/الدفع المسبق/);
  });

  it("يرفض رمزاً مكرّراً لنفس المزوّد والفرع، ويسمح به في فرع آخر", async () => {
    const { providerId } = await mkProvider({ name: "آسياسيل", settlementMode: "PREPAID" });
    await withTx((tx) => walletService.createWallet(tx, { providerId, branchId: 1, code: "DEV", name: "أ" }, actor));
    await expect(
      withTx((tx) => walletService.createWallet(tx, { providerId, branchId: 1, code: "DEV", name: "ب" }, actor)),
    ).rejects.toThrow(/نفس الرمز/);
    const ok = await withTx((tx) =>
      walletService.createWallet(tx, { providerId, branchId: 2, code: "DEV", name: "ج" }, actor),
    );
    expect(ok.walletId).toBeGreaterThan(0);
  });
});

describe("ش٣ — العرض (البطاقة)", () => {
  it("ينشئ منتجاً خدمياً تلقائياً موسوماً DIGITAL_CARD بوحدة أساس واحدة", async () => {
    const { providerId } = await mkProvider({ name: "آسياسيل", settlementMode: "PREPAID" });
    const r = await withTx((tx) => offeringService.createOffering(tx, offeringInput(providerId), actor));

    const [p] = await db().select().from(s.products).where(eq(s.products.id, r.productId));
    expect(p.isService).toBe(true);
    expect(p.productType).toBe("DIGITAL_CARD");
    expect(p.name).toBe("كارت آسياسيل ١٠ آلاف");
    expect(p.showInStore).toBe(false);

    const [u] = await db().select().from(s.productUnits)
      .where(and(eq(s.productUnits.id, r.productUnitId), eq(s.productUnits.isBaseUnit, true)));
    expect(Number(u.conversionFactor)).toBe(1);

    const links = await db().select().from(s.digitalOfferingBranches)
      .where(eq(s.digitalOfferingBranches.offeringId, r.offeringId));
    expect(links).toHaveLength(1);
    expect(links[0].branchId).toBe(1);
  });

  it("معيار خروج ش٣: البطاقة تظهر إدارياً ولا سعر نافذاً لها قبل النشر", async () => {
    const { providerId } = await mkProvider({ name: "آسياسيل", settlementMode: "PREPAID" });
    const r = await withTx((tx) => offeringService.createOffering(tx, offeringInput(providerId), actor));

    const admin = await offeringService.listOfferings(db(), {});
    expect(admin.map((o) => o.id)).toContain(r.offeringId);

    const current = await db().select().from(s.digitalCurrentPrices)
      .where(eq(s.digitalCurrentPrices.offeringId, r.offeringId));
    expect(current).toHaveLength(0);
  });

  it("يرفض ربط محفظة بعرض لمزوّد آجل", async () => {
    const { providerId: prepaidId } = await mkProvider({ name: "آسياسيل", settlementMode: "PREPAID" });
    const { walletId } = await withTx((tx) =>
      walletService.createWallet(tx, { providerId: prepaidId, branchId: 1, code: "W", name: "w" }, actor),
    );
    const { providerId: postpaidId } = await mkProvider({ name: "زين", settlementMode: "POSTPAID" });
    await expect(
      withTx((tx) => offeringService.createOffering(tx, offeringInput(postpaidId, {
        branches: [{ branchId: 1, walletId }],
      }), actor)),
    ).rejects.toThrow(/غير مسبق الدفع/);
  });

  it("يرفض محفظة من فرع آخر", async () => {
    const { providerId } = await mkProvider({ name: "آسياسيل", settlementMode: "PREPAID" });
    const { walletId } = await withTx((tx) =>
      walletService.createWallet(tx, { providerId, branchId: 2, code: "W2", name: "w" }, actor),
    );
    await expect(
      withTx((tx) => offeringService.createOffering(tx, offeringInput(providerId, {
        branches: [{ branchId: 1, walletId }],
      }), actor)),
    ).rejects.toThrow(/لا تنتمي للفرع/);
  });

  it("يرفض عرضاً بلا فرع", async () => {
    const { providerId } = await mkProvider({ name: "آسياسيل", settlementMode: "PREPAID" });
    await expect(
      withTx((tx) => offeringService.createOffering(tx, offeringInput(providerId, { branches: [] }), actor)),
    ).rejects.toThrow(/فرع واحد على الأقل/);
  });

  it("فشل ربط الفرع يُرجِع المنتج المُنشأ تلقائياً (ذرّية المعاملة)", async () => {
    const { providerId } = await mkProvider({ name: "آسياسيل", settlementMode: "PREPAID" });
    const before = await db().select().from(s.products);
    await expect(
      withTx((tx) => offeringService.createOffering(tx, offeringInput(providerId, {
        branches: [{ branchId: 999999 }],
      }), actor)),
    ).rejects.toThrow(/غير موجود/);
    const after = await db().select().from(s.products);
    expect(after).toHaveLength(before.length);
  });

  it("التعديل يغيّر الاسم في المنتج ويستبدل الفروع", async () => {
    const { providerId } = await mkProvider({ name: "آسياسيل", settlementMode: "PREPAID" });
    const r = await withTx((tx) => offeringService.createOffering(tx, offeringInput(providerId), actor));

    await withTx((tx) => offeringService.updateOffering(tx, {
      id: r.offeringId, name: "كارت آسياسيل ٢٥ ألفاً", minimumMargin: "250",
      branches: [{ branchId: 1, isFavorite: true }, { branchId: 2 }],
    }, actor));

    const o = await offeringService.getOffering(db(), r.offeringId);
    expect(o.productName).toBe("كارت آسياسيل ٢٥ ألفاً");
    expect(o.minimumMargin).toBe("250.00");
    expect(o.branches).toHaveLength(2);
    expect(o.branches.find((b) => b.branchId === 1)?.isFavorite).toBe(true);
  });

  it("التعطيل يخفي البطاقة من القائمة النشطة دون حذفها", async () => {
    const { providerId } = await mkProvider({ name: "آسياسيل", settlementMode: "PREPAID" });
    const r = await withTx((tx) => offeringService.createOffering(tx, offeringInput(providerId), actor));
    await withTx((tx) => offeringService.updateOffering(tx, { id: r.offeringId, isActive: false }, actor));

    expect(await offeringService.listOfferings(db(), { isActive: true })).toHaveLength(0);
    expect(await offeringService.listOfferings(db(), {})).toHaveLength(1);
  });

  it("إعادة الترتيب تمسّ الفرع المستهدف وحده", async () => {
    const { providerId } = await mkProvider({ name: "آسياسيل", settlementMode: "PREPAID" });
    const r = await withTx((tx) => offeringService.createOffering(tx, offeringInput(providerId, {
      branches: [{ branchId: 1, displayOrder: 0 }, { branchId: 2, displayOrder: 0 }],
    }), actor));

    await withTx((tx) => offeringService.reorderOfferings(tx, {
      branchId: 1, order: [{ offeringId: r.offeringId, displayOrder: 7 }],
    }, actor));

    const links = await db().select().from(s.digitalOfferingBranches)
      .where(eq(s.digitalOfferingBranches.offeringId, r.offeringId));
    expect(links.find((l) => l.branchId === 1)?.displayOrder).toBe(7);
    expect(links.find((l) => l.branchId === 2)?.displayOrder).toBe(0);
  });

  it("فلتر الفرع يعزل بطاقات الفروع الأخرى", async () => {
    const { providerId } = await mkProvider({ name: "آسياسيل", settlementMode: "PREPAID" });
    await withTx((tx) => offeringService.createOffering(tx, offeringInput(providerId, {
      name: "بطاقة الفرع الرئيسي", branches: [{ branchId: 1 }],
    }), actor));
    await withTx((tx) => offeringService.createOffering(tx, offeringInput(providerId, {
      name: "بطاقة فرع المبيعات", branches: [{ branchId: 2 }],
    }), actor));

    const b1 = await offeringService.listOfferings(db(), { branchId: 1 });
    expect(b1.map((o) => o.productName)).toEqual(["بطاقة الفرع الرئيسي"]);
  });
});
