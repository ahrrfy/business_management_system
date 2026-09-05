/**
 * صندوق «مطلوب مني الآن» من سجلّ القرارات (م٧ ق٢) — عقودٌ على القاعدة:
 *  · الصفّ يعرض **ما يُقرَّر عليه**: المورّد والأصناف بكمّياتها وأسعارها والإجماليّ — لا «3 أسطر».
 *  · البوّابة مرآةُ الإجراء الأصليّ: الكاشير لا يرى ولا يحسم؛ المالك يحسم مباشرةً.
 *  · فصلُ المهام كما في الخدمة: الطالب لا يرى طلبه في صندوقه ولا يحسمه.
 *  · النتيجةُ مُهيكَلة: الحسمُ الثاني على طلبٍ حُسم يعود `STALE` لا «نجاحاً» ولا خطأً أحمر.
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { DECISION_SOURCES, decisionSourceCoverage } from "../decisions";
import { createEmployee } from "../employeeService";
import { createLeave } from "../leaveService";
import { submitPurchaseOrderForApproval } from "../purchase/controls";
import { openPurchaseIntegrityCase, requestPurchaseIntegrityResolution } from "../purchase/integrityCases";
import { createPurchaseOrder } from "../purchaseService";
import { ensureFinancialPostingGate } from "../reports/monthCloseGate";
import { RETURN_EXECUTED_AUDIT_ACTION } from "../returns/auditActions";
import { requestSalesControl } from "../sale/controlRequests";
import { createSale } from "../saleService";
import { DECISION_ACTIONS, allDecisions } from "@shared/decisionRegistry";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

const TABLES = [
  "idempotencyKeys", "auditLogs", "appNotifications", "accountingEntries", "receipts", "expenses", "inventoryMovements",
  "stockAdjustmentRequests", "purchaseOrderEvents", "purchaseOrderControlRequests",
  "purchaseOrderRequisitionAllocations", "purchaseOrderRevisionItems", "purchaseOrderRevisions",
  "purchaseOrderItems", "purchaseOrders", "purchaseIntegrityCaseEvents", "purchaseIntegrityCases",
  "salesExchangeCommands", "salesControlRequests", "returnRequests", "invoiceItems", "invoices", "customers",
  "giftVoucherLines", "giftVouchers", "leaveRequests", "employees",
  "branchStock", "productPrices", "productUnits",
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
const MANAGER_NO_BRANCH = 7; // مديرٌ يحمل hr:FULL بلا فرعٍ مُسنَد — ترفضه branchScopedProcedure
const CASHIER_ACTOR = { userId: CASHIER, branchId: 1, role: "cashier" } as const;

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
    { id: MANAGER_NO_BRANCH, openId: "mgr0", name: "مدير بلا فرع", role: "manager", loginMethod: "local", branchId: null, isActive: true },
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
  await d.insert(s.productPrices).values({ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" });
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 10 },
    { variantId: 2, branchId: 1, quantity: 3 },
  ]);
  await d.insert(s.suppliers).values({ id: 1, name: "مورد الورق", currentBalance: "0" });
  await d.insert(s.customers).values({ id: 1, name: "عميل دائم", phone: "+9647701111111", currentBalance: "0.00" });
  await d.insert(s.shifts).values({ id: 1, branchId: 1, userId: CASHIER, openingBalance: "0", status: "OPEN" });
  await ensureFinancialPostingGate(d);
}

/** بيعُ رزمتَي ورق نقداً (2 × 1000) من كاشير الوردية 1 — الفاتورةُ التي تُطلب عليها طلبات ضبط البيع. */
async function cashSale() {
  const created = await createSale(
    {
      branchId: 1,
      shiftId: 1,
      sourceType: "POS",
      customerId: 1,
      lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }],
      payment: { amount: "2000.00", method: "CASH" },
    },
    CASHIER_ACTOR,
  );
  const [item] = await db().select({ id: s.invoiceItems.id }).from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, created.invoiceId));
  return { invoiceId: created.invoiceId, itemId: Number(item!.id) };
}

