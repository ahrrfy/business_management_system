// اختبارات رجوع لإصلاحات تشديد الأمان والمالية — انظر شريحة security-financial-hardening
// والتقرير العدائي. كل اختبار يثبت سدّ ثغرة محدّدة (شدّة + جذرها) ويمنع عودتها.
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { reconcileCustomerBalances } from "../reconcileService";
import { createVoucher, cancelVoucher } from "../voucherService";
import { recordAttendance, monthSummary } from "../attendanceService";
import { getSupplierStatement } from "../reportsService";

const actor = { userId: 1, branchId: 1, role: "admin" };

const TABLES = [
  "idempotencyKeys", "accountingEntries", "receipts", "inventoryMovements", "invoiceItems", "invoices",
  "purchaseOrderItems", "purchaseOrders",
  "branchStock", "productPrices", "productUnits", "productVariants", "products",
  "shifts", "attendance", "leaveRequests", "employees", "customers", "suppliers", "branches", "users",
  "auditLogs",
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
  await d.insert(s.branches).values([
    { id: 1, name: "MAIN", code: "MAIN", type: "MAIN" },
    { id: 2, name: "SALES", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "admin", name: "admin", role: "admin", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "mgrA", name: "مدير-MAIN", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "mgrB", name: "مدير-SALES", role: "manager", loginMethod: "local", branchId: 2 },
  ]);
  await d.insert(s.customers).values({ id: 1, name: "تاجر", defaultPriceTier: "RETAIL", currentBalance: "0.00" });
  await d.insert(s.suppliers).values({ id: 1, name: "مورّد", currentBalance: "0.00" });
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("reconcileCustomerBalances — يضمّ سندات العميل المستقلّة (إصلاح ٤)", () => {
  it("سند قبض مستقلّ (PAYMENT_IN، بلا فاتورة) لا ينتج انحرافاً وهمياً", async () => {
    // قبل الإصلاح: السند ينقص currentBalance لكنّ المتوقّع لم يحتسبه ⇒ انحراف وهمي دائم.
    await createVoucher(
      {
        voucherType: "RECEIPT",
        branchId: 1,
        amount: "30.00",
        paymentMethod: "CASH",
        partyType: "CUSTOMER",
        partyId: 1,
        description: "دفعة على الحساب",
      },
      actor,
    );
    const issues = await reconcileCustomerBalances();
    expect(issues).toHaveLength(0);
  });

  it("سند صرف لعميل (PAYMENT_OUT، بلا فاتورة) لا ينتج انحرافاً وهمياً", async () => {
    await createVoucher(
      {
        voucherType: "PAYMENT",
        branchId: 1,
        amount: "20.00",
        paymentMethod: "CASH",
        partyType: "CUSTOMER",
        partyId: 1,
        description: "استرداد نقدي مستقلّ",
      },
      actor,
    );
    const issues = await reconcileCustomerBalances();
    expect(issues).toHaveLength(0);
  });

  it("سند ثمّ إلغاؤه يتصافر إلى صفر انحراف (cancelVoucher يكتب قيداً تعويضياً)", async () => {
    const r = await createVoucher(
      {
        voucherType: "RECEIPT",
        branchId: 1,
        amount: "30.00",
        paymentMethod: "CASH",
        partyType: "CUSTOMER",
        partyId: 1,
        description: "تجربة",
      },
      actor,
    );
    await cancelVoucher(r.receiptId, actor);
    const issues = await reconcileCustomerBalances();
    expect(issues).toHaveLength(0);
  });
});

describe("attendance — ABSENT/LEAVE لا تولّد أجراً (إصلاح ٤)", () => {
  beforeEach(async () => {
    await db().insert(s.employees).values({
      id: 1,
      firstName: "حسن",
      lastName: "العزاوي",
      payType: "hourly",
      salary: "0",
      allowances: "0",
      employmentStatus: "active",
      branchId: 1,
      dayRates: { "السبت": 5000, "الأحد": 5000, "الاثنين": 5000, "الثلاثاء": 5000, "الأربعاء": 5000, "الخميس": 5000, "الجمعة": 5000 } as any,
    });
  });

  it("status=ABSENT مع ساعات يخزّن amount=0", async () => {
    const r = await recordAttendance({
      employeeId: 1,
      attendanceDate: "2026-06-15",
      hours: 8,
      status: "ABSENT",
    });
    expect(Number(r.amount)).toBe(0);
    expect(Number(r.hours)).toBe(0);
  });

  it("status=LEAVE مع ساعات يخزّن amount=0", async () => {
    const r = await recordAttendance({
      employeeId: 1,
      attendanceDate: "2026-06-15",
      hours: 8,
      status: "LEAVE",
    });
    expect(Number(r.amount)).toBe(0);
  });

  it("monthSummary لا يحتسب أيام ABSENT/LEAVE في الأجر المُجمَّع", async () => {
    await recordAttendance({ employeeId: 1, attendanceDate: "2026-06-15", hours: 8, status: "PRESENT" });
    await recordAttendance({ employeeId: 1, attendanceDate: "2026-06-16", hours: 8, status: "ABSENT" });
    await recordAttendance({ employeeId: 1, attendanceDate: "2026-06-17", hours: 8, status: "LEAVE" });
    const summary = await monthSummary("2026-06");
    const me = summary.find((x) => x.employeeId === 1)!;
    // يوم حضور واحد فقط يدخل المجموع.
    expect(Number(me.totalAmount)).toBe(40000);
    expect(me.totalHours).toBe(8);
  });

  it("موظف منتهي الخدمة يُرفض تسجيل حضوره", async () => {
    await db().update(s.employees).set({ employmentStatus: "terminated" }).where(sql`${s.employees.id} = 1`);
    await expect(
      recordAttendance({ employeeId: 1, attendanceDate: "2026-06-15", hours: 8, status: "PRESENT" }),
    ).rejects.toThrow(/منتهي/);
  });
});

describe("voucherService — رفض سند لعميل/مورد مُعطَّل (نمط جذري ٣)", () => {
  it("createVoucher يرفض سند قبض لعميل مُعطَّل (isActive=false)", async () => {
    await db().update(s.customers).set({ isActive: false }).where(sql`${s.customers.id} = 1`);
    await expect(
      createVoucher(
        {
          voucherType: "RECEIPT",
          branchId: 1,
          amount: "30.00",
          paymentMethod: "CASH",
          partyType: "CUSTOMER",
          partyId: 1,
          description: "محاولة",
        },
        actor,
      ),
    ).rejects.toThrow(/مُعطَّل/);
  });

  it("createVoucher يرفض سند صرف لمورد مُعطَّل", async () => {
    await db().update(s.suppliers).set({ isActive: false }).where(sql`${s.suppliers.id} = 1`);
    await expect(
      createVoucher(
        {
          voucherType: "PAYMENT",
          branchId: 1,
          amount: "30.00",
          paymentMethod: "CASH",
          partyType: "SUPPLIER",
          partyId: 1,
          description: "محاولة",
        },
        actor,
      ),
    ).rejects.toThrow(/مُعطَّل/);
  });
});

describe("voucherService idempotency — تأكيد كيان (نمط جذري ١)", () => {
  it("نفس clientRequestId مع طرف/مبلغ مختلف ⇒ CONFLICT لا replay صامت", async () => {
    await createVoucher(
      {
        voucherType: "RECEIPT",
        branchId: 1,
        amount: "30.00",
        paymentMethod: "CASH",
        partyType: "CUSTOMER",
        partyId: 1,
        description: "أول",
        clientRequestId: "test-key-001",
      },
      actor,
    );
    // إعادة المفتاح بمبلغ مختلف ⇒ يجب أن يُرفض (لا يُعاد بنتيجة قديمة صامتاً).
    await expect(
      createVoucher(
        {
          voucherType: "RECEIPT",
          branchId: 1,
          amount: "99.00",
          paymentMethod: "CASH",
          partyType: "CUSTOMER",
          partyId: 1,
          description: "ثانٍ",
          clientRequestId: "test-key-001",
        },
        actor,
      ),
    ).rejects.toThrow(/تعارض idempotency/);
  });

  it("نفس clientRequestId بنفس المدخلات ⇒ replay يُعيد السند الأصلي بلا قيد جديد", async () => {
    const r1 = await createVoucher(
      {
        voucherType: "RECEIPT",
        branchId: 1,
        amount: "30.00",
        paymentMethod: "CASH",
        partyType: "CUSTOMER",
        partyId: 1,
        description: "test",
        clientRequestId: "test-key-002",
      },
      actor,
    );
    const r2 = await createVoucher(
      {
        voucherType: "RECEIPT",
        branchId: 1,
        amount: "30.00",
        paymentMethod: "CASH",
        partyType: "CUSTOMER",
        partyId: 1,
        description: "test",
        clientRequestId: "test-key-002",
      },
      actor,
    );
    expect(r1.receiptId).toBe(r2.receiptId);
  });
});

describe("voucherService cancelVoucher — عزل عبر-فرعي (نمط جذري ٢)", () => {
  it("مدير فرع SALES لا يستطيع إلغاء سند فرع MAIN", async () => {
    const r = await createVoucher(
      {
        voucherType: "RECEIPT",
        branchId: 1,
        amount: "30.00",
        paymentMethod: "CASH",
        partyType: "CUSTOMER",
        partyId: 1,
        description: "سند MAIN",
      },
      actor,
    );
    // مدير SALES (userId=3, branchId=2) يحاول إلغاء سند MAIN ⇒ FORBIDDEN
    const mgrSales = { userId: 3, branchId: 2 };
    await expect(cancelVoucher(r.receiptId, mgrSales)).rejects.toThrow(/فرع آخر/);
  });

  it("مدير نفس الفرع يستطيع الإلغاء بنجاح", async () => {
    const r = await createVoucher(
      {
        voucherType: "RECEIPT",
        branchId: 1,
        amount: "30.00",
        paymentMethod: "CASH",
        partyType: "CUSTOMER",
        partyId: 1,
        description: "سند MAIN",
      },
      actor,
    );
    const mgrMain = { userId: 2, branchId: 1 };
    const res = await cancelVoucher(r.receiptId, mgrMain);
    expect(res.status).toBe("REVERSED");
  });

  it("admin يستطيع الإلغاء عبر أي فرع", async () => {
    const r = await createVoucher(
      {
        voucherType: "RECEIPT",
        branchId: 1,
        amount: "30.00",
        paymentMethod: "CASH",
        partyType: "CUSTOMER",
        partyId: 1,
        description: "سند MAIN",
      },
      actor,
    );
    const res = await cancelVoucher(r.receiptId, actor); // admin
    expect(res.status).toBe("REVERSED");
  });
});

describe("supplierStatement — يضمّ PAYMENT_IN/RETURN (إصلاح ٥)", () => {
  it("سند قبض من مورد يَظهر في الكشف ضمن payments بـentryType=PAYMENT_IN", async () => {
    await createVoucher(
      {
        voucherType: "RECEIPT",
        branchId: 1,
        amount: "25.00",
        paymentMethod: "CASH",
        partyType: "SUPPLIER",
        partyId: 1,
        description: "استرداد من مورد",
      },
      actor,
    );
    const st = await getSupplierStatement(1, {});
    expect(st).not.toBeNull();
    const inEntry = st!.payments.find((p) => p.entryType === "PAYMENT_IN");
    expect(inEntry).toBeTruthy();
    expect(Number(inEntry!.amount)).toBe(25);
  });
});
