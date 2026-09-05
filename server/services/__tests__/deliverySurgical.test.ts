/**
 * جراحات حملة التوصيل (٢٢/٨) — سبعُ جراحات دقيقة على settle/remittance/queries/fees:
 *  ١) خسارة الشطب الموجَّه بالجزء الحقيقي (cost=realPart) وسقف الاسترداد عليه.
 *  ٢) حارس الفرع الصفري (branchId=0 كان يكتب قيوداً خارج كل التقارير).
 *  ٣) ائتمان الفاتورة في التوريد **مبلغيٌّ لا وجوديّ**: كشفٌ جزئيّ ثم توريدُ المتبقّي
 *     يُكمل تسديد الفاتورة بالمتراكم غير المقيَّد (كان النقد يدخل والفاتورة تعلق ناقصة).
 *  ٤) المتبقّي الحيّ = codAmount − collectedAmount − counterSettledAmount (سقفاً وعرضاً وإغلاقاً).
 *  ٥) storeInTransit لا يزدوج مع إرساليةٍ حيّة لنفس الطلب.
 *  ٦) payPartyDeliveryFees: صرف كل أجور الجهة بسند واحد وقيود لكل إرسالية، idempotent.
 *  ٧) listPartyObligations: تجميع التزامات الجهة (الأقدم أولاً) بعزل الفرع.
 * البيئة والبذرة على منوال deliveryFlow.test.ts حرفياً.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { openShift } from "../shiftService";
import { createWorkOrder } from "../workOrderService";
import {
  confirmConsignmentDelivery,
  createDeliveryParty,
  dispatchToDelivery,
  getPartyStoreInTransit,
  listInTransitConsignments,
  listOpenConsignments,
  recordDeliveryRemittance,
  recoverDeliveryWriteOff,
  settleDeliveryBalance,
  transitionConsignmentParcel,
  writeOffDeliveryShortfall,
} from "../deliveryService";
// الجديدتان تُستوردان من وحدتيهما مباشرةً — تسجيلهما في البرميل/الراوتر شأن قائد الدمج.
import { getConsignmentTimeline, listPartyObligations } from "../delivery/queries";
import { payPartyDeliveryFees } from "../delivery/fees";
import {
  reconcileCustomerBalances,
  reconcileDeliveryFloat,
  reconcileLedgerProfit,
} from "../reconcileService";

const TABLES = [
  "idempotencyKeys", "accountingEntries", "receipts",
  "deliveryOutbox", "deliveryEvents", "deliveryLedgerEntries", "deliveryRemittanceLines", "deliveryPartyMembers",
  "deliveryConsignments", "deliveryRemittances", "deliveryParties",
  "onlineOrders",
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
const OWNER = { userId: 4, branchId: 1, role: "admin" };
const WRITE_OFF_EVIDENCE = { evidenceNote: "محضر مطابقة عهدة موقع من طرفين" } as const;

async function seed() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "local_mgr", name: "مدير", email: "m@t.test", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "local_cashier", name: "كاشير", email: "c@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "local_courier", name: "مندوب", email: "d@t.test", role: "courier", loginMethod: "local", branchId: 1 },
    { id: 4, openId: "local_owner", name: "مالك", email: "o@t.test", role: "admin", loginMethod: "local", branchId: 1, isOwner: true },
  ]);
  await d.insert(s.customers).values([{ id: 1, name: "عميل التوصيل", phone: "+9647700000000" }]);
  await d.insert(s.products).values([{ id: 1, name: "كتاب مطبوع" }]);
  await d.insert(s.productVariants).values([{ id: 1, productId: 1, sku: "BK-1", costPrice: "0.00" }]);
  await d.insert(s.branchStock).values([{ variantId: 1, branchId: 1, quantity: 100 }]);
  const { id: partyId } = await createDeliveryParty(
    { partyType: "INDIVIDUAL", name: "مندوب", defaultFee: "1500", userId: 3, branchId: 1 },
    MANAGER,
  );
  return { partyId };
}

async function partyBalance(partyId: number): Promise<string> {
  const p = (await db().select({ b: s.deliveryParties.currentBalance }).from(s.deliveryParties).where(eq(s.deliveryParties.id, partyId)).limit(1))[0];
  return String(p?.b ?? "0");
}
async function invoice(id: number) {
  return (await db().select().from(s.invoices).where(eq(s.invoices.id, id)).limit(1))[0];
}
async function customerBalance(id: number): Promise<string> {
  const c = (await db().select({ b: s.customers.currentBalance }).from(s.customers).where(eq(s.customers.id, id)).limit(1))[0];
  return String(c?.b ?? "0");
}
async function consignment(id: number) {
  return (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, id)).limit(1))[0];
}
async function allReconcileClean() {
  expect(await reconcileDeliveryFloat()).toEqual([]);
  expect(await reconcileCustomerBalances()).toEqual([]);
  expect(await reconcileLedgerProfit()).toEqual([]);
}

/** ينشئ طلباً (سعر 10000، عربون 2000 نقداً) ويجعله READY. */
async function readyWorkOrder(
  feeCollection: "COURIER" | "COUNTER" | "SHOP" = "COURIER",
): Promise<number> {
  const wo = await createWorkOrder(
    {
      branchId: 1,
      customerId: 1,
      baseVariantId: 1,
      title: "طباعة",
      salePrice: "10000",
      quantity: 1,
      deposit: "2000",
      paymentMethod: "CASH",
      hasDelivery: true,
      deliveryAddress: "بغداد",
      deliveryFeeCollection: feeCollection,
    },
    { userId: 2, branchId: 1 },
  );
  const woId = (wo as { workOrderId: number }).workOrderId;
  await db().update(s.workOrders).set({ status: "READY" }).where(eq(s.workOrders.id, woId));
  return woId;
}

