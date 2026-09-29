import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { withTx } from "../tx";
import { getSupplierStatement } from "../reportsService";
import { autoSettleSupplierAccountTx } from "../reconciliation/autoSettlementService";
import { isDeadInvoice } from "@shared/predicates";

const actor = { userId: 1, branchId: 1, role: "admin" as const };

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

const TABLES = [
  "idempotencyKeys", "accountingEntries", "receipts", "inventoryMovements", "invoiceItems", "invoices",
  "purchaseOrderItems", "purchaseOrders", "shifts", "customers", "suppliers", "branches", "users",
];

async function reset() {
  const d = db();
  for (const table of TABLES) {
    try {
      await d.execute(sql.raw(`DELETE FROM \`${table}\``));
    } catch {
      // ignore
    }
  }
}

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "MAIN", code: "MAIN", type: "MAIN" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "admin", name: "admin", role: "admin", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.suppliers).values({
    id: 1,
    name: "مورد تجريبي",
    currentBalance: "0.00",
  });
  await d.insert(s.customers).values({
    id: 1,
    name: "عميل تجريبي",
    defaultPriceTier: "RETAIL",
    currentBalance: "0.00",
  });
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("FIFO Reconciliation Forensic Audit Fixes", () => {
  describe("1. Supplier Statement — ردم الانفصال البنيوي بين التسوية التلقائية وكشف الحساب", () => {
    it("يعتمد po.paidAmount المسوّى تلقائياً بـ FIFO ويخصمه من unallocatedPayments بدلاً من دهسه بـ 0.00", async () => {
      const d = db();

      // إنشاء أمر شراء بقيمة 100,000 د.ع
      const [poRes] = await d.insert(s.purchaseOrders).values({
        id: 101,
        poNumber: "PO-101",
        supplierId: 1,
        branchId: 1,
        orderDate: new Date("2026-09-01T10:00:00Z"),
        subtotal: "100000.00",
        total: "100000.00",
        paidAmount: "0.00",
        status: "CONFIRMED",
        settlementType: "CREDIT",
        createdBy: 1,
      });

      // تسجيل قيد اعتراف الشراء في الدفتر العام
      await d.insert(s.accountingEntries).values({
        branchId: 1,
        supplierId: 1,
        purchaseOrderId: 101,
        entryType: "PURCHASE",
        amount: "100000.00",
        entryDate: new Date("2026-09-01"),
        description: "شراء بضاعة PO-101",
      });

      // تسجيل سند صرف مستقل غير مخصص بقيمة 120,000 د.ع (دفعة عامة على الحساب purchaseOrderId = null)
      await d.insert(s.accountingEntries).values({
        branchId: 1,
        supplierId: 1,
        purchaseOrderId: null,
        entryType: "PAYMENT_OUT",
        amount: "120000.00",
        entryDate: new Date("2026-09-02"),
        description: "سند صرف على الحساب",
      });

      // تحديث رصيد المورد: ندين له بـ 100,000 وسددنا 120,000 ⇒ رصيد المورد -20,000 (دائن)
      await d.update(s.suppliers).set({ currentBalance: "-20000.00" }).where(sql`id = 1`);

      // تنفيذ التسوية التلقائية FIFO عبر الخدمة
      const settleResult = await withTx((tx) => autoSettleSupplierAccountTx(tx, 1, actor));
      expect(settleResult.settledOrdersCount).toBe(1);
      expect(Number(settleResult.totalSettledAmount)).toBe(100000);

      // الآن استدعاء كشف الحساب
      const stmt = await getSupplierStatement(1, {});
      expect(stmt).not.toBeNull();
      const poInStmt = stmt!.purchaseOrders.find((p) => p.id === 101);
      expect(poInStmt).toBeDefined();

      // التحقق الحاسم: مدفوع الأمر يجب أن يكون 100,000 كاملة (وليس 0.00 كما كان قبل الإصلاح)
      expect(Number(poInStmt!.paidAmount)).toBe(100000);

      // التحقق الحاسم: الدفعات غير المخصصة كانت 120,000 وسُوِّي منها 100,000 للأمر ⇒ المتبقي 20,000 فقط
      expect(Number(stmt!.summary.unallocatedPayments)).toBe(20000);

      // التحقق من أن أعمار الذمم تفرغت بالكامل للأمر المسدد
      expect(Number(stmt!.summary.aging.d0_30)).toBe(0);
      expect(Number(stmt!.summary.aging.d31_60)).toBe(0);
      expect(Number(stmt!.summary.aging.d61_90)).toBe(0);
      expect(Number(stmt!.summary.aging.d91p)).toBe(0);
    });

    it("عند وجود دفعة مقدمة دون أي أوامر شراء، لا يكون هناك mismatch ويظهر الرصيد كغير مخصص", async () => {
      const d = db();

      // دفعة مقدمة 50,000 د.ع دون أي أمر شراء
      await d.insert(s.accountingEntries).values({
        branchId: 1,
        supplierId: 1,
        purchaseOrderId: null,
        entryType: "PAYMENT_OUT",
        amount: "50000.00",
        entryDate: new Date("2026-09-10"),
        description: "دفعة مقدمة على الحساب",
      });
      await d.update(s.suppliers).set({ currentBalance: "-50000.00" }).where(sql`id = 1`);

      const stmt = await getSupplierStatement(1, {});
      expect(stmt).not.toBeNull();
      expect(stmt!.purchaseOrders.length).toBe(0);
      expect(Number(stmt!.summary.unallocatedPayments)).toBe(50000);
      // في الواجهة: openOrdersCount = 0 ⇒ hasUnsettledMismatch = false
      // ولن يظهر تنبيه FIFO الأصفر الخاطئ لـ (0 أمر)
    });

    it("تسوية جزئية وتعدد أوامر: FIFO يسوي الأقدم أولاً ويوزع المتبقي بدقة متناهية", async () => {
      const d = db();

      // أقدم: 40,000 د.ع
      await d.insert(s.purchaseOrders).values({
        id: 201,
        poNumber: "PO-201",
        supplierId: 1,
        branchId: 1,
        orderDate: new Date("2026-08-01T10:00:00Z"),
        subtotal: "40000.00",
        total: "40000.00",
        paidAmount: "0.00",
        status: "CONFIRMED",
        settlementType: "CREDIT",
        createdBy: 1,
      });
      await d.insert(s.accountingEntries).values({
        branchId: 1,
        supplierId: 1,
        purchaseOrderId: 201,
        entryType: "PURCHASE",
        amount: "40000.00",
        entryDate: new Date("2026-08-01"),
      });

      // أحدث: 60,000 د.ع
      await d.insert(s.purchaseOrders).values({
        id: 202,
        poNumber: "PO-202",
        supplierId: 1,
        branchId: 1,
        orderDate: new Date("2026-08-15T10:00:00Z"),
        subtotal: "60000.00",
        total: "60000.00",
        paidAmount: "0.00",
        status: "CONFIRMED",
        settlementType: "CREDIT",
        createdBy: 1,
      });
      await d.insert(s.accountingEntries).values({
        branchId: 1,
        supplierId: 1,
        purchaseOrderId: 202,
        entryType: "PURCHASE",
        amount: "60000.00",
        entryDate: new Date("2026-08-15"),
      });

      // سداد عام غير مخصص بقيمة 70,000 د.ع (يكفي لتسوية PO-201 بالكامل + 30,000 لـ PO-202)
      await d.insert(s.accountingEntries).values({
        branchId: 1,
        supplierId: 1,
        purchaseOrderId: null,
        entryType: "PAYMENT_OUT",
        amount: "70000.00",
        entryDate: new Date("2026-08-20"),
      });
      await d.update(s.suppliers).set({ currentBalance: "30000.00" }).where(sql`id = 1`);

      const settle = await withTx((tx) => autoSettleSupplierAccountTx(tx, 1, actor));
      expect(settle.settledOrdersCount).toBe(1); // PO-201
      expect(settle.partiallySettledOrdersCount).toBe(1); // PO-202
      expect(Number(settle.totalSettledAmount)).toBe(70000);

      const stmt = await getSupplierStatement(1, {});
      expect(stmt).not.toBeNull();
      const p1 = stmt!.purchaseOrders.find((p) => p.id === 201)!;
      const p2 = stmt!.purchaseOrders.find((p) => p.id === 202)!;

      expect(Number(p1.paidAmount)).toBe(40000);
      expect(Number(p2.paidAmount)).toBe(30000);
      // كل الـ 70,000 تم تخصيصها بالكامل للأمرين ⇒ unallocatedPayments = 0.00
      expect(Number(stmt!.summary.unallocatedPayments)).toBe(0);
    });

    it("أمر شراء مسدد جزئياً بقيد في الدفتر ثم استكمل تسويته بـ FIFO: عدم حدوث ازدواج حسابي", async () => {
      const d = db();

      // أمر شراء 100,000
      await d.insert(s.purchaseOrders).values({
        id: 301,
        poNumber: "PO-301",
        supplierId: 1,
        branchId: 1,
        orderDate: new Date("2026-08-01T10:00:00Z"),
        subtotal: "100000.00",
        total: "100000.00",
        paidAmount: "30000.00", // مسدد منه 30,000 مباشرة
        status: "CONFIRMED",
        settlementType: "CREDIT",
        createdBy: 1,
      });
      await d.insert(s.accountingEntries).values({
        branchId: 1,
        supplierId: 1,
        purchaseOrderId: 301,
        entryType: "PURCHASE",
        amount: "100000.00",
        entryDate: new Date("2026-08-01"),
      });
      // قيد سداد مربوط برقم الأمر مباشرة (30,000)
      await d.insert(s.accountingEntries).values({
        branchId: 1,
        supplierId: 1,
        purchaseOrderId: 301,
        entryType: "PAYMENT_OUT",
        amount: "30000.00",
        entryDate: new Date("2026-08-02"),
      });

      // سند صرف إضافي غير مخصص بقيمة 80,000 على الحساب
      await d.insert(s.accountingEntries).values({
        branchId: 1,
        supplierId: 1,
        purchaseOrderId: null,
        entryType: "PAYMENT_OUT",
        amount: "80000.00",
        entryDate: new Date("2026-08-10"),
      });
      // الرصيد: 100k مشتريات - 30k مسدد - 80k سداد عام = -10,000 (دائن)
      await d.update(s.suppliers).set({ currentBalance: "-10000.00" }).where(sql`id = 1`);

      // تسوية FIFO: المتبقي على الأمر 70,000 فقط
      const settle = await withTx((tx) => autoSettleSupplierAccountTx(tx, 1, actor));
      expect(settle.settledOrdersCount).toBe(1);
      expect(Number(settle.totalSettledAmount)).toBe(70000);

      const stmt = await getSupplierStatement(1, {});
      expect(stmt).not.toBeNull();
      const p = stmt!.purchaseOrders.find((x) => x.id === 301)!;

      // إجمالي المدفوع للأمر 100,000 (30,000 من الدفتر + 70,000 من التسوية)
      expect(Number(p.paidAmount)).toBe(100000);

      // السند غير المخصص كان 80,000 وسُوِّي منه 70,000 فقط ⇒ المتبقي غير مخصص 10,000
      expect(Number(stmt!.summary.unallocatedPayments)).toBe(10000);
    });
  });

  describe("2. Customer Statement — استبعاد الفواتير الملغاة بالتصحيح (SUPERSEDED)", () => {
    it("isDeadInvoice يصنف SUPERSEDED كمستند ميت لا يقبل التحصيل", () => {
      expect(isDeadInvoice("SUPERSEDED")).toBe(true);
      expect(isDeadInvoice("CANCELLED")).toBe(true);
      expect(isDeadInvoice("RETURNED")).toBe(true);
      expect(isDeadInvoice("CONFIRMED")).toBe(false);
      expect(isDeadInvoice("PENDING")).toBe(false);
      expect(isDeadInvoice("PAID")).toBe(false);
    });

    it("الفاتورة المصححة SUPERSEDED تُستبعد من عداد الفواتير المفتوحة openInvoicesCount", () => {
      const mockInvoices = [
        // فاتورة ملغاة بالتصحيح
        {
          id: 1,
          invoiceNumber: "INV-001",
          total: "50000.00",
          paidAmount: "0.00",
          returnedTotal: "0.00",
          status: "SUPERSEDED",
        },
        // فاتورة نشطة مفتوحة
        {
          id: 2,
          invoiceNumber: "INV-002",
          total: "30000.00",
          paidAmount: "0.00",
          returnedTotal: "0.00",
          status: "CONFIRMED",
        },
      ];

      // تطبيق نفس منطق CustomerStatement.tsx المحدّث
      const openInvoices = mockInvoices.filter((i) => {
        const remaining = Number(i.total) - Number(i.paidAmount) - Number(i.returnedTotal || 0);
        const active = !isDeadInvoice(i.status);
        return active && remaining > 0;
      });

      expect(openInvoices.length).toBe(1);
      expect(openInvoices[0].id).toBe(2);
    });
  });
});
