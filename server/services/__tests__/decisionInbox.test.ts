/**
 * صندوق «مطلوب مني الآن» من سجلّ القرارات (م٧ ق٢) — عقودٌ على القاعدة:
 *  · الصفّ يعرض **ما يُقرَّر عليه**: المورّد والأصناف بكمّياتها وأسعارها والإجماليّ — لا «3 أسطر».
 *  · البوّابة مرآةُ الإجراء الأصليّ: الكاشير لا يرى ولا يحسم؛ المالك يحسم مباشرةً.
 *  · فصلُ المهام كما في الخدمة: الطالب لا يرى طلبه في صندوقه ولا يحسمه.
 *  · النتيجةُ مُهيكَلة: الحسمُ الثاني على طلبٍ حُسم يعود `STALE` لا «نجاحاً» ولا خطأً أحمر.
 */
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { decisionSourceCoverage } from "../decisions";
import { submitPurchaseOrderForApproval } from "../purchase/controls";
import { createPurchaseOrder } from "../purchaseService";
import { allDecisions } from "@shared/decisionRegistry";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

const TABLES = [
  "idempotencyKeys", "auditLogs", "accountingEntries", "receipts", "expenses", "inventoryMovements",
  "stockAdjustmentRequests", "purchaseOrderEvents", "purchaseOrderControlRequests",
  "purchaseOrderRequisitionAllocations", "purchaseOrderRevisionItems", "purchaseOrderRevisions",
  "purchaseOrderItems", "purchaseOrders", "branchStock", "productPrices", "productUnits",
  "productVariants", "products", "suppliers", "shifts", "users", "branches",
];

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

const CREATOR = 1; // أدمن غير مالك — يُنشئ ويُرسل أمر الشراء (الطالب)
const OWNER = 2; // مالك نشط — يعتمد مباشرةً
const CASHIER = 4;
const MANAGER = 6; // مدير مشتريات مستقلّ في الفرع 1

async function seed() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: CREATOR, openId: "adm", name: "أدمن منشئ", role: "admin", loginMethod: "local", branchId: 1, isActive: true, isOwner: false },
    { id: OWNER, openId: "owner", name: "المالك", role: "admin", loginMethod: "local", branchId: 1, isActive: true, isOwner: true },
    { id: CASHIER, openId: "c1", name: "كاشير", role: "cashier", loginMethod: "local", branchId: 1, isActive: true },
    { id: MANAGER, openId: "mgr", name: "مدير مشتريات", role: "manager", loginMethod: "local", branchId: 1, isActive: true },
  ]);
  await d.insert(s.products).values([{ id: 1, name: "ورق A4" }, { id: 2, name: "حبر أسود" }]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "PAP-A4", costPrice: "200.00" },
    { id: 2, productId: 2, sku: "INK-BLK", costPrice: "9000.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "رزمة", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 2, unitName: "علبة", conversionFactor: "1", isBaseUnit: true },
  ]);
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 10 },
    { variantId: 2, branchId: 1, quantity: 3 },
  ]);
  await d.insert(s.suppliers).values({ id: 1, name: "مورد الورق", currentBalance: "0" });
}

async function caller(userId: number) {
  const [user] = await db().select().from(s.users).where(eq(s.users.id, userId)).limit(1);
  const ctx = { req: { headers: {} }, res: { cookie() {}, clearCookie() {} }, user } as never;
  return appRouter.createCaller(ctx);
}

