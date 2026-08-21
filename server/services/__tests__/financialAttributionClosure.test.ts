import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb, getPool } from "../../db";
import { postEntry } from "../ledgerService";
import { money } from "../money";
import { getSupplierStatement } from "../reports/apAging";
import { getCustomerStatement } from "../reports/arAging";
import { withTx } from "../tx";
import { userNameSnapshot } from "../userSnapshot";
import { listVouchers } from "../voucher/queries";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function seedPartiesAndActors() {
  await db().insert(s.branches).values({
    id: 1,
    name: "الفرع الرئيسي",
    code: "MAIN",
    type: "MAIN",
  });
  await db()
    .insert(s.users)
    .values([
      {
        id: 1,
        openId: "customer-actor",
        username: "customer_actor",
        name: "منفذ العميل الأصلي",
        role: "admin",
        loginMethod: "local",
        branchId: 1,
      },
      {
        id: 2,
        openId: "supplier-actor",
        username: "supplier_actor",
        name: "منفذ المورد الأصلي",
        role: "manager",
        loginMethod: "local",
        branchId: 1,
      },
      {
        id: 3,
        openId: "return-actor",
        username: "return_actor",
        name: "منفذ المرتجع الأصلي",
        role: "accountant",
        loginMethod: "local",
        branchId: 1,
      },
      {
        id: 4,
        openId: "username-only-actor",
        username: "username_only_actor",
        name: null,
        role: "cashier",
        loginMethod: "local",
        branchId: 1,
      },
    ]);
  await db().insert(s.customers).values({
    id: 1,
    name: "شركة العميل الرافدين",
    phone: "+9647700000001",
    customerType: "شركة",
    defaultPriceTier: "WHOLESALE",
    creditLimit: "5000.00",
    currentBalance: "100.00",
    notes: "ملاحظة عميل سرية",
    clientRequestId: "customer-secret-request",
    waConsent: "OPTED_IN",
  });
  await db().insert(s.suppliers).values({
    id: 1,
    name: "مورد دجلة المركزي",
    phone: "+9647700000002",
    city: "بغداد",
    paymentTerms: "30 يوم",
    currentBalance: "200.00",
    currentBalanceUsd: "25.00",
    notes: "ملاحظة مورد سرية",
    clientRequestId: "supplier-secret-request",
    waConsent: "OPTED_OUT",
    iban: "IQ00-SECRET-IBAN",
    agreementAttachmentUrl: "data:image/png;base64,SECRET",
  });
}

beforeEach(seedPartiesAndActors);

describe("الإسناد الجنائي في قائمة السندات", () => {
  it("يعيد أسماء الطرف والمنفذ ويبحث بهما باستعلام ثابت بلا صفوف مكررة", async () => {
    await db()
      .insert(s.receipts)
      .values([
        {
          id: 101,
          voucherNumber: "RV-1-20260821-00101",
          branchId: 1,
          direction: "IN",
          amount: "10.00",
          paymentMethod: "CASH",
          partyType: "CUSTOMER",
          partyId: 1,
          description: "قبض عميل",
          createdBy: 1,
        },
        {
          id: 102,
          voucherNumber: "PV-1-20260821-00102",
          branchId: 1,
          direction: "OUT",
          amount: "20.00",
          paymentMethod: "EXCHANGE",
          partyType: "SUPPLIER",
          partyId: 1,
          description: "دفع مورد",
          createdBy: 2,
        },
        {
          id: 103,
          voucherNumber: "RV-1-20260821-00103",
          branchId: 1,
          direction: "IN",
          amount: "30.00",
          paymentMethod: "TRANSFER",
          partyType: "OTHER",
          counterpartyName: "طرف حر موثق",
          description: "قبض آخر",
          createdBy: 3,
        },
      ]);
    await db()
      .insert(s.exchangeHouses)
      .values({ id: 1, name: "صيرفة الاختبار" });
    // receiptId ليس فريداً في المخطط؛ أي join خام إلى عمليتين يجب ألا يضاعف صف السند.
    await db()
      .insert(s.exchangeTransactions)
      .values([
        {
          txnNumber: "EX-TEST-001",
          exchangeHouseId: 1,
          branchId: 1,
          type: "SETTLE",
          receiptId: 102,
          createdBy: 2,
        },
        {
          txnNumber: "EX-TEST-002",
          exchangeHouseId: 1,
          branchId: 1,
          type: "SETTLE",
          receiptId: 102,
          createdBy: 2,
        },
      ]);

    const pool = getPool() as any;
    const originalQuery = pool.query;
    let queryCalls = 0;
    pool.query = function (...args: unknown[]) {
      queryCalls += 1;
      return originalQuery.apply(this, args);
    };
    let rows: Awaited<ReturnType<typeof listVouchers>>;
    try {
      rows = await listVouchers({ limit: 100 });
    } finally {
      pool.query = originalQuery;
    }

    expect(queryCalls).toBe(1);
    expect(rows.map((row) => Number(row.id)).sort()).toEqual([101, 102, 103]);
    expect(new Set(rows.map((row) => Number(row.id))).size).toBe(rows.length);
    expect(rows.find((row) => Number(row.id) === 101)).toMatchObject({
      partyName: "شركة العميل الرافدين",
      createdByName: "منفذ العميل الأصلي",
    });
    expect(rows.find((row) => Number(row.id) === 102)).toMatchObject({
      partyName: "مورد دجلة المركزي",
      createdByName: "منفذ المورد الأصلي",
    });
    expect(rows.find((row) => Number(row.id) === 103)).toMatchObject({
      partyName: "طرف حر موثق",
      createdByName: "منفذ المرتجع الأصلي",
    });

    expect(
      (await listVouchers({ q: "شركة العميل" })).map((row) => Number(row.id)),
    ).toEqual([101]);
    expect(
      (await listVouchers({ q: "مورد دجلة" })).map((row) => Number(row.id)),
    ).toEqual([102]);
    expect(
      (await listVouchers({ q: "منفذ المرتجع" })).map((row) => Number(row.id)),
    ).toEqual([103]);
  });
});

