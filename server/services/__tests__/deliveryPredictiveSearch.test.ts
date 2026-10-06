/**
 * اختبارات البحث التنبؤي الذكي للطرود والإرساليات (predictiveSearchConsignments)
 *
 * تغطية متطلبات المالك:
 * 1. البحث بجزء من رقم الهاتف (آخر 4 أرقام أو أي جزء) وتصنيف النتيجة PHONE
 * 2. البحث بجزء من اسم الزبون وتصنيف النتيجة CUSTOMER_NAME
 * 3. تطبيع الأحرف العربية (الهمزات والتاء المربوطة) في اسم الزبون
 * 4. البحث بجزء من رقم الفاتورة وتصنيف النتيجة INVOICE_NUMBER
 * 5. البحث بجزء من كود الإرسالية وتصنيف النتيجة CONSIGNMENT_NUMBER
 * 6. البحث بجزء من العنوان وتصنيف النتيجة ADDRESS
 * 7. التحقق من عزل الفروع (branchId) والجهات (partyId)
 * 8. حظر الاستعلامات الأقل من حرفين أو رقمين
 */
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { predictiveSearchConsignments } from "../delivery/queries";

const TABLES = [
  "deliveryEvents",
  "deliveryLedgerEntries",
  "deliveryRemittanceLines",
  "deliveryRemittances",
  "deliveryConsignments",
  "deliveryPartyMembers",
  "deliveryParties",
  "onlineOrders",
  "workOrders",
  "invoices",
  "customers",
  "branches",
  "users",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
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

  // 1. فرع ومستخدم
  await d.insert(s.branches).values([
    { id: 1, name: "فرع بغداد الرئيسي", code: "BGW", type: "MAIN" },
    { id: 2, name: "فرع البصرة", code: "BSR", type: "SALES" },
  ]);

  await d.insert(s.users).values([
    { id: 1, openId: "u-admin", name: "مدير التوصيل", role: "admin", loginMethod: "local", branchId: 1 },
  ]);

  // 2. جهات توصيل
  await d.insert(s.deliveryParties).values([
    { id: 1, name: "شركة النسر الذهبي", partyType: "COMPANY", branchId: 1 },
    { id: 2, name: "المندوب علي الكرخي", partyType: "INDIVIDUAL", branchId: 1 },
    { id: 3, name: "شركة الجنوب السريع", partyType: "COMPANY", branchId: 2 },
  ]);

  // 3. عملاء
  await d.insert(s.customers).values([
    {
      id: 1,
      name: "عمار الحكيم",
      phone: "07809123456",
      whatsapp: "07809123456",
      address: "بغداد - الكرادة خارج",
    },
    {
      id: 2,
      name: "أحمد مهدي البصري",
      phone: "07705554433",
      whatsapp: "07705554433",
      address: "البصرة - حي الجزائر قرب جامع الرسول",
    },
  ]);

  // 4. فواتير
  await d.insert(s.invoices).values([
    {
      id: 104,
      invoiceNumber: "INV-2026-0104",
      branchId: 1,
      customerId: 1,
      subtotal: "15000.00",
      total: "15000.00",
      paidAmount: "0.00",
      returnedTotal: "0.00",
      createdBy: 1,
    },
    {
      id: 105,
      invoiceNumber: "INV-2026-0105",
      branchId: 1,
      customerId: 1,
      subtotal: "8000.00",
      total: "8000.00",
      paidAmount: "0.00",
      returnedTotal: "0.00",
      createdBy: 1,
    },
    {
      id: 205,
      invoiceNumber: "INV-2026-0205",
      branchId: 1,
      customerId: 2,
      subtotal: "25000.00",
      total: "25000.00",
      paidAmount: "0.00",
      returnedTotal: "0.00",
      createdBy: 1,
    },
    {
      id: 301,
      invoiceNumber: "INV-2026-0301",
      branchId: 2,
      subtotal: "10000.00",
      total: "10000.00",
      paidAmount: "0.00",
      returnedTotal: "0.00",
      createdBy: 1,
    },
    {
      id: 106,
      invoiceNumber: "INV-2026-0106",
      sourceType: "ONLINE",
      branchId: 1,
      customerId: 1,
      subtotal: "15000.00",
      total: "15000.00",
      paidAmount: "0.00",
      returnedTotal: "0.00",
      createdBy: 1,
    },
    {
      id: 107,
      invoiceNumber: "INV-2026-0107",
      sourceType: "ONLINE",
      branchId: 1,
      customerId: 1,
      subtotal: "20000.00",
      total: "20000.00",
      paidAmount: "0.00",
      returnedTotal: "0.00",
      createdBy: 1,
    },
  ]);

  // 5. أوامر شغل
  await d.insert(s.workOrders).values([
    {
      id: 501,
      orderNumber: "WO-2026-0501",
      branchId: 1,
      customerId: 1,
      title: "طباعة كروت شخصية",
      status: "READY",
      contactName: "عمار الحكيم",
      contactPhone: "07809123456",
      deliveryPhone: "07809123456",
      deliveryAddress: "بغداد - الكرادة خارج",
      salePrice: "15000.00",
      paidAmount: "0.00",
      createdBy: 1,
    },
    {
      id: 502,
      orderNumber: "WO-2026-0502",
      branchId: 1,
      customerId: 2,
      title: "لوحة كانفاس جدارية",
      status: "READY",
      contactName: "أحمد مهدي البصري",
      contactPhone: "07705554433",
      deliveryPhone: "07705554433",
      deliveryAddress: "البصرة - حي الجزائر قرب جامع الرسول",
      salePrice: "25000.00",
      paidAmount: "0.00",
      createdBy: 1,
    },
  ]);

  // 5.5 طلبات متجر إلكتروني
  await d.insert(s.onlineOrders).values([
    {
      id: 701,
      orderNumber: "ORD-2026-9999",
      customerId: 1,
      branchId: 1,
      invoiceId: 106,
      subtotal: "15000.00",
      total: "15000.00",
      status: "SHIPPED",
    },
    {
      id: 702,
      orderNumber: "ORD-2026-7777",
      customerId: 1,
      branchId: 1,
      invoiceId: 107,
      subtotal: "20000.00",
      total: "20000.00",
      status: "SHIPPED",
    },
  ]);

  // 6. إرساليات التوصيل
  await d.insert(s.deliveryConsignments).values([
    {
      id: 55,
      consignmentNumber: "CNS-2026-0055",
      partyId: 1,
      branchId: 1,
      invoiceId: 106,
      sourceType: "ONLINE_ORDER",
      sourceId: 701,
      endCustomerId: 1,
      recipientName: "زبون متجر الكتروني",
      recipientPhone: "07801239999",
      deliveryAddress: "بغداد - المنصور",
      parcelStatus: "OUT_FOR_DELIVERY",
      moneyStatus: "UNSETTLED",
      status: "DISPATCHED",
      codAmount: "15000.00",
      collectedAmount: "0.00",
      counterSettledAmount: "0.00",
      deliveryFee: "5000.00",
      dispatchedBy: 1,
    },
    {
      id: 56,
      consignmentNumber: "CNS-2026-0056",
      partyId: 1,
      branchId: 1,
      invoiceId: 107,
      sourceType: "INVOICE",
      sourceId: 107,
      endCustomerId: 1,
      recipientName: "زبون إرسالية فاتورة متجر",
      recipientPhone: "07801237777",
      deliveryAddress: "بغداد - الكرادة",
      parcelStatus: "OUT_FOR_DELIVERY",
      moneyStatus: "UNSETTLED",
      status: "DISPATCHED",
      codAmount: "20000.00",
      collectedAmount: "0.00",
      counterSettledAmount: "0.00",
      deliveryFee: "5000.00",
      dispatchedBy: 1,
    },
    {
      id: 88,
      consignmentNumber: "CNS-2026-0088",
      externalTrackingRef: "DHL-998811",
      partyId: 1,
      branchId: 1,
      invoiceId: 104,
      workOrderId: 501,
      sourceType: "INVOICE",
      sourceId: 104,
      endCustomerId: 1,
      recipientName: "عمار الحكيم",
      recipientPhone: "07809123456",
      deliveryAddress: "بغداد - الكرادة خارج",
      parcelStatus: "OUT_FOR_DELIVERY",
      moneyStatus: "UNSETTLED",
      status: "DISPATCHED",
      codAmount: "15000.00",
      collectedAmount: "0.00",
      counterSettledAmount: "0.00",
      deliveryFee: "5000.00",
      dispatchedBy: 1,
    },
    {
      id: 99,
      consignmentNumber: "CNS-2026-0099",
      externalTrackingRef: "FEDEX-443322",
      partyId: 2,
      branchId: 1,
      invoiceId: 205,
      workOrderId: 502,
      sourceType: "INVOICE",
      sourceId: 205,
      endCustomerId: 2,
      recipientName: "أحمد مهدي البصري",
      recipientPhone: "07705554433",
      deliveryAddress: "البصرة - حي الجزائر قرب جامع الرسول",
      parcelStatus: "DELIVERED",
      moneyStatus: "UNSETTLED",
      status: "DISPATCHED",
      codAmount: "25000.00",
      collectedAmount: "0.00",
      counterSettledAmount: "0.00",
      deliveryFee: "6000.00",
      dispatchedBy: 1,
    },
    {
      id: 77,
      consignmentNumber: "CNS-2026-0077",
      partyId: 3,
      branchId: 2,
      invoiceId: 301,
      sourceType: "INVOICE",
      sourceId: 301,
      recipientName: "زبون الفرع الثاني",
      recipientPhone: "07501112233",
      parcelStatus: "ASSIGNED",
      moneyStatus: "UNSETTLED",
      status: "DISPATCHED",
      codAmount: "10000.00",
      collectedAmount: "0.00",
      counterSettledAmount: "0.00",
      deliveryFee: "3000.00",
      dispatchedBy: 1,
    },
    {
      id: 66,
      consignmentNumber: "CNS-2026-0066",
      partyId: 1,
      branchId: 1,
      invoiceId: 105,
      sourceType: "INVOICE",
      sourceId: 105,
      recipientName: "زبون مرتجع",
      recipientPhone: "07809998877",
      parcelStatus: "RETURNED",
      moneyStatus: "UNSETTLED",
      status: "DISPATCHED",
      codAmount: "8000.00",
      collectedAmount: "0.00",
      counterSettledAmount: "0.00",
      deliveryFee: "3000.00",
      dispatchedBy: 1,
    },
  ]);
}

