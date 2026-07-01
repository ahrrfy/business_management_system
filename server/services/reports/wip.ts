// تقرير WIP (Work-in-Progress): المواد المستهلَكة في أوامر شغل IN_PROGRESS/READY ليست بعد ضمن
// SALE.cost (يصل عند DELIVERED) — هذا التقرير يعرض القيمة المعلَّقة بنياً لا محاسبياً.
// يُستخدم في الميزانية: قيمة المخزون الحقيقية = branchStock + WIP.
import { sql } from "drizzle-orm";
import { getDb } from "../../db";
import { sumMoney } from "../money";

export interface WIPRow {
  workOrderId: number;
  orderNumber: string;
  branchId: number | null;
  customerId: number | null;
  customerName: string | null;
  status: "IN_PROGRESS" | "READY";
  materialsCost: string; // decimal
  createdAt: Date;
}

export interface WIPReport {
  rows: WIPRow[];
  totalCount: number;
  totalMaterialsCost: string; // مجموع الـmaterialsCost بـDecimal
}

export async function getWIPReport(opts: { branchId?: number; limit?: number } = {}): Promise<WIPReport> {
  const db = getDb();
  if (!db) return { rows: [], totalCount: 0, totalMaterialsCost: "0.00" };
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
  const { workOrders } = await import("../../../drizzle/schema");
  const branchFilter = opts.branchId ? sql`AND wo.branchId = ${opts.branchId}` : sql``;
  const rows = await db.execute(sql`
    SELECT
      wo.id AS workOrderId,
      wo.orderNumber AS orderNumber,
      wo.branchId AS branchId,
      wo.customerId AS customerId,
      c.name AS customerName,
      wo.workOrderStatus AS status,
      COALESCE(wo.materialsCost, 0) AS materialsCost,
      wo.createdAt AS createdAt
    FROM workOrders wo
    LEFT JOIN customers c ON c.id = wo.customerId
    WHERE wo.workOrderStatus IN ('IN_PROGRESS', 'READY')
    ${branchFilter}
    ORDER BY wo.id DESC
    LIMIT ${limit}
  `);
  const data = ((rows as any)[0] ?? rows) as Array<any>;
  const wipRows: WIPRow[] = (Array.isArray(data) ? data : []).map((r) => ({
    workOrderId: Number(r.workOrderId),
    orderNumber: String(r.orderNumber),
    branchId: r.branchId != null ? Number(r.branchId) : null,
    customerId: r.customerId != null ? Number(r.customerId) : null,
    customerName: r.customerName ?? null,
    status: String(r.status) as "IN_PROGRESS" | "READY",
    materialsCost: String(r.materialsCost ?? "0"),
    createdAt: new Date(r.createdAt),
  }));
  const totalMaterialsCost = sumMoney(wipRows.map((r) => r.materialsCost)).toFixed(2);
  return {
    rows: wipRows,
    totalCount: wipRows.length,
    totalMaterialsCost,
  };
}
