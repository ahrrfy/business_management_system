import { beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  autoSettleAllAccountsTx,
  autoSettleCustomerAccountTx,
  autoSettleSupplierAccountTx,
} from "../reconciliation/autoSettlementService";
import { getARAging } from "../reports/arAging";
import { createVoucher } from "../voucher/create";
import { withTx } from "../tx";

const actor = { userId: 1, branchId: 1, role: "admin" as const };

const TABLES = [
  "accountingEntries",
  "receipts",
  "invoices",
  "invoiceItems",
  "purchaseOrders",
  "purchaseOrderItems",
  "shifts",
  "customers",
  "suppliers",
  "branches",
  "users",
  "auditLogs",
  "deliveryConsignments",
  "deliveryParties",
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

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "local_test", name: "admin", role: "admin", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.shifts).values({
    userId: 1,
    branchId: 1,
    status: "OPEN",
    shiftType: "RECEPTION",
    openedAt: new Date(),
    openGuard: "1:1",
    openingBalance: "0",
  });
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("تسوية ومطابقة ذمم العملاء التلقائية (FIFO Auto-Settlement & AR Aging)", () => {
  it("يسوي فواتير العميل ذي الرصيد الصفري بالكامل إلى PAID", async () => {
    const d = db();
    // عميل دفع عبر التوصيل أو سند قبض عام فرصيده الجاري 0 ولكن فواتيره بقيت معلقة
    await d.insert(s.customers).values({
      id: 10,
      name: "عميل رصيده صفر",
      currentBalance: "0.00",
      defaultPriceTier: "RETAIL",
    });

    await d.insert(s.invoices).values([
      {
        id: 101,
        invoiceNumber: "INV-101",
        customerId: 10,
        branchId: 1,
        invoiceDate: new Date("2026-09-01"),
        subtotal: "100000.00",
        total: "100000.00",
        paidAmount: "0.00",
        status: "PENDING",
      },
      {
        id: 102,
        invoiceNumber: "INV-102",
        customerId: 10,
        branchId: 1,
        invoiceDate: new Date("2026-09-05"),
        subtotal: "150000.00",
        total: "150000.00",
        paidAmount: "0.00",
        status: "PENDING",
      },
    ]);

    const res = await withTx((tx) => autoSettleCustomerAccountTx(tx, 10, actor));
    expect(res.settledInvoicesCount).toBe(2);
    expect(res.partiallySettledInvoicesCount).toBe(0);
    expect(res.totalSettledAmount).toBe("250000.00");
    expect(res.remainingOpenDebt).toBe("0.00");

    // التحقق من حالة الفواتير في قاعدة البيانات
    const invs = await d.select().from(s.invoices).where(sql`customerId = 10`);
    for (const inv of invs) {
      expect(inv.status).toBe("PAID");
      expect(inv.paidAmount).toBe(inv.total);
    }

    // التحقق من أن تقرير أعمار الذمم لا يُظهر هذا العميل كمدين
    const aging = await getARAging({ branchId: 1 });
    expect(aging.find((r) => r.customerId === 10)).toBeUndefined();
  });

  it("يطبق قاعدة FIFO في التسوية الجزئية ويطابق الرصيد المتبقي تماماً مع رصيد بطاقة العميل", async () => {
    const d = db();
    // عميل عليه فاتورتان: 100 ألف قديمة، و100 ألف جديدة (الإجمالي 200 ألف)
    // العميل سدد 120 ألف، فرصيده الجاري 80 ألف
    await d.insert(s.customers).values({
      id: 20,
      name: "عميل تسديد جزئي",
      currentBalance: "80000.00",
      defaultPriceTier: "RETAIL",
    });

    await d.insert(s.invoices).values([
      {
        id: 201,
        invoiceNumber: "INV-201",
        customerId: 20,
        branchId: 1,
        invoiceDate: new Date("2026-08-01"), // الأقدم
        subtotal: "100000.00",
        total: "100000.00",
        paidAmount: "0.00",
        status: "PENDING",
      },
      {
        id: 202,
        invoiceNumber: "INV-202",
        customerId: 20,
        branchId: 1,
        invoiceDate: new Date("2026-09-01"), // الأحدث
        subtotal: "100000.00",
        total: "100000.00",
        paidAmount: "0.00",
        status: "PENDING",
      },
    ]);

    const res = await withTx((tx) => autoSettleCustomerAccountTx(tx, 20, actor));
    expect(res.settledInvoicesCount).toBe(1); // الفاتورة الأولى أقفلت تماماً
    expect(res.partiallySettledInvoicesCount).toBe(1); // الفاتورة الثانية سدد منها 20 ألف
    expect(res.totalSettledAmount).toBe("120000.00");
    expect(res.remainingOpenDebt).toBe("80000.00"); // المطابقة 100% مع الرصيد الجاري

    const [inv1] = await d.select().from(s.invoices).where(sql`id = 201`);
    expect(inv1.status).toBe("PAID");
    expect(inv1.paidAmount).toBe("100000.00");

    const [inv2] = await d.select().from(s.invoices).where(sql`id = 202`);
    expect(inv2.status).toBe("PARTIALLY_PAID");
    expect(inv2.paidAmount).toBe("20000.00");

    // التحقق من تقرير أعمار الذمم
    const aging = await getARAging({ branchId: 1 });
    const row = aging.find((r) => r.customerId === 20);
    expect(row).toBeDefined();
    expect(row!.currentBalance).toBe("80000.00");
    expect(row!.unpaidTotal).toBe("80000.00");
  });

  it("إنشاء سند قبض عام غير مربوط بفاتورة يطلق التسوية التلقائية فوراً ويقفل الفاتورة", async () => {
    const d = db();
    await d.insert(s.customers).values({
      id: 30,
      name: "عميل سند قبض",
      currentBalance: "50000.00",
      defaultPriceTier: "RETAIL",
    });

    await d.insert(s.invoices).values({
      id: 301,
      invoiceNumber: "INV-301",
      customerId: 30,
      branchId: 1,
      invoiceDate: new Date("2026-09-10"),
      subtotal: "50000.00",
      total: "50000.00",
      paidAmount: "0.00",
      status: "PENDING",
    });

    // إنشاء سند قبض تشغيلي عام على حساب العميل بمبلغ 50000 (IN)
    await createVoucher(
      {
        clientRequestId: "req-voucher-30",
        branchId: 1,
        voucherType: "RECEIPT",
        partyType: "CUSTOMER",
        partyId: 30,
        amount: "50000.00",
        paymentMethod: "CASH",
        description: "سداد ذمة العميل بالكامل",
      },
      actor,
    );

    // التحقق من أن رصيد العميل صار 0
    const [cust] = await d.select().from(s.customers).where(sql`id = 30`);
    expect(cust.currentBalance).toBe("0.00");

    // التحقق من أن الفاتورة أقفلت تلقائياً كـ PAID بواسطة الحدث المالي
    const [inv] = await d.select().from(s.invoices).where(sql`id = 301`);
    expect(inv.status).toBe("PAID");
    expect(inv.paidAmount).toBe("50000.00");
  });

  it("حارس تقرير أعمار الذمم يمنع الذمم الوهمية حتى قبل التسوية اليدوية", async () => {
    const d = db();
    // عميل رصيده 0 في بطاقته، لكن توجد فاتورة قديمة لم تسوّ بعد
    await d.insert(s.customers).values({
      id: 40,
      name: "عميل رصيد دفتري صفر مع فاتورة قديمة",
      currentBalance: "0.00",
      defaultPriceTier: "RETAIL",
    });

    await d.insert(s.invoices).values({
      id: 401,
      invoiceNumber: "INV-401",
      customerId: 40,
      branchId: 1,
      invoiceDate: new Date("2026-09-01"),
      subtotal: "75000.00",
      total: "75000.00",
      paidAmount: "0.00",
      status: "PENDING",
    });

    // تقرير أعمار الذمم يجب أن يستبعد هذا العميل تماماً ولا يظهر عليه 75 ألف ذمة وهمية
    const aging = await getARAging({ branchId: 1 });
    const row = aging.find((r) => r.customerId === 40);
    expect(row).toBeUndefined();
  });

  it("المطابقة الشاملة لكافة الحسابات (autoSettleAllAccountsTx) تعالج عدة عملاء في معاملة واحدة", async () => {
    const d = db();
    await d.insert(s.customers).values([
      { id: 51, name: "عميل أ", currentBalance: "0.00", defaultPriceTier: "RETAIL" },
      { id: 52, name: "عميل ب", currentBalance: "0.00", defaultPriceTier: "RETAIL" },
    ]);

    await d.insert(s.invoices).values([
      { id: 501, invoiceNumber: "INV-501", customerId: 51, branchId: 1, invoiceDate: new Date(), subtotal: "30000.00", total: "30000.00", paidAmount: "0.00", status: "PENDING" },
      { id: 502, invoiceNumber: "INV-502", customerId: 52, branchId: 1, invoiceDate: new Date(), subtotal: "40000.00", total: "40000.00", paidAmount: "0.00", status: "PENDING" },
    ]);

    const res = await withTx((tx) => autoSettleAllAccountsTx(tx, actor, 100));
    expect(res.settledAccountsCount).toBe(2);
    expect(res.totalSettledInvoices).toBe(2);
    expect(res.totalSettledAmount).toBe("70000.00");

    const invs = await d.select().from(s.invoices).where(sql`customerId IN (51, 52)`);
    for (const inv of invs) {
      expect(inv.status).toBe("PAID");
    }
  });

  it("تسوية أوامر شراء المورد تلقائياً بنظام FIFO مع سداد غير مخصص", async () => {
    const d = db();
    // مورد سددنا له بسند صرف ولم يخصص لأمر شراء محدد
    // رصيد المورد الحالي 0 (أي لا نطلب منه ولا يطلب منا)، لكن أمر الشراء معلق
    await d.insert(s.suppliers).values({
      id: 60,
      name: "مورد مواد خام",
      currentBalance: "0.00",
    });

    await d.insert(s.purchaseOrders).values({
      id: 601,
      poNumber: "PO-601",
      supplierId: 60,
      branchId: 1,
      orderDate: new Date("2026-09-01"),
      subtotal: "200000.00",
      total: "200000.00",
      paidAmount: "0.00",
      status: "CONFIRMED",
    });

    const res = await withTx((tx) => autoSettleSupplierAccountTx(tx, 60, actor));
    expect(res.settledOrdersCount).toBe(1);
    expect(res.totalSettledAmount).toBe("200000.00");
    expect(res.remainingOpenDebt).toBe("0.00");

    const [po] = await d.select().from(s.purchaseOrders).where(sql`id = 601`);
    expect(po.paidAmount).toBe("200000.00");
  });

  it("يسوي فواتير العميل المرتبطة بإرساليات توصيل محصلة ومسواة غير مقيدة دفترياً ويخفض رصيد العميل بالدفتر ويقفل الفاتورة PAID", async () => {
    const d = db();
    // عميل تم إنشاء فاتورة له من الاستقبال بمبلغ 150 ألف، وخرجت توصيل وسددها الزبون لشركة التوصيل وسوّت الشركة
    // لكن لم تُقيّد دفترياً على حساب العميل فظل رصيد العميل 150 ألف والفاتورة معلقة
    await d.insert(s.customers).values({
      id: 70,
      name: "عميل توصيل غير مقيد",
      currentBalance: "150000.00",
      defaultPriceTier: "RETAIL",
    });

    await d.insert(s.invoices).values({
      id: 701,
      invoiceNumber: "INV-701",
      customerId: 70,
      branchId: 1,
      invoiceDate: new Date("2026-09-01"),
      subtotal: "150000.00",
      total: "150000.00",
      paidAmount: "0.00",
      status: "PENDING",
    });

    await d.insert(s.deliveryParties).values({
      id: 7,
      name: "شركة توصيل الرشيد",
      branchId: 1,
      partyType: "COMPANY",
    });

    await d.insert(s.deliveryConsignments).values({
      id: 7001,
      consignmentNumber: "CN-1-20260901-0070",
      branchId: 1,
      partyId: 7,
      invoiceId: 701,
      sourceType: "INVOICE",
      sourceId: 701,
      codAmount: "150000.00",
      collectedAmount: "150000.00",
      moneyStatus: "SETTLED",
      status: "DELIVERED",
    });

    const res = await withTx((tx) => autoSettleCustomerAccountTx(tx, 70, actor));
    expect(res.settledInvoicesCount).toBe(1);
    expect(res.totalSettledAmount).toBe("150000.00");
    expect(res.remainingOpenDebt).toBe("0.00");

    // التحقق من أن رصيد العميل انخفض إلى 0.00 في قاعدة البيانات
    const [cust] = await d.select().from(s.customers).where(sql`id = 70`);
    expect(cust.currentBalance).toBe("0.00");

    // التحقق من أن الفاتورة أقفلت تماماً كـ PAID
    const [inv] = await d.select().from(s.invoices).where(sql`id = 701`);
    expect(inv.status).toBe("PAID");
    expect(inv.paidAmount).toBe("150000.00");

    // التحقق من تسجيل قيد PAYMENT_IN ذري في دفتر الأستاذ بمفتاح التوصيل
    const entries = await d
      .select()
      .from(s.accountingEntries)
      .where(sql`dedupeKey = 'PAYMENT_IN:DELIVERY_RECONCILE:7001'`);
    expect(entries.length).toBe(1);
    expect(entries[0].entryType).toBe("PAYMENT_IN");
    expect(entries[0].amount).toBe("150000.00");
    expect(entries[0].customerId).toBe(70);

    // التحقق من زوال الذمة الوهمية تماماً من تقرير أعمار الذمم
    const aging = await getARAging({ branchId: 1 });
    expect(aging.find((r) => r.customerId === 70)).toBeUndefined();
  });

  it("يمنع ازدواج الخصم من رصيد العميل إذا كانت إرسالية التوصيل قد قُيدت بالدفتر مسبقاً ويقفل الفاتورة المعلقة", async () => {
    const d = db();
    // عميل تم قيد تحصيل التوصيل له مسبقاً (فرصيده الجاري 0.00) ولكن الفاتورة بقيت PENDING
    await d.insert(s.customers).values({
      id: 80,
      name: "عميل توصيل مقيد مسبقاً",
      currentBalance: "0.00",
      defaultPriceTier: "RETAIL",
    });

    await d.insert(s.invoices).values({
      id: 801,
      invoiceNumber: "INV-801",
      customerId: 80,
      branchId: 1,
      invoiceDate: new Date("2026-09-02"),
      subtotal: "75000.00",
      total: "75000.00",
      paidAmount: "0.00",
      status: "PENDING",
    });

    await d.insert(s.deliveryParties).values({
      id: 8,
      name: "شركة توصيل بغداد",
      branchId: 1,
      partyType: "COMPANY",
    });

    await d.insert(s.deliveryConsignments).values({
      id: 8001,
      consignmentNumber: "CN-1-20260902-0080",
      branchId: 1,
      partyId: 8,
      invoiceId: 801,
      sourceType: "INVOICE",
      sourceId: 801,
      codAmount: "75000.00",
      collectedAmount: "75000.00",
      moneyStatus: "SETTLED",
      status: "DELIVERED",
    });

    // تسجيل القيد السابق الذي خفض رصيد العميل بالفعل
    await d.insert(s.accountingEntries).values({
      entryType: "PAYMENT_IN",
      dedupeKey: "PAYMENT_IN:COURIER_DELIVERY:8001",
      branchId: 1,
      invoiceId: 801,
      customerId: 80,
      amount: "75000.00",
      entryDate: new Date(),
    });

    const res = await withTx((tx) => autoSettleCustomerAccountTx(tx, 80, actor));
    expect(res.settledInvoicesCount).toBe(1);
    expect(res.totalSettledAmount).toBe("75000.00");
    expect(res.remainingOpenDebt).toBe("0.00");

    // التأكد من عدم خصم رصيد العميل مرتين (يبقى 0.00 ولا يصبح سالباً)
    const [cust] = await d.select().from(s.customers).where(sql`id = 80`);
    expect(cust.currentBalance).toBe("0.00");

    // التأكد من تحديث الفاتورة إلى PAID
    const [inv] = await d.select().from(s.invoices).where(sql`id = 801`);
    expect(inv.status).toBe("PAID");
    expect(inv.paidAmount).toBe("75000.00");
  });

  it("المطابقة الشاملة لكافة الحسابات (autoSettleAllAccountsTx) تشمل عملاء التوصيل المحصل مع عملاء السدادات غير المخصصة", async () => {
    const d = db();
    await d.insert(s.customers).values([
      { id: 91, name: "عميل سداد عام", currentBalance: "0.00", defaultPriceTier: "RETAIL" },
      { id: 92, name: "عميل توصيل محصل", currentBalance: "80000.00", defaultPriceTier: "RETAIL" },
    ]);

    await d.insert(s.invoices).values([
      { id: 901, invoiceNumber: "INV-901", customerId: 91, branchId: 1, invoiceDate: new Date(), subtotal: "50000.00", total: "50000.00", paidAmount: "0.00", status: "PENDING" },
      { id: 902, invoiceNumber: "INV-902", customerId: 92, branchId: 1, invoiceDate: new Date(), subtotal: "80000.00", total: "80000.00", paidAmount: "0.00", status: "PENDING" },
    ]);

    await d.insert(s.deliveryParties).values({
      id: 9,
      name: "شركة النور",
      branchId: 1,
      partyType: "COMPANY",
    });

    await d.insert(s.deliveryConsignments).values({
      id: 9002,
      consignmentNumber: "CN-1-20260903-0092",
      branchId: 1,
      partyId: 9,
      invoiceId: 902,
      sourceType: "INVOICE",
      sourceId: 902,
      codAmount: "80000.00",
      collectedAmount: "80000.00",
      moneyStatus: "SETTLED",
      status: "DELIVERED",
    });

    const res = await withTx((tx) => autoSettleAllAccountsTx(tx, actor, 100));
    expect(res.settledAccountsCount).toBe(2);
    expect(res.totalSettledInvoices).toBe(2);
    expect(res.totalSettledAmount).toBe("130000.00");

    const invs = await d.select().from(s.invoices).where(sql`customerId IN (91, 92)`);
    for (const inv of invs) {
      expect(inv.status).toBe("PAID");
    }

    const [c92] = await d.select().from(s.customers).where(sql`id = 92`);
    expect(c92.currentBalance).toBe("0.00");
  });
});
