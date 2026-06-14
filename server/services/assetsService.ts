/* ============================================================================
 * خدمة الأصول الثابتة — منطق الأعمال وحساب الإهلاك (server/services/assetsService.ts)
 * ----------------------------------------------------------------------------
 * يتبع اتفاقيات النظام (§٥): كل عملية كتابة متعددة داخل withTx (ذرّية)، والمبالغ
 * المحفوظة عبر toDbMoney (نصّ decimal). الإهلاك قيمة تحليلية تُحسب عند القراءة ولا
 * تُخزَّن (تتغيّر بمرور الزمن) — منطقه مطابق ١:١ لنموذج التصميم (assets/data.js → computeDep).
 * ========================================================================== */
import { and, desc, eq, getTableColumns, inArray, isNull, sql } from "drizzle-orm";
import {
  assetCustodyLog,
  assetDocuments,
  assetMaintenance,
  branches,
  employees,
  fixedAssets,
  suppliers,
} from "../../drizzle/schema";
import type { Tx } from "../db";
import { requireDb, withTx } from "./tx";
import { toDateStr, toDbMoney } from "./money";

/* ----------------------------------------------------------- حساب الإهلاك */
export interface DepRow {
  year: number;
  opening: number;
  dep: number;
  closing: number;
  isCurrent: boolean;
}
export interface DepResult {
  annualDep: number;
  accumulated: number;
  bookValue: number;
  depPct: number;
  ageYears: number;
  depRate: number;
  schedule: DepRow[];
}

