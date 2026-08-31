/**
 * اسم reverseServiceInvoice توافقي فقط: ينشئ طلب REVERSE_DELIVERY صفري الأثر، ولا يحتفظ
 * بمسار مالي مختلف لفاتورة WORKORDER صفريّة البنود أو ذات البنود.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { ensureFinancialPostingGate } from "../reports/monthCloseGate";
import { openShift } from "../shiftService";
import { approveWorkOrderControlRequest } from "../workOrder/controlRequests";
import { createWorkOrder } from "../workOrder/create";
import { deliverWorkOrder } from "../workOrder/deliver";
import {
  decideWorkOrderDesignApproval,
  requestWorkOrderDesignApproval,
} from "../workOrder/designApproval";
import { reverseServiceInvoice } from "../workOrder/reverseServiceInvoice";

const TABLES = [
  "idempotencyKeys", "auditLogs", "workOrderEvents", "workOrderControlRequests",
  "workOrderDesignApprovals", "workOrderDesignRevisions",
  "accountingEntries", "receipts", "workOrderMaterials", "workOrders",
  "invoiceItems", "invoices", "inventoryMovements", "branchStock",
  "productPrices", "productUnits", "productVariants", "products", "shifts",
  "customers", "serviceTypes", "branches", "users",
];

const SELLER = { userId: 2, branchId: 1, role: "cashier" };
const REQUESTER = { userId: 1, branchId: 1, role: "manager" };
const REVIEWER = { userId: 3, branchId: 1, role: "manager" };

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

beforeEach(async () => {
  const database = db();
  await database.transaction(async (tx) => {
    await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
    for (const table of TABLES) await tx.execute(sql.raw(`DELETE FROM \`${table}\``));
    await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  });
  await ensureFinancialPostingGate(database);
  await database.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await database.insert(s.users).values([
    { id: 1, openId: "requester", name: "طالب العكس", email: "req@t.test", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "seller", name: "البائع", email: "seller@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "reviewer", name: "مراجع مستقل", email: "review@t.test", role: "manager", loginMethod: "local", branchId: 1 },
  ]);
  await database.insert(s.serviceTypes).values({
    name: "موافقة تصميم", defaultKind: "SERVICE_REQUEST", defaultPriority: "HIGH",
    slaHours: 24, isActive: true, blocksExecution: true,
  });
  await database.insert(s.customers).values({ id: 1, name: "عميل", phone: "+9647701234567", currentBalance: "0.00" });
  await database.insert(s.products).values({ id: 1, name: "دفتر" });
  await database.insert(s.productVariants).values({ id: 1, productId: 1, sku: "NB", costPrice: "400.00" });
  await database.insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true });
  await database.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 100 });
  await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, SELLER);
});

async function deliveredOrder(key: string, withLine: boolean) {
  const created = await createWorkOrder({
    branchId: 1,
    customerId: 1,
    title: withLine ? "خدمة مع منتج" : "خدمة تخصيص خالصة",
    baseVariantId: withLine ? 1 : null,
    quantity: 1,
    salePrice: "50000.00",
    materials: [],
    deposit: "0",
    clientRequestId: key,
  } as never, SELLER);
  const workOrderId = Number((created as { workOrderId: number }).workOrderId);
  const approval = await requestWorkOrderDesignApproval({
    workOrderId,
    requestKey: `${key}-design-request`,
    note: "اعتماد النسخة الحالية قبل التسليم",
  }, SELLER);
  await decideWorkOrderDesignApproval({
    approvalId: Number(approval.approval.id),
    decisionKey: `${key}-design-approve`,
    decision: "APPROVED",
    reason: "ثبتت موافقة العميل على التصميم النهائي",
    evidence: { type: "WHATSAPP_MESSAGE", reference: `wamid.${key}` },
  }, REVIEWER);
  await db().update(s.workOrders).set({ status: "READY" }).where(eq(s.workOrders.id, workOrderId));
  const delivered = await deliverWorkOrder({ workOrderId, payment: null }, SELLER);
  const row = (await db().select().from(s.workOrders).where(eq(s.workOrders.id, workOrderId)))[0];
  return { workOrderId, invoiceId: delivered.invoiceId, version: Number(row.version) };
}

describe("reverseServiceInvoice compatibility wrapper", () => {
  it("ينشئ طلباً صفري الأثر ثم ينفّذ العكس فقط عند اعتماد مستقل", async () => {
    const delivered = await deliveredOrder("wrapper-zero", false);
    const requested = await reverseServiceInvoice({
      workOrderId: delivered.workOrderId,
      expectedVersion: delivered.version,
      reason: "رفض العميل الخدمة بعد التسليم",
      clientRequestId: "wrapper-zero-reverse",
    }, REQUESTER);

    expect(requested.status).toBe("PENDING");
    expect((await db().select().from(s.workOrders).where(eq(s.workOrders.id, delivered.workOrderId)))[0].status).toBe("DELIVERED");
    expect((await db().select().from(s.invoices).where(eq(s.invoices.id, delivered.invoiceId)))[0].status).not.toBe("RETURNED");

    await approveWorkOrderControlRequest(Number(requested.id), REVIEWER);
    expect((await db().select().from(s.workOrders).where(eq(s.workOrders.id, delivered.workOrderId)))[0].status).toBe("CANCELLED");
    expect((await db().select().from(s.invoices).where(eq(s.invoices.id, delivered.invoiceId)))[0].status).toBe("RETURNED");
  });

  it("يمرّر الفاتورة ذات البنود إلى المسار الموحد نفسه", async () => {
    const delivered = await deliveredOrder("wrapper-line", true);
    const requested = await reverseServiceInvoice({
      workOrderId: delivered.workOrderId,
      expectedVersion: delivered.version,
      reason: "عكس خدمة ذات بند عبر المسار الموحد",
      clientRequestId: "wrapper-line-reverse",
    }, REQUESTER);
    await approveWorkOrderControlRequest(Number(requested.id), REVIEWER);

    const line = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, delivered.invoiceId)))[0];
    expect(line.returnedBaseQuantity).toBe(line.baseQuantity);
    expect(line.returnedRestockedBaseQuantity).toBe(0);
  });
});
