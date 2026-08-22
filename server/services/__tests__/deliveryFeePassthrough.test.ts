/**
 * ٥/٨ — ثوابت «أجرة التوصيل تمريرٌ لا إيراد» (قرار المالك).
 *
 * الخلل الذي تحرسه هذه الاختبارات: كانت الأجرة تُضمّ إلى workOrders.salePrice في الاستقبال ⇒
 * إيرادٌ بهامش ١٠٠٪ في قيد SALE + نقدٌ في الدرج بلا مصرفٍ مقابل. وإذا دفع الزبون كامل المبلغ
 * مقدّماً صار codAmount=0 فتُنشَأ الإرسالية DELIVERED فوراً ولا يراها مسار التوريد أبداً ⇒
 * الأجرة تدخل الدرج مرّةً ولا تخرج قط، والموظّف يسلّمها للمندوب فيعجز عن إغلاق ورديته
 * (enforceCashGovernance يرفض أيّ فرق).
 *
 * الثوابت المُثبَّتة هنا:
 *  I1 — الأجرة ليست جزءاً من salePrice/الفاتورة/قيد SALE في أيّ وضع.
 *  I2 — COURIER: صفر أثرٍ على الدرج وعلى الدفتر (يقبضها المندوب من الزبون مباشرةً).
 *  I3 — COUNTER: تدخل الدرج إيصالاً مستقلاً عند الاستقبال، وتخرج للمندوب عند الإرسال ⇒
 *       صافي الدرج منها صفر، وبلا أيّ أثرٍ على الربح (تمرير لا مصروف).
 *  I4 — الأجرة لا تُصرَف مرّتين: ما سُوّي عند الإرسال لا يُخصَم ثانيةً من التوريد.
 *  I5 — طلبٌ مدفوعٌ كاملاً (codAmount=0) لم يعُد يبتلع الأجرة صامتاً.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { openShift } from "../shiftService";
import { createWorkOrder } from "../workOrderService";
import { createPostingIntent, creditLine, debitLine } from "../accounting/postingEngine";
import { postEntry } from "../ledgerService";
import { money } from "../money";
import { withTx } from "../tx";
import {
  confirmConsignmentDelivery,
  createDeliveryParty,
  dispatchToDelivery,
  listOpenConsignments,
  payDeliveryFee,
  recordDeliveryRemittance,
  returnConsignment,
  transitionConsignmentParcel,
} from "../deliveryService";
import { reconcileDeliveryFloat, reconcileLedgerProfit } from "../reconcileService";

const TABLES = [
  "journalLines", "journalEntries", "doubleEntrySettings",
  "idempotencyKeys", "accountingEntries", "receipts",
  "deliveryOutbox", "deliveryEvents", "deliveryLedgerEntries", "deliveryRemittanceLines", "deliveryPartyMembers",
  "deliveryConsignments", "deliveryRemittances", "deliveryParties",
  "invoiceItems", "invoices", "inventoryMovements", "branchStock",
  "workOrderMaterials", "workOrderImages", "workOrders",
  "productPrices", "productUnits", "productVariants", "products",
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

const CASHIER = { userId: 2, branchId: 1, role: "cashier" };
const MANAGER = { userId: 1, branchId: 1, role: "manager" };

async function seed() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    { id: 1, openId: "local_mgr", name: "مدير", email: "m@t.test", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "local_cashier", name: "كاشير", email: "c@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "local_courier", name: "مندوب", email: "d@t.test", role: "courier", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.doubleEntrySettings).values({
    id: 1,
    mode: "SHADOW",
    shadowCycleId: "delivery-fee-accrual-test",
  });
  await d.insert(s.customers).values([{ id: 1, name: "عميل", phone: "+9647700000000" }]);
  await d.insert(s.products).values([{ id: 1, name: "كتاب" }]);
  await d.insert(s.productVariants).values([{ id: 1, productId: 1, sku: "BK-1", costPrice: "0.00" }]);
  await d.insert(s.branchStock).values([{ variantId: 1, branchId: 1, quantity: 100 }]);
  const { id: partyId } = await createDeliveryParty(
    { partyType: "INDIVIDUAL", name: "مندوب", defaultFee: "1500", userId: 3, branchId: 1 }, MANAGER,
  );
  return { partyId };
}

/** صافي درج الوردية = Σ(IN) − Σ(OUT) للنقد DRAWER. */
async function drawerNet(shiftId: number): Promise<number> {
  const r = (await db()
    .select({
      net: sql<string>`COALESCE(SUM(CASE WHEN ${s.receipts.direction}='IN' THEN ${s.receipts.amount} ELSE -${s.receipts.amount} END),0)`,
    })
    .from(s.receipts)
    .where(and(eq(s.receipts.shiftId, shiftId), eq(s.receipts.paymentMethod, "CASH"), eq(s.receipts.cashBucket, "DRAWER"))))[0];
  return Number(r?.net ?? 0);
}
async function entries(type: string) {
  return db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, type as never));
}
async function courierPayableNet(): Promise<number> {
  const row = (await db()
    .select({
      net: sql<string>`COALESCE(SUM(${s.journalLines.credit} - ${s.journalLines.debit}), 0)`,
    })
    .from(s.journalLines)
    .where(eq(s.journalLines.role, "COURIER_PAYABLE")))[0];
  return Number(row?.net ?? 0);
}
async function roleNetDebit(role: string): Promise<number> {
  const row = (await db()
    .select({
      net: sql<string>`COALESCE(SUM(${s.journalLines.debit} - ${s.journalLines.credit}), 0)`,
    })
    .from(s.journalLines)
    .where(eq(s.journalLines.role, role)))[0];
  return Number(row?.net ?? 0);
}
async function makeOrder(opts: {
  deposit: string;
  fee: string;
  feeCollection: "COURIER" | "COUNTER" | "SHOP";
}): Promise<number> {
  const wo = await createWorkOrder({
    branchId: 1, customerId: 1, baseVariantId: 1, title: "طباعة",
    salePrice: "10000", quantity: 1,
    deposit: opts.deposit, paymentMethod: "CASH",
    hasDelivery: true, deliveryAddress: "بغداد",
    deliveryCost: opts.fee, deliveryFeeCollection: opts.feeCollection,
  }, { userId: 2, branchId: 1 });
  const woId = (wo as { workOrderId: number }).workOrderId;
  await db().update(s.workOrders).set({ status: "READY" }).where(eq(s.workOrders.id, woId));
  return woId;
}

