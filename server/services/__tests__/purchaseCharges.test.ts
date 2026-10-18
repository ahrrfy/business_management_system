import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  createPurchaseCharge,
  decidePurchaseChargeControl,
  requestPurchaseChargeControl,
} from "../purchase/purchaseCharges";
import { createPurchaseOrder } from "../purchaseService";
import { reconcileSupplierBalances } from "../reconcileService";
import { getAPAging, getSupplierStatement } from "../reports/apAging";
import { getPurchasesReport } from "../reportsPurchasesService";
import {
  isSupplierApLedgerEntrySql,
  supplierApEffectSql,
} from "../ledger/supplierApEffect";

const creator = { userId: 1, branchId: 1, role: "manager" as const };
const independentApprover = {
  userId: 2,
  branchId: 1,
  role: "manager" as const,
};

// يفحص هذا الملفّ فصل المهام تحت سياسة الاعتماد **القديمة** (OFF) — ثبّته صراحةً بدل
// افتراض بيئة التشغيل، مطابقةً لنمط ownerGate.test.ts (مراجعة Codex).
const ROLLOUT_FLAG = "ROLLOUT_OWNER_ONLY_APPROVAL";
let savedRolloutFlag: string | undefined;
beforeEach(() => {
  savedRolloutFlag = process.env[ROLLOUT_FLAG];
  delete process.env[ROLLOUT_FLAG];
});
afterEach(() => {
  if (savedRolloutFlag === undefined) delete process.env[ROLLOUT_FLAG];
  else process.env[ROLLOUT_FLAG] = savedRolloutFlag;
});

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function reset() {
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of [
    "purchaseChargeAllocations",
    "purchaseChargeControlRequests",
    "purchaseCharges",
    "accountingEntries",
    "receipts",
    "accounts",
    "idempotencyKeys",
    "purchaseOrderEvents",
    "purchaseOrderControlRequests",
    "purchaseOrderRequisitionAllocations",
    "purchaseOrderRevisionItems",
    "purchaseOrderRevisions",
    "purchaseRequisitionControlRequests",
    "purchaseRequisitionItems",
    "purchaseRequisitions",
    "purchaseControlSettings",
    "purchaseOrderItems",
    "purchaseOrders",
    "productUnits",
    "productVariants",
    "products",
    "suppliers",
    "branches",
    "users",
  ]) {
    await db().execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  }
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed() {
  await db()
    .insert(schema.branches)
    .values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await db()
    .insert(schema.users)
    .values([
      {
        id: 1,
        openId: "pcharge-creator",
        name: "المنشئ",
        role: "manager",
        loginMethod: "local",
        branchId: 1,
      },
      {
        id: 2,
        openId: "pcharge-independent",
        name: "المعتمد المستقل",
        role: "manager",
        loginMethod: "local",
        branchId: 1,
      },
    ]);
  await db()
    .insert(schema.suppliers)
    .values({ id: 1, name: "مورد الاختبار", currentBalance: "0" });
  await db().insert(schema.products).values({ id: 1, name: "ورق" });
  await db()
    .insert(schema.productVariants)
    .values({ id: 1, productId: 1, sku: "PAPER", costPrice: "0" });
  await db().insert(schema.productUnits).values({
    id: 1,
    variantId: 1,
    unitName: "قطعة",
    conversionFactor: "1",
    isBaseUnit: true,
  });
  await db().insert(schema.accounts).values({
    id: 1,
    code: "TEST-EXP-1",
    name: "مصروفات الشحن (اختبار)",
    type: "EXPENSE",
    isActive: true,
    systemRole: "OPERATING_EXPENSE",
  });
}

