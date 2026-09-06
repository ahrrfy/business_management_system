// vouchers-pro (٣٠/٦/٢٦): اختبارات تَعزيزات السندات — Maker-Checker + بَصمة + تَحقّقات إلزامية.
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";

import { getDb } from "../../db";
import {
  approveVoucher,
  createVoucher as createVoucherRaw,
  rejectVoucher,
  recentVouchersForParty,
} from "../voucherService";

type LegacyVoucherInput = Omit<Parameters<typeof createVoucherRaw>[0], "clientRequestId"> & {
  clientRequestId?: string;
};
let voucherRequestSequence = 0;
function createVoucher(input: LegacyVoucherInput, actor: Parameters<typeof createVoucherRaw>[1]) {
  voucherRequestSequence += 1;
  const isOther = input.partyType === "OTHER";
  const isOtherReceipt = isOther && input.voucherType === "RECEIPT";
  return createVoucherRaw({
    ...input,
    voucherCategoryId: isOther
      ? (input.voucherCategoryId ?? (input.voucherType === "RECEIPT" ? 2 : 1))
      : input.voucherCategoryId,
    counterpartyName: isOther ? (input.counterpartyName ?? "طرف اختباري موثق") : input.counterpartyName,
    referenceNumber: isOtherReceipt ? (input.referenceNumber ?? `SRC-PRO-${voucherRequestSequence}`) : input.referenceNumber,
    clientRequestId: input.clientRequestId ?? `voucher-pro-test-${voucherRequestSequence}`,
  }, actor);
}