async function submitPurchase() {
  const po = await createPurchaseOrder(
    {
      supplierId: 1,
      branchId: 1,
      items: [
        { variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "200.00" },
        { variantId: 2, productUnitId: 2, quantity: "2", unitPrice: "9000.00" },
      ],
    },
    { userId: CREATOR, branchId: 1, role: "admin" },
  );
  const submitted = await submitPurchaseOrderForApproval(
    { purchaseOrderId: po.purchaseOrderId, expectedVersion: po.version, reason: "طلب اعتماد أمر شراء الورق والحبر", requestKey: `m7-submit:${randomUUID()}` },
    { userId: CREATOR, branchId: 1, role: "admin" },
  );
  return { po, requestId: submitted.requestId };
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("التغطية مقابل السجل", () => {
  it("كل نوع موصول مسجل في السجل، والموصول لا يقل عن اربعين نوعا", () => {
    const registered = new Set(allDecisions().map((d) => d.kind));
    const { wired } = decisionSourceCoverage();
    for (const k of wired) expect(registered.has(k), k).toBe(true);
    expect(wired.length).toBeGreaterThanOrEqual(40);
    expect(new Set(wired).size).toBe(wired.length);
  });
});

describe("decisions.inbox — الصف يعرض ما يقرر عليه", () => {
  it("طلب شراء معلق يظهر للمالك بالمورد والاصناف والاسعار والاجمالي — لا عدد اسطر", async () => {
    const { po, requestId } = await submitPurchase();
    const owner = await caller(OWNER);
    const inbox = await owner.decisions.inbox();
    expect(inbox.failedSources).toEqual([]);
    const row = inbox.rows.find((r) => r.kind === "purchase.order.control" && r.id === requestId);
    expect(row).toBeDefined();
    expect(row!.party).toBe("مورد الورق");
    expect(row!.amount).toBe("20000.00");
    expect(row!.currency).toBe("IQD");
    expect(row!.href).toBe(`/purchases/${po.purchaseOrderId}`);
    expect(row!.summaryItems).toHaveLength(2);
    const paper = row!.summaryItems.find((i) => i.label.includes("ورق A4"));
    expect(paper).toMatchObject({ unitPrice: "200.00" });
    expect(String(paper!.qty)).toMatch(/^10/);
    expect(row!.confirmations.map((c) => c.key)).toEqual(["confirmedFullReceipt"]);
    expect(row!.allowedActions).toEqual(["APPROVE", "REJECT"]);
    expect(row!.approveReason).toBe("REQUIRED");
    expect(row!.sla).toMatchObject({ hours: 48, breached: false });
    expect(row!.requestedBy).toBe(CREATOR);
    expect(inbox.kinds).toContain("purchase.order.control");
  });

  it("المدير المستقل يراه؛ والطالب لا يرى طلبه؛ والكاشير لا يملك بوابة المشتريات", async () => {
    const { requestId } = await submitPurchase();
    const manager = (await (await caller(MANAGER)).decisions.inbox()).rows;
    expect(manager.some((r) => r.kind === "purchase.order.control" && r.id === requestId)).toBe(true);

    const requester = await (await caller(CREATOR)).decisions.inbox();
    expect(requester.rows.some((r) => r.kind === "purchase.order.control" && r.id === requestId)).toBe(false);

    const cashier = await (await caller(CASHIER)).decisions.inbox();
    expect(cashier.kinds).not.toContain("purchase.order.control");
    expect(cashier.rows.some((r) => r.kind === "purchase.order.control")).toBe(false);
  });

  it("مصروف معلق يظهر للمالك وحده بمبلغه وطرفه، ويرفض في مكانه بسبب", async () => {
    const [receipt] = await db().insert(s.receipts).values({
      branchId: 1, direction: "OUT", amount: "150000.00", paymentMethod: "CASH", cashBucket: null, shiftId: null,
      status: "PENDING", approvalStatus: "PENDING_APPROVAL", description: "صيانة مكيف الصالة", createdBy: CASHIER,
    }).$returningId();
    const [expense] = await db().insert(s.expenses).values({
      branchId: 1, expenseDate: new Date("2026-09-01"), category: "MAINTENANCE", amount: "150000.00", paymentMethod: "CASH",
      cashBucket: null, source: "CASH", description: "صيانة مكيف الصالة", payee: "ورشة التبريد", receiptId: receipt.id,
      status: "PENDING_APPROVAL", createdBy: CASHIER,
    }).$returningId();

    const owner = await caller(OWNER);
    const row = (await owner.decisions.inbox()).rows.find((r) => r.kind === "expense.approve" && r.id === expense.id);
    expect(row).toMatchObject({ amount: "150000.00", party: "ورشة التبريد", trigger: "MONEY_OUT" });
    expect(row!.sla?.hours).toBe(24);

    const managerRows = (await (await caller(MANAGER)).decisions.inbox()).rows;
    expect(managerRows.some((r) => r.kind === "expense.approve")).toBe(false);

    const res = await owner.decisions.decide({ kind: "expense.approve", id: expense.id, action: "REJECT", clientRequestId: randomUUID(), reason: "لا فاتورة من الورشة" });
    expect(res.outcome).toBe("REJECTED");
    const [after] = await db().select({ status: s.expenses.status }).from(s.expenses).where(eq(s.expenses.id, expense.id));
    expect(after!.status).toBe("REJECTED");
  });
});

describe("decisions.decide — الحسم في مكانه بنتيجة مهيكلة", () => {
  it("الكاشير يرفض ببوابة الاجراء الاصلي، والطالب يرفض بفصل المهام، والمالك يحسم مباشرة ثم STALE", async () => {
    const { requestId } = await submitPurchase();
    const input = { kind: "purchase.order.control", id: requestId, action: "REJECT" as const, reason: "الأسعار أعلى من عرض المورد الأخير" };

    await expect((await caller(CASHIER)).decisions.decide({ ...input, clientRequestId: randomUUID() }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });

    await expect((await caller(CREATOR)).decisions.decide({ ...input, clientRequestId: randomUUID() }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });

    const owner = await caller(OWNER);
    const first = await owner.decisions.decide({ ...input, clientRequestId: randomUUID() });
    expect(first.outcome).toBe("REJECTED");
    const [req] = await db().select({ status: s.purchaseOrderControlRequests.status, reviewedBy: s.purchaseOrderControlRequests.reviewedBy })
      .from(s.purchaseOrderControlRequests).where(eq(s.purchaseOrderControlRequests.id, requestId));
    expect(req).toMatchObject({ status: "REJECTED", reviewedBy: OWNER });

    // ⭐ الحسم الثاني على طلب محسوم: نتيجة STALE لا «نجاح» ولا خطأ أحمر.
    const second = await owner.decisions.decide({ ...input, clientRequestId: randomUUID() });
    expect(second.outcome).toBe("STALE");
    expect((await owner.decisions.inbox()).rows.some((r) => r.kind === "purchase.order.control" && r.id === requestId)).toBe(false);
  });

  it("اعتماد تسوية مخزون ينفذ الاثر ويعود EXECUTED، وتكراره STALE", async () => {
    const [adj] = await db().insert(s.stockAdjustmentRequests).values({
      variantId: 1, branchId: 1, targetQuantity: 14, expectedQuantity: 10, notes: "[COST_SNAPSHOT:200.00]\nجرد الرف الثاني",
      status: "PENDING_APPROVAL", createdBy: CASHIER,
    }).$returningId();
    const manager = await caller(MANAGER);
    const row = (await manager.decisions.inbox()).rows.find((r) => r.kind === "inventory.adjustment.approve" && r.id === adj.id);
    expect(row).toBeDefined();
    expect(row!.summaryItems[0]?.qty).toBe("10 → 14");
    expect(row!.trigger).toBe("ERASE_EFFECT");

    const res = await manager.decisions.decide({ kind: "inventory.adjustment.approve", id: adj.id, action: "APPROVE", clientRequestId: randomUUID() });
    expect(res.outcome).toBe("EXECUTED");
    const [stock] = await db().select({ q: s.branchStock.quantity }).from(s.branchStock).where(sql`${s.branchStock.variantId} = 1 AND ${s.branchStock.branchId} = 1`);
    expect(Number(stock!.q)).toBe(14);

    const again = await manager.decisions.decide({ kind: "inventory.adjustment.approve", id: adj.id, action: "APPROVE", clientRequestId: randomUUID() });
    expect(again.outcome).toBe("STALE");
  });

  it("نوع غير مسجل او غير موصول يرفض برسالة تقود الى الشاشة", async () => {
    const owner = await caller(OWNER);
    await expect(owner.decisions.decide({ kind: "لا.وجود.له", id: 1, action: "APPROVE", clientRequestId: randomUUID() }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(owner.decisions.decide({ kind: "digitalCards.reversal.approve", id: 1, action: "APPROVE", clientRequestId: randomUUID() }))
      .rejects.toThrow(/لم يُوصَل بالحسم في مكانه/);
  });
});