async function deliver(consignmentId: number) {
  for (const toStatus of ["ACCEPTED", "PICKED_UP", "OUT_FOR_DELIVERY"] as const) {
    await transitionConsignmentParcel(
      { consignmentId, toStatus, clientRequestId: `fee-test-${consignmentId}-${toStatus}` },
      { userId: 3 },
    );
  }
  await confirmConsignmentDelivery(
    { consignmentId, clientRequestId: `fee-test-${consignmentId}-delivered` },
    { userId: 3 },
  );
}

describe("٥/٨ — أجرة التوصيل تمريرٌ لا إيراد", () => {
  beforeEach(async () => { await reset(); });

  it("I1+I2 — COURIER: الأجرة خارج الفاتورة والإيراد والدرج تماماً", async () => {
    const { partyId } = await seed();
    const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
    const woId = await makeOrder({ deposit: "2000", fee: "1500", feeCollection: "COURIER" });

    // الدرج بعد الاستقبال = العربون وحده (الأجرة لم تُقبض هنا).
    expect(await drawerNet(shift.shiftId)).toBe(2000);

    const disp = await dispatchToDelivery({ workOrderId: woId, partyId, deliveryFee: "1500" }, CASHIER);
    // COD = ما تبقّى على البضاعة فقط: 10000 − 2000. الأجرة ليست جزءاً منه.
    expect(disp.codAmount).toBe("8000.00");

    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, disp.invoiceId)).limit(1))[0];
    expect(inv.total).toBe("10000.00"); // بلا الأجرة
    const sale = await entries("SALE");
    expect(sale).toHaveLength(1);
    expect(sale[0].revenue).toBe("10000.00"); // الأجرة ليست إيراداً

    // لا إيصال درج ولا قيد أجرة عند الإرسال — يقبضها المندوب من الزبون.
    expect(await drawerNet(shift.shiftId)).toBe(2000);
    expect(await entries("DELIVERY_FEE")).toHaveLength(0);
    expect(await entries("DELIVERY_FEE_HELD")).toHaveLength(0);

    // التوريد: يورّد الـCOD كاملاً بلا خصم أجرة (قبضها بنفسه).
    await deliver(disp.consignmentId);
    const rem = await recordDeliveryRemittance(
      { branchId: 1, partyId, countedCash: "8000", lines: [{ consignmentId: disp.consignmentId, collectedAmount: "8000" }] },
      CASHIER,
    );
    expect(rem.feesTotal).toBe("0.00");
    expect(rem.netRemitted).toBe("8000.00");
    expect(await reconcileDeliveryFloat()).toEqual([]);
    expect(await reconcileLedgerProfit()).toEqual([]);
  });

  it("I3+I4 — COUNTER: تدخل الدرج أمانةً ثم تخرج للمندوب ⇒ صافيها صفر ولا تُصرَف مرّتين", async () => {
    const { partyId } = await seed();
    const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
    const woId = await makeOrder({ deposit: "2000", fee: "1500", feeCollection: "COUNTER" });

    // الأجرة قُبضت في الاستقبال بإيصالٍ مستقلّ ⇒ الدرج = عربون + أجرة.
    expect(await drawerNet(shift.shiftId)).toBe(3500);
    const held = await entries("DELIVERY_FEE_HELD");
    expect(held).toHaveLength(1);
    expect(held[0].amount).toBe("1500.00");
    expect(await courierPayableNet()).toBe(1500);
    expect(Number(held[0].cost ?? 0)).toBe(0); // تمرير: لا مصروف ولا ربح

    const disp = await dispatchToDelivery({ workOrderId: woId, partyId, deliveryFee: "1500" }, CASHIER);
    expect(disp.codAmount).toBe("8000.00");
    // لا تُدفع الأجرة قبل نجاح التوصيل.
    expect(await drawerNet(shift.shiftId)).toBe(3500);
    expect(await entries("DELIVERY_FEE")).toHaveLength(0); // ليست مصروفاً
    expect(await entries("DELIVERY_FEE_HELD")).toHaveLength(1);

    await deliver(disp.consignmentId);
    await payDeliveryFee(
      { consignmentId: disp.consignmentId, shiftId: shift.shiftId, clientRequestId: "counter-fee-paid" },
      CASHIER,
    );
    expect(await drawerNet(shift.shiftId)).toBe(2000);
    expect(await courierPayableNet()).toBe(0);
    expect(await entries("DELIVERY_FEE_HELD")).toHaveLength(2); // قبض + دفع بعد النجاح

    // I4 — لا تُخصَم ثانيةً من التوريد.
    const rem = await recordDeliveryRemittance(
      { branchId: 1, partyId, countedCash: "8000", lines: [{ consignmentId: disp.consignmentId, collectedAmount: "8000" }] },
      CASHIER,
    );
    expect(rem.feesTotal).toBe("0.00");
    expect(rem.netRemitted).toBe("8000.00");
    expect(await reconcileLedgerProfit()).toEqual([]);
  });

  it("I5 — طلبٌ مدفوعٌ كاملاً (COD=0) لم يعُد يبتلع الأجرة صامتاً", async () => {
    const { partyId } = await seed();
    const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
    // العربون = كامل السعر ⇒ codAmount = 0 (الحالة التي كانت تُنشئ إرسالية DELIVERED فوراً).
    const woId = await makeOrder({ deposit: "10000", fee: "1500", feeCollection: "COUNTER" });
    expect(await drawerNet(shift.shiftId)).toBe(11500); // 10000 + أجرة أمانةً

    const disp = await dispatchToDelivery({ workOrderId: woId, partyId, deliveryFee: "1500" }, CASHIER);
    expect(disp.codAmount).toBe("0.00");
    expect(await drawerNet(shift.shiftId)).toBe(11500);
    expect((await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, disp.consignmentId)).limit(1))[0].feeSettledAt).toBeNull();
    await deliver(disp.consignmentId);
    const feeQueue = await listOpenConsignments(partyId, 1);
    expect(feeQueue.find((c) => Number(c.id) === disp.consignmentId)?.feeDue).toBe("1500.00");
    await payDeliveryFee(
      { consignmentId: disp.consignmentId, shiftId: shift.shiftId, clientRequestId: "prepaid-counter-fee" },
      CASHIER,
    );
    expect((await listOpenConsignments(partyId, 1)).some((c) => Number(c.id) === disp.consignmentId)).toBe(false);
    expect(await drawerNet(shift.shiftId)).toBe(10000);
    const cn = (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, disp.consignmentId)).limit(1))[0];
    expect(cn.feeSettledAt).not.toBeNull();
    expect(await reconcileLedgerProfit()).toEqual([]);
  });

  it("SHOP — المكتبة تتحمّل الأجرة ⇒ مصروفٌ حقيقيّ يُخصَم من التوريد (السلوك القديم محفوظ)", async () => {
    const { partyId } = await seed();
    const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
    const woId = await makeOrder({ deposit: "2000", fee: "1500", feeCollection: "SHOP" });
    const disp = await dispatchToDelivery({ workOrderId: woId, partyId, deliveryFee: "1500" }, CASHIER);

    expect(await courierPayableNet()).toBe(0);
    await deliver(disp.consignmentId);
    expect(await courierPayableNet()).toBe(1500);
    const rem = await recordDeliveryRemittance(
      { branchId: 1, partyId, countedCash: "8000", lines: [{ consignmentId: disp.consignmentId, collectedAmount: "8000" }] },
      CASHIER,
    );
    expect(rem.feesTotal).toBe("0.00");
    expect(rem.netRemitted).toBe("8000.00");
    await payDeliveryFee(
      { consignmentId: disp.consignmentId, shiftId: shift.shiftId, clientRequestId: "shop-fee-paid" },
      CASHIER,
    );
    const fee = await entries("DELIVERY_FEE");
    expect(fee).toHaveLength(2);
    expect(await courierPayableNet()).toBe(0);
    expect(fee.reduce((sum, entry) => sum + Number(entry.cost), 0)).toBe(1500);
    const profiles = (await db().select({ profile: s.journalEntries.postingProfile }).from(s.journalEntries))
      .map((row) => row.profile);
    expect(profiles.filter((profile) => profile === "DELIVERY_FEE_ACCRUAL")).toHaveLength(1);
    expect(profiles.filter((profile) => profile === "DELIVERY_FEE_SETTLEMENT")).toHaveLength(1);
    expect(fee[0].cost).toBe("1500.00"); // مصروفٌ حقيقيّ (تتحمّله المكتبة)
    expect(await reconcileLedgerProfit()).toEqual([]);
  });

  it("releases work-order materials from WIP once and keeps them as COGS when a delivery return cancels the job", async () => {
    const { partyId } = await seed();
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
    const woId = await makeOrder({ deposit: "0", fee: "0", feeCollection: "COURIER" });
    await db().update(s.workOrders).set({ materialsCost: "4500.00", laborCost: "500.00" }).where(eq(s.workOrders.id, woId));
    await withTx(async (tx) => {
      const materialsCost = money("4500.00");
      const postingSourceComponents = {
        roleDebits: { WORK_IN_PROGRESS: materialsCost },
        roleCredits: { INVENTORY: materialsCost },
      } as const;
      await postEntry(tx, {
        entryType: "ADJUST",
        branchId: 1,
        amount: materialsCost,
        postingIntent: createPostingIntent("ADJUST_WIP_CONSUME", "ADJUST", [
          debitLine("WORK_IN_PROGRESS", materialsCost),
          creditLine("INVENTORY", materialsCost),
        ], postingSourceComponents),
        postingSourceComponents,
      });
    });
    expect(await roleNetDebit("WORK_IN_PROGRESS")).toBe(4500);

    const dispatched = await dispatchToDelivery({ workOrderId: woId, partyId, deliveryFee: "0" }, CASHIER);
    expect(await roleNetDebit("WORK_IN_PROGRESS")).toBe(0);
    expect(await roleNetDebit("COGS")).toBe(4500);

    await returnConsignment(dispatched.consignmentId, {
      ...MANAGER,
      clientRequestId: "return-cancelled-work-order-wip",
    });
    expect(await roleNetDebit("WORK_IN_PROGRESS")).toBe(0);
    expect(await roleNetDebit("COGS")).toBe(4500);
    const entriesForInvoice = await db().select().from(s.accountingEntries)
      .where(eq(s.accountingEntries.invoiceId, dispatched.invoiceId));
    expect(entriesForInvoice.find((entry) => entry.entryType === "SALE")?.cost).toBe("4500.00");
    expect(entriesForInvoice.find((entry) => entry.entryType === "RETURN")?.cost).toBe("0.00");
    expect(entriesForInvoice.reduce((sum, entry) => sum + Number(entry.profit), 0)).toBe(-4500);
    expect((await db().select().from(s.workOrders).where(eq(s.workOrders.id, woId)))[0].status).toBe("CANCELLED");
  });
});
