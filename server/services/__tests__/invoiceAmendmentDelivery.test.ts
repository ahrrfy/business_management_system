import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createSale } from "../sale/create";
import { correctSale } from "../sale/correct";
import { cancelSale } from "../sale/cancel";
import { recordStaffDeliveryConfirmation } from "../delivery/companyStatement";
import { getDeliveryFinancialSummary } from "../delivery/lifecycle";
import { recordDeliveryRemittance } from "../delivery/remittance";
import { openShift } from "../shiftService";
import { money } from "../money";
import { withTx } from "../tx";
import { postEntry } from "../ledgerService";
import { createPostingIntent, debitLine, creditLine } from "../accounting/postingEngine";
import { extractInsertId } from "../../lib/insertId";
import { loadRefundCaps } from "../returns/refundCaps";
import { saleRouter } from "../../routers/saleRouter";
import { returnRouter } from "../../routers/returnRouter";
import { router } from "../../trpc";
import { resolveCustomRole, type AuthUser, type TrpcContext } from "../../context";
import { SECTION_CASHIER_ROLES } from "@shared/permissions";
import { buildDefaultRoleOperationPolicy } from "@shared/roleOperationPresets";

const actor = { userId: 1, branchId: 1, role: "admin" as const };
const db = () => getDb()!;
const line = (quantity: string) => ({
  variantId: 1,
  productUnitId: 1,
  quantity,
});
const invoice = async (id: number) =>
  (await db().select().from(s.invoices).where(eq(s.invoices.id, id)))[0];
const consignment = async (id: number) =>
  (
    await db()
      .select()
      .from(s.deliveryConsignments)
      .where(eq(s.deliveryConsignments.id, id))
  )[0];
const customer = async () =>
  (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0];
const party = async () =>
  (
    await db()
      .select()
      .from(s.deliveryParties)
      .where(eq(s.deliveryParties.id, 1))
  )[0];

beforeEach(async () => {
  await db()
    .insert(s.branches)
    .values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values({
    id: 1,
    openId: "amendment-admin",
    name: "مدير",
    role: "admin",
    branchId: 1,
  });
  await db()
    .insert(s.customers)
    .values({ id: 1, name: "عميل", currentBalance: "0", creditLimit: "0" });
  await db().insert(s.deliveryParties).values({
    id: 1,
    name: "شركة",
    partyType: "COMPANY",
    branchId: 1,
    currentBalance: "0",
    defaultFee: "0",
  });
  await db().insert(s.products).values({ id: 1, name: "دفتر" });
  await db()
    .insert(s.productVariants)
    .values({ id: 1, productId: 1, sku: "AMEND-1", costPrice: "500" });
  await db().insert(s.productUnits).values({
    id: 1,
    variantId: 1,
    unitName: "قطعة",
    conversionFactor: 1,
    isBaseUnit: true,
  });
  await db()
    .insert(s.productPrices)
    .values({ productUnitId: 1, priceTier: "RETAIL", price: "1000" });
  await db()
    .insert(s.branchStock)
    .values({ variantId: 1, branchId: 1, quantity: 100 });
  await openShift(
    { branchId: 1, openingBalance: "0", shiftType: "RECEPTION" },
    actor,
  );
});

async function sale(customerId: number | null = 1) {
  return createSale(
    {
      branchId: 1,
      sourceType: "POS",
      customerId,
      lines: [line("10")],
      delivery: {
        partyId: 1,
        fee: "0",
        feeCollection: "COURIER",
        recipientPhone: "07701234567",
        externalTrackingRef: "AMEND-TRACK-1",
      },
      clientRequestId: "amend-sale",
    },
    actor,
  );
}
async function delivered(id: number) {
  await recordStaffDeliveryConfirmation(
    {
      consignmentId: id,
      collectedAmount: "10000",
      evidence: "اتصال الشركة",
      clientRequestId: "amend-delivered",
    },
    actor,
  );
}
const correct = (id: number, qty: string, key = "amend-correct") =>
  correctSale(
    { originalInvoiceId: id, lines: [line(qty)], clientRequestId: key },
    actor,
  );
const remit = (consignmentId: number, amount: string) =>
  recordDeliveryRemittance(
    {
      branchId: 1,
      partyId: 1,
      lines: [{ consignmentId, collectedAmount: amount }],
      countedCash: amount,
      shiftType: "RECEPTION",
      clientRequestId: `amend-remit-${amount}`,
    },
    actor,
  );

