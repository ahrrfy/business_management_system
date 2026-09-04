import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createPurchaseOrder } from "../purchaseService";
import {
  createPurchaseCharge,
  decidePurchaseChargeControl,
  requestPurchaseChargeControl,
} from "../purchase/purchaseCharges";
import type { Actor } from "../tx";

/**
 * مصروفُ الشراء (شحن/كمرك/…) خروجُ مالٍ حقيقيّ خلف بوّابة فصل مهامٍ
 * (decidePurchaseChargeControl) لم يستدعِها أيّ اختبارٍ قاعديّ قطّ — purchaseChargesS6.test.ts
 * وpurchaseChargePayableFailClosedP0.test.ts يفحصان دوالّ نقيّةً معزولة بلا معاملة ولا إيصال ولا
 * قيد. هذا الملفّ يسدّ الفجوة، ويثبت أيضاً أنّ تجاوز المالك (٣/٩، 3227ce5b) يعمل فعلياً على
 * جدول `purchaseChargeControlRequests` بعد إسقاط `chk_purchase_charge_control_maker_checker`
 * في الهجرة 0333 (PR #982) — قبلها كانت محاولة المالك اعتماد طلبه تسقط بخطأ DB خامّ
 * (ER_CHECK_CONSTRAINT_VIOLATED) رغم أنّ طبقة التطبيق تسمح له. راجع ذاكرة
 * [[owner-decision-no-second-approval-2026-09-03]].
 */