function yearsBetween(d1: Date, d2: Date): number {
  return (d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
}

/**
 * يحسب الإهلاك بطريقة القسط الثابت (sl) أو المتناقص المضاعف (db) حتى تاريخ asOf.
 * يتوقّف الحساب عند تاريخ الإخراج إن وُجد. الأصول المُستبعَدة تُعتبر مُهلَكة بالكامل.
 * قيمة تحليلية للعرض (تُقرَّب لأقرب دينار) — ليست عملية دفترية تمسّ رصيداً، فالحساب رقميّ.
 */
export function computeDepreciation(
  a: {
    purchaseValue: string | number;
    salvageValue: string | number;
    usefulLifeYears: number;
    depreciationMethod: "sl" | "db";
    purchaseDate: string | Date;
    status: string;
    disposalDate?: string | Date | null;
  },
  asOf: Date = new Date(),
): DepResult {
  const cost = Number(a.purchaseValue);
  const sal = Number(a.salvageValue) || 0;
  const life = a.usefulLifeYears || 1;
  const method = a.depreciationMethod || "sl";
  const annualSL = life > 0 ? Math.round(Math.max(0, cost - sal) / life) : 0;
  const rate = life > 0 ? 2 / life : 0;
  const startYear = new Date(a.purchaseDate).getFullYear();
  const curYear = asOf.getFullYear();

  const schedule: DepRow[] = [];
  let book = cost;
  for (let i = 0; i < life; i++) {
    let dep: number;
    if (method === "db") {
      dep = Math.min(Math.max(0, book - sal), Math.round(book * rate));
      if (i === life - 1) dep = Math.max(0, book - sal); // آخر سنة: أنزل للتخريدية
    } else {
      dep = Math.min(Math.max(0, book - sal), annualSL);
    }
    schedule.push({ year: startYear + i, opening: book, dep, closing: book - dep, isCurrent: startYear + i === curYear });
    book -= dep;
  }

  // المتراكم حتى تاريخ الإخراج (للمُخرَج/المُستبعَد) أو حتى asOf — تناسبياً مع جزء السنة الجاري.
  // ملاحظة محاسبية: المُستبعَد لا يُجبَر على إهلاك كامل؛ يُحتسب بقيمته الدفترية الحقيقية عند تاريخ
  // الإخراج كي يصحّ ربح/خسارة الاستبعاد (proceeds − NBV). الأصل الذي تجاوز عمره يبلغ التخريدية طبيعياً.
  const stop = a.disposalDate ? new Date(a.disposalDate) : null;
  const age = Math.max(0, yearsBetween(new Date(a.purchaseDate), stop || asOf));

  let accumulated = 0;
  const fy = Math.floor(age);
  const frac = age - fy;
  for (let i = 0; i < life; i++) {
    if (i < fy) accumulated += schedule[i].dep;
    else if (i === fy) {
      accumulated += Math.round(schedule[i].dep * frac);
      break;
    }
  }
  accumulated = Math.min(accumulated, Math.max(0, cost - sal));
  const bookValue = Math.max(sal, cost - accumulated);
  const curIdx = Math.min(life - 1, Math.floor(age));
  return {
    annualDep: method === "db" ? (schedule[curIdx]?.dep ?? annualSL) : annualSL,
    accumulated,
    bookValue,
    depPct: cost > 0 ? Math.min(100, Math.round((accumulated / cost) * 100)) : 0,
    ageYears: Math.round(age * 10) / 10,
    depRate: method === "db" ? rate : cost > 0 ? annualSL / cost : 0,
    schedule,
  };
}

/* ----------------------------------------------------------- ترقيم الأصول */
const empNameSql = sql<string | null>`concat(${employees.firstName}, ' ', ${employees.lastName})`;

/** الرمز التالي AST-#### — قراءة مرتّبة تحت قفل FOR UPDATE تُضيّق السباق، وقيد UNIQUE هو الحارس النهائي. */
async function nextAssetCode(tx: Tx): Promise<string> {
  const rows = await tx
    .select({ code: fixedAssets.code })
    .from(fixedAssets)
    .orderBy(desc(fixedAssets.id))
    .for("update")
    .limit(1);
  const last = rows[0] ? parseInt(rows[0].code.replace(/\D/g, ""), 10) || 1000 : 1000;
  return "AST-" + (Math.max(1000, last) + 1);
}

/* ----------------------------------------------------------- قراءات */
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

  const maintTotal = maintenance.reduce((s, m) => s + Number(m.cost), 0);
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

/* ----------------------------------------------------------- كتابات (ذرّية) */
export interface CreateAssetInput {
  name: string;
  category: string;
  brand?: string | null;
  serial?: string | null;
  branchId?: number | null;
  location?: string | null;
  custodianId?: number | null;
  supplierId?: number | null;
  purchaseDate: string;
  purchaseValue: string;
  salvageValue?: string;
  usefulLifeYears: number;
  depreciationMethod?: "sl" | "db";
  condition?: string | null;
  warrantyEnd?: string | null;
  linkedDeviceId?: number | null;
}

export async function createAsset(input: CreateAssetInput) {
  const id = await withTx(async (tx) => {
    const code = await nextAssetCode(tx);
    const [res] = await tx.insert(fixedAssets).values({
      code,
      name: input.name,
      category: input.category as never,
      brand: input.brand ?? null,
      serial: input.serial ?? null,
      branchId: input.branchId ?? null,
      location: input.location ?? null,
      custodianId: input.custodianId ?? null,
      supplierId: input.supplierId ?? null,
      purchaseDate: input.purchaseDate,
      purchaseValue: toDbMoney(input.purchaseValue),
      salvageValue: toDbMoney(input.salvageValue ?? "0"),
      usefulLifeYears: input.usefulLifeYears,
      depreciationMethod: input.depreciationMethod ?? "sl",
      condition: input.condition ?? null,
      warrantyEnd: input.warrantyEnd ?? null,
      linkedDeviceId: input.linkedDeviceId ?? null,
    });
    const newId = Number((res as { insertId: number }).insertId);
    // إن سُلّم بعهدة عند الإنشاء، افتح سطر عهدة جارية من تاريخ الشراء.
    if (input.custodianId) {
      await tx.insert(assetCustodyLog).values({
        assetId: newId,
        employeeId: input.custodianId,
        fromDate: input.purchaseDate || toDateStr(),
        toDate: null,
        note: "تسليم عند إضافة الأصل",
      });
    }
    return newId;
  });
  return getAsset(id);
}

/** تعديل بيانات أصل قائم (لا يشمل العهدة/الحالة/الاستبعاد — لها مساراتها). */
export interface UpdateAssetInput {
  name: string;
  category: string;
  brand?: string | null;
  serial?: string | null;
  branchId?: number | null;
  location?: string | null;
  supplierId?: number | null;
  purchaseDate: string;
  purchaseValue: string;
  salvageValue?: string;
  usefulLifeYears: number;
  depreciationMethod?: "sl" | "db";
  condition?: string | null;
  warrantyEnd?: string | null;
}

export async function updateAsset(id: number, input: UpdateAssetInput) {
  if (!(input.usefulLifeYears > 0)) throw new Error("العمر الإنتاجي يجب أن يكون أكبر من صفر");
  await withTx(async (tx) => {
    const a = await loadForUpdate(tx, id);
    if (a.status === "disposed") throw new Error("لا يمكن تعديل أصل مُستبعَد");
    await tx
      .update(fixedAssets)
      .set({
        name: input.name,
        category: input.category as never,
        brand: input.brand ?? null,
        serial: input.serial ?? null,
        branchId: input.branchId ?? null,
        location: input.location ?? null,
        supplierId: input.supplierId ?? null,
        purchaseDate: input.purchaseDate,
        purchaseValue: toDbMoney(input.purchaseValue),
        salvageValue: toDbMoney(input.salvageValue ?? "0"),
        usefulLifeYears: input.usefulLifeYears,
        depreciationMethod: input.depreciationMethod ?? "sl",
        condition: input.condition ?? null,
        warrantyEnd: input.warrantyEnd ?? null,
      })
      .where(eq(fixedAssets.id, id));
  });
  return getAsset(id);
}

/** يحمّل الأصل داخل المعاملة تحت قفل صفّ (FOR UPDATE) — يمنع سباق TOCTOU بين فحص الحالة والكتابة. */
async function loadForUpdate(tx: Tx, assetId: number) {
  const [a] = await tx.select().from(fixedAssets).where(eq(fixedAssets.id, assetId)).for("update").limit(1);
  if (!a) throw new Error("الأصل غير موجود");
  return a;
}

/** تسليم عهدة: يُغلق العهدة الجارية ويفتح أخرى للموظف الجديد، ويحدّث صاحب العهدة. */
export async function handoverCustody(assetId: number, employeeId: number, note?: string) {
  const today = toDateStr();
  await withTx(async (tx) => {
    const a = await loadForUpdate(tx, assetId);
    if (a.status === "disposed") throw new Error("لا يمكن تسليم عهدة أصل مُستبعَد");
    if (a.custodianId === employeeId) throw new Error("الأصل بعهدة هذا الموظف أصلاً");
    await tx
      .update(assetCustodyLog)
      .set({ toDate: today })
      .where(and(eq(assetCustodyLog.assetId, assetId), isNull(assetCustodyLog.toDate)));
    await tx.insert(assetCustodyLog).values({ assetId, employeeId, fromDate: today, toDate: null, note: note ?? null });
    await tx.update(fixedAssets).set({ custodianId: employeeId }).where(eq(fixedAssets.id, assetId));
  });
  return getAsset(assetId);
}

export interface MaintenanceInput {
  type: string;
  vendor?: string | null;
  cost?: string | number | null;
  note?: string | null;
  maintDate?: string;
}

export async function addMaintenance(assetId: number, m: MaintenanceInput) {
  await withTx(async (tx) => {
    const a = await loadForUpdate(tx, assetId);
    if (a.status === "disposed") throw new Error("لا يمكن تسجيل صيانة لأصل مُستبعَد");
    await tx.insert(assetMaintenance).values({
      assetId,
      maintDate: m.maintDate ?? toDateStr(),
      type: m.type,
      vendor: m.vendor ?? null,
      cost: toDbMoney(m.cost ?? "0"),
      note: m.note ?? null,
    });
    // الأصل قيد الصيانة الآن (إن لم يكن مُستبعَداً).
    if (a.status !== "retired") {
      await tx.update(fixedAssets).set({ status: "maintenance" }).where(eq(fixedAssets.id, assetId));
    }
  });
  return getAsset(assetId);
}

/** إعادة أصل من الصيانة إلى الخدمة. */
export async function returnFromMaintenance(assetId: number) {
  await withTx(async (tx) => {
    const a = await loadForUpdate(tx, assetId);
    if (a.status !== "maintenance") throw new Error("الأصل ليس في حالة صيانة");
    await tx.update(fixedAssets).set({ status: "active" }).where(eq(fixedAssets.id, assetId));
  });
  return getAsset(assetId);
}

export interface DisposeInput {
  kind: "retired" | "disposed";
  date: string;
  reason?: string | null;
  value?: string | number | null;
}

/** إخراج من الخدمة (retired) أو استبعاد ببيع/خردة (disposed) مع احتساب الربح/الخسارة. */
export async function disposeAsset(assetId: number, input: DisposeInput) {
  await withTx(async (tx) => {
    const a = await loadForUpdate(tx, assetId);
    if (a.status === "disposed") throw new Error("الأصل مُستبعَد سلفاً");
    await tx
      .update(assetCustodyLog)
      .set({ toDate: input.date })
      .where(and(eq(assetCustodyLog.assetId, assetId), isNull(assetCustodyLog.toDate)));
    await tx
      .update(fixedAssets)
      .set({
        status: input.kind,
        disposalDate: input.date,
        disposalReason: input.reason ?? null,
        disposalValue: input.kind === "disposed" ? toDbMoney(input.value ?? "0") : null,
        custodianId: null,
      })
      .where(eq(fixedAssets.id, assetId));
  });
  return getAsset(assetId);
}

/* ----------------------------------------------------------- لوحة المؤشّرات */
export async function dashboard() {
  const all = await listAssets({ includeDisposed: true });
  const live = all.filter((a) => a.status === "active" || a.status === "maintenance" || a.status === "retired");

  const totalAssets = live.length;
  const purchaseValue = live.reduce((s, a) => s + Number(a.purchaseValue), 0);
  const bookValue = live.reduce((s, a) => s + a.bookValue, 0);
  const accumulated = live.reduce((s, a) => s + a.accumulated, 0);
  const inMaintenance = live.filter((a) => a.status === "maintenance").length;
  const inCustody = live.filter((a) => a.custodianId).length;

  // القيمة الدفترية حسب الفئة.
  const byCategory = new Map<string, { count: number; value: number }>();
  for (const a of live) {
    const c = byCategory.get(a.category) ?? { count: 0, value: 0 };
    c.count += 1;
    c.value += a.bookValue;
    byCategory.set(a.category, c);
  }
  // القيمة الدفترية حسب الفرع.
  const byBranch = new Map<string, { count: number; value: number }>();
  for (const a of live) {
    const key = a.branchName ?? "بلا فرع";
    const b = byBranch.get(key) ?? { count: 0, value: 0 };
    b.count += 1;
    b.value += a.bookValue;
    byBranch.set(key, b);
  }

  // أحدث عمليات الصيانة (عبر كل الأصول).
  const db = requireDb();
  const recentMaintenance = await db
    .select({
      ...getTableColumns(assetMaintenance),
      assetName: fixedAssets.name,
      assetCode: fixedAssets.code,
    })
    .from(assetMaintenance)
    .leftJoin(fixedAssets, eq(assetMaintenance.assetId, fixedAssets.id))
    .orderBy(desc(assetMaintenance.maintDate))
    .limit(6);

  // تحتاج إجراءً: قيد الصيانة، أو انتهت كفالتها، أو لا عهدة.
  const today = toDateStr();
  const needsAction = live
    .filter((a) => a.status === "maintenance" || (a.warrantyEnd && String(a.warrantyEnd) < today && a.status === "active") || !a.custodianId)
    .slice(0, 8)
    .map((a) => ({
      id: a.id,
      code: a.code,
      name: a.name,
      reason:
        a.status === "maintenance"
          ? "قيد الصيانة"
          : !a.custodianId
            ? "بلا عهدة مُسندة"
            : "انتهت الكفالة",
    }));

  return {
    kpis: { totalAssets, purchaseValue, bookValue, accumulated, inMaintenance, inCustody },
    byCategory: Array.from(byCategory.entries()).map(([category, v]) => ({ category, ...v })).sort((a, b) => b.value - a.value),
    byBranch: Array.from(byBranch.entries()).map(([branch, v]) => ({ branch, ...v })).sort((a, b) => b.value - a.value),
    recentMaintenance,
    needsAction,
  };
}

/* ----------------------------------------------------------- تقارير */
/** تقرير العهد مجمّعاً حسب الموظف (للأصول بالخدمة/الصيانة فقط). */
export async function custodyReport() {
  const live = (await listAssets()).filter((a) => a.status === "active" || a.status === "maintenance");
  const byEmp = new Map<number, { employeeId: number; employeeName: string | null; count: number; value: number; items: typeof live }>();
  const unassigned: typeof live = [];
  for (const a of live) {
    if (!a.custodianId) {
      unassigned.push(a);
      continue;
    }
    const e = byEmp.get(a.custodianId) ?? { employeeId: a.custodianId, employeeName: a.custodianName, count: 0, value: 0, items: [] };
    e.count += 1;
    e.value += a.bookValue;
    e.items.push(a);
    byEmp.set(a.custodianId, e);
  }
  return {
    byEmployee: Array.from(byEmp.values()).sort((a, b) => b.value - a.value),
    unassigned,
  };
}

/** سجلّ الاستبعاد/الإخراج مع نتيجة (ربح/خسارة) كل عملية. */
export async function disposalLog() {
  const db = requireDb();
  const rows = await db
    .select({ ...getTableColumns(fixedAssets), branchName: branches.name })
    .from(fixedAssets)
    .leftJoin(branches, eq(fixedAssets.branchId, branches.id))
    .where(inArray(fixedAssets.status, ["disposed", "retired"]))
    .orderBy(desc(fixedAssets.disposalDate));
  return rows.map((a) => {
    const dep = computeDepreciation(a);
    const proceeds = a.status === "disposed" ? Number(a.disposalValue ?? 0) : null;
    return {
      ...a,
      ...dep,
      proceeds,
      gain: proceeds !== null ? proceeds - dep.bookValue : null,
    };
  });
}
