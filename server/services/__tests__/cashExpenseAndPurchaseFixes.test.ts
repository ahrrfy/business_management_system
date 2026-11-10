/**
 * اختبارات القبول لإصلاحي المصروف النقدي والشراء النقدي:
 * 1) المصروف النقدي:
 *    - صلاحية الإنشاء والتنفيذ تُحكم بدور المستخدم وصلاحية العملية دون حصر بنوع وردية RETAIL.
 *    - نجاح المصروف من وردية استقبال (RECEPTION) أو طباعة (PRINT_SERVICES) ممولة تخص المنشئ وفي نفس الفرع.
 *    - رفض الوردية المغلقة (PRECONDITION_FAILED) أو التابعة لمستخدم آخر (FORBIDDEN).
 *    - تثبيت رقم الوردية المحددة في السند والمصروف والخصم، وتسجيل المعتمِد في السند وسجل القرار.
 * 2) الشراء النقدي:
 *    - فصل مصدر سداد البضاعة والرصيد المتاح والمتبقي والعجز عن مصدر الشحن وحالة سنده.
 *    - السماح بالإرسال للاعتماد مع إظهار تنبيه العجز عندما يكون درج المنشئ فارغاً ودرج المعتمِد ممولاً.
 *    - فشل الاعتماد ذرياً عند عدم كفاية درج المنشئ، ومنع مسار cashSource القديم من الصرف من درج المعتمِد.
 *    - احتساب سند المورد السابق المؤهل ضمن التسوية، وإثبات الشحن بسنده المسجل مرة واحدة دون تكرار خصم.
 *    - نجاح الصرف من درج المنشئ مرة واحدة بعد تمويله حتى عند إعادة طلب القرار (Replay).
 *    - تصحيح مصدر السداد بمراجعة محكومة جديدة قبل الدفع الفعلي ورفضه بعد الدفع.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { truncateTables } from "./__testUtils__";
import type { TrpcContext } from "../../context";
import { buildDefaultRoleOperationPolicy } from "@shared/roleOperationPresets";
import type { OperationPolicy } from "@shared/operationPermissions";
import { SECTION_CASHIER_ROLES, type RoleKey } from "@shared/permissions";

function presetPolicy(presetKey: "reception_clerk" | "print_cashier"): OperationPolicy {
  const preset = SECTION_CASHIER_ROLES.find((r) => r.key === presetKey)!;
  return buildDefaultRoleOperationPolicy(preset.key, preset.baseRole, preset.permissions);
}
import { router } from "../../trpc";
import { expenseRouter } from "../../routers/expenseRouter";
import { decisionsRouter } from "../../routers/decisionsRouter";
import { purchaseRouter } from "../../routers/purchaseRouter";
import { getDb } from "../../db";
import * as s from "../../../drizzle/schema";
import { getShiftReport } from "../shiftService";
import { withTx } from "../tx";
import { computeCashPurchaseShortageSummaryTx } from "../purchase/controls";
import {
  createPurchaseOrder,
  decidePurchaseOrderControl,
  revisePurchaseOrderPaymentSource,
  submitPurchaseOrderForApproval,
} from "../purchaseService";

const testRouter = router({
  expenses: expenseRouter,
  decisions: decisionsRouter,
  purchases: purchaseRouter,
});

const TABLES = [
  "auditLogs",
  "idempotencyKeys",
  "documentCounters",
  "accountingEntries",
  "supplierPaymentAllocations",
  "supplierPayments",
  "supplierPaymentRequestAllocations",
  "supplierPaymentRequests",
  "supplierInvoiceMatchAllocations",
  "supplierInvoiceMatchRuns",
  "supplierInvoiceLines",
  "supplierInvoices",
  "goodsReceiptAccountingLinks",
  "goodsReceiptItems",
  "goodsReceipts",
  "accrualObligationEvents",
  "accrualObligations",
  "purchaseOrderEvents",
  "purchaseOrderControlRequests",
  "purchaseOrderRequisitionAllocations",
  "purchaseOrderRevisionItems",
  "purchaseOrderRevisions",
  "purchaseOrderItems",
  "purchaseOrders",
  "inventoryMovements",
  "branchStock",
  "expenseStockItems",
  "expenses",
  "expenseCategories",
  "receipts",
  "shifts",
  "productPrices",
  "productUnitBarcodes",
  "productUnits",
  "productVariants",
  "products",
  "suppliers",
  "accounts",
  "users",
  "branches",
] as const;

const db = () => {
  const d = getDb();
  if (!d) throw new Error("DB unavailable");
  return d;
};

async function reset() {
  await truncateTables(TABLES);
}

function makeCaller(user: {
  id: number;
  openId: string;
  name: string;
  role: RoleKey;
  branchId: number;
  isOwner?: boolean;
  roleOperationPolicy?: OperationPolicy | null;
}) {
  return testRouter.createCaller({
    req: { headers: {} },
    res: {},
    sessionId: null,
    platformAdmin: null,
    user: {
      ...user,
      isActive: true,
      isOwner: Boolean(user.isOwner),
      operationPolicyEnabled: Boolean(user.roleOperationPolicy),
      roleOperationPolicy: user.roleOperationPolicy ?? null,
    },
  } as unknown as TrpcContext);
}

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values({
    id: 1,
    code: "MAIN",
    name: "الفرع الرئيسي",
    type: "MAIN",
    isActive: true,
  });
  await d.insert(s.users).values([
    {
      id: 1,
      openId: "reception-clerk-1",
      name: "موظف استقبال",
      role: "cashier",
      loginMethod: "local",
      branchId: 1,
      isActive: true,
      isOwner: false,
      operationPolicy: presetPolicy("reception_clerk"),
    },
    {
      id: 2,
      openId: "print-cashier-2",
      name: "كاشير طباعة",
      role: "print_operator",
      loginMethod: "local",
      branchId: 1,
      isActive: true,
      isOwner: false,
      operationPolicy: presetPolicy("print_cashier"),
    },
    {
      id: 3,
      openId: "purchasing-creator-3",
      name: "مسؤول مشتريات",
      role: "purchasing",
      loginMethod: "local",
      branchId: 1,
      isActive: true,
      isOwner: false,
    },
    {
      id: 4,
      openId: "owner-approver-4",
      name: "المالك المعتمد",
      role: "manager",
      loginMethod: "local",
      branchId: 1,
      isActive: true,
      isOwner: true,
    },
  ]);
  await d.insert(s.suppliers).values({
    id: 1,
    name: "مورد الاختبار",
    currentBalance: "0.00",
    isActive: true,
  });
  await d.insert(s.products).values({
    id: 1,
    name: "ورق طباعة A4",
    isActive: true,
    stockUsage: "SALE_ONLY",
    showInStore: false,
  });
  await d.insert(s.productVariants).values({
    id: 1,
    productId: 1,
    sku: "SKU-PRD-001",
    color: "أبيض",
    size: "A4",
    costPrice: "10.00",
    isActive: true,
  });
  await d.insert(s.productUnits).values({
    id: 1,
    variantId: 1,
    unitName: "رزمة",
    conversionFactor: "1",
    isBaseUnit: true,
    isActive: true,
  });
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("إصلاح المصروف النقدي (جميع أنواع الورديات النشطة للمنشئ)", () => {
  it("ينجح إنشاء مصروف نقدي فوري من وردية استقبال ممولة تخص المنشئ ويثبت رقم الوردية ويخصم مرة واحدة", async () => {
    await db().insert(s.shifts).values({
      id: 101,
      userId: 1,
      branchId: 1,
      openingBalance: "150000.00",
      status: "OPEN",
      shiftType: "RECEPTION",
      openGuard: "1:1:RECEPTION",
    });

    const receptionCaller = makeCaller({
      id: 1,
      openId: "reception-clerk-1",
      name: "موظف استقبال",
      role: "cashier",
      branchId: 1,
      roleOperationPolicy: presetPolicy("reception_clerk"),
    });

    const drawers = await receptionCaller.expenses.openDrawers({ branchId: 1 });
    expect(drawers).toHaveLength(1);
    expect(drawers[0]).toMatchObject({
      id: 101,
      shiftType: "RECEPTION",
      availableCash: "150000.00",
    });

    const created = await receptionCaller.expenses.create({
      branchId: 1,
      category: "SUPPLIES",
      amount: "40000.00",
      paymentMethod: "CASH",
      cashSource: "OWN_DRAWER",
      shiftId: 101,
      description: "قرطاسية استقبال عاجلة",
      clientRequestId: "exp-rec-101",
    });
    expect(created).toMatchObject({
      expenseId: expect.any(Number),
      shiftId: 101,
      status: "ACTIVE",
    });

    // إعادة الطلب بنفس المفتاح لا تكرر الخصم
    const replay = await receptionCaller.expenses.create({
      branchId: 1,
      category: "SUPPLIES",
      amount: "40000.00",
      paymentMethod: "CASH",
      cashSource: "OWN_DRAWER",
      shiftId: 101,
      description: "قرطاسية استقبال عاجلة",
      clientRequestId: "exp-rec-101",
    });
    expect(replay).toMatchObject({
      expenseId: created.expenseId,
      idempotent: true,
    });

    const [expRow] = await db()
      .select()
      .from(s.expenses)
      .where(eq(s.expenses.id, created.expenseId));
    const [rcpRow] = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.id, Number(created.receiptId)));
    expect(Number(expRow!.shiftId)).toBe(101);
    expect(expRow!.cashBucket).toBe("DRAWER");
    expect(Number(rcpRow!.shiftId)).toBe(101);
    expect(rcpRow!.cashBucket).toBe("DRAWER");

    const rep = await getShiftReport(101);
    expect(rep!.expectedCash).toBe("110000.00");
  });

  it("ينجح اعتماد وتنفيذ مصروف نقدي كبير من وردية طباعة ممولة مع تسجيل المعتمِد، ويرفض الوردية المغلقة أو التابعة لآخر", async () => {
    await db().insert(s.shifts).values([
      {
        id: 201,
        userId: 2,
        branchId: 1,
        openingBalance: "800000.00",
        status: "OPEN",
        shiftType: "PRINT_SERVICES",
        openGuard: "2:1:PRINT_SERVICES",
      },
      {
        id: 202,
        userId: 2,
        branchId: 1,
        openingBalance: "800000.00",
        status: "CLOSED",
        shiftType: "PRINT_SERVICES",
        openGuard: null,
      },
      {
        id: 203,
        userId: 1,
        branchId: 1,
        openingBalance: "800000.00",
        status: "OPEN",
        shiftType: "RECEPTION",
        openGuard: "1:1:RECEPTION",
      },
    ]);

    const printCaller = makeCaller({
      id: 2,
      openId: "print-cashier-2",
      name: "كاشير طباعة",
      role: "print_operator",
      branchId: 1,
      roleOperationPolicy: presetPolicy("print_cashier"),
    });
    const ownerCaller = makeCaller({
      id: 4,
      openId: "owner-approver-4",
      name: "المالك المعتمد",
      role: "manager",
      branchId: 1,
      isOwner: true,
    });

    // رفض الوردية المغلقة في المصروف الفوري
    await expect(
      printCaller.expenses.create({
        branchId: 1,
        category: "MAINTENANCE",
        amount: "20000.00",
        paymentMethod: "CASH",
        cashSource: "OWN_DRAWER",
        shiftId: 202,
        description: "محاولة صرف على وردية مغلقة",
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    // رفض وردية مستخدم آخر في المصروف الفوري
    await expect(
      printCaller.expenses.create({
        branchId: 1,
        category: "MAINTENANCE",
        amount: "20000.00",
        paymentMethod: "CASH",
        cashSource: "OWN_DRAWER",
        shiftId: 203,
        description: "محاولة صرف على وردية شخص آخر",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // إنشاء مصروف يتطلب اعتماد المالك (>= 500,000)
    const pending = await printCaller.expenses.create({
      branchId: 1,
      category: "MAINTENANCE",
      amount: "550000.00",
      paymentMethod: "CASH",
      description: "صيانة ماكينة طباعة رقمية",
      clientRequestId: "exp-print-pending-201",
    });
    expect("status" in pending && pending.status).toBe("PENDING_APPROVAL");

    // اعتماد المالك عبر مركز القرارات يسجل approvedBy في السند وسجل القرار
    const decisionRes = await ownerCaller.decisions.decide({
      kind: "expense.approve",
      id: pending.expenseId,
      action: "APPROVE",
      clientRequestId: "dec-approve-exp-201",
    });
    expect(decisionRes).toMatchObject({
      outcome: "REQUESTED",
    });

    const decisionAudits = await db()
      .select()
      .from(s.auditLogs)
      .where(
        and(
          eq(s.auditLogs.action, "decisions.approve"),
          eq(s.auditLogs.entityId, String(pending.expenseId)),
        ),
      );
    expect(decisionAudits).toHaveLength(1);
    expect(Number(decisionAudits[0]!.userId)).toBe(4);
    expect(JSON.stringify(decisionAudits[0]!.newValue)).toContain('"approvedBy":4');

    // رفض التنفيذ من وردية مغلقة أو وردية موظف آخر
    await expect(
      printCaller.expenses.executeFromOwnDrawer({
        expenseId: pending.expenseId,
        shiftId: 202,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    await expect(
      printCaller.expenses.executeFromOwnDrawer({
        expenseId: pending.expenseId,
        shiftId: 203,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // نجاح التنفيذ من وردية الطباعة الممولة الخاصة بالمنشئ
    const executed = await printCaller.expenses.executeFromOwnDrawer({
      expenseId: pending.expenseId,
      shiftId: 201,
    });
    expect(executed).toMatchObject({
      status: "ACTIVE",
      cashBucket: "DRAWER",
      shiftId: 201,
      approvedBy: 4,
      executedBy: 2,
    });

    const rep = await getShiftReport(201);
    expect(rep!.expectedCash).toBe("250000.00");
  });
});

describe("إصلاح الشراء النقدي (فصل البضاعة عن الشحن، فحص الرصيد الذري، ومنع خصم درج المعتمِد)", () => {
  const creator = { userId: 3, branchId: 1, role: "purchasing", isOwner: false };
  const approver = { userId: 4, branchId: 1, role: "manager", isOwner: true };

  it("يسمح بالإرسال مع تنبيه العجز ويفشل الاعتماد ذرياً عندما يكون درج المنشئ فارغاً ودرج المعتمِد ممولاً ثم يصرف مرة واحدة بعد تمويل درج المنشئ مع حفظ سند المورد وسند الشحن", async () => {
    // 0) يبقى صرف الشحن الفعلي خاضعاً لفحص رصيده الخاص: إذا كان درج المنشئ 0.00 وطلب صرف شحن 20.00 يُرفض ذرياً
    await db().insert(s.shifts).values([
      {
        id: 9,
        userId: creator.userId,
        branchId: 1,
        openingBalance: "0.00",
        status: "OPEN",
        shiftType: "PRINT_SERVICES",
        openGuard: "3:1:PRINT_SERVICES",
      },
      {
        // درج المنشئ رقم 10 فيه 20.00 فقط (يكفي لصرف سند الشحن 20.00 ويصبح فارغاً 0.00 أمام بضاعة متبقية 70.00!)
        id: 10,
        userId: creator.userId,
        branchId: 1,
        openingBalance: "20.00",
        status: "OPEN",
        shiftType: "RECEPTION",
        openGuard: "3:1:RECEPTION",
      },
      {
        id: 20,
        userId: approver.userId,
        branchId: 1,
        openingBalance: "500.00",
        status: "OPEN",
        shiftType: "RETAIL",
        openGuard: "4:1:RETAIL",
      },
    ]);

    await expect(
      createPurchaseOrder(
        {
          supplierId: 1,
          branchId: 1,
          status: "DRAFT",
          settlementType: "CASH",
          tender: { mode: "DRAWER", shiftId: 9 },
          shippingCost: "20.00",
          shippingFundingSource: "DRAWER",
          shippingShiftId: 9,
          items: [
            {
              variantId: 1,
              productUnitId: 1,
              quantity: "10",
              unitPrice: "10.00",
            },
          ],
        },
        creator,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    // سند مورد سابق مؤهل بقيمة 30.00 د.ع (يتبقى 70.00 د.ع من بضاعة قيمتها 100.00 د.ع)
    await db().insert(s.receipts).values({
      id: 9001,
      branchId: 1,
      direction: "OUT",
      amount: "30.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      partyType: "SUPPLIER",
      partyId: 1,
      referenceNumber: "PRIOR-SUP-30",
      description: "دفعة مقدمة للمورد",
      createdBy: approver.userId,
      approvedBy: approver.userId,
    });
    await db().insert(s.accountingEntries).values({
      entryType: "PAYMENT_OUT",
      branchId: 1,
      receiptId: 9001,
      supplierId: 1,
      amount: "30.00",
      entryDate: new Date("2026-08-22T00:00:00Z"),
      dedupeKey: "TEST:PRIOR_SUPPLIER_VOUCHER:9001",
    });
    const priorReceiptId = 9001;

    // إنشاء أمر شراء نقدي: البضاعة 100.00 + شحن 20.00 يُصرف سند شحنه الآن من الدرج 10 فيصبح رصيد الدرج 10 مساوياً 0.00 (فارغاً للبضاعة!)
    const createdPo = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        status: "DRAFT",
        settlementType: "CASH",
        tender: {
          mode: "DRAWER",
          shiftId: 10,
          previousReceiptId: priorReceiptId,
        },
        shippingCost: "20.00",
        shippingFundingSource: "DRAWER",
        shippingShiftId: 10,
        items: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "10",
            unitPrice: "10.00",
          },
        ],
      },
      creator,
    );

    const summaryBefore = await withTx(async (tx) => {
      const [poRow] = await tx
        .select()
        .from(s.purchaseOrders)
        .where(eq(s.purchaseOrders.id, createdPo.purchaseOrderId));
      return computeCashPurchaseShortageSummaryTx(tx, poRow!);
    });
    expect(summaryBefore).toMatchObject({
      goodsTotal: "100.00",
      sourceMode: "DRAWER",
      shiftId: 10,
      priorVoucherId: priorReceiptId,
      priorAppliedAmount: "30.00",
      remainingPayable: "70.00",
      availableCash: "0.00",
      shortageAmount: "70.00",
      hasShortage: true,
      shipping: {
        shippingTotal: "20.00",
        fundingSource: "DRAWER",
        voucherStatus: "RECORDED",
      },
    });

    // 1) الإرسال ينجح مع إرجاع تنبيه العجز الصريح
    const submitted = await submitPurchaseOrderForApproval(
      {
        purchaseOrderId: createdPo.purchaseOrderId,
        expectedVersion: createdPo.version,
        reason: "إرسال للاعتماد مع علم العجز المؤقت في الدرج",
        requestKey: "submit-shortage-po-1",
      },
      creator,
    );
    expect(submitted.shortageWarning).toMatchObject({
      hasShortage: true,
      remainingPayable: "70.00",
      availableCash: "0.00",
      shortageAmount: "70.00",
    });

    // 2) الاعتماد يفشل ذرياً لأن درج المنشئ فارغ (رغم أن درج المعتمِد فيه 500.00!)
    await expect(
      decidePurchaseOrderControl(
        {
          requestId: submitted.requestId,
          decisionKey: "approve-fail-empty-creator-drawer",
          approve: true,
          confirmedFullReceipt: true,
          reason: "محاولة اعتماد قبل تمويل درج المنشئ",
        },
        approver,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    // 3) محاولة تمرير درج المعتمِد عبر مسار cashSource القديم تُرفض صراحةً ولا تلمس درج المعتمِد
    await expect(
      decidePurchaseOrderControl(
        {
          requestId: submitted.requestId,
          decisionKey: "approve-fail-approver-drawer-override",
          approve: true,
          confirmedFullReceipt: true,
          cashSource: { mode: "DRAWER", shiftId: 20 },
          reason: "محاولة تمرير درج المعتمِد عبر المسار القديم",
        },
        approver,
      ),
    ).rejects.toThrow();

    const [poStillSent] = await db()
      .select()
      .from(s.purchaseOrders)
      .where(eq(s.purchaseOrders.id, createdPo.purchaseOrderId));
    expect(poStillSent!.status).toBe("SENT");
    expect(await db().select().from(s.supplierInvoices)).toHaveLength(0);

    const approverRepBefore = await getShiftReport(20);
    expect(approverRepBefore!.expectedCash).toBe("500.00");

    // 4) تمويل درج المنشئ بمبلغ 100.00 د.ع
    await db().insert(s.receipts).values({
      id: 9003,
      branchId: 1,
      direction: "IN",
      amount: "100.00",
      paymentMethod: "CASH",
      cashBucket: "DRAWER",
      shiftId: 10,
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      referenceNumber: "FUND-CREATOR-SHIFT-10",
      createdBy: creator.userId,
    });

    // 5) نجاح الاعتماد والخصم من درج المنشئ مرة واحدة فقط (70.00 د.ع) + إثبات سند المورد وسند الشحن مرة واحدة
    const approved = await decidePurchaseOrderControl(
      {
        requestId: submitted.requestId,
        decisionKey: "approve-after-creator-funded",
        approve: true,
        confirmedFullReceipt: true,
        reason: "تمت مطابقة البضاعة وتمويل درج المنشئ",
      },
      approver,
    );
    expect(approved).toMatchObject({
      status: "APPROVED",
      orderStatus: "RECEIVED",
      idempotent: false,
    });

    // إعادة إرسال نفس القرار (Replay) لا تخصم مرة ثانية
    const replayApproved = await decidePurchaseOrderControl(
      {
        requestId: submitted.requestId,
        decisionKey: "approve-after-creator-funded",
        approve: true,
        confirmedFullReceipt: true,
        reason: "تمت مطابقة البضاعة وتمويل درج المنشئ",
      },
      approver,
    );
    expect(replayApproved).toMatchObject({
      status: "APPROVED",
      idempotent: true,
    });

    // درج المنشئ خُصم منه المتبقي فقط (100 - 70 = 30)، ودرج المعتمِد لم يُمس (500)
    const creatorRepAfter = await getShiftReport(10);
    expect(creatorRepAfter!.expectedCash).toBe("30.00");
    const approverRepAfter = await getShiftReport(20);
    expect(approverRepAfter!.expectedCash).toBe("500.00");

    // التحقق من سند الشحن: مثبت مرة واحدة فقط بلا أي خصم إضافي
    const shippingObligations = await db()
      .select()
      .from(s.accrualObligations)
      .where(
        and(
          eq(s.accrualObligations.purchaseOrderId, createdPo.purchaseOrderId),
          eq(s.accrualObligations.kind, "PURCHASE_SHIPPING"),
        ),
      );
    expect(shippingObligations).toHaveLength(1);
    expect(shippingObligations[0]!.status).toBe("PAID");
    const shippingEvents = await db()
      .select()
      .from(s.accrualObligationEvents)
      .where(
        and(
          eq(
            s.accrualObligationEvents.obligationId,
            shippingObligations[0]!.id,
          ),
          eq(s.accrualObligationEvents.eventType, "PAYMENT_SETTLED"),
        ),
      );
    expect(shippingEvents).toHaveLength(1);
  });

  it("يصحح مصدر السداد بمراجعة محكومة جديدة قبل الدفع ويرفض التغيير بعد السداد الفعلي", async () => {
    await db().insert(s.shifts).values({
      id: 15,
      userId: creator.userId,
      branchId: 1,
      openingBalance: "0.00",
      status: "OPEN",
      shiftType: "RETAIL",
      openGuard: "3:1:RETAIL",
    });
    // تمويل الخزينة الرئيسية بمبلغ 250.00 د.ع
    await db().insert(s.receipts).values({
      id: 9010,
      branchId: 1,
      direction: "IN",
      amount: "250.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      referenceNumber: "FUND-TREASURY-250",
      createdBy: approver.userId,
    });

    const po = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        status: "DRAFT",
        settlementType: "CASH",
        tender: { mode: "DRAWER", shiftId: 15 },
        items: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "5",
            unitPrice: "20.00",
          },
        ],
      },
      creator,
    );
    await submitPurchaseOrderForApproval(
      {
        purchaseOrderId: po.purchaseOrderId,
        expectedVersion: po.version,
        reason: "إرسال أولي على الدرج",
        requestKey: "submit-revise-po-1",
      },
      creator,
    );

    const [sentRow] = await db()
      .select({ version: s.purchaseOrders.version })
      .from(s.purchaseOrders)
      .where(eq(s.purchaseOrders.id, po.purchaseOrderId));

    // تصحيح مؤقت إلى بطاقة الشركة للتحقق من حارس منع تمرير cashSource متعارض عند الاعتماد
    await db().insert(s.accounts).values({
      id: 77,
      code: "1115",
      name: "بطاقة الشركة الإلكترونية",
      type: "ASSET",
      systemRole: "CARD_BANK",
      isActive: true,
    });
    const revisedCard = await revisePurchaseOrderPaymentSource(
      {
        purchaseOrderId: po.purchaseOrderId,
        expectedVersion: Number(sentRow!.version),
        reason: "تحويل السداد مؤقتاً إلى بطاقة الشركة",
        tender: {
          mode: "CARD",
          accountId: 77,
          cardLastFour: "4242",
          referenceNumber: "CARD-TEST-77",
        },
        clientRequestId: "revise-pay-src-card-conflict",
      },
      approver,
    );
    expect(revisedCard.idempotent).toBe(false);
    if (!revisedCard.idempotent) {
      await expect(
        decidePurchaseOrderControl(
          {
            requestId: Number(revisedCard.controlRequestId),
            decisionKey: "approve-card-with-conflicting-cash-source",
            approve: true,
            confirmedFullReceipt: true,
            cashSource: { mode: "TREASURY" },
            reason: "محاولة تمرير مصدر نقدي متعارض مع البطاقة",
          },
          approver,
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    }

    // تصحيح مصدر السداد إلى الخزينة بمراجعة جديدة بعد التحقق من عدم وجود دفع سابق
    const revised = await revisePurchaseOrderPaymentSource(
      {
        purchaseOrderId: po.purchaseOrderId,
        expectedVersion: Number(revisedCard.version),
        reason: "تحويل السداد إلى الخزينة الرئيسية لعدم توفر سيولة في الدرج",
        tender: { mode: "TREASURY" },
        clientRequestId: "revise-pay-src-1",
      },
      approver,
    );
    expect(revised.idempotent).toBe(false);
    if (!revised.idempotent) {
      expect(revised.revisionNo).toBe(3);
      expect(revised.controlRequestId).toBeTruthy();
      expect(revised.shortageWarning?.hasShortage).toBe(false);

      const decided = await decidePurchaseOrderControl(
        {
          requestId: Number(revised.controlRequestId),
          decisionKey: "approve-revised-treasury-po",
          approve: true,
          confirmedFullReceipt: true,
          reason: "اعتماد المراجعة المصححة من الخزينة",
        },
        approver,
      );
      expect(decided.status).toBe("APPROVED");
    }

    const [paidRow] = await db()
      .select({ version: s.purchaseOrders.version })
      .from(s.purchaseOrders)
      .where(eq(s.purchaseOrders.id, po.purchaseOrderId));

    // رفض تعديل مصدر السداد بعد استلام البضاعة وتنفيذ الدفع الفعلي
    await expect(
      revisePurchaseOrderPaymentSource(
        {
          purchaseOrderId: po.purchaseOrderId,
          expectedVersion: Number(paidRow!.version),
          reason: "محاولة تغيير مصدر السداد بعد الدفع الفعلي",
          tender: { mode: "DRAWER", shiftId: 15 },
          clientRequestId: "revise-pay-src-after-paid",
        },
        approver,
      ),
    ).rejects.toThrow();
  });
});
