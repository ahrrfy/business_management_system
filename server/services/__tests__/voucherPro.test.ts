// vouchers-pro (٣٠/٦/٢٦): اختبارات تَعزيزات السندات — Maker-Checker + بَصمة + تَحقّقات إلزامية.
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  approveVoucher,
  createVoucher,
  rejectVoucher,
  recentVouchersForParty,
} from "../voucherService";

const adminActor = { userId: 1, branchId: 1, role: "admin" };
const managerActor = { userId: 2, branchId: 1, role: "manager" };

const TABLES = [
  "idempotencyKeys", "accountingEntries", "receipts", "inventoryMovements", "invoiceItems", "invoices",
  "purchaseOrderItems", "purchaseOrders",
  "branchStock", "productPrices", "productUnits", "productVariants", "products",
  "shifts", "workOrderMaterials", "workOrders", "customers", "suppliers", "branches", "users",
  "auditLogs", "voucherCategories",
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
  await d.insert(s.users).values([
    { id: 1, openId: "admin", name: "admin", role: "admin", loginMethod: "local" },
    { id: 2, openId: "mgr", name: "مدير", role: "manager", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.customers).values({ id: 1, name: "تاجر", defaultPriceTier: "RETAIL", currentBalance: "0.00" });
  await d.insert(s.suppliers).values({ id: 1, name: "مورّد", currentBalance: "0.00" });
  // فئة سَندٍ نموذجية
  await d.insert(s.voucherCategories).values({
    id: 1, name: "إيجار", direction: "OUT", isActive: true, sortOrder: 10,
  });
  await d.insert(s.voucherCategories).values({
    id: 2, name: "إيرادات متفرّقة", direction: "IN", isActive: true, sortOrder: 100,
  });
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("vouchers-pro: تَحقّقات إلزامية", () => {
  it("TRANSFER بلا referenceNumber يُرفض", async () => {
    await expect(createVoucher({
      voucherType: "PAYMENT", branchId: 1, amount: "500.00",
      paymentMethod: "TRANSFER", partyType: "SUPPLIER", partyId: 1,
      description: "تحويل",
    }, adminActor)).rejects.toThrow(/مرجعي/);
  });

  it("CARD بلا cardLastFour يُرفض", async () => {
    await expect(createVoucher({
      voucherType: "RECEIPT", branchId: 1, amount: "500.00",
      paymentMethod: "CARD", partyType: "CUSTOMER", partyId: 1,
      description: "بطاقة",
    }, adminActor)).rejects.toThrow(/البطاقة/);
  });

  it("CHECK بلا checkNumber يُرفض", async () => {
    await expect(createVoucher({
      voucherType: "PAYMENT", branchId: 1, amount: "500.00",
      paymentMethod: "CHECK", partyType: "SUPPLIER", partyId: 1,
      description: "صكّ",
    }, adminActor)).rejects.toThrow(/الصكّ/);
  });

  it("مبلغ ≥ عَتبة المُرفق بلا attachmentUrl يُرفض", async () => {
    // الافتراضي ٢٥٠.٠٠٠ — نُجرّب ٣٠٠.٠٠٠
    await expect(createVoucher({
      voucherType: "PAYMENT", branchId: 1, amount: "300000.00",
      paymentMethod: "CASH", partyType: "OTHER",
      description: "إيجار شهر مايو",
      voucherCategoryId: 1,
    }, adminActor)).rejects.toThrow(/المُرفق/);
  });

  it("مبلغ ≥ عَتبة المُرفق مع attachmentUrl ⇒ يَنجح", async () => {
    const r = await createVoucher({
      voucherType: "PAYMENT", branchId: 1, amount: "300000.00",
      paymentMethod: "CASH", partyType: "OTHER",
      description: "إيجار شهر مايو",
      voucherCategoryId: 1,
      attachmentUrl: "https://drive.example.com/receipt-may.pdf",
    }, adminActor);
    expect(r.voucherNumber).toMatch(/^PV-/);
    expect(r.approvalStatus).toBe("APPROVED");
  });

  it("فئة قَبض على سند صَرف ⇒ تُرفض", async () => {
    await expect(createVoucher({
      voucherType: "PAYMENT", branchId: 1, amount: "100.00",
      paymentMethod: "CASH", partyType: "OTHER",
      description: "x", voucherCategoryId: 2, // فئة IN فقط
    }, adminActor)).rejects.toThrow(/القبض/);
  });

  it("فئة BOTH ⇒ مَقبولة لكلا الاتجاهَين", async () => {
    await db().insert(s.voucherCategories).values({
      id: 3, name: "تَسوية", direction: "BOTH", isActive: true, sortOrder: 200,
    });
    const r1 = await createVoucher({
      voucherType: "PAYMENT", branchId: 1, amount: "10.00",
      paymentMethod: "CASH", partyType: "OTHER", description: "a",
      voucherCategoryId: 3,
    }, adminActor);
    const r2 = await createVoucher({
      voucherType: "RECEIPT", branchId: 1, amount: "20.00",
      paymentMethod: "CASH", partyType: "OTHER", description: "b",
      voucherCategoryId: 3,
    }, adminActor);
    expect(r1.voucherNumber).toMatch(/^PV-/);
    expect(r2.voucherNumber).toMatch(/^RV-/);
  });
});

describe("vouchers-pro: Maker-Checker (موافقة ثانية)", () => {
  it("مبلغ ≥ عَتبة الموافقة ⇒ PENDING_APPROVAL بلا قَيد ولا تَغيير رصيد", async () => {
    const r = await createVoucher({
      voucherType: "PAYMENT", branchId: 1, amount: "2000000.00", // > ١.٠٠٠.٠٠٠
      paymentMethod: "CASH", partyType: "SUPPLIER", partyId: 1,
      description: "دفعة كبيرة",
      attachmentUrl: "https://example.com/proof.pdf",
    }, adminActor);
    expect(r.approvalStatus).toBe("PENDING_APPROVAL");
    // لا قَيد دفتر بَعد
    const ents = await db().select().from(s.accountingEntries);
    expect(ents).toHaveLength(0);
    // رصيد المورّد لم يَتغيّر
    const sup = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0];
    expect(sup.currentBalance).toBe("0.00");
    // لا بَصمة بَعد (تُكتَب عند الاعتماد)
    const rc = (await db().select().from(s.receipts).where(eq(s.receipts.id, r.receiptId)))[0];
    expect(rc.signatureHash).toBeNull();
  });

  it("اعتماد سند مُعلَّق بواسطة مدير غير المُنشئ ⇒ قَيد + رَصيد + بَصمة", async () => {
    const r = await createVoucher({
      voucherType: "PAYMENT", branchId: 1, amount: "2000000.00",
      paymentMethod: "TRANSFER", partyType: "SUPPLIER", partyId: 1,
      description: "حَوالة كَبيرة",
      referenceNumber: "TRF-001",
      attachmentUrl: "https://example.com/proof.pdf",
    }, managerActor); // مَنشأ بواسطة مدير

    const ap = await approveVoucher(r.receiptId, adminActor); // اعتمد بواسطة admin
    expect(ap.approvalStatus).toBe("APPROVED");
    expect(ap.signatureHash).toMatch(/^[0-9a-f]{64}$/);

    const ents = await db().select().from(s.accountingEntries);
    expect(ents).toHaveLength(1); // قَيد PAYMENT_OUT
    expect(ents[0].entryType).toBe("PAYMENT_OUT");

    const sup = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0];
    expect(sup.currentBalance).toBe("-2000000.00"); // AP يَنقص للمورّد ⇒ سَلب

    const rc = (await db().select().from(s.receipts).where(eq(s.receipts.id, r.receiptId)))[0];
    expect(rc.approvalStatus).toBe("APPROVED");
    expect(rc.signatureHash).toBe(ap.signatureHash);
    expect(rc.approvedBy).toBe(1); // adminActor.userId
  });

  it("المُنشئ نَفسه يُحاول اعتماد سَنده (غير admin) ⇒ يُرفض (SOD)", async () => {
    const r = await createVoucher({
      voucherType: "PAYMENT", branchId: 1, amount: "2000000.00",
      paymentMethod: "TRANSFER", partyType: "OTHER",
      description: "عُمولة كَبيرة",
      referenceNumber: "TRF-X",
      attachmentUrl: "https://example.com/proof.pdf",
    }, managerActor);

    await expect(approveVoucher(r.receiptId, managerActor)).rejects.toThrow(/فصل المهام/);
  });

  it("admin يُمكنه اعتماد سَنده بنفسه (مُستثنى للتصحيح الإداري)", async () => {
    const r = await createVoucher({
      voucherType: "PAYMENT", branchId: 1, amount: "2000000.00",
      paymentMethod: "TRANSFER", partyType: "OTHER",
      description: "تَسوية",
      referenceNumber: "TRF-Y",
      attachmentUrl: "https://example.com/proof.pdf",
    }, adminActor);
    const ap = await approveVoucher(r.receiptId, adminActor);
    expect(ap.approvalStatus).toBe("APPROVED");
  });

  it("رَفض سَند مُعلَّق ⇒ لا أَثَر مالي + سَبب مُحفَّظ في internalNote", async () => {
    const r = await createVoucher({
      voucherType: "PAYMENT", branchId: 1, amount: "2000000.00",
      paymentMethod: "TRANSFER", partyType: "OTHER",
      description: "صَرف مَشكوك",
      referenceNumber: "TRF-Z",
      attachmentUrl: "https://example.com/proof.pdf",
    }, managerActor);

    const rj = await rejectVoucher(r.receiptId, adminActor, "مبلغ غير مَفهوم — يَلزم تَوضيح");
    expect(rj.approvalStatus).toBe("REJECTED");

    const ents = await db().select().from(s.accountingEntries);
    expect(ents).toHaveLength(0); // لا قَيد

    const rc = (await db().select().from(s.receipts).where(eq(s.receipts.id, r.receiptId)))[0];
    expect(rc.approvalStatus).toBe("REJECTED");
    expect(String(rc.internalNote ?? "")).toContain("مبلغ غير مَفهوم");
  });

  it("لا يَجوز اعتماد سَند سَبق رفضه/اعتماده", async () => {
    const r = await createVoucher({
      voucherType: "PAYMENT", branchId: 1, amount: "2000000.00",
      paymentMethod: "TRANSFER", partyType: "OTHER",
      description: "x", referenceNumber: "T",
      attachmentUrl: "https://example.com/proof.pdf",
    }, managerActor);
    await approveVoucher(r.receiptId, adminActor);
    await expect(approveVoucher(r.receiptId, adminActor)).rejects.toThrow(/بالفعل/);
  });
});

describe("vouchers-pro: السندات الأخيرة لنفس الطَرف", () => {
  it("CUSTOMER: يَجلب آخر السندات حسب partyId", async () => {
    await createVoucher({
      voucherType: "RECEIPT", branchId: 1, amount: "10.00",
      paymentMethod: "CASH", partyType: "CUSTOMER", partyId: 1,
      description: "دفعة ١",
    }, adminActor);
    await createVoucher({
      voucherType: "RECEIPT", branchId: 1, amount: "20.00",
      paymentMethod: "CASH", partyType: "CUSTOMER", partyId: 1,
      description: "دفعة ٢",
    }, adminActor);
    const recent = await recentVouchersForParty({
      partyType: "CUSTOMER", partyId: 1, windowDays: 7, limit: 5,
    });
    expect(recent.length).toBe(2);
  });

  it("OTHER: يَجلب حسب counterpartyName نَصّياً", async () => {
    await createVoucher({
      voucherType: "PAYMENT", branchId: 1, amount: "100.00",
      paymentMethod: "CASH", partyType: "OTHER",
      description: "راتب",
      counterpartyName: "أحمد محمد",
    }, adminActor);
    await createVoucher({
      voucherType: "PAYMENT", branchId: 1, amount: "200.00",
      paymentMethod: "CASH", partyType: "OTHER",
      description: "بَدل",
      counterpartyName: "أحمد محمد",
    }, adminActor);
    const recent = await recentVouchersForParty({
      partyType: "OTHER", counterpartyName: "أحمد محمد", windowDays: 7, limit: 5,
    });
    expect(recent.length).toBe(2);

    // اسم آخر ⇒ لا نَتائج
    const other = await recentVouchersForParty({
      partyType: "OTHER", counterpartyName: "سَمير", windowDays: 7, limit: 5,
    });
    expect(other.length).toBe(0);
  });
});

describe("vouchers-pro: بَصمة SHA-256 + ثَبات", () => {
  it("سَند صَغير (لا اعتماد) ⇒ بَصمة تُكتب فوراً", async () => {
    const r = await createVoucher({
      voucherType: "RECEIPT", branchId: 1, amount: "50.00",
      paymentMethod: "CASH", partyType: "OTHER",
      description: "إيراد",
    }, adminActor);
    const rc = (await db().select().from(s.receipts).where(eq(s.receipts.id, r.receiptId)))[0];
    expect(rc.signatureHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("نَفس المُدخلات ⇒ بَصمات مُختلفة (لأنّ id مُختلف ⇒ canonical مُختلف)", async () => {
    const r1 = await createVoucher({
      voucherType: "RECEIPT", branchId: 1, amount: "50.00",
      paymentMethod: "CASH", partyType: "OTHER", description: "x",
    }, adminActor);
    const r2 = await createVoucher({
      voucherType: "RECEIPT", branchId: 1, amount: "50.00",
      paymentMethod: "CASH", partyType: "OTHER", description: "x",
    }, adminActor);
    const rc1 = (await db().select().from(s.receipts).where(eq(s.receipts.id, r1.receiptId)))[0];
    const rc2 = (await db().select().from(s.receipts).where(eq(s.receipts.id, r2.receiptId)))[0];
    expect(rc1.signatureHash).not.toBe(rc2.signatureHash);
  });
});