/** مسار بوّابة المندوب الكامل حتى ختم التسليم (تحصيل COD كاملاً). */
async function deliverViaPortal(consignmentId: number) {
  for (const toStatus of ["ACCEPTED", "PICKED_UP", "OUT_FOR_DELIVERY"] as const) {
    await transitionConsignmentParcel(
      { consignmentId, toStatus, clientRequestId: `surg-${consignmentId}-${toStatus}` },
      { userId: 3 },
    );
  }
  await confirmConsignmentDelivery(
    { consignmentId, clientRequestId: `surg-${consignmentId}-delivered` },
    { userId: 3 },
  );
}

/**
 * يحاكي «تسديداً كاونترياً» يخفض متبقّي الفاتورة من خارج مسار الإرسالية (كاتبُ العمود
 * الفعليّ شريحةُ عاملٍ آخر): paidAmount ↑ وذمّة العميل ↓ معاً كي تبقى مطابقة reconcile خضراء.
 */
async function simulateCounterPayment(invoiceId: number, customerId: number, amount: string) {
  await db().update(s.invoices)
    .set({ paidAmount: sql`${s.invoices.paidAmount} + ${amount}` })
    .where(eq(s.invoices.id, invoiceId));
  await db().update(s.customers)
    .set({ currentBalance: sql`${s.customers.currentBalance} - ${amount}` })
    .where(eq(s.customers.id, customerId));
}

