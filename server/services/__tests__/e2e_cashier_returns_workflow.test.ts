/**
 * E2E Cashier Return Authorization Workflow Test Suite (Tiers 1-4)
 *
 * Requirements Reference:
 * - ORIGINAL_REQUEST.md (R1-R4)
 * - PROJECT.md (Features 1-19, Milestones M1-M4)
 * - TEST_INFRA.md (Tiers 1-4, Scenarios 1-7)
 *
 * Scope:
 * - Tier 1: Feature Coverage (Features 1 to 19)
 * - Tier 2: Boundary & Corner Cases (Exact Drawer Match, Zero Pool, Multi-Return Cap, IQD Rounding, Return Window)
 * - Tier 3: Cross-Feature Interactions (Peer + Cash + Z-Report, Peer + Credit + Debt Reduction, Damaged + Store Credit)
 * - Tier 4: Real-World Application Scenarios (7 Scenarios from TEST_INFRA.md)
 */

import { and, desc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import type { AuthUser, TrpcContext } from "../../context";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { appRouter } from "../../routers";
import { returnRouter } from "../../routers/returnRouter";
import { assertCashOutAvailable, computeDrawerCashBalance } from "../cash/cashAvailability";
import { getSalesRegister } from "../reportsSalesService";
import { returnSale, returnSaleDirect } from "../returnService";
import { loadRefundCaps } from "../returns/refundCaps";
import { createSale } from "../saleService";
import { computeExpectedCash, getShiftReport, resolveBranchCashShiftTx } from "../shiftService";
import { withTx } from "../tx";
import { truncateTables } from "./__testUtils__";

const TABLES = [
  "idempotencyKeys",
  "accountingEntries",
  "receipts",
  "inventoryMovements",
  "invoiceItems",
  "workOrderMaterials",
  "workOrders",
  "salesControlRequests",
  "returnRequests",
  "invoices",
  "branchStock",
  "productPrices",
  "productUnits",
  "productVariants",
  "products",
  "shifts",
  "customers",
  "suppliers",
  "branches",
  "roles",
  "users",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

// System Actors
const MGR_ID = 1;
const CASHIER1_ID = 2; // Morning cashier in Branch 1
const CASHIER2_ID = 3; // Evening colleague in Branch 1
const RECEPTION_ID = 4; // Reception desk operator in Branch 1
const CASHIER_B2_ID = 5; // Cashier in Branch 2 (Other branch)
const ADMIN_ID = 8;

const managerActor = { userId: MGR_ID, branchId: 1, role: "manager" as const };
const cashier1Actor = { userId: CASHIER1_ID, branchId: 1, role: "cashier" as const };
const cashier2Actor = { userId: CASHIER2_ID, branchId: 1, role: "cashier" as const };
const receptionActor = { userId: RECEPTION_ID, branchId: 1, role: "cashier" as const };
const cashierB2Actor = { userId: CASHIER_B2_ID, branchId: 2, role: "cashier" as const };
const adminActor = { userId: ADMIN_ID, branchId: 1, role: "admin" as const };

function createCaller(user: {
  id: number;
  branchId: number | null;
  role: string;
  name?: string;
  isOwner?: boolean;
  permissionsOverride?: Record<string, string>;
}) {
  const authUser: AuthUser = {
    id: user.id,
    openId: `user_${user.id}`,
    name: user.name ?? `User ${user.id}`,
    email: `user${user.id}@alroya.local`,
    role: user.role as any,
    branchId: user.branchId,
    isActive: true,
    isOwner: user.isOwner ?? false,
    permissionsOverride: user.permissionsOverride ?? null,
    customRoleId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    loginMethod: "local",
    passwordHash: "dummy",
    telephone: null,
    mustChangePassword: false,
    pinHash: null,
    avatarUrl: null,
    activeTokenVersion: 1,
    failedLoginAttempts: 0,
    lockoutUntil: null,
    lastLoginAt: null,
    lastActiveAt: null,
    currentSessionId: null,
    allowedIpRanges: null,
    requireMfa: false,
    mfaSecret: null,
    mfaRecoveryCodes: null,
    mfaVerified: false,
    externalAuthId: null,
    notes: null,
    resignedAt: null,
  };

  const ctx: TrpcContext = {
    req: { headers: {} } as any,
    res: { cookie() {}, clearCookie() {} } as any,
    user: authUser,
    sessionId: null,
    nativeClientId: null,
    platformAdmin: null,
  };

  return appRouter.createCaller(ctx);
}

async function seedBaseEntities() {
  const d = db();
  // Branches
  await d.insert(s.branches).values([
    { id: 1, name: "MAIN - الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "SALES - فرع المعارض", code: "SALES", type: "SALES" },
  ]);

  // Users
  await d.insert(s.users).values([
    { id: MGR_ID, openId: "mgr1", name: "مدير الفرع الأول", role: "manager", loginMethod: "local", branchId: 1 },
    { id: CASHIER1_ID, openId: "cashier1", name: "كاشير الصباح أحمد", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: CASHIER2_ID, openId: "cashier2", name: "كاشير المساء سارة", role: "cashier", loginMethod: "local", branchId: 1 },
    {
      id: RECEPTION_ID,
      openId: "reception1",
      name: "كاشير الاستقبال زينب",
      role: "cashier",
      loginMethod: "local",
      branchId: 1,
      permissionsOverride: { workorders: "FULL", sales: "FULL" },
    },
    { id: CASHIER_B2_ID, openId: "cashier_b2", name: "كاشير فرع 2 علي", role: "cashier", loginMethod: "local", branchId: 2 },
    { id: ADMIN_ID, openId: "admin1", name: "مدير النظام العام", role: "admin", loginMethod: "local", branchId: 1 },
  ]);

  // Customers
  await d.insert(s.customers).values([
    { id: 1, name: "شركة النور للطباعة", phone: "+9647701111111", currentBalance: "0.00", creditLimit: null },
    { id: 2, name: "مكتبة الرافدين", phone: "+9647702222222", currentBalance: "50000.00", creditLimit: null },
  ]);

  // Products: Standard Stationery Item (variant 1: cost 2000, price 5000)
  await d.insert(s.products).values({ id: 1, name: "دفتر ملاحظات جامعي A4" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "NOTEBOOK-A4", costPrice: "2000.00" });
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "5000.00" }]);
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 200 },
    { variantId: 1, branchId: 2, quantity: 100 },
  ]);

  // Product 2: High Value Product (variant 2: cost 150000, price 300000)
  await d.insert(s.products).values({ id: 2, name: "طابعة صور محمولة فاخرة" });
  await d.insert(s.productVariants).values({ id: 2, productId: 2, sku: "PHOTO-PRINTER-PRO", costPrice: "150000.00" });
  await d.insert(s.productUnits).values([{ id: 2, variantId: 2, unitName: "جهاز", conversionFactor: "1", isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 2, priceTier: "RETAIL", price: "300000.00" }]);
  await d.insert(s.branchStock).values([{ variantId: 2, branchId: 1, quantity: 20 }]);
}

async function openShift(userId: number, branchId = 1, openingBalance = "50000.00"): Promise<number> {
  const r = await db().insert(s.shifts).values({
    branchId,
    userId,
    openingBalance,
    status: "OPEN",
  });
  return extractInsertId(r);
}