describe("predictiveSearchConsignments — محرك البحث التنبؤي الذكي للطرود", () => {
  beforeEach(async () => {
    await reset();
    await seed();
  });

  it("يطابق جزئياً برقم الهاتف من آخر 4 أرقام ويصنف النتيجة PHONE", async () => {
    const results = await predictiveSearchConsignments("3456", { branchId: 1 });
    expect(results.length).toBeGreaterThan(0);
    const found = results.find((r) => r.id === 88);
    expect(found).toBeDefined();
    expect(found?.customerPhone).toContain("07809123456");
    expect(found?.matchedOn).toContain("PHONE");
  });

  it("يطابق جزئياً برقم الهاتف من منتصف الرقم أو بدايته", async () => {
    const results = await predictiveSearchConsignments("7809", { branchId: 1 });
    expect(results.length).toBeGreaterThan(0);
    const found = results.find((r) => r.id === 88);
    expect(found).toBeDefined();
    expect(found?.matchedOn).toContain("PHONE");
  });

  it("يطابق جزئياً باسم الزبون من حرفين أو ثلاثة ويصنف CUSTOMER_NAME", async () => {
    const results = await predictiveSearchConsignments("عما", { branchId: 1 });
    expect(results.length).toBeGreaterThan(0);
    const found = results.find((r) => r.id === 88);
    expect(found).toBeDefined();
    expect(found?.customerName).toBe("عمار الحكيم");
    expect(found?.matchedOn).toContain("CUSTOMER_NAME");
  });

  it("يطابق اسم الزبون بتطبيع الأحرف العربية (همزة أحمد -> احمد)", async () => {
    const results = await predictiveSearchConsignments("احمد", { branchId: 1 });
    expect(results.length).toBeGreaterThan(0);
    const found = results.find((r) => r.id === 99);
    expect(found).toBeDefined();
    expect(found?.customerName).toBe("أحمد مهدي البصري");
    expect(found?.matchedOn).toContain("CUSTOMER_NAME");
  });

  it("يطابق جزئياً برقم الفاتورة ويصنف INVOICE_NUMBER", async () => {
    const results = await predictiveSearchConsignments("104", { branchId: 1 });
    expect(results.length).toBeGreaterThan(0);
    const found = results.find((r) => r.id === 88);
    expect(found).toBeDefined();
    expect(found?.invoiceNumber).toBe("INV-2026-0104");
    expect(found?.matchedOn).toContain("INVOICE_NUMBER");
  });

  it("يطابق جزئياً برقم الإرسالية ويصنف CONSIGNMENT_NUMBER", async () => {
    const results = await predictiveSearchConsignments("88", { branchId: 1 });
    expect(results.length).toBeGreaterThan(0);
    const found = results.find((r) => r.id === 88);
    expect(found).toBeDefined();
    expect(found?.consignmentNumber).toBe("CNS-2026-0088");
    expect(found?.matchedOn).toContain("CONSIGNMENT_NUMBER");
  });

  it("يطابق جزئياً برقم البوليصة الخارجي externalTrackingRef", async () => {
    const results = await predictiveSearchConsignments("998811", { branchId: 1 });
    expect(results.length).toBeGreaterThan(0);
    const found = results.find((r) => r.id === 88);
    expect(found).toBeDefined();
    expect(found?.externalTrackingRef).toBe("DHL-998811");
    expect(found?.matchedOn).toContain("CONSIGNMENT_NUMBER");
  });

  it("يطابق جزئياً برقم أمر الشغل ويصنف ORDER_NUMBER", async () => {
    const results = await predictiveSearchConsignments("502", { branchId: 1 });
    expect(results.length).toBeGreaterThan(0);
    const found = results.find((r) => r.id === 99);
    expect(found).toBeDefined();
    expect(found?.orderNumber).toBe("WO-2026-0502");
    expect(found?.matchedOn).toContain("ORDER_NUMBER");
  });

  it("يطابق جزئياً بجزء من العنوان ويصنف ADDRESS", async () => {
    const results = await predictiveSearchConsignments("الجزائر", { branchId: 1 });
    expect(results.length).toBeGreaterThan(0);
    const found = results.find((r) => r.id === 99);
    expect(found).toBeDefined();
    expect(found?.deliveryAddress).toContain("الجزائر");
    expect(found?.matchedOn).toContain("ADDRESS");
  });

  it("يحترم عزل الفروع ولا يُظهر طرود الفروع الأخرى", async () => {
    // الطرد 77 يتبع الفرع 2
    const resultsBranch1 = await predictiveSearchConsignments("0750111", { branchId: 1 });
    expect(resultsBranch1.find((r) => r.id === 77)).toBeUndefined();

    const resultsBranch2 = await predictiveSearchConsignments("0750111", { branchId: 2 });
    expect(resultsBranch2.find((r) => r.id === 77)).toBeDefined();
  });

  it("يحترم فلترة الجهة المحددة partyId", async () => {
    // الطرد 88 يتبع الجهة 1، نبحث عنه مع تقييد partyId=2
    const results = await predictiveSearchConsignments("3456", { branchId: 1, partyId: 2 });
    expect(results.find((r) => r.id === 88)).toBeUndefined();

    // مع partyId=1 يجب أن يظهر
    const resultsForParty1 = await predictiveSearchConsignments("3456", { branchId: 1, partyId: 1 });
    expect(resultsForParty1.find((r) => r.id === 88)).toBeDefined();
  });

  it("يطابق أرقام الهاتف المكتوبة بالأرقام المشرقية (الهندية ٠١٢٣٤٥٦٧٨٩)", async () => {
    const results = await predictiveSearchConsignments("٣٤٥٦", { branchId: 1 });
    expect(results.length).toBeGreaterThan(0);
    const found = results.find((r) => r.id === 88);
    expect(found).toBeDefined();
    expect(found?.customerPhone).toContain("07809123456");
    expect(found?.matchedOn).toContain("PHONE");
  });

  it("يطابق أرقام الهاتف بالصيغة الدولية (+964)", async () => {
    const results = await predictiveSearchConsignments("+9647809123456", { branchId: 1 });
    expect(results.length).toBeGreaterThan(0);
    const found = results.find((r) => r.id === 88);
    expect(found).toBeDefined();
    expect(found?.customerPhone).toContain("07809123456");
    expect(found?.matchedOn).toContain("PHONE");
  });

  it("يستبعد الطرود المرتجعة (RETURNED) من نتائج البحث", async () => {
    const results = await predictiveSearchConsignments("0066", { branchId: 1 });
    expect(results.find((r) => r.id === 66)).toBeUndefined();
  });

  it("يرفض البحث إذا كان الاستعلام أقل من حرفين أو فارغاً", async () => {
    const emptyRes = await predictiveSearchConsignments("", { branchId: 1 });
    expect(emptyRes).toEqual([]);

    const shortRes = await predictiveSearchConsignments("ع", { branchId: 1 });
    expect(shortRes).toEqual([]);

    const singleDigit = await predictiveSearchConsignments("8", { branchId: 1 });
    expect(singleDigit).toEqual([]);
  });

  it("يطابق جزئياً برقم طلب المتجر ORD-... ويصنف ORDER_NUMBER", async () => {
    const results = await predictiveSearchConsignments("ORD-2026-9999", { branchId: 1 });
    expect(results.length).toBeGreaterThan(0);
    const found = results.find((r) => r.id === 55);
    expect(found).toBeDefined();
    expect(found?.matchedOn).toContain("ORDER_NUMBER");
    expect(found?.orderNumber).toBe("ORD-2026-9999");
  });

  it("يطابق جزئياً بأرقام طلب المتجر 9999", async () => {
    const results = await predictiveSearchConsignments("9999", { branchId: 1 });
    expect(results.length).toBeGreaterThan(0);
    const found = results.find((r) => r.id === 55);
    expect(found).toBeDefined();
    expect(found?.matchedOn).toContain("ORDER_NUMBER");
    expect(found?.orderNumber).toBe("ORD-2026-9999");
  });

  it("يطابق بمعرف الطلب الرقمي 701 ويصنف ORDER_NUMBER مع أعلى أولوية", async () => {
    const results = await predictiveSearchConsignments("701", { branchId: 1 });
    expect(results.length).toBeGreaterThan(0);
    const found = results.find((r) => r.id === 55);
    expect(found).toBeDefined();
    expect(found?.matchedOn).toContain("ORDER_NUMBER");
    expect(found?.score).toBe(0);
    expect(found?.onlineOrderId).toBe(701);
  });

  it("يطابق إرسالية منشأة بنوع INVOICE مرتبطة بطلب متجر عبر invoiceId برقم الطلب ORD-...", async () => {
    const results = await predictiveSearchConsignments("ORD-2026-7777", { branchId: 1 });
    expect(results.length).toBeGreaterThan(0);
    const found = results.find((r) => r.id === 56);
    expect(found).toBeDefined();
    expect(found?.matchedOn).toContain("ORDER_NUMBER");
    expect(found?.orderNumber).toBe("ORD-2026-7777");
  });

  it("يطابق إرسالية منشأة بنوع INVOICE بأرقام طلب المتجر 7777", async () => {
    const results = await predictiveSearchConsignments("7777", { branchId: 1 });
    expect(results.length).toBeGreaterThan(0);
    const found = results.find((r) => r.id === 56);
    expect(found).toBeDefined();
    expect(found?.matchedOn).toContain("ORDER_NUMBER");
    expect(found?.orderNumber).toBe("ORD-2026-7777");
  });

  it("يطابق عنوان الشحن الخاص بطلب المتجر ويصنف ADDRESS", async () => {
    const results = await predictiveSearchConsignments("المنصور", { branchId: 1 });
    expect(results.length).toBeGreaterThan(0);
    const found = results.find((r) => r.id === 55);
    expect(found).toBeDefined();
    expect(found?.matchedOn).toContain("ADDRESS");
  });
});

