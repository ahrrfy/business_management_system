/**
 * فاتورةُ أمر شغلٍ بلا وردية استقبال — تُرى وتُحصَّل (٢٠/٨).
 *
 * **العطبُ:** التسليمُ بلا وردية RECEPTION مفتوحة (مديرٌ يُسلّم، أو إسنادٌ من الإدارة) يختم
 * `invoices.shiftId = NULL`. والقائمةُ العامّة و`sales.get` عالجاه سلفاً
 * (`saleRouter.ts` يستثني `shiftId IS NULL AND sourceType='WORKORDER'` صراحةً) — **لكنّ
 * المحطّة نفسها تخلّفت**: `innerJoin(shifts)` يُسقط الصفّ من الطابور، و`collect` يردّ
 * FORBIDDEN. فاتورةٌ حقيقيّةٌ بذمّةٍ قائمة لا تُرى ولا تُقبَض في المكان الذي يعمل فيه
 * الموظّف — وهي بعينها شكوى المالك «تُنشأ ولا تُرى ولا تُدار».
 *
 * الثوابت المحروسة:
 *  (أ) فاتورةُ WORKORDER بـ`shiftId = NULL` **تظهر** في طابور المحطة.
 *  (ب) وفاتورةُ POS بـ`shiftId = NULL` **لا تظهر** — الحصرُ بالمنشأ يمنع ابتلاع الطابور.
 *  (ج) فاتورةُ وردية PRINT_SERVICES تبقى خارج الطابور (لا يتغيّر النطاق القائم).
 */
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";
import { listReceptionInvoices } from "../reception/queries";

const TABLES = [
  "receipts", "invoiceItems", "invoices", "workOrders",
  "shifts", "customers", "branches", "users",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

beforeEach(async () => {
  await truncateTables(TABLES);
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    { id: 1, openId: "m", name: "مدير", email: "m@t.test", role: "manager", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.customers).values([{ id: 1, name: "عميل", currentBalance: "0.00", creditLimit: null }]);
  await d.insert(s.shifts).values([
    { id: 1, branchId: 1, userId: 1, shiftType: "RECEPTION", status: "OPEN", openingCash: "0.00" },
    { id: 2, branchId: 1, userId: 1, shiftType: "PRINT_SERVICES", status: "OPEN", openingCash: "0.00" },
  ] as never);
});

async function invoice(id: number, number: string, shiftId: number | null, sourceType: string) {
  await db().insert(s.invoices).values({
    id, branchId: 1, invoiceNumber: number, customerId: 1, shiftId,
    subtotal: "10000.00", total: "10000.00", paidAmount: "0.00",
    status: "PENDING", sourceType, createdBy: 1,
  } as never);
}

const queueNumbers = async () => {
  const res = await listReceptionInvoices({ branchId: 1, sinceDays: 30 } as never);
  return res.rows.map((r) => (r as { invoiceNumber: string }).invoiceNumber).sort();
};

describe("رؤية فاتورة أمر الشغل بلا وردية استقبال", () => {
  it("⭐ (أ) فاتورةُ WORKORDER بلا وردية تظهر في طابور المحطة", async () => {
    await invoice(201, "INV-N-201", null, "WORKORDER");
    await invoice(202, "INV-N-202", 1, "WORKORDER"); // على وردية استقبال — كانت تظهر أصلاً
    expect(await queueNumbers()).toEqual(["INV-N-201", "INV-N-202"]);
  });

  it("⭐ (ب) فاتورةُ POS بلا وردية لا تظهر — الحصر بالمنشأ يمنع ابتلاع الطابور", async () => {
    await invoice(203, "INV-N-203", null, "POS");
    expect(await queueNumbers()).toEqual([]);
  });

  it("⭐ (ج) وردية PRINT_SERVICES تبقى خارج نطاق المحطة", async () => {
    await invoice(204, "INV-N-204", 2, "POS");
    await invoice(205, "INV-N-205", 2, "WORKORDER");
    expect(await queueNumbers()).toEqual([]);
  });

  it("الطابور يجمع الحالتين معاً بلا تكرار", async () => {
    await invoice(206, "INV-N-206", null, "WORKORDER");
    await invoice(207, "INV-N-207", 1, "POS");
    await invoice(208, "INV-N-208", null, "POS");
    expect(await queueNumbers()).toEqual(["INV-N-206", "INV-N-207"]);
  });
});