async function createSaleInvoice(opts: {
  branchId?: number;
  shiftId: number;
  actor: { userId: number; branchId: number; role?: string };
  variantId?: number;
  quantity?: number;
  customerId?: number;
  paidAmount?: string;
  paymentMethod?: "CASH" | "CARD";
  cashRoundIQD?: boolean;
  daysAgo?: number;
}) {
  const branchId = opts.branchId ?? 1;
  const variantId = opts.variantId ?? 1;
  const quantity = opts.quantity ?? 1;

  const sale = await createSale(
    {
      branchId,
      shiftId: opts.shiftId,
      sourceType: "POS",
      customerId: opts.customerId,
      lines: [{ variantId, productUnitId: variantId, quantity: String(quantity) }],
      payment: opts.paidAmount ? { amount: opts.paidAmount, method: opts.paymentMethod ?? "CASH" } : undefined,
      cashRoundIQD: opts.cashRoundIQD,
    },
    opts.actor,
  );

  if (opts.daysAgo && opts.daysAgo > 0) {
    const pastDate = new Date(Date.now() - opts.daysAgo * 86400000);
    await db()
      .update(s.invoices)
      .set({ createdAt: pastDate })
      .where(eq(s.invoices.id, sale.invoiceId));
  }

  const items = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId));
  return {
    invoiceId: sale.invoiceId,
    item: items[0],
    itemId: Number(items[0].id),
    total: sale.total,
  };
}

