/**
 * إلغاء أمر شغل — إسناد استرداد العربون للدرج الفعليّ لا وردية الفاعل (بلاغ مالك ٢/٨/٢٦، متابعة
 * تدقيق shiftIdForCashTx — مرآة إصلاح returnService.ts وdelivery/returns.ts).
 *
 * المشكلة: `workOrders.cancel` صلاحية مدير (workordersManagerProcedure — «الإلغاء يعكس مخزوناً/قيوداً»)
 * — مُنفِّذ الإلغاء غالباً شخصٌ مختلف عن الكاشير الذي يُشغّل درج الاستقبال الذي قبض العربون فعلاً. كان
 * الكود القديم يستخدم openShiftIdTx(actor.userId) فقط: يرفض الإلغاء كاملاً إن لم يكن للمدير وردية
 * استقبال خاصّة، أو (لو كانت له) ينسب الاسترداد إليها فيختفي عن Z-report صاحب الدرج الحقيقيّ.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { cancelWorkOrder } from "../workOrder/cancel";
import { createWorkOrder } from "../workOrder/create";
import { closeShift, openShift } from "../shiftService";

const manager = { userId: 1, branchId: 1, role: "manager" };
const cashier = { userId: 2, branchId: 1 };

const TABLES = [
  "idempotencyKeys",
  "accountingEntries", "receipts", "inventoryMovements", "invoiceItems", "invoices",
  "workOrderMaterials", "workOrderImages", "workOrders",
  "branchStock", "productPrices", "productUnits", "productVariants", "products",
  "shifts", "customers", "branches", "users",
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
  await d.insert(s.branches).values({ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values([
    { id: 1, openId: "mgr", name: "مديرة الفرع", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "reception1", name: "موظف استقبال", role: "cashier", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.customers).values({ id: 1, name: "عميل", defaultPriceTier: "RETAIL", currentBalance: "0" });
}

async function openShiftFor(userId: number, shiftType: "RETAIL" | "RECEPTION" | "PRINT_SERVICES", branchId = 1) {
  return openShift({ branchId, openingBalance: "0", shiftType }, { userId, branchId });
}

/** أمر شغل بعربون نقديّ ٢٠٠٠، يُنشئه الكاشير (موظّف الاستقبال). */
async function createWorkOrderWithDeposit() {
  const wo = await createWorkOrder(
    { branchId: 1, customerId: 1, baseVariantId: null, title: "بطاقات تعريفية", salePrice: "5000", deposit: "2000", paymentMethod: "CASH" },
    cashier,
  );
  return (wo as { workOrderId: number }).workOrderId;
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("cancelWorkOrder — إسناد استرداد العربون لدرج الفرع الفعليّ (لا وردية الفاعل)", () => {
  it("المديرة بلا وردية + وردية الاستقبال (الكاشير) هي الوحيدة المفتوحة ⇒ الاسترداد يُنسَب لها تلقائياً", async () => {
    const shift = await openShiftFor(2, "RECEPTION");
    const workOrderId = await createWorkOrderWithDeposit();

    // قبل الإصلاح: openShiftIdTx(actor=المديرة بلا وردية استقبال) ⇒ null ⇒ CONFLICT.
    await cancelWorkOrder(workOrderId, manager);

    const refund = (
      await db()
        .select({ shiftId: s.receipts.shiftId, cashBucket: s.receipts.cashBucket, amount: s.receipts.amount })
        .from(s.receipts)
        .where(and(eq(s.receipts.workOrderId, workOrderId), eq(s.receipts.direction, "OUT")))
    )[0];
    expect(refund?.shiftId).toBe(shift.shiftId); // انتسب لدرج الاستقبال الحقيقيّ — لا رفض، لا وردية شبحيّة.
    expect(refund?.cashBucket).toBe("DRAWER");
    expect(refund?.amount).toBe("2000.00");
  });

  it("تعدّد الدرج (وردية المديرة الخاصّة + وردية الاستقبال) بلا تحديد صريح ⇒ يُرفَض", async () => {
    await openShiftFor(2, "RECEPTION");
    await openShiftFor(1, "RETAIL");
    const workOrderId = await createWorkOrderWithDeposit();

    await expect(cancelWorkOrder(workOrderId, manager)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("تعدّد الدرج + refundShiftId صريح لوردية الاستقبال ⇒ ينجح وينتسب لها لا لوردية المديرة", async () => {
    const receptionShift = await openShiftFor(2, "RECEPTION");
    const mgrShift = await openShiftFor(1, "RETAIL");
    const workOrderId = await createWorkOrderWithDeposit();

    await cancelWorkOrder(workOrderId, manager, { refundShiftId: receptionShift.shiftId });

    const refund = (
      await db()
        .select({ shiftId: s.receipts.shiftId })
        .from(s.receipts)
        .where(and(eq(s.receipts.workOrderId, workOrderId), eq(s.receipts.direction, "OUT")))
    )[0];
    expect(refund?.shiftId).toBe(receptionShift.shiftId);
    expect(refund?.shiftId).not.toBe(mgrShift.shiftId);
  });

  it("الدرج استُنزف بمصروفٍ سابق في نفس الوردية ⇒ استرداد يتجاوز المتاح حالياً يُرفَض", async () => {
    const shift = await openShiftFor(2, "RECEPTION");
    const workOrderId = await createWorkOrderWithDeposit(); // عربون ٢٠٠٠
    // مصروفٌ نقديّ يستنزف الدرج (المتاح بعد العربون = ٢٠٠٠) إلى ٥٠٠ فقط.
    await db().insert(s.receipts).values({
      branchId: 1, shiftId: shift.shiftId, direction: "OUT", amount: "1500.00",
      paymentMethod: "CASH", cashBucket: "DRAWER", status: "COMPLETED", createdBy: 2,
    });

    await expect(cancelWorkOrder(workOrderId, manager)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("لا وردية مفتوحة بالفرع إطلاقاً (أُغلقت بعد قبض العربون) ⇒ الاسترداد النقدي يُرفَض", async () => {
    const shift = await openShiftFor(2, "RECEPTION"); // يلزم وردية لقبض العربون نفسه عند الإنشاء
    const workOrderId = await createWorkOrderWithDeposit();
    await closeShift({ shiftId: shift.shiftId, countedCash: "2000.00" }, { userId: 2, branchId: 1, role: "cashier" });

    await expect(cancelWorkOrder(workOrderId, manager)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});