describe("atomic invoice amendment with courier custody", () => {
  describe("paid cashier lifecycle across creators and closed source shifts", () => {
    const scenarios = [
      ...SECTION_CASHIER_ROLES.flatMap(profile => ["4000", "10000"].flatMap(paid =>
        (["RETURN", "CANCEL", "EDIT"] as const).map(action => ({ profile, paid, action })))),
      ...(["CAP", "FUNDS", "NO_DRAWER"] as const).map(action => ({ profile: SECTION_CASHIER_ROLES[0], paid: "10000", action })),
      ...(["PRINT_NO_CHANNEL_CREDIT", "PRINT_NO_CHANNEL_EQUAL"] as const).map(action => ({ profile: SECTION_CASHIER_ROLES[1], paid: "10000", action })),
      ...(["CREDIT_CAP_FULL", "CREDIT_ALLOWED", "MULTI_CANCEL"] as const).map(action => ({ profile: SECTION_CASHIER_ROLES[2], paid: "10000", action })),
      ...(["CREDIT_CAP_PARTIAL", "CREDIT_REDUCE"] as const).map(action => ({ profile: SECTION_CASHIER_ROLES[2], paid: "4000", action })),
    ];
    it.each(scenarios)("$profile.key $action with proved paid $paid", async ({ profile, paid, action }) => {
      await db().update(s.customers).set({ creditLimit: "100000.00" }).where(eq(s.customers.id, 1));
      const [sourceShift] = await db().select().from(s.shifts);
      const missingPrintChannel = action === "PRINT_NO_CHANNEL_CREDIT" || action === "PRINT_NO_CHANNEL_EQUAL";
      const sourceChannel = missingPrintChannel ? "PRINT_SERVICES" as const : profile.station;
      await db().update(s.shifts).set({ shiftType: sourceChannel, openGuard: `1:1:${sourceChannel}` }).where(eq(s.shifts.id, sourceShift.id));
      const original = await createSale({ branchId: 1, shiftId: sourceShift.id, sourceType: "POS", customerId: 1,
        lines: [line("10")], payment: { amount: paid, method: "CASH" } }, actor);
      await db().update(s.shifts).set({ status: "CLOSED", closedAt: new Date(), openGuard: null }).where(eq(s.shifts.id, sourceShift.id));
      const [closedSource] = await db().select().from(s.shifts).where(eq(s.shifts.id, sourceShift.id));
      const originalReceipts = await db().select().from(s.receipts);
      const policy = buildDefaultRoleOperationPolicy(profile.key, profile.baseRole, profile.permissions);
      for (const path of ["sales.get", "sales.lookupForCorrection", "sales.reissue", "sales.cancel"]) {
        policy.grants[`operation.${path}`] = true;
        if (path !== "sales.cancel") policy.recordScopes = { ...policy.recordScopes, [`operation.${path}`]: "BRANCH" };
      }
      await db().insert(s.roles).values({ id: 10, key: profile.key, label: profile.label, baseRole: profile.baseRole,
        permissions: profile.permissions, operationPolicy: policy, operationalCaps: { maxRefundAmountIqd: "25000.00" } });
      await db().insert(s.users).values({ id: 2, openId: "paid-peer", name: "كاشير لاحق", role: profile.baseRole,
        branchId: 1, customRoleId: 10 });
      const [raw] = await db().select().from(s.users).where(eq(s.users.id, 2));
      const user = raw as AuthUser;
      await resolveCustomRole(user);
      const currentChannel = missingPrintChannel ? "RETAIL" as const : sourceChannel;
      const current = { id: extractInsertId(await db().insert(s.shifts).values({ userId: 2, branchId: 1,
        openingBalance: "20000", status: "OPEN", shiftType: currentChannel, openGuard: `2:1:${currentChannel}` })) };
      if (action === "MULTI_CANCEL") await db().insert(s.shifts).values({ userId: 2, branchId: 1,
        openingBalance: "20000", status: "OPEN", shiftType: "RETAIL", openGuard: "2:1:RETAIL" });
      const api = router({ sales: saleRouter, returns: returnRouter }).createCaller({ user,
        req: { headers: {} }, res: {}, sessionId: null, nativeClientId: null, platformAdmin: null } as unknown as TrpcContext);
      const needsReview = action === "CAP" || action === "FUNDS" || action === "NO_DRAWER" || missingPrintChannel || action === "CREDIT_CAP_FULL" || action === "CREDIT_CAP_PARTIAL";
      const targetQuantity = action.startsWith("CREDIT_CAP") || action === "CREDIT_ALLOWED" ? 12 : action === "CREDIT_REDUCE" ? 8 : action === "PRINT_NO_CHANNEL_EQUAL" ? 10 : 2;
      const targetTotal = money(targetQuantity).times(1000);
      const isCancel = action === "CANCEL" || action === "MULTI_CANCEL";
      if (action === "CAP") await db().update(s.roles).set({ operationalCaps: { maxRefundAmountIqd: "1000.00" } }).where(eq(s.roles.id, 10));
      if (action === "FUNDS") await db().update(s.shifts).set({ openingBalance: "100.00" }).where(eq(s.shifts.id, current.id));
      if (action === "NO_DRAWER") await db().update(s.shifts).set({ status: "CLOSED", closedAt: new Date(), openGuard: null }).where(eq(s.shifts.id, current.id));
      if (action === "CREDIT_ALLOWED") await db().update(s.roles).set({ operationalCaps: { maxRefundAmountIqd: "25000.00", maxCreditSaleLimitIqd: "5000.00" } }).where(eq(s.roles.id, 10));
      if (action === "CREDIT_CAP_FULL" || action === "CREDIT_CAP_PARTIAL" || action === "CREDIT_REDUCE") await db().update(s.roles).set({ operationalCaps: { maxRefundAmountIqd: "25000.00", maxCreditSaleLimitIqd: "0.00" } }).where(eq(s.roles.id, 10));
      if (action === "RETURN") {
        const [item] = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, original.invoiceId));
        const refund = (baseQuantity: number, amount: string, key: string) => api.returns.create({
          invoiceId: original.invoiceId, lines: [{ invoiceItemId: item.id, baseQuantity }],
          refund: { method: "CASH", amount, shiftId: current.id }, restock: true,
          reason: "مرتجع من الكاشير الحالي", clientRequestId: key,
        });
        expect(await refund(2, "2000", "paid-peer-partial")).toMatchObject({ mode: "EXECUTED" });
        expect(await refund(8, money(paid).minus(2000).toFixed(2), "paid-peer-full")).toMatchObject({ mode: "EXECUTED" });
        expect(await refund(2, "2000", "paid-peer-partial")).toMatchObject({ mode: "EXECUTED" });
        expect((await invoice(original.invoiceId)).status).toBe("RETURNED");
      } else if (isCancel) {
        expect(await api.sales.cancel({ invoiceId: original.invoiceId, refundPaymentMethod: "CASH", reason: "إلغاء فاتورة موظف سابق",
          clientRequestId: "paid-peer-cancel" })).toMatchObject({ mode: "EXECUTED", refundAmount: money(paid).toFixed(2) });
      } else {
        const result = await api.sales.reissue({ originalInvoiceId: original.invoiceId, lines: [line(String(targetQuantity))],
          reason: "تصحيح فاتورة موظف سابق", overpayHandling: action === "PRINT_NO_CHANNEL_CREDIT" ? "CREDIT" : "CASH_REFUND", clientRequestId: "paid-peer-edit" });
        expect(result.status).toBe(needsReview ? "PENDING" : "APPROVED");
        if (needsReview) {
          expect(await invoice(original.invoiceId)).toMatchObject({ status: paid === "10000" ? "PAID" : "PARTIALLY_PAID", paidAmount: money(paid).toFixed(2), correctedByInvoiceId: null });
          expect(await db().select().from(s.invoices)).toHaveLength(1);
        } else {
          expect(result.resultInvoiceId).toBeTruthy();
          expect(await invoice(Number(result.resultInvoiceId))).toMatchObject({ total: targetTotal.toFixed(2), paidAmount: money(paid).lt(targetTotal) ? money(paid).toFixed(2) : targetTotal.toFixed(2), shiftId: current.id });
        }
      }
      const receipts = await db().select().from(s.receipts);
      const refunds = receipts.filter(r => r.direction === "OUT");
      const expectedRefund = needsReview ? money(0) : action === "RETURN" || isCancel ? money(paid) : money(paid).gt(targetTotal) ? money(paid).minus(targetTotal) : money(0);
      expect(refunds.reduce((total, r) => total.plus(money(r.amount)), money(0)).toFixed(2)).toBe(expectedRefund.toFixed(2));
      for (const r of refunds) expect(r).toMatchObject({ shiftId: current.id, createdBy: 2, cashBucket: "DRAWER" });
      for (const r of originalReceipts) expect(receipts.find(next => next.id === r.id)).toMatchObject({
        amount: r.amount, shiftId: r.shiftId, createdBy: r.createdBy, cashBucket: r.cashBucket, paymentMethod: r.paymentMethod });
      expect((await db().select().from(s.shifts).where(eq(s.shifts.id, sourceShift.id)))[0]).toEqual(closedSource);
      const expectedDebt = needsReview ? money(10000).minus(paid) : action === "RETURN" || isCancel ? money(0) : targetTotal.gt(money(paid)) ? targetTotal.minus(paid) : money(0);
      expect((await customer()).currentBalance).toBe(expectedDebt.toFixed(2));
      expect((await db().select().from(s.branchStock))[0].quantity).toBe(needsReview ? 90 : action === "RETURN" || isCancel ? 100 : 100 - targetQuantity);
      expect((await party()).currentBalance).toBe("0.00");
    });
  });
  describe("limited unpaid COD cancellation", () => {
    const cashier = { userId: 2, branchId: 1, role: "cashier" as const };
    const limited = (invoiceId: number) => ({ invoiceId, refundPaymentMethod: "CASH" as const,
      reason: "تراجع العميل عن الشراء", clientRequestId: `limited-cod-${invoiceId}`,
      enforceOperationalDecision: true, unpaidCodOnly: true });
    async function ownSale() {
      await db().insert(s.users).values({ id: 2, openId: "limited-reception", name: "استقبال", role: "cashier", branchId: 1,
        operationPolicy: { version: 1, grants: { "operation.sales.cancelUnpaidCod": true, "operation.sales.cancel": false,
          "operation.sales.get": true, "operation.returns.create": true }, recordScopes: { "operation.sales.get": "BRANCH" } } });
      const original = await sale();
      await db().update(s.invoices).set({ createdBy: 2 }).where(eq(s.invoices.id, original.invoiceId));
      return original;
    }
    async function api() {
      const [user] = await db().select().from(s.users).where(eq(s.users.id, 2));
      await resolveCustomRole(user as AuthUser);
      return router({ sales: saleRouter, returns: returnRouter }).createCaller({ user, req: { headers: {} }, res: {}, sessionId: null,
        nativeClientId: null, platformAdmin: null } as unknown as TrpcContext);
    }
    const snapshot = async () => Promise.all([db().select().from(s.invoices), db().select().from(s.branchStock),
      db().select().from(s.deliveryConsignments), db().select().from(s.deliveryLedgerEntries),
      db().select().from(s.accountingEntries), db().select().from(s.receipts)]);

    it("atomically cancels own unpaid COD without a shift, approval or receipt, then replays once", async () => {
      const original = await ownSale();
      expect(await cancelSale(limited(original.invoiceId), cashier)).toMatchObject({ refundAmount: "0.00", pendingRefundAmount: "0.00" });
      expect(await invoice(original.invoiceId)).toMatchObject({ status: "CANCELLED", paidAmount: "0.00" });
      expect((await customer()).currentBalance).toBe("0.00");
      expect((await party()).currentBalance).toBe("0.00");
      expect((await db().select().from(s.branchStock))[0].quantity).toBe(100);
      expect((await getDeliveryFinancialSummary(1)).codOutstandingRaw).toBe("0.00");
      expect(await db().select().from(s.receipts)).toHaveLength(0);
      expect(await db().select().from(s.salesControlRequests)).toHaveLength(0);
      const before = await snapshot();
      expect(await cancelSale(limited(original.invoiceId), cashier)).toMatchObject({ idempotentReplay: true, refundAmount: "0.00" });
      expect(await snapshot()).toEqual(before);
    });

    it.each(["paid", "receipt", "custody", "non-COD"])("rejects %s before any cancellation effect", async (kind) => {
      const original = await ownSale();
      if (kind === "paid") await db().update(s.invoices).set({ paidAmount: "1000" }).where(eq(s.invoices.id, original.invoiceId));
      if (kind === "receipt") await db().insert(s.receipts).values({ invoiceId: original.invoiceId, branchId: 1,
        direction: "IN", amount: "1000", paymentMethod: "CASH", cashBucket: "TREASURY", createdBy: 1 });
      if (kind === "custody") await delivered(original.consignmentId!);
      if (kind === "non-COD") await db().update(s.invoices).set({ paymentMode: "PREPAID" }).where(eq(s.invoices.id, original.invoiceId));
      const before = await snapshot();
      await expect(cancelSale(limited(original.invoiceId), cashier)).rejects.toBeDefined();
      expect(await snapshot()).toEqual(before);
    });

    it("cancels another employee's unpaid COD after their shift closes", async () => {
      const original = await ownSale();
      await db().update(s.invoices).set({ createdBy: 1 }).where(eq(s.invoices.id, original.invoiceId));
      await db().update(s.shifts).set({ status: "CLOSED", closedAt: new Date() }).where(eq(s.shifts.userId, 1));
      await expect((await api()).sales.get({ invoiceId: original.invoiceId })).resolves.toMatchObject({
        unpaidCodCancellationEligible: true });
      await expect(cancelSale(limited(original.invoiceId), cashier)).resolves.toMatchObject({ refundAmount: "0.00" });
      expect((await invoice(original.invoiceId)).status).toBe("CANCELLED");
      expect((await customer()).currentBalance).toBe("0.00");
      expect((await getDeliveryFinancialSummary(1)).codOutstandingRaw).toBe("0.00");
      expect((await db().select().from(s.branchStock))[0].quantity).toBe(100);
      expect(await db().select().from(s.receipts)).toHaveLength(0);
      expect(await db().select().from(s.salesControlRequests)).toHaveLength(0);
    });

    it.each(SECTION_CASHIER_ROLES)("$key partially then fully returns another employee's unpaid COD after their shift closes", async profile => {
      const original = await ownSale();
      const policy = buildDefaultRoleOperationPolicy(profile.key, profile.baseRole, profile.permissions);
      policy.grants["operation.sales.get"] = true;
      policy.recordScopes = { ...policy.recordScopes, "operation.sales.get": "BRANCH" };
      await db().insert(s.roles).values({ id: 10, key: profile.key, label: profile.label, baseRole: profile.baseRole,
        permissions: profile.permissions, operationPolicy: policy });
      await db().update(s.users).set({ customRoleId: 10, operationPolicy: null }).where(eq(s.users.id, 2));
      await db().update(s.invoices).set({ createdBy: 1 }).where(eq(s.invoices.id, original.invoiceId));
      await db().update(s.shifts).set({ status: "CLOSED", closedAt: new Date() }).where(eq(s.shifts.userId, 1));
      const [item] = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, original.invoiceId));
      const caller = await api();
      await expect(caller.sales.get({ invoiceId: original.invoiceId })).resolves.toMatchObject({ id: original.invoiceId });
      await expect(caller.returns.getInvoice({ invoiceId: original.invoiceId })).resolves.toMatchObject({ id: original.invoiceId });
      await caller.returns.create({ invoiceId: original.invoiceId, lines: [{ invoiceItemId: item.id, baseQuantity: 2 }],
        restock: true, reason: "مرتجع جزئي للزبون", clientRequestId: "cross-maker-partial" });
      expect((await invoice(original.invoiceId)).returnedTotal).toBe("2000.00");
      expect((await customer()).currentBalance).toBe("8000.00");
      expect((await getDeliveryFinancialSummary(1)).codOutstandingRaw).toBe("8000.00");
      await caller.returns.create({ invoiceId: original.invoiceId, lines: [{ invoiceItemId: item.id, baseQuantity: 8 }],
        restock: true, reason: "إكمال مرتجع الزبون", clientRequestId: "cross-maker-full" });
      expect((await invoice(original.invoiceId)).status).toBe("RETURNED");
      expect((await customer()).currentBalance).toBe("0.00");
      expect((await getDeliveryFinancialSummary(1)).codOutstandingRaw).toBe("0.00");
      expect((await db().select().from(s.branchStock))[0].quantity).toBe(100);
      expect(await db().select().from(s.receipts)).toHaveLength(0);
      expect(await db().select().from(s.salesControlRequests)).toHaveLength(0);
    });

    it("does not grant general cancellation or let a revoked permission replay", async () => {
      const original = await ownSale();
      const { unpaidCodOnly: _restricted, ...general } = limited(original.invoiceId);
      await expect(cancelSale(general, cashier)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await cancelSale(limited(original.invoiceId), cashier);
      await db().update(s.users).set({ operationPolicy: { version: 1, grants: { "operation.sales.cancelUnpaidCod": false } } }).where(eq(s.users.id, 2));
      const before = await snapshot();
      await expect(cancelSale(limited(original.invoiceId), cashier)).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(await snapshot()).toEqual(before);
    });

    it("executes the dedicated API and writes its zero-refund audit atomically", async () => {
      const original = await ownSale();
      const caller = await api();
      await expect(caller.sales.cancelUnpaidCod({ invoiceId: original.invoiceId,
        reason: "تراجع العميل", clientRequestId: "limited-api" })).resolves.toMatchObject({ mode: "EXECUTED", refundAmount: "0.00" });
      const audits = await db().select().from(s.auditLogs).where(eq(s.auditLogs.action, "sale.cancel.unpaidCod"));
      expect(audits).toHaveLength(1);
      expect(audits[0].userId).toBe(2);
      expect(await db().select().from(s.receipts)).toHaveLength(0);
    });

    it.each([{ refundPaymentMethod: "CARD" }, { reference: "card-proof" }, { refundShiftId: 1 }, { refundAmount: "1000" }])(
      "rejects injected refund fields at the dedicated API boundary: %j", async (extra) => {
        const original = await ownSale();
        const before = await snapshot();
        await expect((await api()).sales.cancelUnpaidCod({ invoiceId: original.invoiceId, reason: "تراجع العميل",
          clientRequestId: "limited-injected", ...extra })).rejects.toMatchObject({ code: "BAD_REQUEST" });
        expect(await snapshot()).toEqual(before);
      });

    it("rejects historically refunded money even when the net paid cache is zero", async () => {
      const original = await ownSale();
      await db().insert(s.receipts).values((["IN", "OUT"] as const).map(direction => ({ invoiceId: original.invoiceId,
        branchId: 1, direction, amount: "1000", paymentMethod: "CASH" as const, cashBucket: "TREASURY" as const, createdBy: 1 })));
      const before = await snapshot();
      await expect(cancelSale(limited(original.invoiceId), cashier)).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(await snapshot()).toEqual(before);
    });

    it("rejects a COD sale with a separately collected counter delivery fee", async () => {
      await ownSale();
      const [shift] = await db().select().from(s.shifts).where(eq(s.shifts.status, "OPEN"));
      const original = await createSale({ branchId: 1, shiftId: shift.id, sourceType: "POS", customerId: 1,
        lines: [line("10")], deliveryFeeHeld: "1000",
        delivery: { partyId: 1, fee: "1000", feeCollection: "COUNTER", recipientPhone: "07701234567",
          externalTrackingRef: "limited-counter-fee" }, clientRequestId: "limited-counter-fee" }, actor);
      await db().update(s.invoices).set({ createdBy: 2 }).where(eq(s.invoices.id, original.invoiceId));
      expect(await invoice(original.invoiceId)).toMatchObject({ paymentMode: "COD", paidAmount: "0.00" });
      await expect((await api()).sales.get({ invoiceId: original.invoiceId })).resolves.toMatchObject({
        refundablePaidAmount: "0.00", unpaidCodCancellationEligible: false });
      const before = await snapshot();
      await expect(cancelSale(limited(original.invoiceId), cashier)).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(await snapshot()).toEqual(before);
    });

    it("rejects a cashier from another branch before any effect", async () => {
      const original = await ownSale();
      await db().insert(s.branches).values({ id: 2, name: "فرع ثان", code: "SECOND", type: "SALES" });
      await db().update(s.users).set({ branchId: 2 }).where(eq(s.users.id, 2));
      const before = await snapshot();
      await expect(cancelSale(limited(original.invoiceId), { ...cashier, branchId: 2 })).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(await snapshot()).toEqual(before);
    });
  });

  it("corrects walk-in unpaid COD without requiring a registered customer", async () => {
    const original = await sale(null);
    const corrected = await correct(original.invoiceId, "8");
    expect(await invoice(corrected.correctedInvoiceId)).toMatchObject({
      customerId: null,
      paymentMode: "COD",
      paidAmount: "0.00",
    });
    expect((await getDeliveryFinancialSummary(1)).codOutstandingRaw).toBe(
      "8000.00",
    );
    expect(await db().select().from(s.receipts)).toHaveLength(0);
  });

  it("corrects cancelled unpaid COD and releases stale exposure without reactivating the parcel", async () => {
    const original = await sale(null);
    await db()
      .update(s.deliveryConsignments)
      .set({
        status: "CANCELLED",
        parcelStatus: "CANCELLED",
        moneyStatus: "CANCELLED",
        custodyRecognizedAt: new Date(),
        feeSettledAt: new Date(),
      })
      .where(eq(s.deliveryConsignments.id, original.consignmentId!));
    const corrected = await correct(original.invoiceId, "8");
    expect(await invoice(corrected.correctedInvoiceId)).toMatchObject({
      customerId: null,
      paymentMode: "COD",
      paidAmount: "0.00",
    });
    expect(await consignment(original.consignmentId!)).toMatchObject({
      status: "CANCELLED",
      parcelStatus: "CANCELLED",
      moneyStatus: "CANCELLED",
    });
    expect((await getDeliveryFinancialSummary(1)).codOutstandingRaw).toBe(
      "0.00",
    );
    expect(await db().select().from(s.receipts)).toHaveLength(0);
  });

  it("corrects live unpaid COD and keeps the same parcel without cash or credit admission", async () => {
    const original = await sale();
    const corrected = await correct(original.invoiceId, "8");
    expect((await invoice(original.invoiceId)).status).toBe("SUPERSEDED");
    expect(await invoice(corrected.correctedInvoiceId)).toMatchObject({
      total: "8000.00",
      paidAmount: "0.00",
      paymentMode: "COD",
    });
    expect(await consignment(original.consignmentId!)).toMatchObject({
      invoiceId: corrected.correctedInvoiceId,
      codAmount: "8000.00",
      parcelStatus: "OUT_FOR_DELIVERY",
    });
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    expect((await getDeliveryFinancialSummary(1)).codOutstandingRaw).toBe(
      "8000.00",
    );
    expect((await customer()).currentBalance).toBe("8000.00");
    expect((await db().select().from(s.branchStock))[0].quantity).toBe(92);
  });

  it("carries a delivered collection without creating a receipt or changing custody", async () => {
    const original = await sale();
    await delivered(original.consignmentId!);
    const corrected = await correct(original.invoiceId, "10");
    expect(await invoice(corrected.correctedInvoiceId)).toMatchObject({
      paidAmount: "10000.00",
      status: "PAID",
    });
    expect(await consignment(original.consignmentId!)).toMatchObject({
      invoiceId: corrected.correctedInvoiceId,
      parcelStatus: "DELIVERED",
    });
    expect((await party()).currentBalance).toBe("10000.00");
    expect((await customer()).currentBalance).toBe("0.00");
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    expect((await getDeliveryFinancialSummary(1)).cashInCustody).toBe(
      "10000.00",
    );
  });

  it("reduces only excess unremitted custody when the corrected total is lower", async () => {
    const original = await sale();
    await delivered(original.consignmentId!);
    const corrected = await correct(original.invoiceId, "8");
    expect(await invoice(corrected.correctedInvoiceId)).toMatchObject({
      paidAmount: "8000.00",
      total: "8000.00",
    });
    expect((await party()).currentBalance).toBe("8000.00");
    expect((await customer()).currentBalance).toBe("0.00");
    expect((await getDeliveryFinancialSummary(1)).cashInCustody).toBe(
      "8000.00",
    );
    expect(await db().select().from(s.receipts)).toHaveLength(0);
  });

  it("cancels a live unpaid parcel and releases exposure in the invoice transaction", async () => {
    const original = await sale();
    const result = await cancelSale(
      {
        invoiceId: original.invoiceId,
        reason: "إلغاء الطلب",
        refundPaymentMethod: "CASH",
        clientRequestId: "amend-cancel",
        enforceOperationalDecision: true,
      },
      actor,
    );
    expect(result.refundAmount).toBe("0.00");
    expect((await invoice(original.invoiceId)).status).toBe("CANCELLED");
    expect((await getDeliveryFinancialSummary(1)).codOutstandingRaw).toBe(
      "0.00",
    );
    expect(await db().select().from(s.receipts)).toHaveLength(0);
  });

  it("rejects delivered unremitted cancellation until physical return without changing money", async () => {
    const original = await sale();
    await delivered(original.consignmentId!);
    const before = await Promise.all([invoice(original.invoiceId), consignment(original.consignmentId!), db().select().from(s.deliveryLedgerEntries), db().select().from(s.branchStock)]);
    await expect(cancelSale(
      {
        invoiceId: original.invoiceId,
        reason: "إلغاء الطلب",
        refundPaymentMethod: "CASH",
        clientRequestId: "amend-cancel-paid",
        enforceOperationalDecision: true,
      },
      actor,
    )).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await Promise.all([invoice(original.invoiceId), consignment(original.consignmentId!), db().select().from(s.deliveryLedgerEntries), db().select().from(s.branchStock)])).toEqual(before);
    expect((await party()).currentBalance).toBe("10000.00");
    expect((await customer()).currentBalance).toBe("0.00");
    expect((await getDeliveryFinancialSummary(1)).cashInCustody).toBe("10000.00");
    expect(await db().select().from(s.receipts)).toHaveLength(0);
  });

  it("keeps partial remittance evidence and only reverses the unremitted excess", async () => {
    const original = await sale();
    await delivered(original.consignmentId!);
    await remit(original.consignmentId!, "4000");
    const remittances = await db().select().from(s.deliveryRemittanceLines);
    const corrected = await correct(original.invoiceId, "8");
    expect((await invoice(corrected.correctedInvoiceId)).paidAmount).toBe(
      "8000.00",
    );
    expect((await party()).currentBalance).toBe("4000.00");
    expect((await getDeliveryFinancialSummary(1)).cashInCustody).toBe(
      "4000.00",
    );
    expect(await db().select().from(s.deliveryRemittanceLines)).toEqual(
      remittances,
    );
    expect(
      (await db().select().from(s.receipts)).map((r) => r.direction),
    ).toEqual(["IN"]);
    expect((await customer()).currentBalance).toBe("0.00");
  });

  it("rejects fully remitted delivered cancellation until physical return with receipts unchanged", async () => {
    const original = await sale();
    await delivered(original.consignmentId!);
    await remit(original.consignmentId!, "10000");
    const before = await Promise.all([invoice(original.invoiceId), consignment(original.consignmentId!), db().select().from(s.receipts), db().select().from(s.deliveryRemittanceLines), db().select().from(s.branchStock)]);
    await expect(cancelSale(
      {
        invoiceId: original.invoiceId,
        reason: "رجوع الطلب",
        refundPaymentMethod: "CASH",
        clientRequestId: "amend-refund-paid",
        enforceOperationalDecision: true,
      },
      actor,
    )).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await Promise.all([invoice(original.invoiceId), consignment(original.consignmentId!), db().select().from(s.receipts), db().select().from(s.deliveryRemittanceLines), db().select().from(s.branchStock)])).toEqual(before);
    expect((await party()).currentBalance).toBe("0.00");
    expect((await customer()).currentBalance).toBe("0.00");
    const receipts = await db().select().from(s.receipts);
    expect(receipts.map((r) => [r.direction, r.amount])).toEqual([
      ["IN", "10000.00"],
    ]);
  });

  it("splits a large correction decrease between custody reversal and an actual cash refund", async () => {
    const original = await sale();
    await delivered(original.consignmentId!);
    await remit(original.consignmentId!, "4000");
    const corrected = await correctSale(
      {
        originalInvoiceId: original.invoiceId,
        lines: [line("3")],
        clientRequestId: "amend-split",
        overpayHandling: "CASH_REFUND",
      },
      actor,
    );
    expect((await invoice(corrected.correctedInvoiceId)).paidAmount).toBe(
      "3000.00",
    );
    expect((await party()).currentBalance).toBe("0.00");
    expect((await customer()).currentBalance).toBe("0.00");
    expect(
      (await db().select().from(s.receipts)).map((r) => [
        r.direction,
        r.amount,
      ]),
    ).toEqual([
      ["IN", "4000.00"],
      ["OUT", "1000.00"],
    ]);
  });

  it("rolls back invoice, custody, stock, ledger and replay key if a replacement is invalid", async () => {
    const original = await sale();
    await delivered(original.consignmentId!);
    const before = await consignment(original.consignmentId!);
    const ledger = await db().select().from(s.deliveryLedgerEntries);
    await expect(
      correct(original.invoiceId, "1000", "amend-invalid"),
    ).rejects.toThrow();
    expect(await consignment(original.consignmentId!)).toEqual(before);
    expect((await invoice(original.invoiceId)).status).toBe("PAID");
    expect((await party()).currentBalance).toBe("10000.00");
    expect((await db().select().from(s.branchStock))[0].quantity).toBe(90);
    expect(await db().select().from(s.deliveryLedgerEntries)).toEqual(ledger);
    expect(
      (await db().select().from(s.idempotencyKeys)).some(
        (r) => r.requestId === "amend-invalid",
      ),
    ).toBe(false);
  });

  it("replays correction without releasing custody or exposure twice", async () => {
    const original = await sale();
    await delivered(original.consignmentId!);
    const first = await correct(original.invoiceId, "8");
    const ledger = await db().select().from(s.deliveryLedgerEntries);
    const replay = await correct(original.invoiceId, "8");
    expect(replay.correctedInvoiceId).toBe(first.correctedInvoiceId);
    expect((await party()).currentBalance).toBe("8000.00");
    expect(await db().select().from(s.deliveryLedgerEntries)).toEqual(ledger);
  });

  it("reverses assigned shortfall before cash custody and creates no cash return for debt relief", async () => {
    const original = await sale();
    await recordStaffDeliveryConfirmation(
      {
        consignmentId: original.consignmentId!,
        collectedAmount: "8000",
        evidence: "اتصال الشركة",
        clientRequestId: "amend-shortfall",
        shortfallReason: "WRONG_PRICE_QUOTED",
      },
      actor,
    );
    const corrected = await correct(original.invoiceId, "9");
    expect((await invoice(corrected.correctedInvoiceId)).paidAmount).toBe(
      "9000.00",
    );
    expect((await party()).currentBalance).toBe("9000.00");
    expect((await customer()).currentBalance).toBe("0.00");
    const ledger = await db().select().from(s.deliveryLedgerEntries);
    expect(
      ledger
        .filter((r) => r.entryType === "SHORTFALL_SETTLED")
        .map((r) => r.amount),
    ).toEqual(["1000.00"]);
    expect(ledger.filter((r) => r.entryType === "COD_RETURNED")).toHaveLength(
      0,
    );
    expect(await db().select().from(s.receipts)).toHaveLength(0);
  });

  it("reattributes courier-paid AR between customers with immutable source collection and no receipt", async () => {
    await db()
      .insert(s.doubleEntrySettings)
      .values({
        id: 1,
        mode: "SHADOW",
        shadowCycleId: "invoice-amendment-customer",
      });
    await db()
      .insert(s.customers)
      .values({
        id: 2,
        name: "العميل الصحيح",
        currentBalance: "0",
        creditLimit: "0",
      });
    const original = await sale();
    await delivered(original.consignmentId!);
    const collection = (
      await db()
        .select()
        .from(s.accountingEntries)
        .where(eq(s.accountingEntries.entryType, "PAYMENT_IN"))
    )[0];
    const corrected = await correctSale(
      {
        originalInvoiceId: original.invoiceId,
        customerId: 2,
        priorPaymentReceivedAmount: "10000",
        lines: [line("8")],
        clientRequestId: "amend-new-customer",
      },
      actor,
    );
    expect((await invoice(corrected.correctedInvoiceId)).customerId).toBe(2);
    expect((await customer()).currentBalance).toBe("0.00");
    expect(
      (await db().select().from(s.customers).where(eq(s.customers.id, 2)))[0]
        .currentBalance,
    ).toBe("0.00");
    expect(
      (
        await db()
          .select()
          .from(s.accountingEntries)
          .where(eq(s.accountingEntries.id, collection.id))
      )[0],
    ).toEqual(collection);
    for (const customerId of [1, 2]) {
      const rows = await db()
        .select({ debit: s.journalLines.debit, credit: s.journalLines.credit })
        .from(s.journalLines)
        .innerJoin(
          s.journalEntries,
          eq(s.journalEntries.id, s.journalLines.journalId),
        )
        .where(
          and(
            eq(s.journalLines.role, "AR"),
            eq(s.journalLines.customerId, customerId),
            eq(s.journalEntries.status, "POSTED"),
          ),
        );
      expect(rows.length).toBeGreaterThan(0);
      expect(
        rows
          .reduce(
            (total, row) =>
              total.plus(money(row.debit)).minus(money(row.credit)),
            money(0),
          )
          .toFixed(2),
      ).toBe("0.00");
    }
    const bridge = (
      await db()
        .select({
          net: sql<string>`COALESCE(SUM(${s.journalLines.debit}-${s.journalLines.credit}),0)`,
        })
        .from(s.journalLines)
        .where(eq(s.journalLines.role, "OPENING_EQUITY"))
    )[0];
    expect(money(bridge.net).toFixed(2)).toBe("0.00");
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    expect((await party()).currentBalance).toBe("8000.00");
  });

  it("corrects again after a split custody/cash refund and keeps that refund in the carried paid pool", async () => {
    const original = await sale();
    await delivered(original.consignmentId!);
    await remit(original.consignmentId!, "4000");
    const first = await correctSale(
      {
        originalInvoiceId: original.invoiceId,
        lines: [line("3")],
        clientRequestId: "amend-first-refund",
        overpayHandling: "CASH_REFUND",
      },
      actor,
    );
    const second = await correct(
      first.correctedInvoiceId,
      "4",
      "amend-after-refund",
    );
    expect(await invoice(second.correctedInvoiceId)).toMatchObject({
      paidAmount: "3000.00",
      total: "4000.00",
      paymentMode: "COD",
    });
    const receipts = await db().select().from(s.receipts);
    expect(receipts.map((r) => [r.direction, r.amount])).toEqual([
      ["IN", "4000.00"],
      ["OUT", "1000.00"],
    ]);
    expect(receipts.find((r) => r.direction === "OUT")?.invoiceId).toBe(
      second.correctedInvoiceId,
    );
    expect((await party()).currentBalance).toBe("0.00");
    expect((await customer()).currentBalance).toBe("1000.00");
  });

  describe("refund source proof", () => {
    it("rejects a refund exceeding the proved pool before changing any invoice or receipt", async () => {
      const shift = (await db().select().from(s.shifts))[0];
      const original = await createSale({ branchId: 1, shiftId: Number(shift.id), sourceType: "POS", customerId: 1, lines: [line("10")], payment: { method: "CASH", amount: "10000" }, clientRequestId: "unproved-rail-sale" }, actor);
      // Inconsistent legacy import: the refund exceeds all proved inbound money.
      await db().insert(s.receipts).values({ invoiceId: original.invoiceId, branchId: 1, direction: "OUT", amount: "12000", paymentMethod: "CARD", referenceNumber: "legacy-refund", status: "COMPLETED", approvalStatus: "APPROVED", createdBy: 1 });
      await db().update(s.invoices).set({ paidAmount: "8000" }).where(eq(s.invoices.id, original.invoiceId));
      const before = await Promise.all([invoice(original.invoiceId), db().select().from(s.receipts), db().select().from(s.branchStock), db().select().from(s.accountingEntries)]);
      await expect(correct(original.invoiceId, "8", "unproved-rail-correct")).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      expect(await Promise.all([invoice(original.invoiceId), db().select().from(s.receipts), db().select().from(s.branchStock), db().select().from(s.accountingEntries)])).toEqual(before);
    });

    it("carries CASH after an actual CARD roundtrip when the customer changes", async () => {
      await db().insert(s.doubleEntrySettings).values({ id: 1, mode: "SHADOW", shadowCycleId: "refund-rails" });
      await db().update(s.customers).set({ creditLimit: "10000" }).where(eq(s.customers.id, 1));
      await db().insert(s.customers).values({ id: 2, name: "العميل الصحيح", currentBalance: "0", creditLimit: "0" });
      const shift = (await db().select().from(s.shifts))[0];
      const original = await createSale({ branchId: 1, shiftId: Number(shift.id), sourceType: "POS", customerId: 1, lines: [line("10")], payment: { method: "CASH", amount: "5000" }, clientRequestId: "rail-sale" }, actor);
      // Historical confirmed processor receipt and refund; their net is zero.
      await withTx(async tx => {
        for (const direction of ["IN", "OUT"] as const) {
          const id = extractInsertId(await tx.insert(s.receipts).values({ invoiceId: original.invoiceId, branchId: 1, shiftId: Number(shift.id), cashBucket: null, direction, amount: "5000", paymentMethod: "CARD", referenceNumber: `processor-${direction}`, cardLastFour: "1234", status: "COMPLETED", approvalStatus: "APPROVED", createdBy: 1 }));
          const amount = money("5000");
          const source = direction === "IN" ? { roleDebits: { CARD_BANK: amount }, roleCredits: { AR: amount } } : { roleDebits: { AR: amount }, roleCredits: { CARD_BANK: amount } };
          await postEntry(tx, { entryType: direction === "IN" ? "PAYMENT_IN" : "PAYMENT_OUT", branchId: 1, invoiceId: original.invoiceId, receiptId: id, customerId: 1, amount, postingIntent: createPostingIntent(direction === "IN" ? "PAYMENT_IN_CUSTOMER" : "PAYMENT_OUT_CUSTOMER_REFUND", direction === "IN" ? "PAYMENT_IN" : "PAYMENT_OUT", direction === "IN" ? [debitLine("CARD_BANK", amount), creditLine("AR", amount)] : [debitLine("AR", amount), creditLine("CARD_BANK", amount)], source), postingSourceComponents: source });
        }
      });
      const history = await db().select().from(s.receipts);
      const corrected = await correctSale({ originalInvoiceId: original.invoiceId, customerId: 2, priorPaymentReceivedAmount: "5000", lines: [line("5")], clientRequestId: "rail-reassign" }, actor);
      const after = await db().select().from(s.receipts);
      expect(after.filter(row => row.invoiceId === corrected.correctedInvoiceId).map(row => [row.direction, row.paymentMethod, row.amount, row.shiftId, row.cashBucket])).toEqual([["IN", "CASH", "5000.00", Number(shift.id), "DRAWER"]]);
      for (const old of history) expect(after.find(row => row.id === old.id)).toMatchObject({ amount: old.amount, paymentMethod: old.paymentMethod, shiftId: old.shiftId, cashBucket: old.cashBucket, referenceNumber: old.referenceNumber, cardLastFour: old.cardLastFour });
      expect(after.filter(row => row.internalNote?.startsWith("SALE_CORRECTION_REVERSAL:")).map(row => [row.paymentMethod, row.amount])).toEqual([["CASH", "5000.00"]]);
      for (const customerId of [1, 2]) {
        const rows = await db().select().from(s.journalLines).where(and(eq(s.journalLines.role, "AR"), eq(s.journalLines.customerId, customerId)));
        expect(rows.reduce((total, row) => total.plus(money(row.debit)).minus(money(row.credit)), money(0)).toFixed(2)).toBe("0.00");
      }
    });

    it("carries refunded store advance with a consignment and zero courier collection", async () => {
      const shift = (await db().select().from(s.shifts))[0];
      const original = await createSale({ branchId: 1, shiftId: Number(shift.id), sourceType: "POS", customerId: 1, lines: [line("10")], payment: { method: "CASH", amount: "10000" }, delivery: { partyId: 1, fee: "0", feeCollection: "COURIER", recipientPhone: "07701234567", externalTrackingRef: "advance-zero" }, clientRequestId: "advance-zero-sale" }, actor);
      const first = await correctSale({ originalInvoiceId: original.invoiceId, lines: [line("8")], clientRequestId: "advance-zero-first", overpayHandling: "CASH_REFUND" }, actor);
      const second = await correctSale({ originalInvoiceId: first.correctedInvoiceId, lines: [line("6")], clientRequestId: "advance-zero-second", overpayHandling: "CASH_REFUND" }, actor);
      expect(await invoice(second.correctedInvoiceId)).toMatchObject({ paidAmount: "6000.00", total: "6000.00" });
      expect((await db().select().from(s.receipts)).map(row => [row.direction, row.amount])).toEqual([["IN", "10000.00"], ["OUT", "2000.00"], ["OUT", "2000.00"]]);
      expect((await party()).currentBalance).toBe("0.00");
      expect((await consignment(original.consignmentId!)).codAmount).toBe("0.00");
    });

    it("preserves pooled CASH refunds of CARD receipts on their original rails when reassigned", async () => {
      await db().insert(s.doubleEntrySettings).values({ id: 1, mode: "SHADOW", shadowCycleId: "pooled-refund" });
      await db().update(s.customers).set({ creditLimit: "10000" }).where(eq(s.customers.id, 1));
      await db().insert(s.customers).values({ id: 2, name: "العميل الصحيح", currentBalance: "0", creditLimit: "0" });
      const shift = (await db().select().from(s.shifts))[0];
      await db().update(s.shifts).set({ openingBalance: "2000" }).where(eq(s.shifts.id, Number(shift.id)));
      const original = await createSale({ branchId: 1, shiftId: Number(shift.id), sourceType: "POS", customerId: 1, lines: [line("10")], clientRequestId: "pooled-card-sale" }, actor);
      await withTx(async tx => {
        const receiptId = extractInsertId(await tx.insert(s.receipts).values({ invoiceId: original.invoiceId, branchId: 1, shiftId: Number(shift.id), direction: "IN", amount: "10000", paymentMethod: "CARD", referenceNumber: "confirmed-card-only", status: "COMPLETED", approvalStatus: "APPROVED", createdBy: 1 }));
        const amount = money("10000");
        const source = { roleDebits: { CARD_BANK: amount }, roleCredits: { AR: amount } };
        await postEntry(tx, { entryType: "PAYMENT_IN", invoiceId: original.invoiceId, receiptId, branchId: 1, customerId: 1, amount, postingIntent: createPostingIntent("PAYMENT_IN_CUSTOMER", "PAYMENT_IN", [debitLine("CARD_BANK", amount), creditLine("AR", amount)], source), postingSourceComponents: source });
        await tx.update(s.invoices).set({ paidAmount: "10000", status: "PAID", paymentMethod: "CARD" }).where(eq(s.invoices.id, original.invoiceId));
        await tx.update(s.customers).set({ currentBalance: "0" }).where(eq(s.customers.id, 1));
      });
      const first = await correctSale({ originalInvoiceId: original.invoiceId, lines: [line("8")], overpayHandling: "CASH_REFUND", clientRequestId: "pooled-cash-refund" }, actor);
      const physicalRefund = (await db().select().from(s.receipts)).find(row => row.direction === "OUT")!;
      const reassigned = await correctSale({ originalInvoiceId: first.correctedInvoiceId, customerId: 2, priorPaymentReceivedAmount: "8000", lines: [line("8")], clientRequestId: "pooled-reassign" }, actor);
      const after = await db().select().from(s.receipts);
      expect(after.find(row => row.id === physicalRefund.id)).toEqual(physicalRefund);
      expect(after.filter(row => row.invoiceId === reassigned.correctedInvoiceId).map(row => [row.direction, row.paymentMethod, row.amount])).toEqual([["IN", "CARD", "8000.00"]]);
      expect(after.filter(row => row.internalNote?.startsWith("SALE_CORRECTION_REVERSAL:")).map(row => [row.direction, row.paymentMethod, row.amount])).toEqual([["OUT", "CARD", "8000.00"]]);
      for (const customerId of [1, 2]) {
        const rows = await db().select().from(s.journalLines).where(and(eq(s.journalLines.role, "AR"), eq(s.journalLines.customerId, customerId)));
        expect(rows.reduce((total, row) => total.plus(money(row.debit)).minus(money(row.credit)), money(0)).toFixed(2)).toBe("0.00");
      }
    });

    it("keeps a single actual refund spanning store and courier in one paid pool", async () => {
      const shift = (await db().select().from(s.shifts))[0];
      await db().insert(s.customers).values({ id: 2, name: "العميل الصحيح", currentBalance: "0", creditLimit: "0" });
      const original = await createSale({ branchId: 1, shiftId: Number(shift.id), sourceType: "POS", customerId: 1, lines: [line("13")], payment: { method: "CASH", amount: "3000" }, delivery: { partyId: 1, fee: "0", feeCollection: "COURIER", recipientPhone: "07701234567", externalTrackingRef: "spanning-refund" }, clientRequestId: "spanning-sale" }, actor);
      await delivered(original.consignmentId!);
      await remit(original.consignmentId!, "10000");
      const first = await correctSale({ originalInvoiceId: original.invoiceId, lines: [line("8")], overpayHandling: "CASH_REFUND", clientRequestId: "spanning-refund-first" }, actor);
      const physicalRefund = (await db().select().from(s.receipts)).find(row => row.direction === "OUT")!;
      const reassigned = await correctSale({ originalInvoiceId: first.correctedInvoiceId, customerId: 2, priorPaymentReceivedAmount: "8000", lines: [line("8")], clientRequestId: "spanning-reassign" }, actor);
      const repeated = await correct(reassigned.correctedInvoiceId, "8", "spanning-repeat");
      expect(await invoice(repeated.correctedInvoiceId)).toMatchObject({ paidAmount: "8000.00", customerId: 2 });
      const rows = await db().select().from(s.receipts);
      expect(rows.filter(row => row.direction === "OUT")).toHaveLength(1);
      expect(rows.find(row => row.id === physicalRefund.id)).toEqual({ ...physicalRefund, invoiceId: repeated.correctedInvoiceId });
      expect(rows.filter(row => row.invoiceId === repeated.correctedInvoiceId).map(row => [row.direction, row.amount])).toEqual([["IN", "3000.00"], ["OUT", "5000.00"]]);
      expect((await loadRefundCaps(db(), repeated.correctedInvoiceId)).pool.toFixed(2)).toBe("8000.00");
      expect((await party()).currentBalance).toBe("0.00");
    });

    it("rejects unrepresentable split-refund reassignment before any invoice stock or AR mutation", async () => {
      await db().insert(s.doubleEntrySettings).values({ id: 1, mode: "SHADOW", shadowCycleId: "split-refund-boundary" });
      await db().insert(s.customers).values({ id: 2, name: "العميل الصحيح", currentBalance: "0", creditLimit: "0" });
      const shift = (await db().select().from(s.shifts))[0];
      const receiptIds: number[] = [];
      for (const [method, amount] of [["CASH", "3000"], ["CARD", "2000"]] as const) {
        receiptIds.push(extractInsertId(await db().insert(s.receipts).values({ branchId: 1, shiftId: Number(shift.id), cashBucket: method === "CASH" ? "DRAWER" : null, direction: "IN", amount, paymentMethod: method, referenceNumber: `confirmed-${method}`, status: "COMPLETED", approvalStatus: "APPROVED", createdBy: 1 })));
      }
      const original = await createSale({ branchId: 1, shiftId: Number(shift.id), sourceType: "POS", customerId: 1, lines: [line("15")], preCollected: { amount: "5000", receiptIds }, delivery: { partyId: 1, fee: "0", feeCollection: "COURIER", recipientPhone: "07701234567", externalTrackingRef: "split-source-proof" }, clientRequestId: "split-source-sale" }, actor);
      await withTx(async tx => {
        for (const [index, role, amountText] of [[0, "CASH", "3000"], [1, "CARD_BANK", "2000"]] as const) {
          const amount = money(amountText);
          const source = { roleDebits: { [role]: amount }, roleCredits: { AR: amount } };
          await postEntry(tx, { entryType: "PAYMENT_IN", branchId: 1, invoiceId: original.invoiceId, receiptId: receiptIds[index], customerId: 1, amount, postingIntent: createPostingIntent("PAYMENT_IN_CUSTOMER", "PAYMENT_IN", [debitLine(role, amount), creditLine("AR", amount)], source), postingSourceComponents: source });
        }
      });
      await delivered(original.consignmentId!);
      await remit(original.consignmentId!, "10000");
      const first = await correctSale({ originalInvoiceId: original.invoiceId, lines: [line("10")], overpayHandling: "CASH_REFUND", clientRequestId: "split-source-refund" }, actor);
      const snapshot = () => Promise.all([db().select().from(s.invoices), db().select().from(s.receipts), db().select().from(s.branchStock), db().select().from(s.accountingEntries), db().select().from(s.journalLines), db().select().from(s.customers), db().select().from(s.deliveryConsignments), db().select().from(s.deliveryLedgerEntries)]);
      const before = await snapshot();
      await expect(correctSale({ originalInvoiceId: first.correctedInvoiceId, customerId: 2, priorPaymentReceivedAmount: "10000", lines: [line("10")], clientRequestId: "split-source-reassign" }, actor)).rejects.toThrow(/طابق توزيع مستند الاسترداد بين المصدرين/);
      expect(await snapshot()).toEqual(before);
    });

    it("attributes a mixed store and remitted courier refund once across customer reassignment", async () => {
      await db().insert(s.doubleEntrySettings).values({ id: 1, mode: "SHADOW", shadowCycleId: "mixed-refund" });
      await db().insert(s.customers).values({ id: 2, name: "العميل الصحيح", currentBalance: "0", creditLimit: "0" });
      const shift = (await db().select().from(s.shifts))[0];
      const original = await createSale({ branchId: 1, shiftId: Number(shift.id), sourceType: "POS", customerId: 1, lines: [line("10")], payment: { method: "CASH", amount: "4000" }, delivery: { partyId: 1, fee: "0", feeCollection: "COURIER", recipientPhone: "07701234567", externalTrackingRef: "mixed-advance" }, clientRequestId: "mixed-advance-sale" }, actor);
      await recordStaffDeliveryConfirmation({ consignmentId: original.consignmentId!, collectedAmount: "6000", evidence: "تحصيل الشركة", clientRequestId: "mixed-delivery" }, actor);
      await remit(original.consignmentId!, "6000");
      const first = await correctSale({ originalInvoiceId: original.invoiceId, lines: [line("8")], clientRequestId: "mixed-refund-first", overpayHandling: "CASH_REFUND" }, actor);
      const actualRefund = (await db().select().from(s.receipts)).find(row => row.direction === "OUT")!;
      const reassigned = await correctSale({ originalInvoiceId: first.correctedInvoiceId, customerId: 2, priorPaymentReceivedAmount: "8000", lines: [line("8")], clientRequestId: "mixed-reassign" }, actor);
      const repeated = await correct(reassigned.correctedInvoiceId, "8", "mixed-repeat");
      expect(await invoice(repeated.correctedInvoiceId)).toMatchObject({ paidAmount: "8000.00", customerId: 2 });
      expect((await db().select().from(s.receipts).where(eq(s.receipts.id, Number(actualRefund.id))))[0]).toEqual(actualRefund);
      expect((await db().select().from(s.receipts).where(eq(s.receipts.invoiceId, repeated.correctedInvoiceId))).map(row => [row.direction, row.amount])).toEqual([["IN", "2000.00"]]);
      for (const customerId of [1, 2]) {
        const rows = await db().select().from(s.journalLines).where(and(eq(s.journalLines.role, "AR"), eq(s.journalLines.customerId, customerId)));
        expect(rows.reduce((total, row) => total.plus(money(row.debit)).minus(money(row.credit)), money(0)).toFixed(2)).toBe("0.00");
      }
      expect((await party()).currentBalance).toBe("0.00");
    });
  });

  it("carries net ordinary CASH across two reductions and cancels only the remaining paid pool", async () => {
    const shift = (await db().select().from(s.shifts))[0];
    const original = await createSale({ branchId: 1, shiftId: Number(shift.id), sourceType: "POS", customerId: 1, lines: [line("10")], payment: { method: "CASH", amount: "10000" }, clientRequestId: "ordinary-cash-original" }, actor);
    const first = await correctSale({ originalInvoiceId: original.invoiceId, lines: [line("8")], clientRequestId: "ordinary-cash-first", overpayHandling: "CASH_REFUND" }, actor);
    const evidence = await db().select().from(s.receipts);
    const second = await correctSale({ originalInvoiceId: first.correctedInvoiceId, lines: [line("6")], clientRequestId: "ordinary-cash-second", overpayHandling: "CASH_REFUND" }, actor);
    expect(await invoice(second.correctedInvoiceId)).toMatchObject({ total: "6000.00", paidAmount: "6000.00" });
    const carried = await db().select().from(s.receipts);
    for (const old of evidence) {
      const current = carried.find(row => row.id === old.id)!;
      expect({ ...current, invoiceId: old.invoiceId }).toEqual(old);
      expect(current.invoiceId).toBe(second.correctedInvoiceId);
    }
    expect(carried.map(row => [row.direction, row.amount])).toEqual([["IN", "10000.00"], ["OUT", "2000.00"], ["OUT", "2000.00"]]);
    const cancelled = await cancelSale({ invoiceId: second.correctedInvoiceId, refundPaymentMethod: "CASH", clientRequestId: "ordinary-cash-cancel", reason: "إلغاء بعد التصحيح" }, actor);
    expect(cancelled.refundAmount).toBe("6000.00");
    const receipts = await db().select().from(s.receipts);
    expect(receipts.reduce((total, row) => row.direction === "IN" ? total.plus(money(row.amount)) : total.minus(money(row.amount)), money(0)).toFixed(2)).toBe("0.00");
    expect((await customer()).currentBalance).toBe("0.00");
    expect((await db().select().from(s.branchStock))[0].quantity).toBe(100);
  });

  it("reassigns only net ordinary CASH after a prior refund and preserves actual drawer cash", async () => {
    await db().insert(s.doubleEntrySettings).values({ id: 1, mode: "SHADOW", shadowCycleId: "ordinary-cash-reassign" });
    await db().insert(s.customers).values({ id: 2, name: "العميل الصحيح", currentBalance: "0", creditLimit: "0" });
    const shift = (await db().select().from(s.shifts))[0];
    const original = await createSale({ branchId: 1, shiftId: Number(shift.id), sourceType: "POS", customerId: 1, lines: [line("10")], payment: { method: "CASH", amount: "10000" }, clientRequestId: "ordinary-reassign-original" }, actor);
    const first = await correctSale({ originalInvoiceId: original.invoiceId, lines: [line("8")], clientRequestId: "ordinary-reassign-first", overpayHandling: "CASH_REFUND" }, actor);
    const reassigned = await correctSale({ originalInvoiceId: first.correctedInvoiceId, customerId: 2, priorPaymentReceivedAmount: "8000", lines: [line("8")], clientRequestId: "ordinary-reassign-net" }, actor);
    expect(await invoice(reassigned.correctedInvoiceId)).toMatchObject({ customerId: 2, paidAmount: "8000.00" });
    const receipts = await db().select().from(s.receipts);
    expect(receipts.filter(row => row.direction === "OUT").map(row => row.amount)).toEqual(["2000.00", "8000.00"]);
    expect(receipts.filter(row => row.direction === "IN").map(row => row.amount)).toEqual(["10000.00", "8000.00"]);
    expect(receipts.reduce((total, row) => row.direction === "IN" ? total.plus(money(row.amount)) : total.minus(money(row.amount)), money(0)).toFixed(2)).toBe("8000.00");
    for (const customerId of [1, 2]) {
      const rows = await db().select({ debit: s.journalLines.debit, credit: s.journalLines.credit }).from(s.journalLines).where(and(eq(s.journalLines.role, "AR"), eq(s.journalLines.customerId, customerId)));
      expect(rows.reduce((total, row) => total.plus(money(row.debit)).minus(money(row.credit)), money(0)).toFixed(2)).toBe("0.00");
    }
    const cancellation = await cancelSale({ invoiceId: reassigned.correctedInvoiceId, refundPaymentMethod: "CASH", clientRequestId: "ordinary-reassign-cancel", reason: "إلغاء الفاتورة المصححة" }, actor);
    expect(cancellation.refundAmount).toBe("8000.00");
    expect((await db().select().from(s.customers).where(eq(s.customers.id, 2)))[0].currentBalance).toBe("0.00");
  });
});