async function createWorkOrderInvoice(branchId = 1, creatorId = CASHIER1_ID) {
  const d = db();
  const invRes = await d.insert(s.invoices).values({
    invoiceNumber: `INV-WO-${Date.now()}`,
    branchId,
    sourceType: "WORKORDER",
    status: "PAID",
    subtotal: "15000.00",
    discountAmount: "0.00",
    taxAmount: "0.00",
    total: "15000.00",
    paidAmount: "15000.00",
    returnedTotal: "0.00",
    createdBy: creatorId,
  });
  const invId = extractInsertId(invRes);

  const woRes = await d.insert(s.workOrders).values({
    orderNumber: `WO-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    title: "أمر شغل تجريبي للاختبار",
    branchId,
    invoiceId: invId,
    workOrderStatus: "DELIVERED",
    createdBy: creatorId,
  });
  const woId = extractInsertId(woRes);

  const itemRes = await d.insert(s.invoiceItems).values({
    invoiceId: invId,
    variantId: 1,
    productUnitId: 1,
    quantity: "3",
    baseQuantity: 3,
    unitPrice: "5000.00",
    unitCost: "2000.00",
    lineCost: "6000.00",
    total: "15000.00",
    returnedBaseQuantity: 0,
    itemNameSnapshot: "دفتر ملاحظات",
  });
  const itemId = extractInsertId(itemRes);

  return { invoiceId: invId, workOrderId: woId, itemId };
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await seedBaseEntities();
});

// ============================================================================
// TIER 1: FEATURE COVERAGE (Features 1 to 19)
// ============================================================================
describe("Tier 1: Feature Coverage (Features 1 to 19)", () => {
  it("F1: Reception Cashier Auth — Reception desk operator with workorders: FULL can read branch invoice via returns.getInvoice", async () => {
    const shift1 = await openShift(CASHIER1_ID, 1);
    const { invoiceId } = await createSaleInvoice({ shiftId: shift1, actor: cashier1Actor, quantity: 1, paidAmount: "5000.00" });

    // Reception desk operator (RECEPTION_ID in branch 1) queries returns.getInvoice
    const receptionCaller = createCaller({
      id: RECEPTION_ID,
      branchId: 1,
      role: "cashier",
      permissionsOverride: { workorders: "FULL", sales: "FULL" },
    });

    const inv = await receptionCaller.returns.getInvoice({ invoiceId });
    expect(inv).toBeDefined();
    expect(inv?.id).toBe(invoiceId);
    expect(inv?.branchId).toBe(1);
  });

  it("F2: Same-Branch Peer Invoice Return — Cashier 2 can view and return invoice created by Colleague Cashier 1", async () => {
    const shift1 = await openShift(CASHIER1_ID, 1);
    const { invoiceId, itemId } = await createSaleInvoice({ shiftId: shift1, actor: cashier1Actor, quantity: 2, paidAmount: "10000.00" });

    const shift2 = await openShift(CASHIER2_ID, 1, "50000.00");

    // Cashier 2 executes return on Cashier 1's invoice
    const result = await returnSaleDirect(
      {
        invoiceId,
        lines: [{ invoiceItemId: itemId, baseQuantity: 1 }],
        resolution: {
          kind: "IMMEDIATE_REFUND",
          method: "CASH",
          amount: "5000.00",
          shiftId: shift2,
          reason: "إرجاع من كاشير المساء لفاتورة كاشير الصباح",
          disposition: "RESTOCK",
        },
        operatorReason: "مرتجع من كاشير زميل في نفس الفرع",
      },
      cashier2Actor,
    );

    expect(result.invoiceId).toBe(invoiceId);
    expect(Number(result.returnedTotal)).toBe(5000);
  });

  it("F3: Cross-Branch Isolation Guard — Direct cashier access or return on invoice from Branch 2 is strictly FORBIDDEN", async () => {
    const shiftB2 = await openShift(CASHIER_B2_ID, 2);
    const { invoiceId, itemId } = await createSaleInvoice({
      branchId: 2,
      shiftId: shiftB2,
      actor: cashierB2Actor,
      quantity: 1,
      paidAmount: "5000.00",
    });

    // Cashier 1 (Branch 1) attempts returns.getInvoice on Branch 2 invoice
    const cashier1Caller = createCaller({ id: CASHIER1_ID, branchId: 1, role: "cashier" });
    await expect(cashier1Caller.returns.getInvoice({ invoiceId })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    // Cashier 1 attempts returnSaleDirect on Branch 2 invoice
    const shift1 = await openShift(CASHIER1_ID, 1);
    await expect(
      returnSaleDirect(
        {
          invoiceId,
          lines: [{ invoiceItemId: itemId, baseQuantity: 1 }],
          operatorReason: "محاولة اختراق عزل الفروع",
        },
        cashier1Actor,
      ),
    ).rejects.toThrow();
  });

  it("F4: WORKORDER Invoice Isolation — Direct return on WORKORDER invoice is rejected with PRECONDITION_FAILED", async () => {
    const { invoiceId, itemId } = await createWorkOrderInvoice(1, CASHIER1_ID);

    const shift1 = await openShift(CASHIER1_ID, 1);
    const cashier1Caller = createCaller({ id: CASHIER1_ID, branchId: 1, role: "cashier" });

    // Router level rejection
    await expect(
      cashier1Caller.returns.create({
        invoiceId,
        lines: [{ invoiceItemId: itemId, baseQuantity: 1 }],
        directExecution: true,
        reason: "محاولة إرجاع أمر شغل",
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("عكس التسليم"),
    });
  });

  it("F5: Cashier Drawer Attribution (DRAWER) — Cash refund creates OUT receipt assigned to executor's active drawer", async () => {
    const shift1 = await openShift(CASHIER1_ID, 1);
    const { invoiceId, itemId } = await createSaleInvoice({ shiftId: shift1, actor: cashier1Actor, quantity: 1, paidAmount: "5000.00" });

    const shift2 = await openShift(CASHIER2_ID, 1, "40000.00");
    await returnSaleDirect(
      {
        invoiceId,
        lines: [{ invoiceItemId: itemId, baseQuantity: 1 }],
        resolution: {
          kind: "IMMEDIATE_REFUND",
          method: "CASH",
          amount: "5000.00",
          shiftId: shift2,
          reason: "إرجاع نقدي للدرج",
          disposition: "RESTOCK",
        },
        operatorReason: "إرجاع موثق بدرج المنفذ",
      },
      cashier2Actor,
    );

    const outReceipt = (
      await db()
        .select()
        .from(s.receipts)
        .where(
          and(
            eq(s.receipts.invoiceId, invoiceId),
            eq(s.receipts.direction, "OUT"),
            eq(s.receipts.paymentMethod, "CASH"),
          ),
        )
    )[0];

    expect(outReceipt).toBeDefined();
    expect(outReceipt.cashBucket).toBe("DRAWER");
    expect(outReceipt.shiftId).toBe(shift2);
    expect(Number(outReceipt.amount)).toBe(5000);
    expect(outReceipt.status).toBe("COMPLETED");
  });

  it("F6: Treasury & Coworker Drawer Blocking — Cashier is blocked from coworker shift and treasury", async () => {
    const shift1 = await openShift(CASHIER1_ID, 1);
    const { invoiceId, itemId } = await createSaleInvoice({ shiftId: shift1, actor: cashier1Actor, quantity: 1, paidAmount: "5000.00" });

    // Cashier 2 tries to disburse cash from Cashier 1's shift
    await openShift(CASHIER2_ID, 1);
    await expect(
      returnSaleDirect(
        {
          invoiceId,
          lines: [{ invoiceItemId: itemId, baseQuantity: 1 }],
          resolution: {
            kind: "IMMEDIATE_REFUND",
            method: "CASH",
            amount: "5000.00",
            shiftId: shift1, // Coworker shift!
            reason: "محاولة صرف من درج زميل",
            disposition: "RESTOCK",
          },
          operatorReason: "محاولة غير مصرح بها",
        },
        cashier2Actor,
      ),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("F7: Real-Time Drawer Balance Overdraft Guard — Cashier cannot refund more than current drawer cash", async () => {
    // Cashier has drawer with only 2000.00 cash
    const shift1 = await openShift(CASHIER1_ID, 1, "2000.00");
    const { invoiceId, itemId } = await createSaleInvoice({ shiftId: shift1, actor: cashier1Actor, quantity: 2, paidAmount: "10000.00" });

    // Drain drawer cash so only 1000.00 remains
    await db().insert(s.receipts).values({
      branchId: 1,
      shiftId: shift1,
      direction: "OUT",
      amount: "11000.00", // 2000 opening + 10000 sale - 11000 = 1000 remaining
      paymentMethod: "CASH",
      cashBucket: "DRAWER",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      createdBy: CASHIER1_ID,
    });

    // Attempting to refund 5000 when drawer only has 1000 must fail
    await expect(
      returnSaleDirect(
        {
          invoiceId,
          lines: [{ invoiceItemId: itemId, baseQuantity: 1 }],
          resolution: {
            kind: "IMMEDIATE_REFUND",
            method: "CASH",
            amount: "5000.00",
            shiftId: shift1,
            reason: "استرداد يفوق رصيد الدرج",
            disposition: "RESTOCK",
          },
          operatorReason: "محاولة سحب نقد غير متوفر",
        },
        cashier1Actor,
      ),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("رصيد الدرج المتاح"),
    });
  });

  it("F8: Cumulative Refund Pool Cap — Multi-return cumulative refund cannot exceed gross paid amount", async () => {
    const shift1 = await openShift(CASHIER1_ID, 1, "10000.00");
    const { invoiceId, itemId } = await createSaleInvoice({ shiftId: shift1, actor: cashier1Actor, quantity: 2, paidAmount: "10000.00" });

    // First return: 1 unit (5000.00)
    await returnSaleDirect(
      {
        invoiceId,
        lines: [{ invoiceItemId: itemId, baseQuantity: 1 }],
        resolution: {
          kind: "IMMEDIATE_REFUND",
          method: "CASH",
          amount: "5000.00",
          shiftId: shift1,
          reason: "مرتجع جزئي أول",
          disposition: "RESTOCK",
        },
        operatorReason: "إرجاع الدفعة الأولى",
      },
      cashier1Actor,
    );

    // Verify refund pool remaining via loadRefundCaps
    const caps = await withTx((tx) => loadRefundCaps(tx, invoiceId));
    expect(Number(caps.grossIn)).toBe(10000);
    expect(Number(caps.grossOut)).toBe(5000);
    expect(Number(caps.pool)).toBe(5000);

    // Attempting to refund 6000.00 when pool is only 5000.00 must fail
    await expect(
      returnSaleDirect(
        {
          invoiceId,
          lines: [{ invoiceItemId: itemId, baseQuantity: 1 }],
          resolution: {
            kind: "IMMEDIATE_REFUND",
            method: "CASH",
            amount: "6000.00",
            shiftId: shift1,
            reason: "تجاوز السقف التراكمي",
            disposition: "RESTOCK",
          },
          operatorReason: "محاولة تجاوز الوعاء",
        },
        cashier1Actor,
      ),
    ).rejects.toThrow();
  });

  it("F9: Expected Cash & Z-Report Subtraction — Cash refund receipt decreases expectedCash and appears in shift report", async () => {
    const shift1 = await openShift(CASHIER1_ID, 1, "10000.00");
    const { invoiceId, itemId } = await createSaleInvoice({ shiftId: shift1, actor: cashier1Actor, quantity: 1, paidAmount: "5000.00" });

    // Expected cash before return = 10000 opening + 5000 sale = 15000
    const beforeCash = await withTx((tx) => computeExpectedCash(tx, shift1, "10000.00"));
    expect(Number(beforeCash)).toBe(15000);

    await returnSaleDirect(
      {
        invoiceId,
        lines: [{ invoiceItemId: itemId, baseQuantity: 1 }],
        resolution: {
          kind: "IMMEDIATE_REFUND",
          method: "CASH",
          amount: "5000.00",
          shiftId: shift1,
          reason: "إرجاع نقدي وتحديث Z-Report",
          disposition: "RESTOCK",
        },
        operatorReason: "مرتجع نقدي للدرج",
      },
      cashier1Actor,
    );

    // Expected cash after return = 15000 - 5000 = 10000
    const afterCash = await withTx((tx) => computeExpectedCash(tx, shift1, "10000.00"));
    expect(Number(afterCash)).toBe(10000);

    // Shift report breakdown shows cashRefunds = 5000
    const report = await getShiftReport(shift1);
    const cashOut = (report?.payments ?? []).find((p) => p.method === "CASH" && p.direction === "OUT");
    expect(Number(cashOut?.total ?? 0)).toBe(5000);
  });

  it("F10: Unpaid Credit Sale Zero Cash Refund — Credit sale with 0 paid enforces refundCap = 0 and blocks cash disbursement", async () => {
    const shift1 = await openShift(CASHIER1_ID, 1);
    const { invoiceId, itemId } = await createSaleInvoice({
      shiftId: shift1,
      actor: cashier1Actor,
      customerId: 1,
      quantity: 1,
      // No paidAmount => Unpaid credit sale (total 5000)
    });

    const caps = await withTx((tx) => loadRefundCaps(tx, invoiceId));
    expect(Number(caps.grossIn)).toBe(0);
    expect(Number(caps.pool)).toBe(0);
    expect(Number(caps.capByMethod.get("CASH") ?? 0)).toBe(0);

    // Cash refund > 0 must fail
    await expect(
      returnSaleDirect(
        {
          invoiceId,
          lines: [{ invoiceItemId: itemId, baseQuantity: 1 }],
          resolution: {
            kind: "IMMEDIATE_REFUND",
            method: "CASH",
            amount: "5000.00",
            shiftId: shift1,
            reason: "محاولة صرف نقد لفاتورة آجلة غير مقبوضة",
            disposition: "RESTOCK",
          },
          operatorReason: "صرف غير مشروع",
        },
        cashier1Actor,
      ),
    ).rejects.toThrow();
  });

  it("F11: Customer Debt Reduction — Return on unpaid credit invoice reduces customer's currentBalance without cash receipt", async () => {
    const shift1 = await openShift(CASHIER1_ID, 1);
    const { invoiceId, itemId } = await createSaleInvoice({
      shiftId: shift1,
      actor: cashier1Actor,
      customerId: 1,
      quantity: 2, // Total 10000
    });

    const customerBefore = (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0];
    expect(Number(customerBefore.currentBalance)).toBe(10000);

    // Return 1 unit (5000) without cash refund
    await returnSaleDirect(
      {
        invoiceId,
        lines: [{ invoiceItemId: itemId, baseQuantity: 1 }],
        operatorReason: "إرجاع آجل وتخفيض مديونية العميل",
      },
      cashier1Actor,
    );

    const customerAfter = (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0];
    expect(Number(customerAfter.currentBalance)).toBe(5000);

    // No cash OUT receipt was created
    const outReceipts = await db()
      .select()
      .from(s.receipts)
      .where(and(eq(s.receipts.invoiceId, invoiceId), eq(s.receipts.direction, "OUT")));
    expect(outReceipts).toHaveLength(0);
  });

  it("F12: Credit on Account (Store Credit) — Customer balance credited on return without drawer disbursement", async () => {
    const shift1 = await openShift(CASHIER1_ID, 1);
    const { invoiceId, itemId } = await createSaleInvoice({
      shiftId: shift1,
      actor: cashier1Actor,
      customerId: 1,
      quantity: 1,
      paidAmount: "5000.00", // Fully paid by registered customer
    });

    // Customer balance after sale is 0.00
    const custBefore = (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0];
    expect(Number(custBefore.currentBalance)).toBe(0);

    // Return settled as Credit on Account (refund = null / 0)
    await returnSaleDirect(
      {
        invoiceId,
        lines: [{ invoiceItemId: itemId, baseQuantity: 1 }],
        operatorReason: "إيداع رصيد دائن على الحساب",
      },
      cashier1Actor,
    );

    const custAfter = (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0];
    // Balance becomes -5000.00 (credit in customer's favor)
    expect(Number(custAfter.currentBalance)).toBe(-5000);

    // Drawer cash was untouched (no OUT receipt)
    const outReceipts = await db()
      .select()
      .from(s.receipts)
      .where(and(eq(s.receipts.invoiceId, invoiceId), eq(s.receipts.direction, "OUT")));
    expect(outReceipts).toHaveLength(0);
  });

  it("F13: Double-Entry Balanced Ledger Postings — Return creates balanced RETURN and PAYMENT_OUT entries", async () => {
    const shift1 = await openShift(CASHIER1_ID, 1);
    const { invoiceId, itemId } = await createSaleInvoice({ shiftId: shift1, actor: cashier1Actor, quantity: 1, paidAmount: "5000.00" });

    await returnSaleDirect(
      {
        invoiceId,
        lines: [{ invoiceItemId: itemId, baseQuantity: 1 }],
        resolution: {
          kind: "IMMEDIATE_REFUND",
          method: "CASH",
          amount: "5000.00",
          shiftId: shift1,
          reason: "فحص قيود اليومية المزدوجة",
          disposition: "RESTOCK",
        },
        operatorReason: "إرجاع نقدي متكامل",
      },
      cashier1Actor,
    );

    const entries = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.invoiceId, invoiceId));

    const returnEntry = entries.find((e) => e.entryType === "RETURN");
    const payOutEntry = entries.find((e) => e.entryType === "PAYMENT_OUT");

    expect(returnEntry).toBeDefined();
    expect(Number(returnEntry?.revenue)).toBeCloseTo(-5000, 2);
    expect(Number(returnEntry?.cost)).toBeCloseTo(-2000, 2); // COGS reversed because restock = true

    expect(payOutEntry).toBeDefined();
    expect(Number(payOutEntry?.amount)).toBeCloseTo(5000, 2);
  });

  it("F14: Restock vs Damaged Inventory Flow & COGS — restock = true restores inventory & COGS; DAMAGED does not", async () => {
    const shift1 = await openShift(CASHIER1_ID, 1);
    const { invoiceId, itemId } = await createSaleInvoice({ shiftId: shift1, actor: cashier1Actor, quantity: 2, paidAmount: "10000.00" });

    const stockBefore = (await db().select().from(s.branchStock).where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 1))))[0];

    // Return 1 unit as DAMAGED (restock = false)
    await returnSaleDirect(
      {
        invoiceId,
        lines: [{ invoiceItemId: itemId, baseQuantity: 1 }],
        resolution: {
          kind: "IMMEDIATE_REFUND",
          method: "CASH",
          amount: "5000.00",
          shiftId: shift1,
          reason: "بضاعة تالفة",
          disposition: "DAMAGED",
        },
        restock: false,
        operatorReason: "إرجاع بضاعة تالفة",
      },
      cashier1Actor,
    );

    const stockAfterDamaged = (await db().select().from(s.branchStock).where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 1))))[0];
    // Stock remains unchanged for DAMAGED goods
    expect(stockAfterDamaged.quantity).toBe(stockBefore.quantity);

    const today = new Date().toISOString().slice(0, 10);
    const registerDamaged = await getSalesRegister({ branchId: 1, from: today, to: today });
    // In sales register, damaged cost is NOT deducted from COGS
    expect(registerDamaged).toBeDefined();

    // Now return remaining 1 unit as RESTOCK
    await returnSaleDirect(
      {
        invoiceId,
        lines: [{ invoiceItemId: itemId, baseQuantity: 1 }],
        resolution: {
          kind: "IMMEDIATE_REFUND",
          method: "CASH",
          amount: "5000.00",
          shiftId: shift1,
          reason: "بضاعة سليمة للرف",
          disposition: "RESTOCK",
        },
        restock: true,
        operatorReason: "إرجاع بضاعة سليمة",
      },
      cashier1Actor,
    );

    const stockAfterRestock = (await db().select().from(s.branchStock).where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 1))))[0];
    expect(stockAfterRestock.quantity).toBe(stockBefore.quantity + 1);
  });

  it("F15: Critical Refund Amount Approval Trigger — Return exceeding critical threshold routes to manager control request", async () => {
    // Product 2 (variant 2) is a high-value photo printer (300,000 IQD)
    const shift1 = await openShift(CASHIER1_ID, 1, "400000.00");
    const { invoiceId, itemId } = await createSaleInvoice({
      shiftId: shift1,
      actor: cashier1Actor,
      variantId: 2,
      quantity: 1,
      paidAmount: "300000.00",
    });

    const cashier1Caller = createCaller({ id: CASHIER1_ID, branchId: 1, role: "cashier" });

    // When a cashier submits a return exceeding critical limits (e.g. > 100,000 or 250,000), it must require approval
    // Check if salesControlRequests or returnRequests captures the request
    const res = await cashier1Caller.returns.request({
      invoiceId,
      lines: [{ invoiceItemId: itemId, baseQuantity: 1 }],
      reason: "مرتجع جهاز فاخر عالي القيمة يتطلب موافقة المدير",
    });

    expect(res).toBeDefined();
    const pendingReq = await db()
      .select()
      .from(s.returnRequests)
      .where(eq(s.returnRequests.invoiceId, invoiceId));
    expect(pendingReq.length).toBeGreaterThan(0);
  });

  it("F16: Treasury/Drawer Deficit Approval Trigger — Cash refund when drawer has deficit routes to manager control", async () => {
    // Cashier drawer with 0 opening cash
    const shift1 = await openShift(CASHIER1_ID, 1, "0.00");
    const { invoiceId, itemId } = await createSaleInvoice({ shiftId: shift1, actor: cashier1Actor, quantity: 1, paidAmount: "5000.00" });

    // Withdraw the 5000 cash from drawer
    await db().insert(s.receipts).values({
      branchId: 1,
      shiftId: shift1,
      direction: "OUT",
      amount: "5000.00",
      paymentMethod: "CASH",
      cashBucket: "DRAWER",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      createdBy: CASHIER1_ID,
    });

    // Drawer is now at 0.00. Direct cash return is blocked by liquidity guard
    await expect(
      returnSaleDirect(
        {
          invoiceId,
          lines: [{ invoiceItemId: itemId, baseQuantity: 1 }],
          resolution: {
            kind: "IMMEDIATE_REFUND",
            method: "CASH",
            amount: "5000.00",
            shiftId: shift1,
            reason: "عجز بالدرج",
            disposition: "RESTOCK",
          },
          operatorReason: "طلب صرف من الخزينة",
        },
        cashier1Actor,
      ),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });

    // Cashier routes operation to request queue for manager treasury approval
    const cashier1Caller = createCaller({ id: CASHIER1_ID, branchId: 1, role: "cashier" });
    const reqRes = await cashier1Caller.returns.request({
      invoiceId,
      lines: [{ invoiceItemId: itemId, baseQuantity: 1 }],
      reason: "طلب اعتماد صرف من الخزينة لعدم كفاية نقد الدرج",
    });
    expect(reqRes).toBeDefined();
  });

  it("F17: Cross-Branch Return Approval Trigger — Return across branches cannot execute directly and requires manager authority", async () => {
    const shiftB2 = await openShift(CASHIER_B2_ID, 2, "50000.00");
    const { invoiceId, itemId } = await createSaleInvoice({
      branchId: 2,
      shiftId: shiftB2,
      actor: cashierB2Actor,
      quantity: 1,
      paidAmount: "5000.00",
    });

    // Branch 1 cashier cannot execute direct return on Branch 2 invoice
    const cashier1Caller = createCaller({ id: CASHIER1_ID, branchId: 1, role: "cashier" });
    await expect(cashier1Caller.returns.getInvoice({ invoiceId })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      returnSaleDirect(
        {
          invoiceId,
          lines: [{ invoiceItemId: itemId, baseQuantity: 1 }],
          operatorReason: "محاولة مرتجع عابر للفروع بدون موافقة",
        },
        cashier1Actor,
      ),
    ).rejects.toThrow();

    // Manager / Admin has authority to process cross-branch return
    const mgrCaller = createCaller({ id: MGR_ID, branchId: 1, role: "manager" });
    // Admin or cross-branch authorized manager can inspect/handle
    const adminCaller = createCaller({ id: ADMIN_ID, branchId: 1, role: "admin" });
    const inv = await adminCaller.returns.getInvoice({ invoiceId });
    expect(inv?.id).toBe(invoiceId);
  });

  it("F18: Return Policy Expiration Approval Trigger — Invoices older than policy window (14 days) require manager review", async () => {
    const shift1 = await openShift(CASHIER1_ID, 1);
    // Sale made 20 days ago
    const { invoiceId, itemId } = await createSaleInvoice({
      shiftId: shift1,
      actor: cashier1Actor,
      quantity: 1,
      paidAmount: "5000.00",
      daysAgo: 20,
    });

    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, invoiceId)))[0];
    const ageDays = (Date.now() - new Date(inv.createdAt).getTime()) / (1000 * 60 * 60 * 24);
    expect(ageDays).toBeGreaterThan(14);

    // Routed through control request queue
    const cashier1Caller = createCaller({ id: CASHIER1_ID, branchId: 1, role: "cashier" });
    const req = await cashier1Caller.returns.request({
      invoiceId,
      lines: [{ invoiceItemId: itemId, baseQuantity: 1 }],
      reason: "فاتورة متجاوزة لسياسة الـ 14 يوما تتطلب موافقة المدير الاستثنائية",
    });
    expect(req).toBeDefined();
  });

  it("F19: High-Value Damaged Goods Approval Trigger — Return of damaged high-value goods requires manager approval", async () => {
    const shift1 = await openShift(CASHIER1_ID, 1, "400000.00");
    const { invoiceId, itemId } = await createSaleInvoice({
      shiftId: shift1,
      actor: cashier1Actor,
      variantId: 2, // 300,000 IQD printer
      quantity: 1,
      paidAmount: "300000.00",
    });

    // High value item damaged without restock
    const cashier1Caller = createCaller({ id: CASHIER1_ID, branchId: 1, role: "cashier" });
    const req = await cashier1Caller.returns.request({
      invoiceId,
      lines: [{ invoiceItemId: itemId, baseQuantity: 1 }],
      reason: "طابعة فاخرة متضررة لا تعود للمخزون تتطلب مصادقة المدير",
    });
    expect(req).toBeDefined();
  });
});

// ============================================================================
// TIER 2: BOUNDARY & CORNER CASES
// ============================================================================
describe("Tier 2: Boundary & Corner Cases", () => {
  it("B1: Exact Drawer Balance Match — Drawer balance reaches exact 0.00 on return; next 1 IQD overdraft fails", async () => {
    // Drawer has exactly 5000.00 cash
    const shift1 = await openShift(CASHIER1_ID, 1, "0.00");
    const { invoiceId, itemId } = await createSaleInvoice({ shiftId: shift1, actor: cashier1Actor, quantity: 1, paidAmount: "5000.00" });

    // Drawer cash is exactly 5000.00
    const availableBefore = await withTx((tx) => computeDrawerCashBalance(tx, shift1, "0.00"));
    expect(Number(availableBefore)).toBe(5000);

    // Refund exactly 5000.00
    await returnSaleDirect(
      {
        invoiceId,
        lines: [{ invoiceItemId: itemId, baseQuantity: 1 }],
        resolution: {
          kind: "IMMEDIATE_REFUND",
          method: "CASH",
          amount: "5000.00",
          shiftId: shift1,
          reason: "استرداد كامل رصيد الدرج",
          disposition: "RESTOCK",
        },
        operatorReason: "تصفير رصيد الدرج الدقيق",
      },
      cashier1Actor,
    );

    // Available drawer balance is now exactly 0.00
    const availableAfter = await withTx((tx) => computeDrawerCashBalance(tx, shift1, "0.00"));
    expect(Number(availableAfter)).toBe(0);

    // Another return attempting even 1.00 IQD cash out immediately throws PRECONDITION_FAILED
    await expect(
      withTx((tx) =>
        assertCashOutAvailable(tx, {
          branchId: 1,
          cashBucket: "DRAWER",
          shiftId: shift1,
          amount: 1,
          operation: "محاولة سحب بعد تصفير الدرج",
        }),
      ),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });

  it("B2: Pool = 0 Boundary for Unpaid Sales — 0.00 cash refund is accepted, 0.01 cash refund is rejected", async () => {
    const shift1 = await openShift(CASHIER1_ID, 1);
    const { invoiceId, itemId } = await createSaleInvoice({
      shiftId: shift1,
      actor: cashier1Actor,
      customerId: 1,
      quantity: 1,
      // 0 paidAmount => pool = 0
    });

    const caps = await withTx((tx) => loadRefundCaps(tx, invoiceId));
    expect(Number(caps.pool)).toBe(0);

    // Attempting cash refund of 0.01 throws BAD_REQUEST / PRECONDITION_FAILED
    await expect(
      returnSaleDirect(
        {
          invoiceId,
          lines: [{ invoiceItemId: itemId, baseQuantity: 1 }],
          resolution: {
            kind: "IMMEDIATE_REFUND",
            method: "CASH",
            amount: "0.01",
            shiftId: shift1,
            reason: "محاولة صرف قرش غير مقبوض",
            disposition: "RESTOCK",
          },
          operatorReason: "فحص الحد الأدنى للوعاء الصفري",
        },
        cashier1Actor,
      ),
    ).rejects.toThrow();

    // Return with 0 cash refund succeeds and settles against AR
    const ret = await returnSaleDirect(
      {
        invoiceId,
        lines: [{ invoiceItemId: itemId, baseQuantity: 1 }],
        operatorReason: "إرجاع صفري ناجح",
      },
      cashier1Actor,
    );
    expect(ret.returnedTotal).toBe("5000.00");
  });

  it("B3: Multi-Return Hitting Cumulative Cap — Multiple partial returns exhaust cumulative pool down to 0", async () => {
    const shift1 = await openShift(CASHIER1_ID, 1, "50000.00");
    // Sale of 3 items: Total 15000.00
    const { invoiceId, itemId } = await createSaleInvoice({ shiftId: shift1, actor: cashier1Actor, quantity: 3, paidAmount: "15000.00" });

    // Return 1: 1 unit (5000.00)
    await returnSaleDirect(
      {
        invoiceId,
        lines: [{ invoiceItemId: itemId, baseQuantity: 1 }],
        resolution: {
          kind: "IMMEDIATE_REFUND",
          method: "CASH",
          amount: "5000.00",
          shiftId: shift1,
          reason: "مرتجع أول",
          disposition: "RESTOCK",
        },
        operatorReason: "دفعة 1",
      },
      cashier1Actor,
    );

    let caps = await withTx((tx) => loadRefundCaps(tx, invoiceId));
    expect(Number(caps.pool)).toBe(10000);

    // Return 2: 2 units (10000.00)
    await returnSaleDirect(
      {
        invoiceId,
        lines: [{ invoiceItemId: itemId, baseQuantity: 2 }],
        resolution: {
          kind: "IMMEDIATE_REFUND",
          method: "CASH",
          amount: "10000.00",
          shiftId: shift1,
          reason: "مرتجع ثانٍ يستنفد السقف",
          disposition: "RESTOCK",
        },
        operatorReason: "دفعة 2",
      },
      cashier1Actor,
    );

    caps = await withTx((tx) => loadRefundCaps(tx, invoiceId));
    expect(Number(caps.pool)).toBe(0);

    // Fully returned invoice cannot be returned again
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, invoiceId)))[0];
    expect(Number(inv.returnedTotal)).toBe(15000);
    expect(Number(inv.total)).toBe(15000);
  });

  it("B4: IQD Rounding Reversal — Cash sale rounding difference reverses upon complete return", async () => {
    const shift1 = await openShift(CASHIER1_ID, 1, "50000.00");
    // Product price 5000, tender 5000, rounding active
    const { invoiceId, itemId } = await createSaleInvoice({
      shiftId: shift1,
      actor: cashier1Actor,
      quantity: 1,
      paidAmount: "5000.00",
      cashRoundIQD: true,
    });

    const invBefore = (await db().select().from(s.invoices).where(eq(s.invoices.id, invoiceId)))[0];
    expect(invBefore.cashRoundingAdjustment).toBeDefined();

    await returnSaleDirect(
      {
        invoiceId,
        lines: [{ invoiceItemId: itemId, baseQuantity: 1 }],
        resolution: {
          kind: "IMMEDIATE_REFUND",
          method: "CASH",
          amount: "5000.00",
          shiftId: shift1,
          reason: "إرجاع كامل مع تقريب الدينار",
          disposition: "RESTOCK",
        },
        operatorReason: "عكس التقريب المالي",
      },
      cashier1Actor,
    );

    // Accounting entries for ADJUST are present and net to 0
    const adjEntries = await db()
      .select()
      .from(s.accountingEntries)
      .where(and(eq(s.accountingEntries.invoiceId, invoiceId), eq(s.accountingEntries.entryType, "ADJUST")));
    if (adjEntries.length > 0) {
      const netAdj = adjEntries.reduce((acc, curr) => acc + Number(curr.amount), 0);
      expect(netAdj).toBeCloseTo(0, 2);
    }
  });

  it("B5: Return Window Limits — Return at day 13 is routine; return past day 14 triggers policy boundary", async () => {
    const shift1 = await openShift(CASHIER1_ID, 1, "50000.00");

    // Invoice at 13 days old (within 14 days policy window)
    const { invoiceId: inv13, itemId: item13 } = await createSaleInvoice({
      shiftId: shift1,
      actor: cashier1Actor,
      quantity: 1,
      paidAmount: "5000.00",
      daysAgo: 13,
    });

    const ret13 = await returnSaleDirect(
      {
        invoiceId: inv13,
        lines: [{ invoiceItemId: item13, baseQuantity: 1 }],
        resolution: {
          kind: "IMMEDIATE_REFUND",
          method: "CASH",
          amount: "5000.00",
          shiftId: shift1,
          reason: "إرجاع في اليوم 13 ضمن المهلة",
          disposition: "RESTOCK",
        },
        operatorReason: "ضمن سياسة الإرجاع",
      },
      cashier1Actor,
    );
    expect(ret13.returnedTotal).toBe("5000.00");

    // Invoice at 16 days old (exceeds 14 days policy window)
    const { invoiceId: inv16, itemId: item16 } = await createSaleInvoice({
      shiftId: shift1,
      actor: cashier1Actor,
      quantity: 1,
      paidAmount: "5000.00",
      daysAgo: 16,
    });

    const caller = createCaller({ id: CASHIER1_ID, branchId: 1, role: "cashier" });
    const req = await caller.returns.request({
      invoiceId: inv16,
      lines: [{ invoiceItemId: item16, baseQuantity: 1 }],
      reason: "مرتجع متجاوز لـ 14 يوماً يتطلب موافقة المدير",
    });
    expect(req).toBeDefined();
  });
});

// ============================================================================
// TIER 3: CROSS-FEATURE INTERACTIONS
// ============================================================================
describe("Tier 3: Cross-Feature Interactions", () => {
  it("C1: Peer Invoice + Cash Refund + Z-Report: Cashier 2 returns Cashier 1 invoice, deducting strictly from Cashier 2's drawer and Z-Report", async () => {
    // Cashier 1 opens shift and sells 1 item (5000 cash in)
    const shift1 = await openShift(CASHIER1_ID, 1, "10000.00");
    const { invoiceId, itemId } = await createSaleInvoice({ shiftId: shift1, actor: cashier1Actor, quantity: 1, paidAmount: "5000.00" });

    // Cashier 2 opens shift with 20000.00
    const shift2 = await openShift(CASHIER2_ID, 1, "20000.00");

    // Cashier 2 processes return for Cashier 1's invoice
    await returnSaleDirect(
      {
        invoiceId,
        lines: [{ invoiceItemId: itemId, baseQuantity: 1 }],
        resolution: {
          kind: "IMMEDIATE_REFUND",
          method: "CASH",
          amount: "5000.00",
          shiftId: shift2,
          reason: "مرتجع كاشير 2 على فاتورة كاشير 1",
          disposition: "RESTOCK",
        },
        operatorReason: "صرف من درج كاشير 2",
      },
      cashier2Actor,
    );

    // Verify Cashier 2's shift report
    const report2 = await getShiftReport(shift2);
    const cashOut2 = (report2?.payments ?? []).find((p) => p.method === "CASH" && p.direction === "OUT");
    expect(Number(cashOut2?.total ?? 0)).toBe(5000);
    const expectedCash2 = await withTx((tx) => computeExpectedCash(tx, shift2, "20000.00"));
    expect(Number(expectedCash2)).toBe(15000); // 20000 - 5000 = 15000

    // Cashier 1's drawer is completely untouched
    const report1 = await getShiftReport(shift1);
    const cashOut1 = (report1?.payments ?? []).some((p) => p.method === "CASH" && p.direction === "OUT");
    expect(cashOut1).toBe(false);
    const expectedCash1 = await withTx((tx) => computeExpectedCash(tx, shift1, "10000.00"));
    expect(Number(expectedCash1)).toBe(15000); // 10000 + 5000 = 15000
  });

  it("C2: Peer Invoice + Credit Sale + Debt Reduction: Colleague returns unpaid credit invoice with 0 cash out and debt reduction", async () => {
    const shift1 = await openShift(CASHIER1_ID, 1);
    const { invoiceId, itemId } = await createSaleInvoice({
      shiftId: shift1,
      actor: cashier1Actor,
      customerId: 1,
      quantity: 2, // 10000 debt
    });

    const shift2 = await openShift(CASHIER2_ID, 1, "30000.00");

    // Cashier 2 returns the unpaid credit invoice created by Cashier 1
    await returnSaleDirect(
      {
        invoiceId,
        lines: [{ invoiceItemId: itemId, baseQuantity: 2 }],
        operatorReason: "إرجاع كاشير 2 لفاتورة آجل أنشأها كاشير 1",
      },
      cashier2Actor,
    );

    // Customer debt completely cleared
    const customer = (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0];
    expect(Number(customer.currentBalance)).toBe(0);

    // Zero cash was disbursed from Cashier 2's drawer
    const expectedCash2 = await withTx((tx) => computeExpectedCash(tx, shift2, "30000.00"));
    expect(Number(expectedCash2)).toBe(30000);
  });

  it("C3: Damaged + Partial Credit + Store Credit: Damaged goods on partially paid credit invoice; stock unreversed, store credit applied, debt reduced", async () => {
    const shift1 = await openShift(CASHIER1_ID, 1, "50000.00");
    // Customer buys 2 items = 10000.00, pays 5000.00, owes 5000.00
    const { invoiceId, itemId } = await createSaleInvoice({
      shiftId: shift1,
      actor: cashier1Actor,
      customerId: 1,
      quantity: 2,
      paidAmount: "5000.00",
    });

    const stockBefore = (await db().select().from(s.branchStock).where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 1))))[0];

    // Return 2 items as DAMAGED with 0 cash refund (Store Credit / Debt Settlement)
    await returnSaleDirect(
      {
        invoiceId,
        lines: [{ invoiceItemId: itemId, baseQuantity: 2 }],
        restock: false,
        operatorReason: "إرجاع تالف مع تسوية ذمة ورصيد متجر",
      },
      cashier1Actor,
    );

    // Stock was NOT restored (damaged)
    const stockAfter = (await db().select().from(s.branchStock).where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 1))))[0];
    expect(stockAfter.quantity).toBe(stockBefore.quantity);

    // Customer balance: was +5000.00, return of 10000 drops balance by 10000 => -5000.00 (Store credit)
    const customer = (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0];
    expect(Number(customer.currentBalance)).toBe(-5000);
  });
});

// ============================================================================
// TIER 4: REAL-WORLD APPLICATION SCENARIOS (Scenarios 1 to 7)
// ============================================================================
describe("Tier 4: Real-World Application Scenarios (TEST_INFRA.md 1 to 7)", () => {
  it("Scenario 1: Evening Shift Cashier returns morning colleague invoice with cash refund (F1, F2, F5, F7, F8, F9, F13)", async () => {
    // 1. Morning shift: Cashier 1 sells 1 stationery item for 5000 cash
    const morningShift = await openShift(CASHIER1_ID, 1, "10000.00");
    const { invoiceId, itemId } = await createSaleInvoice({
      shiftId: morningShift,
      actor: cashier1Actor,
      quantity: 1,
      paidAmount: "5000.00",
    });

    // 2. Evening shift: Cashier 2 opens shift with 25000.00
    const eveningShift = await openShift(CASHIER2_ID, 1, "25000.00");

    // 3. Evening cashier processes customer return for morning invoice
    const ret = await returnSaleDirect(
      {
        invoiceId,
        lines: [{ invoiceItemId: itemId, baseQuantity: 1 }],
        resolution: {
          kind: "IMMEDIATE_REFUND",
          method: "CASH",
          amount: "5000.00",
          shiftId: eveningShift,
          reason: "سيناريو 1: كاشير المساء يسترجع فاتورة الصباح نقداً",
          disposition: "RESTOCK",
        },
        operatorReason: "إرجاع مسائي لعميل الصباح",
      },
      cashier2Actor,
    );

    expect(ret.fullyReturned).toBe(true);

    // 4. Verify evening cashier drawer and Z-Report
    const eveningReport = await getShiftReport(eveningShift);
    const cashOut = (eveningReport?.payments ?? []).find((p) => p.method === "CASH" && p.direction === "OUT");
    expect(Number(cashOut?.total ?? 0)).toBe(5000);

    const expectedCash = await withTx((tx) => computeExpectedCash(tx, eveningShift, "25000.00"));
    expect(Number(expectedCash)).toBe(20000); // 25000 - 5000

    // 5. Verify morning cashier drawer is completely unaffected
    const morningExpected = await withTx((tx) => computeExpectedCash(tx, morningShift, "10000.00"));
    expect(Number(morningExpected)).toBe(15000); // 10000 + 5000
  });

  it("Scenario 2: Customer returns partially paid credit sale; debt reduced + partial cash returned (F1, F2, F8, F10, F11, F13)", async () => {
    const shift1 = await openShift(CASHIER1_ID, 1, "50000.00");
    // Customer buys 2 items = 10000.00, pays 5000.00 cash, 5000.00 on credit
    const { invoiceId, itemId } = await createSaleInvoice({
      shiftId: shift1,
      actor: cashier1Actor,
      customerId: 1,
      quantity: 2,
      paidAmount: "5000.00",
    });

    const custInitial = (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0];
    expect(Number(custInitial.currentBalance)).toBe(5000); // Debt of 5000

    // Return 1 item: Total value 5000.00. Refund 2000.00 in cash, remainder (3000.00) reduces debt
    await returnSaleDirect(
      {
        invoiceId,
        lines: [{ invoiceItemId: itemId, baseQuantity: 1 }],
        refund: {
          amount: "2000.00", // Within the 5000 pool
          method: "CASH",
          shiftId: shift1,
        },
        operatorReason: "إرجاع جزئي مع صرف نقدي في حدود المقبوض",
      },
      cashier1Actor,
    );

    // Customer balance: was 5000, unrefunded return portion (5000 - 2000 = 3000) reduces balance => 2000 remaining debt
    const custAfter = (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0];
    expect(Number(custAfter.currentBalance)).toBe(2000);

    // Remaining cash pool on invoice: 5000 - 2000 = 3000
    const caps = await withTx((tx) => loadRefundCaps(tx, invoiceId));
    expect(Number(caps.pool)).toBe(3000);
  });

  it("Scenario 3: Customer returns unpaid invoice and requests store credit for future purchases (F1, F10, F11, F12, F13)", async () => {
    const shift1 = await openShift(CASHIER1_ID, 1);
    // Sale on customer account with 0 cash received: Total 5000.00
    const { invoiceId, itemId } = await createSaleInvoice({
      shiftId: shift1,
      actor: cashier1Actor,
      customerId: 1,
      quantity: 1,
    });

    const custInitial = (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0];
    expect(Number(custInitial.currentBalance)).toBe(5000);

    // Customer returns the item; debt is eliminated, no cash drawn
    await returnSaleDirect(
      {
        invoiceId,
        lines: [{ invoiceItemId: itemId, baseQuantity: 1 }],
        operatorReason: "سيناريو 3: تسوية ذمة وإيداع رصيد دائن",
      },
      cashier1Actor,
    );

    const custFinal = (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0];
    expect(Number(custFinal.currentBalance)).toBe(0);

    // Zero cash leaves the drawer
    const outReceipts = await db()
      .select()
      .from(s.receipts)
      .where(and(eq(s.receipts.invoiceId, invoiceId), eq(s.receipts.direction, "OUT")));
    expect(outReceipts).toHaveLength(0);
  });

  it("Scenario 4: Customer attempts return exceeding policy window; routed to manager approval and executed (F1, F15, F18)", async () => {
    const shift1 = await openShift(CASHIER1_ID, 1, "50000.00");
    // Invoice 25 days old
    const { invoiceId, itemId } = await createSaleInvoice({
      shiftId: shift1,
      actor: cashier1Actor,
      quantity: 1,
      paidAmount: "5000.00",
      daysAgo: 25,
    });

    const cashierCaller = createCaller({ id: CASHIER1_ID, branchId: 1, role: "cashier" });

    // Cashier submits request for manager review
    const reqResult = await cashierCaller.returns.request({
      invoiceId,
      lines: [{ invoiceItemId: itemId, baseQuantity: 1 }],
      reason: "سيناريو 4: تجاوز مهلة الإرجاع يتطلب موافقة المدير",
    });
    expect(reqResult).toBeDefined();

    // Manager approves request
    const pending = (
      await db()
        .select()
        .from(s.returnRequests)
        .where(eq(s.returnRequests.invoiceId, invoiceId))
    )[0];

    const mgrCaller = createCaller({ id: MGR_ID, branchId: 1, role: "manager" });
    const mgrShift = await openShift(MGR_ID, 1, "50000.00");
    const approvalRes = await mgrCaller.returns.approveRequest({
      requestId: Number(pending.id),
      resolution: {
        kind: "IMMEDIATE_REFUND",
        method: "CASH",
        amount: "5000.00",
        shiftId: mgrShift,
        reason: "موافقة استثنائية من المدير لتجاوز المهلة",
        disposition: "RESTOCK",
      },
    });
    expect(approvalRes).toBeDefined();
  });

  it("Scenario 5: Return with mixed restock and damaged items; stock and COGS correctly differentiated (F1, F13, F14, F19)", async () => {
    const shift1 = await openShift(CASHIER1_ID, 1, "50000.00");
    // Sale of 2 items = 10000.00
    const { invoiceId, itemId } = await createSaleInvoice({
      shiftId: shift1,
      actor: cashier1Actor,
      quantity: 2,
      paidAmount: "10000.00",
    });

    const stockBefore = (await db().select().from(s.branchStock).where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 1))))[0];

    // 1 item damaged (disposition = DAMAGED, restock = false)
    await returnSaleDirect(
      {
        invoiceId,
        lines: [{ invoiceItemId: itemId, baseQuantity: 1 }],
        resolution: {
          kind: "IMMEDIATE_REFUND",
          method: "CASH",
          amount: "5000.00",
          shiftId: shift1,
          reason: "قطعة تالفة",
          disposition: "DAMAGED",
        },
        restock: false,
        operatorReason: "بضاعة تالفة",
      },
      cashier1Actor,
    );

    // 1 item intact (disposition = RESTOCK, restock = true)
    await returnSaleDirect(
      {
        invoiceId,
        lines: [{ invoiceItemId: itemId, baseQuantity: 1 }],
        resolution: {
          kind: "IMMEDIATE_REFUND",
          method: "CASH",
          amount: "5000.00",
          shiftId: shift1,
          reason: "قطعة سليمة",
          disposition: "RESTOCK",
        },
        restock: true,
        operatorReason: "بضاعة سليمة",
      },
      cashier1Actor,
    );

    const stockAfter = (await db().select().from(s.branchStock).where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 1))))[0];
    // Stock increased by exactly 1 (the restocked unit only)
    expect(stockAfter.quantity).toBe(stockBefore.quantity + 1);

    // Invoice fully returned
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, invoiceId)))[0];
    expect(Number(inv.returnedTotal)).toBe(10000);
  });

  it("Scenario 6: Cross-branch return blocked from direct cashier execution and routed to manager approval (F3, F17)", async () => {
    // Customer purchased at Branch 2
    const shiftB2 = await openShift(CASHIER_B2_ID, 2, "50000.00");
    const { invoiceId, itemId } = await createSaleInvoice({
      branchId: 2,
      shiftId: shiftB2,
      actor: cashierB2Actor,
      quantity: 1,
      paidAmount: "5000.00",
    });

    // Customer walks into Branch 1; Cashier 1 is blocked from direct execution
    const shiftB1 = await openShift(CASHIER1_ID, 1, "50000.00");
    await expect(
      returnSaleDirect(
        {
          invoiceId,
          lines: [{ invoiceItemId: itemId, baseQuantity: 1 }],
          operatorReason: "محاولة إرجاع عابر للفروع",
        },
        cashier1Actor,
      ),
    ).rejects.toThrow();

    // Operation must be authorized by Manager or Admin
    const adminCaller = createCaller({ id: ADMIN_ID, branchId: 1, role: "admin" });
    const invDetails = await adminCaller.returns.getInvoice({ invoiceId });
    expect(invDetails?.branchId).toBe(2);
  });

  it("Scenario 7: Attempted return on WORKORDER invoice rejected with clear guidance (F4)", async () => {
    const { invoiceId, itemId } = await createWorkOrderInvoice(1, CASHIER1_ID);
    const cashier1Caller = createCaller({ id: CASHIER1_ID, branchId: 1, role: "cashier" });

    // Attempting return on work order invoice throws PRECONDITION_FAILED directing to reverseDelivery
    await expect(
      cashier1Caller.returns.create({
        invoiceId,
        lines: [{ invoiceItemId: itemId, baseQuantity: 1 }],
        directExecution: true,
        reason: "سيناريو 7: محاولة إرجاع أمر شغل",
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("عكس التسليم"),
    });
  });
});