const maker = { userId: 7, branchId: 1, role: "purchasing" as const };
const reviewer = { userId: 8, branchId: 1, role: "accountant" as const };
const owner = { userId: 9, branchId: 1, role: "manager" as const };

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function reset() {
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of [
    "purchaseChargeAllocations",
    "purchaseCharges",
    "purchaseChargeControlRequests",
    "receipts",
    "accountingEntries",
    "purchaseOrderItems",
    "purchaseOrders",
    "productUnits",
    "productVariants",
    "products",
    "accounts",
    "suppliers",
    "branches",
    "users",
  ]) {
    await db().execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  }
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed() {
  await db().insert(schema.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await db()
    .insert(schema.users)
    .values([
      { id: 7, openId: "pc-gov-maker", name: "طالب", role: "purchasing", loginMethod: "local", branchId: 1 },
      { id: 8, openId: "pc-gov-reviewer", name: "مراجع", role: "accountant", loginMethod: "local", branchId: 1 },
      { id: 9, openId: "pc-gov-owner", name: "المالك", role: "manager", loginMethod: "local", branchId: 1, isOwner: true },
    ]);
  await db().insert(schema.suppliers).values({ id: 1, name: "مورد اختبار المصروف", currentBalance: "0" });
  await db().insert(schema.accounts).values({
    id: 1,
    code: "5901-PC-GOV",
    name: "مصروف شحن الاختبار",
    type: "EXPENSE",
    systemRole: "DELIVERY_EXPENSE",
    isActive: true,
  });
  await db().insert(schema.products).values({ id: 1, name: "صنفٌ لاختبار مصروف الشراء" });
  await db().insert(schema.productVariants).values({ id: 1, productId: 1, sku: "PC-GOV-1", costPrice: "0.00" });
  await db().insert(schema.productUnits).values({ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true });
}

beforeEach(async () => {
  await reset();
  await seed();
});

/** أمرُ شراءٍ بمسوَّدة — يكفي مصدرَ توزيعٍ لمصروف الشراء بلا حاجة لاعتماده أو استلامه. */
async function makePurchaseOrderId(): Promise<number> {
  const created = await createPurchaseOrder(
    {
      supplierId: 1,
      branchId: 1,
      status: "DRAFT",
      settlementType: "CREDIT",
      items: [{ variantId: 1, productUnitId: 1, quantity: "1", unitPrice: "5000.00" }],
    },
    maker,
  );
  return Number(created.purchaseOrderId);
}

/** ينشئ مصروف شراءٍ PAID/TRANSFER مسوَّدةً، ثم يطلب ترحيله بهويّة `requester`. */
async function createChargeAndRequestPost(requester: Actor) {
  const purchaseOrderId = await makePurchaseOrderId();
  const created = await createPurchaseCharge(
    {
      branchId: 1,
      clientRequestId: `pc-gov-charge:${randomUUID()}`,
      payeeSupplierId: 1,
      expenseAccountId: 1,
      chargeType: "SHIPPING",
      settlement: "PAID",
      paymentMethod: "TRANSFER",
      amount: "5000.00",
      expenseDate: "2026-01-01",
      externalReference: `TR-${randomUUID()}`,
      evidenceType: "BANK_ADVICE",
      evidenceReference: `ev-${randomUUID()}`,
      allocations: [{ purchaseOrderId, allocatedAmount: "5000.00" }],
    },
    requester,
  );
  const requested = await requestPurchaseChargeControl(
    {
      purchaseChargeId: created.purchaseChargeId,
      expectedChargeVersion: 1,
      requestKey: `pc-gov-request:${randomUUID()}`,
      kind: "POST",
      evidenceReference: `control-ev-${randomUUID()}`,
      reason: "ترحيل مصروف شحنٍ حقيقيّ",
    },
    requester,
  );
  return { purchaseChargeId: created.purchaseChargeId, requestId: requested.requestId };
}

describe("حوكمة مصروف الشراء — فصل المهام على قاعدةٍ حقيقية", () => {
  it("يرفض اعتماد طالب الترحيل لطلبه ذاته", async () => {
    const { requestId } = await createChargeAndRequestPost(maker);

    await expect(
      decidePurchaseChargeControl(
        { requestId, decisionKey: randomUUID(), action: "APPROVE", reviewReason: "محاولة اعتماد ذاتي" },
        maker,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(await db().select().from(schema.receipts)).toHaveLength(0);
    expect(
      await db().select().from(schema.accountingEntries).where(eq(schema.accountingEntries.entryType, "PAYMENT_OUT")),
    ).toHaveLength(0);
    const [charge] = await db().select().from(schema.purchaseCharges);
    expect(charge.status).toBe("DRAFT");
  });

  it("يعتمد مراجعٌ مستقلّ الطلب فيُرحَّل المصروف فعلياً بإيصالٍ وقيد", async () => {
    const { requestId, purchaseChargeId } = await createChargeAndRequestPost(maker);

    const decided = await decidePurchaseChargeControl(
      { requestId, decisionKey: randomUUID(), action: "APPROVE", reviewReason: "راجعت مستند الشحن واعتمدت الترحيل" },
      reviewer,
    );
    expect(decided.status).toBe("APPROVED");

    const [charge] = await db().select().from(schema.purchaseCharges).where(eq(schema.purchaseCharges.id, purchaseChargeId));
    expect(charge.status).toBe("POSTED");

    const receiptsRows = await db().select().from(schema.receipts);
    expect(receiptsRows).toHaveLength(1);
    expect(receiptsRows[0]).toMatchObject({ direction: "OUT", partyType: "SUPPLIER", partyId: 1 });

    const entries = await db().select().from(schema.accountingEntries).where(eq(schema.accountingEntries.entryType, "PAYMENT_OUT"));
    expect(entries).toHaveLength(1);
  });

  it("يعتمد المالكُ طلب ترحيلٍ أنشأه هو بنفسه فيُرحَّل المصروف فعلياً (لا خطأ DB خامّ بعد الهجرة 0333)", async () => {
    const { requestId, purchaseChargeId } = await createChargeAndRequestPost(owner);

    const decided = await decidePurchaseChargeControl(
      { requestId, decisionKey: randomUUID(), action: "APPROVE", reviewReason: "اعتماد ذاتي — قرار المالك ٣/٩/٢٦" },
      owner,
    );
    expect(decided.status).toBe("APPROVED");

    const [charge] = await db().select().from(schema.purchaseCharges).where(eq(schema.purchaseCharges.id, purchaseChargeId));
    expect(charge.status).toBe("POSTED");

    const receiptsRows = await db().select().from(schema.receipts);
    expect(receiptsRows).toHaveLength(1);
    expect(receiptsRows[0]).toMatchObject({ direction: "OUT", partyType: "SUPPLIER", partyId: 1 });

    const [request] = await db().select().from(schema.purchaseChargeControlRequests).where(eq(schema.purchaseChargeControlRequests.id, requestId));
    expect(request).toMatchObject({ status: "APPROVED", requestedBy: owner.userId, reviewedBy: owner.userId });
  });
});