describe("القائمة البيضاء وإسناد حركات كشوف الأطراف", () => {
  it("يعيد حقول الطرف المصرح بها فقط مع منفذ الفواتير والدفعات وأوامر الشراء", async () => {
    await db().insert(s.invoices).values({
      id: 201,
      invoiceNumber: "INV-ATTR-201",
      sourceType: "POS",
      branchId: 1,
      customerId: 1,
      subtotal: "100.00",
      total: "100.00",
      paidAmount: "25.00",
      createdBy: 1,
    });
    await db().insert(s.receipts).values({
      id: 202,
      invoiceId: 201,
      branchId: 1,
      direction: "IN",
      amount: "25.00",
      paymentMethod: "TRANSFER",
      partyType: "CUSTOMER",
      partyId: 1,
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      createdBy: 2,
    });
    await db().insert(s.purchaseOrders).values({
      id: 301,
      poNumber: "PO-ATTR-301",
      supplierId: 1,
      branchId: 1,
      subtotal: "80.00",
      total: "80.00",
      paidAmount: "20.00",
      status: "CONFIRMED",
      createdBy: 2,
    });
    await db()
      .insert(s.accountingEntries)
      .values([
        {
          entryType: "PURCHASE",
          branchId: 1,
          purchaseOrderId: 301,
          supplierId: 1,
          amount: "80.00",
          entryDate: new Date("2026-08-20T00:00:00.000Z"),
        },
        {
          entryType: "PAYMENT_OUT",
          branchId: 1,
          purchaseOrderId: 301,
          supplierId: 1,
          amount: "20.00",
          entryDate: new Date("2026-08-21T00:00:00.000Z"),
          createdBy: 3,
          createdByNameSnapshot: "منفذ المرتجع الأصلي",
        },
      ]);

    const customer = await getCustomerStatement(1);
    const supplier = await getSupplierStatement(1);
    expect(customer).not.toBeNull();
    expect(supplier).not.toBeNull();

    expect(Object.keys(customer!.customer).sort()).toEqual([
      "creditLimit",
      "currentBalance",
      "customerType",
      "defaultPriceTier",
      "id",
      "name",
      "phone",
    ]);
    expect(customer!.customer).not.toHaveProperty("notes");
    expect(customer!.customer).not.toHaveProperty("clientRequestId");
    expect(customer!.customer).not.toHaveProperty("waConsent");
    expect(customer!.invoices[0]).toMatchObject({
      createdBy: 1,
      createdByName: "منفذ العميل الأصلي",
    });
    expect(customer!.payments[0]).toMatchObject({
      createdBy: 2,
      createdByName: "منفذ المورد الأصلي",
    });

    expect(Object.keys(supplier!.supplier).sort()).toEqual([
      "city",
      "currentBalance",
      "currentBalanceUsd",
      "id",
      "name",
      "paymentTerms",
      "phone",
    ]);
    expect(supplier!.supplier).not.toHaveProperty("notes");
    expect(supplier!.supplier).not.toHaveProperty("clientRequestId");
    expect(supplier!.supplier).not.toHaveProperty("waConsent");
    expect(supplier!.supplier).not.toHaveProperty("iban");
    expect(supplier!.supplier).not.toHaveProperty("agreementAttachmentUrl");
    expect(supplier!.purchaseOrders[0]).toMatchObject({
      createdBy: 2,
      createdByName: "منفذ المورد الأصلي",
    });
    expect(supplier!.payments[0]).toMatchObject({
      createdBy: 3,
      createdByName: "منفذ المرتجع الأصلي",
    });
  });
});