async function createDraft(key: string) {
  return createPurchaseOrder(
    {
      supplierId: 1,
      branchId: 1,
      clientRequestId: key,
      revisionReason: "إنشاء أمر شراء لاختبار مصروف الشراء",
      items: [
        { variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "100.00" },
      ],
    },
    creator,
  );
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("purchaseCharges — إنشاء وترحيل وعكس مصروف شراء", () => {
  async function seedSupplierDebt() {
    await db()
      .update(schema.suppliers)
      .set({ currentBalance: "1000.00", currentBalanceUsd: "3.00" })
      .where(eq(schema.suppliers.id, 1));
    await db().insert(schema.suppliers).values({
      id: 2,
      name: "ناقل مستقل",
      branchId: 1,
      currentBalance: "200.00",
      currentBalanceUsd: "2.00",
    });
    await db()
      .insert(schema.accountingEntries)
      .values([
        {
          entryType: "OPENING",
          entryDate: "2026-10-18",
          branchId: 1,
          supplierId: 1,
          amount: "1000.00",
          createdBy: 1,
        },
        {
          entryType: "OPENING",
          entryDate: "2026-10-18",
          branchId: 1,
          supplierId: 2,
          amount: "200.00",
          createdBy: 1,
        },
      ]);
  }

  async function expectSupplierDebt(
    supplierId: number,
    amount: string,
    usd: string,
    paid = "0.00",
  ) {
    const [supplier] = await db()
      .select()
      .from(schema.suppliers)
      .where(eq(schema.suppliers.id, supplierId));
    expect.soft(supplier.currentBalance).toBe(amount);
    expect.soft(supplier.currentBalanceUsd).toBe(usd);
    const statement = await getSupplierStatement(supplierId, { branchId: 1 });
    expect.soft(statement?.summary.currentBalance).toBe(amount);
    expect.soft(statement?.summary.totalPaid).toBe(paid);
    expect.soft(statement?.payments).toHaveLength(paid === "0.00" ? 0 : 1);
    const aging = await getAPAging({ branchId: 1 });
    expect
      .soft(aging.find((row) => row.supplierId === supplierId)?.currentBalance)
      .toBe(amount);
    expect.soft(await reconcileSupplierBalances()).toEqual([]);
    const report = await getPurchasesReport({
      from: "2026-01-01",
      to: "2099-12-31",
      branchId: 1,
    });
    expect
      .soft(
        report.rows.find((row) => row.supplierId === supplierId)?.paid ??
          "0.00",
      )
      .toBe(paid);
  }

  it.each([
    ["SHIPPING", 1],
    ["CUSTOMS", 1],
    ["FREIGHT", 1],
    ["SHIPPING", 2],
    ["CUSTOMS", 2],
    ["FREIGHT", 2],
  ] as const)(
    "isolates company %s from supplier AP on posting and reversal (recipient %s)",
    async (chargeType, payeeSupplierId) => {
      await seedSupplierDebt();
      const po = await createDraft(
        `ap-isolation-${chargeType}-${payeeSupplierId}`,
      );
      const charge = await createPurchaseCharge(
        {
          branchId: 1,
          clientRequestId: "ap-charge",
          expenseAccountId: 1,
          chargeType,
          settlement: "PAID",
          paymentMethod: "CARD",
          payeeSupplierId,
          amount: "50.00",
          expenseDate: "2026-10-18",
          evidenceType: "CARRIER_INVOICE",
          evidenceReference: "COMPANY-EXPENSE-PROOF",
          allocations: [
            { purchaseOrderId: po.purchaseOrderId, allocatedAmount: "50.00" },
          ],
        },
        creator,
      );
      const post = await requestPurchaseChargeControl(
        {
          purchaseChargeId: charge.purchaseChargeId,
          expectedChargeVersion: 1,
          requestKey: "ap-post",
          kind: "POST",
          evidenceReference: "COMPANY-EXPENSE-PROOF",
          reason: "إثبات مصروف الشركة خارج ذمة المورد",
        },
        creator,
      );
      await decidePurchaseChargeControl(
        {
          requestId: post.requestId,
          decisionKey: "ap-post-decision",
          action: "APPROVE",
          reviewReason: "مطابقة فاتورة الناقل",
        },
        independentApprover,
      );
      const [posted] = await db()
        .select()
        .from(schema.purchaseCharges)
        .where(eq(schema.purchaseCharges.id, charge.purchaseChargeId));
      const [entry] = await db()
        .select()
        .from(schema.accountingEntries)
        .where(eq(schema.accountingEntries.id, posted.postingEntryId!));
      const [receipt] = await db()
        .select()
        .from(schema.receipts)
        .where(eq(schema.receipts.id, posted.paymentReceiptId!));
      expect.soft(entry.supplierId).toBeNull();
      expect.soft(receipt.partyType).toBe("SUPPLIER");
      expect.soft(receipt.partyId).toBe(payeeSupplierId);
      await expectSupplierDebt(1, "1000.00", "3.00");
      await expectSupplierDebt(2, "200.00", "2.00");

      const reverse = await requestPurchaseChargeControl(
        {
          purchaseChargeId: charge.purchaseChargeId,
          expectedChargeVersion: posted.version,
          requestKey: "ap-reverse",
          kind: "REVERSE",
          evidenceReference: "ACTUAL-CARRIER-REFUND",
          reason: "استرداد فعلي لمصروف الشركة دون ذمة المورد",
        },
        creator,
      );
      await decidePurchaseChargeControl(
        {
          requestId: reverse.requestId,
          decisionKey: "ap-reverse-decision",
          action: "APPROVE",
          reviewReason: "تأكيد رجوع مبلغ الشركة",
        },
        independentApprover,
      );
      const [reversed] = await db()
        .select()
        .from(schema.purchaseCharges)
        .where(eq(schema.purchaseCharges.id, charge.purchaseChargeId));
      const [reversalEntry] = await db()
        .select()
        .from(schema.accountingEntries)
        .where(eq(schema.accountingEntries.id, reversed.reversalEntryId!));
      expect.soft(reversalEntry.supplierId).toBeNull();
      await expectSupplierDebt(1, "1000.00", "3.00");
      await expectSupplierDebt(2, "200.00", "2.00");
    },
  );

  it("excludes historical company-charge attribution without hiding real supplier payments", async () => {
    await seedSupplierDebt();
    await db().insert(schema.accountingEntries).values({
      entryType: "PAYMENT_OUT",
      entryDate: "2026-10-18",
      branchId: 1,
      supplierId: 1,
      amount: "50.00",
      createdBy: 1,
      dedupeKey: "PURCHASE_CHARGE_POST:91",
    });
    await expectSupplierDebt(1, "1000.00", "3.00");
    await db().insert(schema.accountingEntries).values({
      entryType: "PAYMENT_IN",
      entryDate: "2026-10-18",
      branchId: 1,
      supplierId: 1,
      amount: "50.00",
      createdBy: 1,
      dedupeKey: "PURCHASE_CHARGE_REVERSAL:91",
    });
    await expectSupplierDebt(1, "1000.00", "3.00");
    await db().insert(schema.accountingEntries).values({
      entryType: "PAYMENT_OUT",
      entryDate: "2026-10-18",
      branchId: 1,
      supplierId: 1,
      amount: "40.00",
      createdBy: 1,
      dedupeKey: null,
    });
    await db()
      .update(schema.suppliers)
      .set({ currentBalance: "960.00" })
      .where(eq(schema.suppliers.id, 1));
    await expectSupplierDebt(1, "960.00", "3.00", "40.00");
  });

  it("keeps AP classification exact without hiding unrelated supplier payments", async () => {
    const cases = [
      ["PAYMENT_OUT", "PURCHASE_CHARGE_POST:9", "0.00", 0],
      ["PAYMENT_IN", "PURCHASE_CHARGE_REVERSAL:9", "0.00", 0],
      ["PAYMENT_OUT", null, "-10.00", 1],
      ["PAYMENT_OUT", "purchase_charge_post:9", "-10.00", 1],
      ["PAYMENT_OUT", "PURCHASE_CHARGE_POST:09", "-10.00", 1],
      ["PAYMENT_OUT", "PURCHASE_CHARGE_POST:9:OTHER", "-10.00", 1],
      ["PAYMENT_IN", "PURCHASE_CHARGE_POST:9", "10.00", 1],
    ] as const;
    for (const [entryType, dedupeKey, expected, visible] of cases) {
      const cols = {
        entryType: sql`${entryType}`,
        dedupeKey: sql`${dedupeKey}`,
        amount: sql`10.00`,
        liabilityAccount: sql`NULL`,
      };
      const [result] = await db()
        .select({
          effect: sql<string>`CAST(${supplierApEffectSql(cols)} AS DECIMAL(15,2))`,
          visible: sql<number>`IF(${isSupplierApLedgerEntrySql(cols)},1,0)`,
        })
        .from(schema.branches)
        .limit(1);
      expect.soft(result.effect, `${entryType}/${dedupeKey}`).toBe(expected);
      expect
        .soft(Number(result.visible), `${entryType}/${dedupeKey}`)
        .toBe(visible);
    }
  });

  it("ينشئ مصروف الشراء بمسودة حين تُساوي التوزيعات المبلغ بالضبط، ويحفظ سطر التوزيع", async () => {
    const po = await createDraft("pcharge-po-1");
    const created = await createPurchaseCharge(
      {
        branchId: 1,
        clientRequestId: "pcharge-create-1",
        expenseAccountId: 1,
        chargeType: "SHIPPING",
        settlement: "PAID",
        paymentMethod: "CARD",
        amount: "50000.00",
        expenseDate: "2026-09-01",
        evidenceType: "CARRIER_INVOICE",
        evidenceReference: "CARRIER-INV-1001",
        allocations: [
          { purchaseOrderId: po.purchaseOrderId, allocatedAmount: "50000.00" },
        ],
      },
      creator,
    );
    expect(created).toMatchObject({ status: "DRAFT", idempotent: false });

    const allocations = await db()
      .select()
      .from(schema.purchaseChargeAllocations)
      .where(
        eq(
          schema.purchaseChargeAllocations.purchaseChargeId,
          created.purchaseChargeId,
        ),
      );
    expect(allocations).toHaveLength(1);
    expect(allocations[0].purchaseOrderId).toBe(po.purchaseOrderId);
    expect(allocations[0].allocatedAmount).toBe("50000.00");
  });

  it("يرفض إنشاء مصروف الشراء حين لا يساوي مجموع التوزيعات المبلغ، ولا يكتب أي صفّ", async () => {
    const po = await createDraft("pcharge-po-2");
    await expect(
      createPurchaseCharge(
        {
          branchId: 1,
          clientRequestId: "pcharge-create-2",
          expenseAccountId: 1,
          chargeType: "SHIPPING",
          settlement: "PAID",
          paymentMethod: "CARD",
          amount: "50000.00",
          expenseDate: "2026-09-01",
          evidenceType: "CARRIER_INVOICE",
          evidenceReference: "CARRIER-INV-1002",
          allocations: [
            {
              purchaseOrderId: po.purchaseOrderId,
              allocatedAmount: "49999.00",
            },
          ],
        },
        creator,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(await db().select().from(schema.purchaseCharges)).toHaveLength(0);
    expect(
      await db().select().from(schema.purchaseChargeAllocations),
    ).toHaveLength(0);
  });

  it("يفرض فصل المهام على قرار الترحيل ثم يرحّل المصروف ويعكسه بقيدين وإيصالين مستقلّين", async () => {
    const po = await createDraft("pcharge-po-3");
    const created = await createPurchaseCharge(
      {
        branchId: 1,
        clientRequestId: "pcharge-create-3",
        expenseAccountId: 1,
        chargeType: "SHIPPING",
        settlement: "PAID",
        paymentMethod: "CARD",
        amount: "75000.00",
        expenseDate: "2026-09-01",
        evidenceType: "CARRIER_INVOICE",
        evidenceReference: "CARRIER-INV-1003",
        allocations: [
          { purchaseOrderId: po.purchaseOrderId, allocatedAmount: "75000.00" },
        ],
      },
      creator,
    );
    const purchaseChargeId = created.purchaseChargeId;

    // طلب الترحيل — بلا أثرٍ ماديّ أو ماليّ بعد.
    const postRequest = await requestPurchaseChargeControl(
      {
        purchaseChargeId,
        expectedChargeVersion: 1,
        requestKey: "pcharge-post-request-3",
        kind: "POST",
        evidenceReference: "CARRIER-INV-1003",
        reason: "ترحيل مصروف شحن مؤكَّد بمستند الناقل",
      },
      creator,
    );
    expect(postRequest).toMatchObject({ status: "PENDING", idempotent: false });

    // فصل المهام: من طلب الترحيل لا يعتمده بنفسه.
    await expect(
      decidePurchaseChargeControl(
        {
          requestId: postRequest.requestId,
          decisionKey: "pcharge-post-self-decision",
          action: "APPROVE",
          reviewReason: "اعتماد ذاتي",
        },
        creator,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // معتمِد مستقل يرحّل المصروف فعلاً — قيد وإيصال حقيقيّان.
    const posted = await decidePurchaseChargeControl(
      {
        requestId: postRequest.requestId,
        decisionKey: "pcharge-post-independent-decision",
        action: "APPROVE",
        reviewReason: "راجعت مستند الناقل وطابقته بالمبلغ",
      },
      independentApprover,
    );
    expect(posted).toMatchObject({ status: "APPROVED", idempotent: false });

    const [chargeAfterPost] = await db()
      .select()
      .from(schema.purchaseCharges)
      .where(eq(schema.purchaseCharges.id, purchaseChargeId));
    expect(chargeAfterPost.status).toBe("POSTED");
    expect(chargeAfterPost.postingEntryId).not.toBeNull();
    expect(chargeAfterPost.paymentReceiptId).not.toBeNull();
    expect(Number(chargeAfterPost.version)).toBe(2);

    const [postEntryRow] = await db()
      .select()
      .from(schema.accountingEntries)
      .where(
        eq(
          schema.accountingEntries.dedupeKey,
          `PURCHASE_CHARGE_POST:${purchaseChargeId}`,
        ),
      );
    expect(postEntryRow).toBeTruthy();
    expect(postEntryRow.entryType).toBe("PAYMENT_OUT");
    expect(postEntryRow.amount).toBe("75000.00");

    const [postReceiptRow] = await db()
      .select()
      .from(schema.receipts)
      .where(eq(schema.receipts.id, Number(chargeAfterPost.paymentReceiptId)));
    expect(postReceiptRow.direction).toBe("OUT");
    expect(postReceiptRow.cashBucket).toBeNull();
    expect(postReceiptRow.paymentMethod).toBe("CARD");
    expect(postReceiptRow.amount).toBe("75000.00");

    // طلب العكس على المصروف المُرحَّل فعلاً.
    const reverseRequest = await requestPurchaseChargeControl(
      {
        purchaseChargeId,
        expectedChargeVersion: 2,
        requestKey: "pcharge-reverse-request-3",
        kind: "REVERSE",
        evidenceReference: "CARRIER-INV-1003-REV",
        reason: "المورّد ألغى رسوم الشحن بعد الترحيل",
      },
      creator,
    );
    expect(reverseRequest).toMatchObject({
      status: "PENDING",
      idempotent: false,
    });

    // معتمِد مستقل (غير طالب العكس) يعتمد العكس — قيد وإيصال مستقلّان.
    const reversed = await decidePurchaseChargeControl(
      {
        requestId: reverseRequest.requestId,
        decisionKey: "pcharge-reverse-independent-decision",
        action: "APPROVE",
        reviewReason: "تحقّقت من إلغاء رسوم الشحن مع الناقل",
      },
      independentApprover,
    );
    expect(reversed).toMatchObject({ status: "APPROVED", idempotent: false });

    const [chargeAfterReverse] = await db()
      .select()
      .from(schema.purchaseCharges)
      .where(eq(schema.purchaseCharges.id, purchaseChargeId));
    expect(chargeAfterReverse.status).toBe("REVERSED");
    expect(chargeAfterReverse.reversalEntryId).not.toBeNull();
    expect(chargeAfterReverse.reversedBy).toBe(independentApprover.userId);
    expect(chargeAfterReverse.reversedAt).not.toBeNull();
    expect(chargeAfterReverse.reversalReason).toBe(
      "المورّد ألغى رسوم الشحن بعد الترحيل",
    );

    const [reverseEntryRow] = await db()
      .select()
      .from(schema.accountingEntries)
      .where(
        eq(
          schema.accountingEntries.dedupeKey,
          `PURCHASE_CHARGE_REVERSAL:${purchaseChargeId}`,
        ),
      );
    expect(reverseEntryRow).toBeTruthy();
    expect(reverseEntryRow.entryType).toBe("PAYMENT_IN");
    expect(reverseEntryRow.amount).toBe("75000.00");

    const [reverseReceiptRow] = await db()
      .select()
      .from(schema.receipts)
      .where(
        eq(schema.receipts.id, Number(chargeAfterReverse.reversalReceiptId)),
      );
    expect(reverseReceiptRow.direction).toBe("IN");
    expect(reverseReceiptRow.cashBucket).toBeNull();
    expect(reverseReceiptRow.paymentMethod).toBe("CARD");
    expect(reverseReceiptRow.amount).toBe("75000.00");
  });
});
