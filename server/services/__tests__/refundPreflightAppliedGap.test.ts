/**
 * **الفجوةُ الماليّة: حصصُ العربون المطبَّقة على أمرٍ عمودُه `deposit = 0`** (قرار المالك ١/٩).
 *
 * أمرٌ من مسوّدة استقبالٍ قد يحمل حصصَ قبضٍ نقديّةً محتجزة (`orderPayments` APPLICATION) بينما
 * `workOrders.deposit = 0`. كانت حلقةُ ردّها في `cancel.ts` داخل `if (refundD.gt(0))` فتُتخطّى ⇒
 * مالُ العميل يبقى في الدرج بلا مسار خروجٍ (خرقُ §٥)، وتمهيدُ `refundPreflight` يبلّغ «لا نقد».
 *
 * هذا الاختبار يُثبت **التلازم** الذي حذّرت منه مراجعة Codex: تمهيدُ الإلغاء يعدّ هذه الحصص
 * **بلا حارسِ العربون** — فما يقوله للشاشة هو ما ستصرفه الخدمةُ فعلاً.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { withTx } from "../tx";
import { workOrderRefundPreflight } from "../workOrder/refundPreflight";

const TABLES = [
  "auditLogs",
  "accountingEntries",
  "receipts",
  "orderPayments",
  "receptionDrafts",
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
    .values({ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values([
    {
      id: 1,
      openId: "mgr",
      name: "مديرة",
      role: "manager",
      loginMethod: "local",
      branchId: 1,
    },
    {
      id: 2,
      openId: "reception",
      name: "استقبال",
      role: "cashier",
      loginMethod: "local",
      branchId: 1,
    },
  ]);
  await d
    .insert(s.customers)
    .values({
      id: 1,
      name: "عميل",
      defaultPriceTier: "RETAIL",
      currentBalance: "0",
    });
}

/** وردية استقبالٍ مفتوحة برصيدٍ افتتاحيّ، ثمّ نضخّ فيها قبضاً نقدياً فيصير نقدُها المتاح موجباً. */
async function openReceptionShiftWithCash(cash: string): Promise<number> {
  const shiftId = extractInsertId(
    await db()
      .insert(s.shifts)
      .values({
        branchId: 1,
        userId: 2,
        openingBalance: "0",
        shiftStatus: "OPEN",
        shiftType: "RECEPTION",
        openGuard: `g-${randomUUID().slice(0, 8)}`,
      }),
  );
  await db().insert(s.receipts).values({
    branchId: 1,
    shiftId,
    direction: "IN",
    amount: cash,
    paymentMethod: "CASH",
    cashBucket: "DRAWER",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    partyType: "OTHER",
    createdBy: 2,
  });
  return shiftId;
}

/**
 * أمرُ شغلٍ **بعربونٍ صفر** لكنّه يحمل حصّةَ قبضٍ نقديّةً مطبَّقةً من مسوّدة استقبال:
 * COLLECTION أمّ (نقديّة، بإيصالٍ في الدرج) + APPLICATION على الأمر.
 */
async function orderWithAppliedCash(
  appliedAmount: string,
  shiftId: number,
): Promise<number> {
  const workOrderId = extractInsertId(
    await db()
      .insert(s.workOrders)
      .values({
        orderNumber: `WO-APPLIED-${randomUUID().slice(0, 6)}`,
        branchId: 1,
        customerId: 1,
        title: "أمر بحصّة مطبَّقة",
        quantity: 1,
        materialsCost: "0.00",
        laborCost: "0.00",
        salePrice: "5000.00",
        status: "RECEIVED",
        deposit: "0.00",
        paymentMethod: "CASH",
        createdBy: 2,
      }),
  );
  const draftId = extractInsertId(
    await db()
      .insert(s.receptionDrafts)
      .values({
        draftNumber: `D-${randomUUID().slice(0, 8)}`,
        branchId: 1,
        commitRequestId: randomUUID(),
        createdBy: 2,
      }),
  );
  const collectionReceiptId = extractInsertId(
    await db().insert(s.receipts).values({
      branchId: 1,
      shiftId,
      direction: "IN",
      amount: appliedAmount,
      paymentMethod: "CASH",
      cashBucket: "DRAWER",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      partyType: "CUSTOMER",
      partyId: 1,
      createdBy: 2,
    }),
  );
  const collectionId = extractInsertId(
    await db().insert(s.orderPayments).values({
      draftId,
      branchId: 1,
      kind: "COLLECTION",
      amount: appliedAmount,
      method: "CASH",
      receiptId: collectionReceiptId,
      shiftId,
      customerId: 1,
      status: "APPLIED",
      createdBy: 2,
    }),
  );
  await db().insert(s.orderPayments).values({
    draftId,
    branchId: 1,
    kind: "APPLICATION",
    amount: appliedAmount,
    method: "CASH",
    parentPaymentId: collectionId,
    appliedKind: "WORKORDER",
    appliedId: workOrderId,
    createdBy: 2,
  });
  return workOrderId;
}

