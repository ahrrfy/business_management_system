/**
 * **خدمةُ منتقي روافد الردّ الموحَّدة** — تختبرها بحالاتٍ حقيقيّة يُتوقّع فيها الرفض:
 *  ① مستندٌ غير موجود ⇒ `NOT_FOUND` مقروء بمصطلحه العربيّ.
 *  ② فرعٌ آخر لغير مَن يعبُر الفروع ⇒ `FORBIDDEN` مقروء.
 *  ③ عزلُ الفرع لا يُطبَّق على مَن يعبُر الفروع (admin).
 *  ④ حجبُ رصيد الخزينة/الأدراج عن مَن لا يملك `treasury:READ`.
 *  ⑤ التوزيع الصحيح لأنواع المستندات الثلاثة (WORKORDER_CANCEL/REVERSE_DELIVERY/CONSIGNMENT_RETURN).
 *
 * ⚠️ الاختبارُ لا يعيد اختبارَ منطقِ الحساب — ذلك مغطّى في `refundPreflightAppliedGap.test.ts`
 * وفي `deliveryFlow.test.ts` وأخواتها. هنا نختبر **البوّابة والتوزيع** لا الحسبة.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { withTx } from "../tx";
import { refundRailPreflight, type RefundRailActor } from "../refundRailService";

const TABLES = [
  "auditLogs",
  "accountingEntries",
  "receipts",
  "orderPayments",
  "receptionDrafts",
  "deliveryConsignments",
  "workOrders",
  "shifts",
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

async function seedBase() {
  const d = db();
  await d
    .insert(s.branches)
    .values([
      { id: 1, name: "MAIN", code: "MAIN", type: "MAIN" },
      { id: 2, name: "SALES", code: "SALES", type: "SALES" },
    ]);
  await d.insert(s.users).values([
    { id: 1, openId: "admin", name: "المالك", role: "admin", loginMethod: "local", branchId: 1, isOwner: true },
    { id: 2, openId: "reception", name: "استقبال ١", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "reception2", name: "استقبال ٢", role: "cashier", loginMethod: "local", branchId: 2 },
    { id: 4, openId: "manager", name: "مديرة", role: "manager", loginMethod: "local", branchId: 1 },
  ]);
  await d
    .insert(s.customers)
    .values({ id: 1, name: "عميل", defaultPriceTier: "RETAIL", currentBalance: "0" });
}

async function openReceptionShiftWithCash(branchId: number, userId: number, cash: string): Promise<number> {
  const shiftId = extractInsertId(
    await db()
      .insert(s.shifts)
      .values({
        branchId,
        userId,
        openingBalance: "0",
        shiftStatus: "OPEN",
        shiftType: "RECEPTION",
        openGuard: `g-${randomUUID().slice(0, 8)}`,
      }),
  );
  await db().insert(s.receipts).values({
    branchId,
    shiftId,
    direction: "IN",
    amount: cash,
    paymentMethod: "CASH",
    cashBucket: "DRAWER",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    partyType: "OTHER",
    createdBy: userId,
  });
  return shiftId;
}

async function workOrderWithDeposit(branchId: number, shiftId: number, deposit: string): Promise<number> {
  const workOrderId = extractInsertId(
    await db()
      .insert(s.workOrders)
      .values({
        orderNumber: `WO-${randomUUID().slice(0, 6)}`,
        branchId,
        customerId: 1,
        title: "أمرٌ بعربونٍ مباشر",
        quantity: 1,
        materialsCost: "0.00",
        laborCost: "0.00",
        salePrice: "10000.00",
        status: "RECEIVED",
        deposit,
        paymentMethod: "CASH",
        createdBy: 2,
      }),
  );
  await db().insert(s.receipts).values({
    branchId,
    shiftId,
    workOrderId,
    direction: "IN",
    amount: deposit,
    paymentMethod: "CASH",
    cashBucket: "DRAWER",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    partyType: "CUSTOMER",
    partyId: 1,
    createdBy: 2,
  });
  return workOrderId;
}

const RECEPTION_STAFF: RefundRailActor = { userId: 2, branchId: 1, role: "cashier" };
const OTHER_BRANCH_STAFF: RefundRailActor = { userId: 3, branchId: 2, role: "cashier" };
const ADMIN: RefundRailActor = { userId: 1, branchId: 1, role: "admin", isOwner: true };
const MANAGER_B1: RefundRailActor = { userId: 4, branchId: 1, role: "manager" };

describe("خدمةُ روافد الردّ الموحَّدة — العزلُ والتوزيع", () => {
  beforeEach(async () => {
    await reset();
    await seedBase();
  });

  it("⭐ ①  مستندٌ غير موجود ⇒ NOT_FOUND برسالةٍ عربيةٍ بمصطلحه", async () => {
    let caught: unknown = null;
    try {
      await withTx((tx) =>
        refundRailPreflight(
          tx,
          { sourceDocType: "WORKORDER_CANCEL", sourceDocId: 999999 },
          RECEPTION_STAFF,
        ),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe("NOT_FOUND");
    expect((caught as TRPCError).message).toMatch(/إلغاء طلب خدمة/);
    expect((caught as TRPCError).message).toMatch(/999999/);
  });

  it("⭐ ②  فرعٌ آخر لكاشير الفرع ⇒ FORBIDDEN بلا كشفِ رصيدٍ ولا أدراج", async () => {
    const shiftB2 = await openReceptionShiftWithCash(2, 3, "50000.00");
    const woB2 = await workOrderWithDeposit(2, shiftB2, "3000.00");
    let caught: unknown = null;
    try {
      await withTx((tx) =>
        refundRailPreflight(
          tx,
          { sourceDocType: "WORKORDER_CANCEL", sourceDocId: woB2 },
          RECEPTION_STAFF, // فرع ١
        ),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe("FORBIDDEN");
    expect((caught as TRPCError).message).toMatch(/لا يخصّ فرعك/);
  });

  it("⭐ ③  admin/isOwner يعبُر الفروع — يقرأ تمهيدَ فرعٍ آخرَ بلا FORBIDDEN", async () => {
    const shiftB2 = await openReceptionShiftWithCash(2, 3, "50000.00");
    const woB2 = await workOrderWithDeposit(2, shiftB2, "3000.00");
    const res = await withTx((tx) =>
      refundRailPreflight(
        tx,
        { sourceDocType: "WORKORDER_CANCEL", sourceDocId: woB2 },
        ADMIN,
      ),
    );
    expect(res.needsCashDrawer).toBe(true);
    expect(res.branchId).toBe(2);
    expect(res.estimatedCashOut).toBe("3000.00");
  });

  it("⭐ ④  حجبُ رصيد الخزينة عن مَن لا يملك `treasury:READ` — علَمُ الكفاية باقٍ", async () => {
    const shift = await openReceptionShiftWithCash(1, 2, "50000.00");
    const wo = await workOrderWithDeposit(1, shift, "3000.00");
    // كاشير الاستقبال في الفرع ١ — بلا `treasury:READ` (قالب دور cashier لا يمنحه).
    const res = await withTx((tx) =>
      refundRailPreflight(
        tx,
        { sourceDocType: "WORKORDER_CANCEL", sourceDocId: wo },
        RECEPTION_STAFF,
      ),
    );
    expect(res.needsCashDrawer).toBe(true);
    // الرقم محجوب، والعلَم يكفي للقرار.
    expect(res.treasuryCash).toBeNull();
    expect(res.drawers[0]!.expectedCash).toBeUndefined();
    expect(res.drawers[0]!.sufficient).toBe(true);
  });

  it("⑤  admin يرى الأرقام (`exposeCash=true`) على نفس المستند", async () => {
    const shift = await openReceptionShiftWithCash(1, 2, "50000.00");
    const wo = await workOrderWithDeposit(1, shift, "3000.00");
    const res = await withTx((tx) =>
      refundRailPreflight(
        tx,
        { sourceDocType: "WORKORDER_CANCEL", sourceDocId: wo },
        ADMIN,
      ),
    );
    expect(res.drawers[0]!.expectedCash).toBe("53000.00");
    // الخزينةُ خاويةٌ للفرع، فرقمُها 0.00 لا null.
    expect(res.treasuryCash).toBe("0.00");
  });

  it("⑥  مدير الفرع يرى الأرقام (يملك treasury:READ بقالبه) لكن على فرعه فقط", async () => {
    const shiftB2 = await openReceptionShiftWithCash(2, 3, "50000.00");
    const woB2 = await workOrderWithDeposit(2, shiftB2, "3000.00");
    let caught: unknown = null;
    try {
      await withTx((tx) =>
        refundRailPreflight(
          tx,
          { sourceDocType: "WORKORDER_CANCEL", sourceDocId: woB2 },
          MANAGER_B1, // مدير الفرع ١ — لا يعبُر الفروع
        ),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe("FORBIDDEN");
  });

  it("⑦  التوزيع: REVERSE_DELIVERY يستعمل نفس التمهيد ونتيجتُه لعمليةٍ مختلفة", async () => {
    // مستندٌ فيه شرطُ الإلغاء لكن ليس شرطَ عكسِ التسليم (لا فاتورة) ⇒ needsCashDrawer=false.
    const shift = await openReceptionShiftWithCash(1, 2, "50000.00");
    const wo = await workOrderWithDeposit(1, shift, "3000.00");
    const res = await withTx((tx) =>
      refundRailPreflight(
        tx,
        { sourceDocType: "WORKORDER_REVERSE_DELIVERY", sourceDocId: wo },
        ADMIN,
      ),
    );
    expect(res.branchId).toBe(1);
    // بلا فاتورةٍ محصَّلة، لا نقدَ يخرج من مسار الاسترجاع.
    expect(res.needsCashDrawer).toBe(false);
    expect(res.estimatedCashOut).toBe("0.00");
  });

  it("⑧  التوزيع: CONSIGNMENT_RETURN لإرساليةٍ غير موجودة ⇒ NOT_FOUND بمصطلحها", async () => {
    let caught: unknown = null;
    try {
      await withTx((tx) =>
        refundRailPreflight(
          tx,
          { sourceDocType: "CONSIGNMENT_RETURN", sourceDocId: 12345 },
          ADMIN,
        ),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe("NOT_FOUND");
    expect((caught as TRPCError).message).toMatch(/إرجاعُ إرسالية توصيل/);
  });
});
