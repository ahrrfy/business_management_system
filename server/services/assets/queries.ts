// قراءات: القائمة (مع الإهلاك المحسوب)، أصل منفرد + عهدة/صيانة/مستندات، خيارات النماذج.
import { and, desc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import {
  assetCustodyLog,
  assetDocuments,
  assetMaintenance,
  branches,
  employees,
  fixedAssets,
  suppliers,
} from "../../../drizzle/schema";
import { requireDb } from "../tx";
import { sumMoney } from "../money";
import { computeDepreciation } from "./depreciation";

const empNameSql = sql<string | null>`concat(${employees.firstName}, ' ', ${employees.lastName})`;

export interface AssetFilters {
  category?: string;
  branchId?: number;
  status?: string;
  includeDisposed?: boolean;
}

export async function listAssets(filters?: AssetFilters) {
  const db = requireDb();
  const conds = [eq(fixedAssets.isActive, true)];
  if (filters?.category) conds.push(eq(fixedAssets.category, filters.category as never));
  if (filters?.branchId) conds.push(eq(fixedAssets.branchId, filters.branchId));
  if (filters?.status) conds.push(eq(fixedAssets.status, filters.status as never));
  else if (!filters?.includeDisposed) conds.push(inArray(fixedAssets.status, ["active", "maintenance", "retired"]));

  const rows = await db
    .select({
      ...getTableColumns(fixedAssets),
      custodianName: empNameSql,
      branchName: branches.name,
    })
    .from(fixedAssets)
    .leftJoin(employees, eq(fixedAssets.custodianId, employees.id))
    .leftJoin(branches, eq(fixedAssets.branchId, branches.id))
    .where(and(...conds))
    .orderBy(desc(fixedAssets.id));

  // أَثرِ كل أصل بقيم الإهلاك المحسوبة (لا تُخزَّن — تُحسب عند القراءة).
  return rows.map((r) => ({ ...r, ...computeDepreciation(r) }));
}

export async function getAsset(id: number) {
  const db = requireDb();
  const [a] = await db
    .select({
      ...getTableColumns(fixedAssets),
      custodianName: empNameSql,
      branchName: branches.name,
      supplierName: suppliers.name,
    })
    .from(fixedAssets)
    .leftJoin(employees, eq(fixedAssets.custodianId, employees.id))
    .leftJoin(branches, eq(fixedAssets.branchId, branches.id))
    .leftJoin(suppliers, eq(fixedAssets.supplierId, suppliers.id))
    .where(eq(fixedAssets.id, id))
    .limit(1);
  if (!a) return null;

  const [custody, maintenance, docs] = await Promise.all([
    db
      .select({ ...getTableColumns(assetCustodyLog), employeeName: empNameSql })
      .from(assetCustodyLog)
      .leftJoin(employees, eq(assetCustodyLog.employeeId, employees.id))
      .where(eq(assetCustodyLog.assetId, id))
      .orderBy(desc(assetCustodyLog.fromDate)),
    db
      .select()
      .from(assetMaintenance)
      .where(eq(assetMaintenance.assetId, id))
      .orderBy(desc(assetMaintenance.maintDate)),
    db.select().from(assetDocuments).where(eq(assetDocuments.assetId, id)),
  ]);

  // FA-05 (§٥): جمع المال عبر decimal لا Number/float (يَمنع انجراف الكسور في إجمالي الصيانة).
  const maintTotal = sumMoney(maintenance.map((m) => m.cost)).toNumber();
  return { ...a, ...computeDepreciation(a), custody, maintenance, docs, maintTotal };
}

/** خيارات النماذج (إضافة/تسليم عهدة): الموظفون والفروع والموردون. */
export async function formOptions() {
  const db = requireDb();
  const [emps, brs, sups] = await Promise.all([
    db
      .select({ id: employees.id, name: empNameSql, position: employees.position, branchId: employees.branchId })
      .from(employees)
      .where(eq(employees.isActive, true))
      .orderBy(employees.firstName),
    db.select({ id: branches.id, name: branches.name }).from(branches).orderBy(branches.name),
    db.select({ id: suppliers.id, name: suppliers.name }).from(suppliers).orderBy(suppliers.name),
  ]);
  return { employees: emps, branches: brs, suppliers: sups };
}