/** أمرُ شغلٍ بعربونٍ صفر وبلا أيّ حصّة — لا نقدَ يخرج إطلاقاً. */
async function orderWithNothing(): Promise<number> {
  return extractInsertId(
    await db()
      .insert(s.workOrders)
      .values({
        orderNumber: `WO-NADA-${randomUUID().slice(0, 6)}`,
        branchId: 1,
        customerId: 1,
        title: "أمر بلا مال",
        quantity: 1,
        materialsCost: "0.00",
        laborCost: "0.00",
        salePrice: "5000.00",
        status: "RECEIVED",
        deposit: "0.00",
        paymentMethod: "CASH",
        createdBy: 2,
      }),
  );
}

describe("تمهيدُ الإلغاء — الفجوةُ المسدودة: حصصٌ مطبَّقة على أمرٍ عمودُه صفر", () => {
  beforeEach(async () => {
    await reset();
    await seedBase();
  });

  it("⭐ deposit=0 + حصّةٌ نقديّة ٣٠٠٠ ⇒ needsCashDrawer=true و estimatedCashOut=3000", async () => {
    const shiftId = await openReceptionShiftWithCash("50000.00");
    const workOrderId = await orderWithAppliedCash("3000.00", shiftId);

    const res = await withTx((tx) =>
      workOrderRefundPreflight(tx, workOrderId, "CANCEL", { exposeCash: true }),
    );
    expect(res).not.toBeNull();
    // قبل سدّ الفجوة كان هذا false و«0.00» — والخدمةُ تصرف ٣٠٠٠ فتطلب درجاً ⇒ حائط.
    expect(res!.needsCashDrawer).toBe(true);
    expect(res!.estimatedCashOut).toBe("3000.00");
    expect(res!.drawers.length).toBeGreaterThan(0);
    // النقدُ المتاح يُحسَب حيّاً لا من عمود expectedCash الفارغ للوردية المفتوحة.
    expect(res!.drawers[0]!.expectedCash).toBe("53000.00");
    expect(res!.drawers[0]!.sufficient).toBe(true);
    // ⭐ البطاقةُ ممنوعةٌ: الحصّةُ نقديّةٌ تُردّ نقداً حتماً، فطلبُ CARD يستحيل اعتمادُه.
    expect(res!.cardRefundAllowed).toBe(false);
  });

  it("deposit=0 وبلا حصص ⇒ needsCashDrawer=false (لا نُطالب بدرجٍ لمالٍ لا يخرج)", async () => {
    await openReceptionShiftWithCash("50000.00");
    const workOrderId = await orderWithNothing();

    const res = await withTx((tx) =>
      workOrderRefundPreflight(tx, workOrderId, "CANCEL", { exposeCash: true }),
    );
    expect(res!.needsCashDrawer).toBe(false);
    expect(res!.estimatedCashOut).toBe("0.00");
    expect(res!.drawers).toEqual([]);
  });

  it("عربونٌ نقديٌّ مباشر بلا حصص ⇒ البطاقةُ مباحة (لا جزءَ نقديٍّ يمنعها)", async () => {
    const shiftId = await openReceptionShiftWithCash("50000.00");
    const workOrderId = extractInsertId(
      await db()
        .insert(s.workOrders)
        .values({
          orderNumber: `WO-DIRECT-${randomUUID().slice(0, 6)}`,
          branchId: 1,
          customerId: 1,
          title: "عربونٌ مباشر",
          quantity: 1,
          materialsCost: "0.00",
          laborCost: "0.00",
          salePrice: "5000.00",
          status: "RECEIVED",
          deposit: "2000.00",
          paymentMethod: "CASH",
          createdBy: 2,
        }),
    );
    await db().insert(s.receipts).values({
      branchId: 1,
      shiftId,
      workOrderId,
      direction: "IN",
      amount: "2000.00",
      paymentMethod: "CASH",
      cashBucket: "DRAWER",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      partyType: "CUSTOMER",
      partyId: 1,
      createdBy: 2,
    });
    const res = await withTx((tx) =>
      workOrderRefundPreflight(tx, workOrderId, "CANCEL", { exposeCash: true }),
    );
    expect(res!.needsCashDrawer).toBe(true);
    expect(res!.estimatedCashOut).toBe("2000.00");
    // البطاقةُ مباحةٌ: العربونُ المباشر يقبل الردَّ عليها (قرار المالك)، ولا حصصَ ولا أمانة.
    expect(res!.cardRefundAllowed).toBe(true);
  });

  it("الحجبُ عن الخزينة: exposeCash=false ⇒ رقمٌ محجوبٌ وعلَمُ كفايةٍ باقٍ", async () => {
    const shiftId = await openReceptionShiftWithCash("50000.00");
    const workOrderId = await orderWithAppliedCash("3000.00", shiftId);

    const res = await withTx((tx) =>
      workOrderRefundPreflight(tx, workOrderId, "CANCEL", {
        exposeCash: false,
      }),
    );
    expect(res!.needsCashDrawer).toBe(true);
    expect(res!.drawers[0]!.expectedCash).toBeUndefined();
    expect(res!.drawers[0]!.sufficient).toBe(true);
    expect(res!.treasuryCash).toBeNull();
  });
});