/** يحاكي عهدةً معترفاً بها على الجهة (نمط تجهيزة deliveryFlow): قيد DISPATCH + رصيد. */
async function simulateCustody(partyId: number, amount: string, note: string, collectedLedger = true) {
  await db().insert(s.accountingEntries).values({
    entryType: "DELIVERY_DISPATCH", branchId: 1, deliveryPartyId: partyId,
    amount, entryDate: sql`CURDATE()` as unknown as Date,
    notes: note,
  });
  await db().update(s.deliveryParties)
    .set({ currentBalance: sql`${s.deliveryParties.currentBalance} + ${amount}` })
    .where(eq(s.deliveryParties.id, partyId));
  // م١ (حارس reconcileDeliveryFloat/deliveryPartyLedger، PR-3): العهدةُ المُسجَّلة نقداً يلزمها قيدُ
  // دفترٍ (COD_COLLECTED) كي يطابق `deriveCashInHandFromLedger` العمودَ المخزَّن. الافتراض `true` هو
  // المحاكاةُ الواقعيّة (عهدةٌ من تحصيلٍ فعليّ). ⛔ يُستثنى سيناريو العهدة الموروثة **المنفوخة** (ج١)
  // بـ`collectedLedger=false`: العهدةُ أكبرُ من التحصيل الحقيقيّ عمداً (خطأُ بياناتٍ موروث يُنظَّف بالشطب)،
  // فانحرافُ دفترها متوقَّعٌ ويُقاس بـ`reconcileCleanExceptLegacyLedger` لا يُساوى صفراً.
  if (collectedLedger) {
    await db().insert(s.deliveryLedgerEntries).values({
      eventKey: `SIM-CUSTODY-COD_COLLECTED:${partyId}:${note}`,
      partyId, branchId: 1, entryType: "COD_COLLECTED", amount, occurredAt: new Date(),
    });
  }
}

/**
 * م١ — reconcile نظيفٌ عدا انحرافِ الدفتر المتوقَّع لعهدةٍ موروثة منفوخة (ج١): `currentBalance` رُفع
 * فوق التحصيل الحقيقيّ بلا `COD_COLLECTED`، والشطبُ كتب `COD_WRITTEN_OFF` بكامل المبلغ (يتطلبه ثابتُ
 * DISPATCH−REMIT−WRITEOFF المحاسبيّ) ⇒ `deliveryPartyLedger` ينحرف حتماً. الحارسُ المحاسبيّ
 * (`deliveryParty`) والعميلُ والربحُ تبقى نظيفةً — وهو ما يهمّ.
 */
async function reconcileCleanExceptLegacyLedger() {
  const floatIssues = await reconcileDeliveryFloat();
  expect(floatIssues.every((i) => i.entity === "deliveryPartyLedger")).toBe(true);
  expect(await reconcileCustomerBalances()).toEqual([]);
  expect(await reconcileLedgerProfit()).toEqual([]);
}