async function pendingGift(withLines: boolean) {
  const [head] = await db().insert(s.giftVouchers).values({
    giftNumber: `GO-${randomUUID().slice(0, 8)}`, direction: "OUT", branchId: 1, status: "PENDING_APPROVAL",
    totalCost: "2000.00", createdBy: CASHIER, sellable: true,
  }).$returningId();
  if (withLines) {
    await db().insert(s.giftVoucherLines).values({
      giftVoucherId: head.id, variantId: 1, productUnitId: 1, quantity: "10", baseQuantity: 10, unitCostSnapshot: "200.00", lineCost: "2000.00",
    });
  }
  return head.id;
}

/** موظّفٌ مرتبطٌ بحساب الكاشير (يستقبل إشعار الإجازة) برصيد إجازةٍ يكفي الاعتماد. */
async function employeeOfCashier() {
  const emp = await createEmployee({ firstName: "زيد", lastName: "الرئيسي", payType: "monthly", salary: "900000", branchId: 1, annualLeaveBalance: 30 });
  await db().update(s.employees).set({ userId: CASHIER }).where(eq(s.employees.id, emp!.id));
  return emp!.id;
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

  // Codex على #1004 (P1): كلُّ مصدرٍ يعلن أفعالَه — لا مصدرَ بلا إعلان، ولا فعلَ خارج القاموس.
  it("كل مصدر يعلن افعاله المدعومة صراحة من قاموس الافعال", () => {
    for (const source of DECISION_SOURCES) {
      expect(source.supportedActions.length, source.key).toBeGreaterThan(0);
      for (const a of source.supportedActions) expect(DECISION_ACTIONS, `${source.key}:${a}`).toContain(a);
    }
  });
});

describe("decisions.decide — الافعال غير المدعومة ترفض قبل بلوغ الخدمة (P1)", () => {
  it("رفض هدية (تعتمد فقط) يرفض بالبوابة لا ينفذ الاعتماد، والهدية تبقى معلقة", async () => {
    const giftId = await pendingGift(true);
    const manager = await caller(MANAGER);
    await expect(manager.decisions.decide({ kind: "gifts.request.approve", id: giftId, action: "REJECT", clientRequestId: randomUUID(), reason: "لا نهدي هذا الصنف" }))
      .rejects.toThrow(/لا يدعم فعل «رفض»/);
    const [gift] = await db().select({ status: s.giftVouchers.status }).from(s.giftVouchers).where(eq(s.giftVouchers.id, giftId));
    expect(gift!.status).toBe("PENDING_APPROVAL");
    const [stock] = await db().select({ q: s.branchStock.quantity }).from(s.branchStock).where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 1)));
    expect(Number(stock!.q)).toBe(10);
  });

  it("سحب تسوية مخزون (اعتماد/رفض فقط) يرفض ولا يمس الطلب", async () => {
    const [adj] = await db().insert(s.stockAdjustmentRequests).values({
      variantId: 1, branchId: 1, targetQuantity: 12, expectedQuantity: 10, notes: "[COST_SNAPSHOT:200.00]\nجرد", status: "PENDING_APPROVAL", createdBy: CASHIER,
    }).$returningId();
    const manager = await caller(MANAGER);
    await expect(manager.decisions.decide({ kind: "inventory.adjustment.approve", id: adj.id, action: "WITHDRAW", clientRequestId: randomUUID() }))
      .rejects.toThrow(/لا يدعم فعل «سحب الطلب»/);
    const [after] = await db().select({ status: s.stockAdjustmentRequests.status }).from(s.stockAdjustmentRequests).where(eq(s.stockAdjustmentRequests.id, adj.id));
    expect(after!.status).toBe("PENDING_APPROVAL");
  });
});