const adminActor = { userId: 1, branchId: 1, role: "admin" };
const managerActor = { userId: 2, branchId: 1, role: "manager" };
const ownerManagerActor = { userId: 3, branchId: 1, role: "manager" };

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
    { id: 1, openId: "admin", name: "admin", role: "admin", loginMethod: "local", branchId: 1, isOwner: true },
    { id: 2, openId: "mgr", name: "مدير", role: "manager", loginMethod: "local", branchId: 1, isOwner: false },
    { id: 3, openId: "owner-mgr", name: "مالك بدور مدير", role: "manager", loginMethod: "local", branchId: 1, isOwner: true },
  ]);
  await d.insert(s.customers).values({ id: 1, name: "تاجر", defaultPriceTier: "RETAIL", currentBalance: "0.00" });
  await d.insert(s.suppliers).values({ id: 1, name: "مورّد", currentBalance: "0.00" });
  // فئة سَندٍ نموذجية
  await d.insert(s.voucherCategories).values({
    id: 1, name: "إيجار", direction: "OUT", postingRole: "RENT", isActive: true, sortOrder: 10,
  });
  await d.insert(s.voucherCategories).values({
    id: 2, name: "إيرادات متفرّقة", direction: "IN", postingRole: "OTHER_REVENUE", isActive: true, sortOrder: 100,
  });
  await d.insert(s.receipts).values({
    branchId: 1,
    cashBucket: "TREASURY",
    direction: "IN",
    amount: "10000000.00",
    paymentMethod: "CASH",
    status: "COMPLETED",
    referenceNumber: "TEST-TREASURY-FUND",
    createdBy: 1,
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

  it("CARD للقبض بلا cardLastFour يُرفض (المطابقة مع كشف المزوّد)", async () => {
    await expect(createVoucher({
      voucherType: "RECEIPT", branchId: 1, amount: "500.00",
      paymentMethod: "CARD", partyType: "CUSTOMER", partyId: 1,
      description: "بطاقة",
    }, adminActor)).rejects.toThrow(/آخر ٤ من البطاقة/);
  });

  it("CHECK بلا checkNumber يُرفض", async () => {
    await expect(createVoucher({
      voucherType: "PAYMENT", branchId: 1, amount: "500.00",
      paymentMethod: "CHECK", partyType: "SUPPLIER", partyId: 1,
      description: "صكّ",
    }, adminActor)).rejects.toThrow(/الصكّ/);
  });

  it("لا مُرفق إلزامي: مبلغ كبير بلا attachmentUrl ⇒ يَنجح (٣١/٧ — أُلغيت عَتبة المُرفق)", async () => {
    // كان يُرفض سابقاً عند ≥ ٢٥٠.٠٠٠ — الآن المُرفق اختياريّ في النظام كله.
    const r = await createVoucher({
      voucherType: "PAYMENT", branchId: 1, amount: "300000.00",
      paymentMethod: "CASH", partyType: "OTHER",
      description: "إيجار شهر مايو",
      voucherCategoryId: 1,
    }, managerActor);
    expect(r.voucherNumber).toMatch(/^PV-/);
    expect(r.approvalStatus).toBe("PENDING_APPROVAL");
  });

  it("مبلغ كبير مع attachmentUrl ⇒ يَنجح", async () => {
    const r = await createVoucher({
      voucherType: "PAYMENT", branchId: 1, amount: "300000.00",
      paymentMethod: "CASH", partyType: "OTHER",
      description: "إيجار شهر مايو",
      voucherCategoryId: 1,
      attachmentUrl: "https://drive.example.com/receipt-may.pdf",
    }, managerActor);
    expect(r.voucherNumber).toMatch(/^PV-/);
    expect(r.approvalStatus).toBe("PENDING_APPROVAL");
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
      id: 3, name: "تَسوية", direction: "BOTH", postingRole: "OWNER_CURRENT", isActive: true, sortOrder: 200,
    });
    const r1 = await createVoucher({
      voucherType: "PAYMENT", branchId: 1, amount: "10.00",
      paymentMethod: "CASH", partyType: "OTHER", description: "a",
      voucherCategoryId: 3,
    }, managerActor);
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
  it("مفتاح إنشاء واحد لا يعيد سنداً بمرجع/طريقة مختلفة ولا يولّد voucherNumber ثانياً", async () => {
    const first = await createVoucher({
      voucherType: "PAYMENT",
      branchId: 1,
      amount: "10.00",
      paymentMethod: "TRANSFER",
      partyType: "OTHER",
      description: "طلب حتمي",
      referenceNumber: "DET-REF-A",
      clientRequestId: "deterministic-voucher-key",
    }, managerActor);
    await expect(createVoucher({
      voucherType: "PAYMENT",
      branchId: 1,
      amount: "10.00",
      paymentMethod: "TRANSFER",
      partyType: "OTHER",
      description: "طلب حتمي",
      referenceNumber: "DET-REF-B",
      clientRequestId: "deterministic-voucher-key",
    }, managerActor)).rejects.toMatchObject({ code: "CONFLICT" });
    const rows = await db().select().from(s.receipts);
    expect(rows).toHaveLength(2); // تمويل الخزينة + طلب واحد فقط
    expect(rows.filter((row) => row.voucherNumber === first.voucherNumber)).toHaveLength(1);
  });

  it("مبلغ ≥ عَتبة الموافقة ⇒ PENDING_APPROVAL بلا قَيد ولا تَغيير رصيد", async () => {
    const r = await createVoucher({
      voucherType: "PAYMENT", branchId: 1, amount: "2000000.00", // > ١.٠٠٠.٠٠٠
      paymentMethod: "CASH", partyType: "SUPPLIER", partyId: 1,
      description: "دفعة كبيرة",
      attachmentUrl: "https://example.com/proof.pdf",
    }, managerActor);
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

  it("فشل الرصيد عند الاعتماد يُبقي السند PENDING بلا قيد أو ذمة أو دلو نقدي", async () => {
    await db().update(s.suppliers).set({ currentBalance: "3000000.00" }).where(eq(s.suppliers.id, 1));
    await db()
      .delete(s.receipts)
      .where(eq(s.receipts.referenceNumber, "TEST-TREASURY-FUND"));
    const r = await createVoucher({
      voucherType: "PAYMENT",
      branchId: 1,
      amount: "2000000.00",
      paymentMethod: "CASH",
      partyType: "SUPPLIER",
      partyId: 1,
      description: "دفعة كبيرة غير ممولة",
    }, managerActor);
    expect(r.approvalStatus).toBe("PENDING_APPROVAL");

    await expect(approveVoucher(r.receiptId, adminActor)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });

    const receipt = (
      await db().select().from(s.receipts).where(eq(s.receipts.id, r.receiptId))
    )[0];
    expect(receipt.approvalStatus).toBe("PENDING_APPROVAL");
    expect(receipt.cashBucket).toBeNull();
    expect(receipt.shiftId).toBeNull();
    expect(receipt.approvedBy).toBeNull();
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
    const supplier = (
      await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1))
    )[0];
    expect(supplier.currentBalance).toBe("3000000.00");
  });

  it("اعتماد سند مُعلَّق بواسطة مدير غير المُنشئ ⇒ قَيد + رَصيد + بَصمة", async () => {
    await db().update(s.suppliers).set({ currentBalance: "3000000.00" }).where(eq(s.suppliers.id, 1));
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
    expect(sup.currentBalance).toBe("1000000.00"); // AP يَنقص بلا السماح بدفعٍ يتجاوز المستحق

    const rc = (await db().select().from(s.receipts).where(eq(s.receipts.id, r.receiptId)))[0];
    expect(rc.approvalStatus).toBe("APPROVED");
    expect(rc.signatureHash).toBe(ap.signatureHash);
    expect(rc.approvedBy).toBe(1); // adminActor.userId
  });

  it("المالك ينشئ السند ⇒ يعتمد وينفذ في العملية نفسها بلا اعتماد ثان", async () => {
    const r = await createVoucher({
      voucherType: "PAYMENT", branchId: 1, amount: "2000000.00",
      paymentMethod: "TRANSFER", partyType: "OTHER",
      description: "عُمولة كَبيرة",
      referenceNumber: "TRF-X",
      attachmentUrl: "https://example.com/proof.pdf",
    }, ownerManagerActor);

    expect(r.approvalStatus).toBe("APPROVED");
    const rc = (await db().select().from(s.receipts).where(eq(s.receipts.id, r.receiptId)))[0];
    expect(rc).toMatchObject({ status: "COMPLETED", approvalStatus: "APPROVED" });
    expect(rc.createdBy).toBe(ownerManagerActor.userId);
    expect(rc.approvedBy).toBe(ownerManagerActor.userId);
    expect(rc.signatureHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await db().select().from(s.accountingEntries)).toHaveLength(1);
  });

  it("قبض OTHER الذي ينشئه المالك يعتمد تلقائيا في العملية نفسها", async () => {
    const r = await createVoucher({
      voucherType: "RECEIPT", branchId: 1, amount: "70000.00",
      paymentMethod: "CASH", partyType: "OTHER",
      description: "إيراد بيع مخلفات",
    }, adminActor);
    expect(r.approvalStatus).toBe("APPROVED");
    const [stored] = await db().select().from(s.receipts).where(eq(s.receipts.id, r.receiptId));
    expect(stored).toMatchObject({ status: "COMPLETED", approvedBy: adminActor.userId });
  });

  it("قبض OTHER — مالكٌ آخر غير المُنشئ يعتمده بنجاح", async () => {
    const r = await createVoucher({
      voucherType: "RECEIPT", branchId: 1, amount: "70000.00",
      paymentMethod: "CASH", partyType: "OTHER",
      description: "إيراد بيع مخلفات",
    }, managerActor);

    const ap = await approveVoucher(r.receiptId, adminActor);
    expect(ap.approvalStatus).toBe("APPROVED");
    const rc = (await db().select().from(s.receipts).where(eq(s.receipts.id, r.receiptId)))[0];
    expect(rc.approvedBy).toBe(adminActor.userId);
  });

  it("يعيد فحص رصيد المورد الحالي عند الاعتماد ويُبقي الطلب معلّقاً إن استُهلك المستحق بعد الإنشاء", async () => {
    await db().update(s.suppliers).set({ currentBalance: "3000000.00" }).where(eq(s.suppliers.id, 1));
    const request = await createVoucher({
      voucherType: "PAYMENT", branchId: 1, amount: "2000000.00",
      paymentMethod: "TRANSFER", partyType: "SUPPLIER", partyId: 1,
      description: "طلب قبل تغيّر كشف المورد", referenceNumber: "SUP-CURRENT-BALANCE",
    }, managerActor);
    await db().update(s.suppliers).set({ currentBalance: "500000.00" }).where(eq(s.suppliers.id, 1));

    await expect(approveVoucher(request.receiptId, adminActor)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const [pending] = await db().select().from(s.receipts).where(eq(s.receipts.id, request.receiptId));
    expect(pending).toMatchObject({ status: "PENDING", approvalStatus: "PENDING_APPROVAL", approvedBy: null });
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
    expect((await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0].currentBalance).toBe("500000.00");
  });

  it("الدور الإداري لا يكفي: غير المالك والمالك المعطّل لا يعتمدان أو يرفضان", async () => {
    await db().insert(s.users).values([
      { id: 4, openId: "not-owner", name: "إداري", role: "admin", branchId: 1, isOwner: false },
      { id: 5, openId: "inactive-owner", name: "مالك معطل", role: "admin", branchId: 1, isOwner: true, isActive: false },
    ]);
    const r = await createVoucher({
      voucherType: "PAYMENT", branchId: 1, amount: "10.00", paymentMethod: "TRANSFER",
      partyType: "OTHER", description: "اختبار صفة المالك", referenceNumber: "OWNER-AUTHZ",
    }, managerActor);
    await expect(approveVoucher(r.receiptId, { userId: 4, branchId: 1, role: "admin" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(rejectVoucher(r.receiptId, { userId: 5, branchId: 1, role: "admin" }, "رفض")).rejects.toMatchObject({ code: "FORBIDDEN" });
    const [stored] = await db().select().from(s.receipts).where(eq(s.receipts.id, r.receiptId));
    expect(stored.approvalStatus).toBe("PENDING_APPROVAL");
  });

  it("لا فرق بحسب الدور: مالكٌ role=admin يعتمد سندَه أيضاً بنفسه", async () => {
    const r = await createVoucher({
      voucherType: "PAYMENT", branchId: 1, amount: "2000000.00",
      paymentMethod: "TRANSFER", partyType: "OTHER",
      description: "تَسوية",
      referenceNumber: "TRF-Y",
      attachmentUrl: "https://example.com/proof.pdf",
    }, managerActor);
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

  it("إعادة اعتماد سند APPROVED idempotent بلا أثر ثانٍ", async () => {
    const r = await createVoucher({
      voucherType: "PAYMENT", branchId: 1, amount: "2000000.00",
      paymentMethod: "TRANSFER", partyType: "OTHER",
      description: "x", referenceNumber: "T",
      attachmentUrl: "https://example.com/proof.pdf",
    }, managerActor);
    const first = await approveVoucher(r.receiptId, adminActor);
    const replay = await approveVoucher(r.receiptId, adminActor);
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.signatureHash).toBe(first.signatureHash);
    expect(await db().select().from(s.accountingEntries)).toHaveLength(1);
  });

  it("فشلٌ بعد تحديث السند وإدراج القيد يرجع المعاملة كاملة ويبقي الطلب معلّقاً", async () => {
    await db().update(s.suppliers).set({ currentBalance: "-9999999999999.99" }).where(eq(s.suppliers.id, 1));
    const request = await createVoucher({
      voucherType: "PAYMENT",
      branchId: 1,
      amount: "1.00",
      paymentMethod: "CASH",
      partyType: "SUPPLIER",
      partyId: 1,
      description: "اختبار rollback بعد القيد",
    }, managerActor);

    await expect(approveVoucher(request.receiptId, adminActor)).rejects.toBeTruthy();
    const [stored] = await db().select().from(s.receipts).where(eq(s.receipts.id, request.receiptId));
    expect(stored).toMatchObject({ status: "PENDING", approvalStatus: "PENDING_APPROVAL", cashBucket: null, approvedBy: null });
    expect(stored.signatureHash).toBeNull();
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
    const [supplier] = await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1));
    expect(supplier.currentBalance).toBe("-9999999999999.99");
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
  it("سند الصرف الصغير لا يُبصم إلا بعد اعتماد مالك آخر", async () => {
    const r = await createVoucher({
      voucherType: "PAYMENT", branchId: 1, amount: "50.00",
      paymentMethod: "CASH", partyType: "OTHER",
      description: "إيراد",
    }, managerActor);
    let rc = (await db().select().from(s.receipts).where(eq(s.receipts.id, r.receiptId)))[0];
    expect(rc.signatureHash).toBeNull();
    await approveVoucher(r.receiptId, adminActor);
    rc = (await db().select().from(s.receipts).where(eq(s.receipts.id, r.receiptId)))[0];
    expect(rc.signatureHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("نَفس المُدخلات ⇒ بَصمات مُختلفة (لأنّ id مُختلف ⇒ canonical مُختلف)", async () => {
    const r1 = await createVoucher({
      voucherType: "PAYMENT", branchId: 1, amount: "50.00",
      paymentMethod: "CASH", partyType: "OTHER", description: "x",
    }, managerActor);
    const r2 = await createVoucher({
      voucherType: "PAYMENT", branchId: 1, amount: "50.00",
      paymentMethod: "CASH", partyType: "OTHER", description: "x",
    }, managerActor);
    await approveVoucher(r1.receiptId, adminActor);
    await approveVoucher(r2.receiptId, adminActor);
    const rc1 = (await db().select().from(s.receipts).where(eq(s.receipts.id, r1.receiptId)))[0];
    const rc2 = (await db().select().from(s.receipts).where(eq(s.receipts.id, r2.receiptId)))[0];
    expect(rc1.signatureHash).not.toBe(rc2.signatureHash);
  });
});
