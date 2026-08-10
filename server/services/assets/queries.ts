// قراءات: القائمة (مع الإهلاك المحسوب)، أصل منفرد + عهدة/صيانة/مستندات، خيارات النماذج.
import { and, desc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import {
  assetCustodyLog,
  assetDocuments,
  assetMaintenance,
  branches,
  employees,
  fixedAssets,
  kioskDevices,
  suppliers,
} from "../../../drizzle/schema";
import { requireDb } from "../tx";
import { sumMoney } from "../money";
import type { CompanyBranchScope } from "../companyBranchScope";
import { computeDepreciation } from "./depreciation";

const empNameSql = sql<string | null>`concat(${employees.firstName}, ' ', ${employees.lastName})`;

export interface AssetFilters {
  category?: string;
  branchId?: number;
  status?: string;
  includeDisposed?: boolean;
}

export async function listAssets(filters: AssetFilters | undefined, scope: CompanyBranchScope) {
  const db = requireDb();
  const custodianJoin = scope.branchId == null
    ? eq(fixedAssets.custodianId, employees.id)
    : and(eq(fixedAssets.custodianId, employees.id), eq(employees.branchId, scope.branchId));
  const deviceJoin = scope.branchId == null
    ? eq(fixedAssets.linkedDeviceId, kioskDevices.id)
    : and(eq(fixedAssets.linkedDeviceId, kioskDevices.id), eq(kioskDevices.branchId, scope.branchId));
  const conds = [eq(fixedAssets.isActive, true)];
  if (scope.branchId != null) conds.push(eq(fixedAssets.branchId, scope.branchId));
  if (filters?.category) conds.push(eq(fixedAssets.category, filters.category as never));
  if (filters?.branchId) {
    // A mismatching filter must never widen a branch-scoped list.
    if (scope.branchId == null || filters.branchId === scope.branchId) {
      conds.push(eq(fixedAssets.branchId, filters.branchId));
    } else {
      return [];
    }
  }
  if (filters?.status) conds.push(eq(fixedAssets.status, filters.status as never));
  else if (!filters?.includeDisposed) conds.push(inArray(fixedAssets.status, ["active", "maintenance", "retired"]));

  const rows = await db
    .select({
      ...getTableColumns(fixedAssets),
      custodianName: empNameSql,
      branchName: branches.name,
      linkedDeviceInScope: kioskDevices.id,
    })
    .from(fixedAssets)
    .leftJoin(employees, custodianJoin)
    .leftJoin(kioskDevices, deviceJoin)
    .leftJoin(branches, eq(fixedAssets.branchId, branches.id))
    .where(and(...conds))
    .orderBy(desc(fixedAssets.id));

  // أَثرِ كل أصل بقيم الإهلاك المحسوبة (لا تُخزَّن — تُحسب عند القراءة).
  return rows.map((r) => {
    const { linkedDeviceInScope, ...base } = r;
    const scopedRow = {
      ...base,
      custodianId: scope.branchId != null && base.custodianId != null && base.custodianName == null
        ? null
        : base.custodianId,
      linkedDeviceId: scope.branchId != null && base.linkedDeviceId != null && linkedDeviceInScope == null
        ? null
        : base.linkedDeviceId,
    };
    return { ...scopedRow, ...computeDepreciation(scopedRow) };
  });
}

export async function getAsset(id: number, scope: CompanyBranchScope) {
  const db = requireDb();
  const custodianJoin = scope.branchId == null
    ? eq(fixedAssets.custodianId, employees.id)
    : and(eq(fixedAssets.custodianId, employees.id), eq(employees.branchId, scope.branchId));
  const deviceJoin = scope.branchId == null
    ? eq(fixedAssets.linkedDeviceId, kioskDevices.id)
    : and(eq(fixedAssets.linkedDeviceId, kioskDevices.id), eq(kioskDevices.branchId, scope.branchId));
  const conds = [eq(fixedAssets.id, id)];
  if (scope.branchId != null) conds.push(eq(fixedAssets.branchId, scope.branchId));
  const [a] = await db
    .select({
      ...getTableColumns(fixedAssets),
      custodianName: empNameSql,
      branchName: branches.name,
      supplierName: suppliers.name,
      linkedDeviceInScope: kioskDevices.id,
    })
    .from(fixedAssets)
    .leftJoin(employees, custodianJoin)
    .leftJoin(kioskDevices, deviceJoin)
    .leftJoin(branches, eq(fixedAssets.branchId, branches.id))
    .leftJoin(suppliers, eq(fixedAssets.supplierId, suppliers.id))
    .where(and(...conds))
    .limit(1);
  if (!a) return null;

  const { linkedDeviceInScope, ...baseAsset } = a;
  const scopedAsset = {
    ...baseAsset,
    custodianId: scope.branchId != null && baseAsset.custodianId != null && baseAsset.custodianName == null
      ? null
      : baseAsset.custodianId,
    linkedDeviceId: scope.branchId != null && baseAsset.linkedDeviceId != null && linkedDeviceInScope == null
      ? null
      : baseAsset.linkedDeviceId,
  };
  const relationConds = [eq(fixedAssets.id, id)];
  if (scope.branchId != null) relationConds.push(eq(fixedAssets.branchId, scope.branchId));
  const custodyEmployeeJoin = scope.branchId == null
    ? eq(assetCustodyLog.employeeId, employees.id)
    : and(eq(assetCustodyLog.employeeId, employees.id), eq(employees.branchId, scope.branchId));
  const [custody, maintenance, docs] = await Promise.all([
    db
      .select({ ...getTableColumns(assetCustodyLog), employeeName: empNameSql })
      .from(assetCustodyLog)
      .innerJoin(fixedAssets, eq(assetCustodyLog.assetId, fixedAssets.id))
      .innerJoin(employees, custodyEmployeeJoin)
      .where(and(eq(assetCustodyLog.assetId, id), ...relationConds))
      .orderBy(desc(assetCustodyLog.fromDate)),
    db
      .select({ ...getTableColumns(assetMaintenance) })
      .from(assetMaintenance)
      .innerJoin(fixedAssets, eq(assetMaintenance.assetId, fixedAssets.id))
      .where(and(eq(assetMaintenance.assetId, id), ...relationConds))
      .orderBy(desc(assetMaintenance.maintDate)),
    db
      .select({ ...getTableColumns(assetDocuments) })
      .from(assetDocuments)
      .innerJoin(fixedAssets, eq(assetDocuments.assetId, fixedAssets.id))
      .where(and(eq(assetDocuments.assetId, id), ...relationConds)),
  ]);

  // FA-05 (§٥): جمع المال عبر decimal لا Number/float (يَمنع انجراف الكسور في إجمالي الصيانة).
  const maintTotal = sumMoney(maintenance.map((m) => m.cost)).toNumber();
  return { ...scopedAsset, ...computeDepreciation(scopedAsset), custody, maintenance, docs, maintTotal };
}

/** خيارات النماذج (إضافة/تسليم عهدة): الموظفون والفروع والموردون. */
export async function formOptions(scope: CompanyBranchScope) {
  const db = requireDb();
  const employeeConds = [eq(employees.isActive, true)];
  if (scope.branchId != null) employeeConds.push(eq(employees.branchId, scope.branchId));
  const [emps, brs, sups] = await Promise.all([
    db
      .select({ id: employees.id, name: empNameSql, position: employees.position, branchId: employees.branchId })
      .from(employees)
      .where(and(...employeeConds))
      .orderBy(employees.firstName),
    db
      .select({ id: branches.id, name: branches.name })
      .from(branches)
      .where(scope.branchId == null ? undefined : eq(branches.id, scope.branchId))
      .orderBy(branches.name),
    db.select({ id: suppliers.id, name: suppliers.name }).from(suppliers).orderBy(suppliers.name),
  ]);
  return { employees: emps, branches: brs, suppliers: sups };
}