describe("الهدايا الصادرة — الاسطر جزء من القرار (P1)", () => {
  it("صف الهدية يعرض الاصناف والكميات التي ستخرج من المخزون", async () => {
    const giftId = await pendingGift(true);
    const row = (await (await caller(MANAGER)).decisions.inbox()).rows.find((r) => r.kind === "gifts.request.approve" && r.id === giftId);
    expect(row).toBeDefined();
    expect(row!.approveBlockedReason).toBeNull();
    const line = row!.summaryItems.find((i) => i.label.includes("ورق A4"));
    expect(line).toBeDefined();
    expect(String(line!.qty)).toMatch(/^10/);
    expect(line!.unit).toContain("رزمة");
    expect(line!.unitPrice).toBe("200.00");
    expect(row!.summaryItems.some((i) => i.label === "تكلفة الاصناف المهداة" && i.unitPrice === "2000.00")).toBe(true);
  });

  it("هدية بلا اسطر تحجب سطريا، واعتمادها من الصندوق يرفض", async () => {
    const giftId = await pendingGift(false);
    const manager = await caller(MANAGER);
    const row = (await manager.decisions.inbox()).rows.find((r) => r.kind === "gifts.request.approve" && r.id === giftId);
    expect(row!.approveBlockedReason).toMatch(/بلا اسطر/);
    await expect(manager.decisions.decide({ kind: "gifts.request.approve", id: giftId, action: "APPROVE", clientRequestId: randomUUID() }))
      .rejects.toThrow(/بلا اسطر/);
  });
});

describe("ضبط البيع — المبلغ المتاثر وحاجز الاعتماد السطري وحدث التدقيق (P1)", () => {
  it("مرتجع جزئي يعرض قيمة البنود المرتجعة لا اجمالي الفاتورة، واعتماده من الصندوق يكتب حدث تنفيذ المرتجع", async () => {
    const { invoiceId, itemId } = await cashSale();
    const requested = await requestSalesControl({
      requestKey: `ret-${randomUUID()}`, invoiceId, requestType: "SALES_RETURN", reason: "رفض الزبون رزمة واحدة",
      payload: { lines: [{ invoiceItemId: itemId, baseQuantity: 1 }], restock: true },
    }, CASHIER_ACTOR);
    const manager = await caller(MANAGER);
    const row = (await manager.decisions.inbox()).rows.find((r) => r.kind === "sales.control.approve" && r.id === Number(requested.id));
    expect(row).toBeDefined();
    // 1 من 2 × 2000 = 1000 — لا 2000 (إجماليّ الفاتورة).
    expect(row!.amount).toBe("1000.00");
    expect(row!.approveBlockedReason).toBeNull();
    expect(row!.summaryItems.some((i) => i.label.includes("ورق A4") && i.unitPrice === "1000.00")).toBe(true);
    expect(row!.summaryItems.some((i) => i.label.includes("قيمة البنود المرتجعة") && i.unitPrice === "1000.00")).toBe(true);
    expect(row!.summaryItems.some((i) => i.label.includes("اجمالي الفاتورة") && i.unitPrice === "2000.00")).toBe(true);

    const res = await manager.decisions.decide({ kind: "sales.control.approve", id: Number(requested.id), action: "APPROVE", clientRequestId: randomUUID() });
    expect(res.outcome).toBe("EXECUTED");
    const [inv] = await db().select({ returnedTotal: s.invoices.returnedTotal }).from(s.invoices).where(eq(s.invoices.id, invoiceId));
    expect(inv!.returnedTotal).toBe("1000.00");
    // ⭐ الحدثُ الذي يقرؤه رقيبُ الشذوظ D3-ب — كان الراوتر وحده يكتبه فيتخطّاه الصندوق.
    const audits = await db().select({ newValue: s.auditLogs.newValue, userId: s.auditLogs.userId }).from(s.auditLogs).where(eq(s.auditLogs.action, RETURN_EXECUTED_AUDIT_ACTION));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.userId).toBe(MANAGER);
    expect(audits[0]!.newValue).toMatchObject({ mode: "GOVERNED_APPROVAL", requestId: Number(requested.id), requestedBy: CASHIER });
  });

  it("الغاء ببطاقة بلا مرجع جهاز: المبلغ = المقبوض القابل للرد، والصف محجوب، والاعتماد من الصندوق يرفض", async () => {
    const { invoiceId } = await cashSale();
    const requested = await requestSalesControl({
      requestKey: `cancel-${randomUUID()}`, invoiceId, requestType: "SALES_CANCEL", reason: "فاتورة مكررة بالخطأ",
      payload: { refundPaymentMethod: "CARD" },
    }, CASHIER_ACTOR);
    const manager = await caller(MANAGER);
    const row = (await manager.decisions.inbox()).rows.find((r) => r.kind === "sales.control.approve" && r.id === Number(requested.id));
    expect(row!.amount).toBe("2000.00");
    expect(row!.summaryItems.some((i) => i.label === "المقبوض القابل للرد عند الالغاء")).toBe(true);
    expect(row!.approveBlockedReason).toMatch(/مرجع عملية جهاز الدفع/);
    expect(row!.allowedActions).toContain("REJECT");
    await expect(manager.decisions.decide({ kind: "sales.control.approve", id: Number(requested.id), action: "APPROVE", clientRequestId: randomUUID() }))
      .rejects.toThrow(/مرجع عملية جهاز الدفع/);
    const [after] = await db().select({ status: s.salesControlRequests.status }).from(s.salesControlRequests).where(eq(s.salesControlRequests.id, Number(requested.id)));
    expect(after!.status).toBe("PENDING");
  });

  it("الغاء نقدي لا يحتاج توجيها: الصف غير محجوب", async () => {
    const { invoiceId } = await cashSale();
    const requested = await requestSalesControl({
      requestKey: `cancel-cash-${randomUUID()}`, invoiceId, requestType: "SALES_CANCEL", reason: "فاتورة مكررة بالخطأ",
      payload: { refundPaymentMethod: "CASH" },
    }, CASHIER_ACTOR);
    const row = (await (await caller(MANAGER)).decisions.inbox()).rows.find((r) => r.kind === "sales.control.approve" && r.id === Number(requested.id));
    expect(row!.approveBlockedReason).toBeNull();
    expect(row!.allowedActions).toEqual(["APPROVE", "REJECT"]);
  });
});