describe("لقطة منفذ قيد الدفتر", () => {
  it("يثبت actor id والاسم لـ PAYMENT_IN/PAYMENT_OUT/RETURN ويقرأ اللقطة بعد تغيير اسم المستخدم", async () => {
    await db().insert(s.invoices).values({
      id: 401,
      invoiceNumber: "INV-LEDGER-401",
      sourceType: "POS",
      branchId: 1,
      customerId: 1,
      subtotal: "100.00",
      total: "100.00",
      createdBy: 1,
    });
    await db().insert(s.receipts).values({
      id: 402,
      voucherNumber: "PV-1-20260821-00402",
      branchId: 1,
      direction: "OUT",
      amount: "15.00",
      paymentMethod: "TRANSFER",
      partyType: "SUPPLIER",
      partyId: 1,
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      createdBy: 1,
      approvedBy: 2,
    });

    await withTx(async (tx) => {
      expect(await userNameSnapshot(tx, 4)).toBe("username_only_actor");
      await postEntry(tx, {
        entryType: "PAYMENT_IN",
        branchId: 1,
        invoiceId: 401,
        customerId: 1,
        amount: money("25.00"),
        createdBy: 1,
      });
      // مسار الاعتماد يملك receipt.approvedBy ولا يمرر actor إلى postEntry حالياً.
      await postEntry(tx, {
        entryType: "PAYMENT_OUT",
        branchId: 1,
        receiptId: 402,
        supplierId: 1,
        amount: money("15.00"),
        createdByNameSnapshot: "لقطة يتيمة لا تخص المعتمد",
      });
      await postEntry(tx, {
        entryType: "RETURN",
        branchId: 1,
        invoiceId: 401,
        customerId: 1,
        amount: money("10.00").neg(),
        createdBy: 3,
      });
    });

    const persisted = await db()
      .select({
        entryType: s.accountingEntries.entryType,
        createdBy: s.accountingEntries.createdBy,
        createdByNameSnapshot: s.accountingEntries.createdByNameSnapshot,
      })
      .from(s.accountingEntries);
    expect(persisted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entryType: "PAYMENT_IN",
          createdBy: 1,
          createdByNameSnapshot: "منفذ العميل الأصلي",
        }),
        expect.objectContaining({
          entryType: "PAYMENT_OUT",
          createdBy: 2,
          createdByNameSnapshot: "منفذ المورد الأصلي",
        }),
        expect.objectContaining({
          entryType: "RETURN",
          createdBy: 3,
          createdByNameSnapshot: "منفذ المرتجع الأصلي",
        }),
      ]),
    );

    await db()
      .update(s.users)
      .set({ name: "اسم معدل لاحقاً" })
      .where(eq(s.users.id, 1));
    await db()
      .update(s.users)
      .set({ name: "اسم معدل لاحقاً" })
      .where(eq(s.users.id, 2));
    await db()
      .update(s.users)
      .set({ name: "اسم معدل لاحقاً" })
      .where(eq(s.users.id, 3));

    const customer = await getCustomerStatement(1);
    const supplier = await getSupplierStatement(1);
    expect(customer!.payments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          paymentMethod: "COD",
          createdBy: 1,
          createdByName: "منفذ العميل الأصلي",
        }),
        expect.objectContaining({
          paymentMethod: "RETURN",
          createdBy: 3,
          createdByName: "منفذ المرتجع الأصلي",
        }),
      ]),
    );
    expect(supplier!.payments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entryType: "PAYMENT_OUT",
          createdBy: 2,
          createdByName: "منفذ المورد الأصلي",
        }),
      ]),
    );
  });
});