describe("delivery surgical fixes — settle/remittance/queries/fees", () => {
  beforeEach(async () => {
    await reset();
  });

  it("ج١: شطب موجَّه فيه جزء وهمي ⇒ الخسارة الحقيقية وحدها، والاسترداد مسقوفٌ بها", async () => {
    const { partyId } = await seed();
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
    const woId = await readyWorkOrder();
    const disp = await dispatchToDelivery({ workOrderId: woId, partyId, deliveryFee: "0" }, CASHIER);
    // صفٌّ موروث: مُسلَّم بعهدةٍ معترفٍ بها **بلا تسوية فاتورة ولا دليل تحصيلٍ في دفتر
    // التوصيل** (لا COD_COLLECTED) — فالخسارة الحقيقية عند الشطب = الذمّة الحيّة المُبرَّأة
    // وحدها (realPart)، وما فوقها انحرافُ codAmount لا مالٌ خُسر. (الشطبُ بعد تسليمٍ مثبتِ
    // التحصيل دفترياً يبقى خسارةً كاملة — تحرسه G3/G4/G15 في deliverySettlementGuards.)
    await db().update(s.deliveryConsignments)
      .set({ parcelStatus: "DELIVERED", custodyRecognizedAt: new Date() })
      .where(eq(s.deliveryConsignments.id, disp.consignmentId));
    await simulateCustody(partyId, "8000.00", "عهدة موروثة (تجهيزة اختبار)", false); // منفوخة: بلا COD_COLLECTED (custodyHeld=0 ⇒ realLoss=realPart)
    // تسديد كاونتري لاحق 3000 ⇒ متبقّي الفاتورة الحيّ 5000 < متبقّي الإرسالية 8000.
    await simulateCounterPayment(disp.invoiceId, 1, "3000.00");

    await writeOffDeliveryShortfall(
      { branchId: 1, partyId, amount: "8000", reason: "ضياع نقد المندوب", consignmentId: disp.consignmentId, ...WRITE_OFF_EVIDENCE },
      OWNER,
    );

    // قيد الشطب: amount كامل (مطابقة العهدة) — cost/profit على الجزء الحقيقي 5000 وحده.
    const wo = (await db().select().from(s.accountingEntries)
      .where(and(eq(s.accountingEntries.entryType, "DELIVERY_WRITEOFF"), eq(s.accountingEntries.deliveryPartyId, partyId))))[0];
    expect(String(wo.amount)).toBe("8000.00");
    expect(String(wo.cost)).toBe("5000.00");
    expect(String(wo.profit)).toBe("-5000.00");
    const inv = await invoice(disp.invoiceId);
    expect(inv.paidAmount).toBe("10000.00"); // realPart وحده قيَّد الفاتورة
    expect(inv.status).toBe("PAID");
    expect(await customerBalance(1)).toBe("0.00");
    expect(await partyBalance(partyId)).toBe("0.00");
    expect((await consignment(disp.consignmentId)).status).toBe("WRITTEN_OFF");
    await reconcileCleanExceptLegacyLedger(); // عهدةٌ منفوخة موروثة ⇒ انحرافُ دفترٍ متوقَّع، والمحاسبيّ نظيف

    // السقف = الخسارة الحقيقية (5000) لا كامل المبلغ (8000): الوهمي لم يكن خسارةً فلا يُستردّ.
    await expect(
      recoverDeliveryWriteOff({ branchId: 1, partyId, amount: "8000" }, MANAGER),
    ).rejects.toThrow(/يتجاوز صافي الخسارة المشطوبة/);
    const rec = await recoverDeliveryWriteOff({ branchId: 1, partyId, amount: "5000" }, MANAGER);
    expect(rec.recovered).toBe("5000.00");
    await expect(
      recoverDeliveryWriteOff({ branchId: 1, partyId, amount: "1" }, MANAGER),
    ).rejects.toThrow(/يتجاوز صافي الخسارة المشطوبة/);
    await reconcileCleanExceptLegacyLedger(); // كما أعلاه: العهدة الموروثة المنفوخة تُبقي انحرافَ دفترٍ متوقَّعاً
  });

  it("ج٢: branchId غير موجب يُرفض في التسوية والشطب والاسترداد قبل أي كتابة", async () => {
    const { partyId } = await seed();
    for (const branchId of [0, -1]) {
      await expect(
        settleDeliveryBalance({ branchId, partyId, amount: "1000" }, MANAGER),
      ).rejects.toThrow(/لا فرع مسند/);
      await expect(
        writeOffDeliveryShortfall({ branchId, partyId, amount: "1000", reason: "سبب كافٍ", ...WRITE_OFF_EVIDENCE }, OWNER),
      ).rejects.toThrow(/لا فرع مسند/);
      await expect(
        recoverDeliveryWriteOff({ branchId, partyId, amount: "1000" }, MANAGER),
      ).rejects.toThrow(/لا فرع مسند/);
    }
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
  });

  it("ج٣: كشف جزئي ثم توريد المتبقّي ⇒ الفاتورة تُسدَّد بالمتراكم غير المقيَّد", async () => {
    const { partyId } = await seed();
    const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
    const woId = await readyWorkOrder();
    const disp = await dispatchToDelivery({ workOrderId: woId, partyId, deliveryFee: "0" }, CASHIER);

    // كشف الشركة يثبت تسليماً بتحصيلٍ جزئي 5000 من 8000 — يكتب قيد COURIER_DELIVERY الجزئي.
    await confirmConsignmentDelivery(
      {
        consignmentId: disp.consignmentId,
        clientRequestId: `stmt-partial-${disp.consignmentId}`,
        statementWitness: { partyId, statementNumber: "ST-100", collectedAmount: "5000" },
      },
      { userId: 1 },
    );
    expect((await invoice(disp.invoiceId)).paidAmount).toBe("7000.00"); // 2000 عربون + 5000
    expect(await partyBalance(partyId)).toBe("5000.00");

    // توريد الجزء المُثبَت: مقيَّدٌ سلفاً لحظة التسليم ⇒ لا ائتمان ثانٍ (نقل عهدةٍ إلى نقد).
    await recordDeliveryRemittance(
      { branchId: 1, partyId, countedCash: "5000", lines: [{ consignmentId: disp.consignmentId, collectedAmount: "5000" }] },
      CASHIER,
    );
    expect((await invoice(disp.invoiceId)).paidAmount).toBe("7000.00");
    expect(await partyBalance(partyId)).toBe("0.00");
    expect((await consignment(disp.consignmentId)).moneyStatus).toBe("PARTIAL");
    await allReconcileClean();

    // الجهة حصّلت المتبقّي 3000 لاحقاً (المطابقة المالية تعترف بالعهدة) ثم ورّدته.
    await simulateCustody(partyId, "3000.00", "اعتراف عهدة المتبقّي (تجهيزة اختبار)");
    await recordDeliveryRemittance(
      { branchId: 1, partyId, countedCash: "3000", lines: [{ consignmentId: disp.consignmentId, collectedAmount: "3000" }] },
      CASHIER,
    );

    // قبل الجراحة: وجود قيد COURIER_DELIVERY كان يُصفّر الائتمان ⇒ نقدٌ في الدرج وفاتورة
    // عالقة 7000 للأبد. بعدها: المتراكم (8000) − المقيَّد (5000) = 3000 يُقيَّد الآن.
    const inv = await invoice(disp.invoiceId);
    expect(inv.paidAmount).toBe("10000.00");
    expect(inv.status).toBe("PAID");
    expect(await customerBalance(1)).toBe("0.00");
    const cn = await consignment(disp.consignmentId);
    expect(cn.moneyStatus).toBe("SETTLED");
    expect(cn.status).toBe("DELIVERED");
    // الدرج: عربون 2000 + توريد 5000 + توريد 3000.
    const drawer = (await db().select({
      net: sql<string>`COALESCE(SUM(CASE WHEN ${s.receipts.direction}='IN' THEN ${s.receipts.amount} ELSE -${s.receipts.amount} END),0)`,
    }).from(s.receipts).where(and(eq(s.receipts.shiftId, shift.shiftId), eq(s.receipts.cashBucket, "DRAWER"))))[0];
    expect(Number(drawer.net)).toBe(10000);
    await allReconcileClean();
  });

  it("ج٤: counterSettledAmount يدخل المتبقّي الحيّ — codDue في الشاشة، سقف التوريد، والإغلاق", async () => {
    const { partyId } = await seed();
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
    const woId = await readyWorkOrder();
    const disp = await dispatchToDelivery({ workOrderId: woId, partyId, deliveryFee: "0" }, CASHIER);
    // زبونٌ سدّد 3000 بالكاونتر (كاتب العمود شريحة أخرى — يُحاكى هنا).
    await simulateCounterPayment(disp.invoiceId, 1, "3000.00");
    await db().update(s.deliveryConsignments)
      .set({ counterSettledAmount: "3000.00" })
      .where(eq(s.deliveryConsignments.id, disp.consignmentId));

    // الشاشة: codDue يطرح الكاونتر، والأعمدة الجديدة (invoiceTotal/partyHasPortal) حاضرة.
    const { rows } = await listInTransitConsignments(1);
    const row = rows.find((r) => Number(r.id) === disp.consignmentId);
    expect(row?.codDue).toBe("5000.00");
    expect(String(row?.counterSettledAmount)).toBe("3000.00");
    expect(String(row?.invoiceTotal)).toBe("10000.00");
    expect(Number(row?.partyHasPortal)).toBe(1); // للجهة حساب مندوب (userId=3)
    expect(row?.address).toBe("بغداد"); // COALESCE: عنوان الإرسالية المنسوخ من أمر الشغل

    // كشف الشركة يثبت تحصيل المتبقّي الحيّ 5000.
    await confirmConsignmentDelivery(
      {
        consignmentId: disp.consignmentId,
        clientRequestId: `stmt-counter-${disp.consignmentId}`,
        statementWitness: { partyId, statementNumber: "ST-200", collectedAmount: "5000" },
      },
      { userId: 1 },
    );
    // سقف التوريد بالمتبقّي الحيّ: 6000 > (8000 − 0 − 3000) ⇒ يُرفض.
    await expect(recordDeliveryRemittance(
      { branchId: 1, partyId, countedCash: "6000", lines: [{ consignmentId: disp.consignmentId, collectedAmount: "6000" }] },
      CASHIER,
    )).rejects.toThrow(/أكثر من المتبقّي/);
    // توريد 5000 = المتبقّي الحيّ كاملاً ⇒ الإغلاق SETTLED لا PARTIAL زومبي.
    await recordDeliveryRemittance(
      { branchId: 1, partyId, countedCash: "5000", lines: [{ consignmentId: disp.consignmentId, collectedAmount: "5000" }] },
      CASHIER,
    );
    const cn = await consignment(disp.consignmentId);
    expect(cn.moneyStatus).toBe("SETTLED");
    expect(cn.status).toBe("DELIVERED");
    expect(cn.settledAt).not.toBeNull();
    const inv = await invoice(disp.invoiceId);
    expect(inv.paidAmount).toBe("10000.00");
    expect(inv.status).toBe("PAID");
    expect(await partyBalance(partyId)).toBe("0.00");
    await allReconcileClean();
  });

  it("ج٥: storeInTransit لا يعدّ طلباً له إرسالية حيّة — ويستعيده حين تموت الإرسالية", async () => {
    const { partyId } = await seed();
    await db().insert(s.invoices).values({
      id: 500, invoiceNumber: "INV-OT-1", sourceType: "ONLINE", branchId: 1,
      subtotal: "9000.00", total: "9000.00", paidAmount: "0.00", status: "CONFIRMED",
    });
    await db().insert(s.onlineOrders).values({
      id: 700, orderNumber: "ORD-700", customerId: 1, branchId: 1, invoiceId: 500,
      subtotal: "9000.00", total: "9000.00", status: "SHIPPED", deliveryPartyId: partyId,
    });
    await db().insert(s.deliveryConsignments).values({
      id: 900, consignmentNumber: "CN-T-900", branchId: 1, partyId, invoiceId: 500,
      sourceType: "ONLINE_ORDER", sourceId: 700, codAmount: "9000.00",
    });

    // إرسالية حيّة لنفس الطلب ⇒ تعرّضه معروض في قوائم الإرساليات، فلا يُعدّ هنا ثانيةً.
    const whileLive = await getPartyStoreInTransit(partyId);
    expect(whileLive.count).toBe(0);
    expect(Number(whileLive.value)).toBe(0);

    // إرسالية ملغاة/مرتجعة = ميتة ⇒ يعود الطلب لعدسة المتجر كي لا يسقط من كل العدّادات.
    await db().update(s.deliveryConsignments).set({ status: "CANCELLED" }).where(eq(s.deliveryConsignments.id, 900));
    const afterCancel = await getPartyStoreInTransit(partyId);
    expect(afterCancel.count).toBe(1);
    expect(Number(afterCancel.value)).toBe(9000);
    await db().update(s.deliveryConsignments).set({ status: "RETURNED" }).where(eq(s.deliveryConsignments.id, 900));
    expect((await getPartyStoreInTransit(partyId)).count).toBe(1);
  });

  it("ج٦: payPartyDeliveryFees يصرف كل المستحق بسند واحد وقيود لكل إرسالية — وidempotent", async () => {
    const { partyId } = await seed();
    const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
    const wo1 = await readyWorkOrder("SHOP");
    const wo2 = await readyWorkOrder("SHOP");
    const d1 = await dispatchToDelivery({ workOrderId: wo1, partyId, deliveryFee: "1500" }, CASHIER);
    const d2 = await dispatchToDelivery({ workOrderId: wo2, partyId, deliveryFee: "2000" }, CASHIER);
    await deliverViaPortal(d1.consignmentId);
    await deliverViaPortal(d2.consignmentId);
    await recordDeliveryRemittance({
      branchId: 1, partyId, countedCash: "16000",
      lines: [
        { consignmentId: d1.consignmentId, collectedAmount: "8000" },
        { consignmentId: d2.consignmentId, collectedAmount: "8000" },
      ],
    }, CASHIER);
    // قبل الصرف: أجرتان مستحقّتان في طابور «أجرة غير مدفوعة».
    const { rows: openBefore } = await listOpenConsignments(partyId, 1);
    expect(openBefore.map((c) => String(c.feeDue)).sort()).toEqual(["1500.00", "2000.00"]);

    const res = await payPartyDeliveryFees(
      { partyId, branchId: 1, shiftId: shift.shiftId, clientRequestId: "bulk-fees-1" },
      CASHIER,
    );
    expect(res.paidTotal).toBe("3500.00");
    expect(res.count).toBe(2);
    expect(res.replay).toBe(false);

    // سند صرف واحد بمجموع الأجور — لا إيصال لكل إرسالية.
    const feeReceipts = await db().select().from(s.receipts)
      .where(and(eq(s.receipts.direction, "OUT"), eq(s.receipts.referenceNumber, `DLV-FEES-${partyId}`)));
    expect(feeReceipts).toHaveLength(1);
    expect(String(feeReceipts[0].amount)).toBe("3500.00");
    // قيد FEE_PAID دفتري + قيد DELIVERY_FEE محاسبي لكل إرسالية، وختم feeSettledAt عليهما.
    const paidLedger = await db().select().from(s.deliveryLedgerEntries)
      .where(eq(s.deliveryLedgerEntries.entryType, "FEE_PAID"));
    expect(paidLedger).toHaveLength(2);
    const settlementEntries = await db().select().from(s.accountingEntries)
      .where(and(eq(s.accountingEntries.entryType, "DELIVERY_FEE"), eq(s.accountingEntries.receiptId, feeReceipts[0].id)));
    expect(settlementEntries).toHaveLength(2);
    expect((await consignment(d1.consignmentId)).feeSettledAt).not.toBeNull();
    expect((await consignment(d2.consignmentId)).feeSettledAt).not.toBeNull();
    // الطابور فرغ من الأجور.
    expect((await listOpenConsignments(partyId, 1)).rows).toHaveLength(0);

    // التكرار بنفس المفتاح = نفس السند بنتيجته، بلا قيدٍ أو إيصالٍ ثانٍ.
    const replay = await payPartyDeliveryFees(
      { partyId, branchId: 1, shiftId: shift.shiftId, clientRequestId: "bulk-fees-1" },
      CASHIER,
    );
    expect(replay.replay).toBe(true);
    expect(replay.paidTotal).toBe("3500.00");
    expect(replay.count).toBe(2);
    expect(await db().select().from(s.deliveryLedgerEntries).where(eq(s.deliveryLedgerEntries.entryType, "FEE_PAID"))).toHaveLength(2);
    // مفتاح جديد بلا مستحق ⇒ رفض واضح لا سند صفري.
    await expect(payPartyDeliveryFees(
      { partyId, branchId: 1, shiftId: shift.shiftId, clientRequestId: "bulk-fees-2" },
      CASHIER,
    )).rejects.toThrow(/لا أجور مستحقّة/);
    await allReconcileClean();
  });

  it("ج٧: listPartyObligations يجمّع (مفتوح/متبقٍّ حي/أجور/عهدة) بعزل الفرع، وgetConsignmentTimeline يروي القصّة", async () => {
    const { partyId } = await seed();
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
    const wo1 = await readyWorkOrder();
    const wo2 = await readyWorkOrder();
    const d1 = await dispatchToDelivery({ workOrderId: wo1, partyId, deliveryFee: "0" }, CASHIER);
    const d2 = await dispatchToDelivery({ workOrderId: wo2, partyId, deliveryFee: "0" }, CASHIER);
    // الثانية أُعلن رجوعُها ⇒ تخرج من codDueTotal وتبقى في openCount حتى تُستلَم.
    await db().update(s.deliveryConsignments)
      .set({ returnDeclaredAt: new Date(), returnDeclaredReason: "رفض العميل" })
      .where(eq(s.deliveryConsignments.id, d2.consignmentId));

    let obligations = await listPartyObligations(1);
    expect(obligations).toHaveLength(1);
    let ob = obligations[0];
    expect(ob.partyId).toBe(partyId);
    expect(ob.openCount).toBe(2);
    expect(Number(ob.codDueTotal)).toBe(8000); // الأولى وحدها — المُعلَن رجوعُه مستثنى
    expect(Number(ob.feeDueTotal)).toBe(0);
    expect(ob.hasPortal).toBe(true);
    expect(ob.oldestOpenAgeHours).not.toBeNull();
    expect(Number(ob.oldestOpenAgeHours)).toBeGreaterThanOrEqual(0);
    expect(ob.lastRemittanceAt).toBeNull();
    // عزل الفرع: الجهة مملوكة للفرع 1 ولا التزام لها في الفرع 2.
    expect(await listPartyObligations(2)).toEqual([]);

    // تسليم الأولى وتوريد جزئي ⇒ عهدة 3000 ومتبقٍّ حي 3000 وتوريد مسجَّل.
    await deliverViaPortal(d1.consignmentId);
    await recordDeliveryRemittance(
      { branchId: 1, partyId, countedCash: "5000", lines: [{ consignmentId: d1.consignmentId, collectedAmount: "5000" }] },
      CASHIER,
    );
    obligations = await listPartyObligations(1);
    ob = obligations[0];
    expect(ob.openCount).toBe(2); // PARTIAL + DISPATCHED
    expect(Number(ob.codDueTotal)).toBe(3000);
    expect(ob.currentBalance).toBe("3000.00");
    expect(ob.lastRemittanceAt).not.toBeNull();

    // الخطّ الزمنيّ: الصفّ المفصّل + الأحداث تصاعدياً بأسماء فاعليها + قيود دفتر الإرسالية.
    const timeline = await getConsignmentTimeline(d1.consignmentId);
    expect(timeline).not.toBeNull();
    expect(timeline!.consignment.partyName).toBe("مندوب");
    expect(String(timeline!.consignment.codAmount)).toBe("8000.00");
    expect(timeline!.consignment.orderNumber).toBeTruthy();
    expect(timeline!.consignment.address).toBe("بغداد");
    const eventTypes = timeline!.events.map((e) => e.eventType);
    expect(eventTypes).toContain("DELIVERED");
    expect(eventTypes.indexOf("DELIVERED")).toBeGreaterThan(eventTypes.indexOf("ACCEPTED"));
    expect(timeline!.events.every((e, i, arr) => i === 0 || arr[i - 1].occurredAt <= e.occurredAt)).toBe(true);
    const delivered = timeline!.events.find((e) => e.eventType === "DELIVERED");
    expect(delivered?.actorName).toBe("مندوب");
    const ledgerTypes = timeline!.ledger.map((l) => l.entryType);
    expect(ledgerTypes).toContain("COD_COLLECTED");
    expect(ledgerTypes).toContain("COD_REMITTED");
    expect(await getConsignmentTimeline(999999)).toBeNull();
    await allReconcileClean();
  });
});