describe("الاجازات — بوابة الفرع والرفض والاشعار والترتيب (P1 + P2)", () => {
  it("مدير يحمل hr:FULL بلا فرع مسند لا يرى الاجازات ولا يحسمها (مرآة branchScopedProcedure)", async () => {
    const empId = await employeeOfCashier();
    const lv = await createLeave({ employeeId: empId, leaveType: "سنوية", fromDate: "2026-10-05", toDate: "2026-10-06" });
    const noBranch = await caller(MANAGER_NO_BRANCH);
    const inbox = await noBranch.decisions.inbox();
    expect(inbox.kinds).not.toContain("hr.leave.decide");
    await expect(noBranch.decisions.decide({ kind: "hr.leave.decide", id: Number(lv!.id), action: "APPROVE", clientRequestId: randomUUID() }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    const [after] = await db().select({ status: s.leaveRequests.status }).from(s.leaveRequests).where(eq(s.leaveRequests.id, Number(lv!.id)));
    expect(after!.status).toBe("pending");
  });

  it("الرفض متاح بسبب اختياري، والاعتماد من الصندوق يشعر الموظف كما يفعل الراوتر", async () => {
    const empId = await employeeOfCashier();
    const lv = await createLeave({ employeeId: empId, leaveType: "سنوية", fromDate: "2026-10-05", toDate: "2026-10-06" });
    const manager = await caller(MANAGER);
    const row = (await manager.decisions.inbox()).rows.find((r) => r.kind === "hr.leave.decide" && r.id === Number(lv!.id));
    expect(row).toBeDefined();
    expect(row!.allowedActions).toContain("REJECT");
    expect(row!.rejectReason).toBe("OPTIONAL");

    const res = await manager.decisions.decide({ kind: "hr.leave.decide", id: Number(lv!.id), action: "APPROVE", clientRequestId: randomUUID() });
    expect(res.outcome).toBe("EXECUTED");
    const [after] = await db().select({ status: s.leaveRequests.status }).from(s.leaveRequests).where(eq(s.leaveRequests.id, Number(lv!.id)));
    expect(after!.status).toBe("approved");
    const notes = await db().select({ kind: s.appNotifications.kind, userId: s.appNotifications.userId }).from(s.appNotifications).where(eq(s.appNotifications.userId, CASHIER));
    expect(notes.some((n) => n.kind === "LEAVE_STATUS")).toBe(true);
  });

  it("الاقدم يبقى ظاهرا حين يتجاوز المعلق حد المصدر (200): الجلب بالاقدم اولا", async () => {
    const empId = await employeeOfCashier();
    const [oldest] = await db().insert(s.leaveRequests).values({
      employeeId: empId, leaveType: "بدون راتب", paid: false, fromDate: "2027-01-01", toDate: "2027-01-01", days: 1, status: "pending",
      requestedAt: new Date("2026-01-01T00:00:00.000Z"),
    }).$returningId();
    const base = new Date("2026-06-01T00:00:00.000Z").getTime();
    await db().insert(s.leaveRequests).values(
      Array.from({ length: 205 }, (_, i) => ({
        employeeId: empId, leaveType: "بدون راتب", paid: false, fromDate: "2027-02-01", toDate: "2027-02-01", days: 1, status: "pending" as const,
        requestedAt: new Date(base + (i + 1) * 3_600_000),
      })),
    );
    const inbox = await (await caller(MANAGER)).decisions.inbox({ kind: "hr.leave.decide", limit: 500 });
    expect(inbox.rows.some((r) => r.id === oldest.id)).toBe(true);
    // الأقدمُ أوّلاً في الصندوق أيضاً: أكثرُها تأخّراً على رأس القائمة.
    expect(inbox.rows[0]!.id).toBe(oldest.id);
  });
});

describe("قضايا السلامة — صيغة الاعتماد تختار صراحة (P2)", () => {
  it("بلا صيغة يرفض الاعتماد، وباختيار «تصرف» تغلق القضية DISMISSED لا RESOLVED", async () => {
    const creator = { userId: CREATOR, branchId: 1, role: "admin" } as const;
    const opened = await openPurchaseIntegrityCase({
      caseKey: `IC-${randomUUID()}`, branchId: 1, code: "OTHER", severity: "MEDIUM", title: "فرق في مطابقة فاتورة",
      description: "المبلغ المكتشف لا يطابق المطابقة الثلاثية", detectedAmount: "1000.00", evidence: { note: "x" }, reason: "اكتشاف يدوي",
    }, creator);
    await requestPurchaseIntegrityResolution({ caseId: opened.caseId, requestKey: `IR-${randomUUID()}`, reason: "تبين ان الفرق خطا ادخال", evidenceReference: "EMAIL-77" }, creator);

    const manager = await caller(MANAGER);
    const row = (await manager.decisions.inbox()).rows.find((r) => r.kind === "purchase.integrity.resolution" && r.id === opened.caseId);
    expect(row).toBeDefined();
    expect(row!.approveVariants.map((v) => v.key)).toEqual(["APPROVE_RESOLVED", "APPROVE_DISMISSED"]);

    await expect(manager.decisions.decide({ kind: "purchase.integrity.resolution", id: opened.caseId, action: "APPROVE", clientRequestId: randomUUID(), reason: "مراجعة مستقلة" }))
      .rejects.toThrow(/اختر صيغة الاعتماد/);
    const res = await manager.decisions.decide({ kind: "purchase.integrity.resolution", id: opened.caseId, action: "APPROVE", clientRequestId: randomUUID(), reason: "مراجعة مستقلة", variant: "APPROVE_DISMISSED" });
    expect(res.outcome).toBe("EXECUTED");
    expect(res.message).toContain("تصرف");
    const [after] = await db().select({ status: s.purchaseIntegrityCases.status }).from(s.purchaseIntegrityCases).where(eq(s.purchaseIntegrityCases.id, opened.caseId));
    expect(after!.status).toBe("DISMISSED");
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
