// دورة حياة الأصل بعد الإنشاء: تسليم عهدة + تسجيل/إنهاء صيانة.
import { and, eq, isNull } from "drizzle-orm";
import { assetCustodyLog, assetMaintenance, employees, fixedAssets } from "../../../drizzle/schema";
import { toDateStr, toDbMoney } from "../money";
import { withTx } from "../tx";
import { loadForUpdate } from "./helpers";
import { getAsset } from "./queries";

/** تسليم عهدة: يُغلق العهدة الجارية ويفتح أخرى للموظف الجديد، ويحدّث صاحب العهدة.
 *  يتحقّق من أنّ الموظف نشط (employmentStatus='active') لمنع تسجيل عهدة على موظف منتهي/في إجازة،
 *  ومن توافق فرع الأصل مع فرع الموظف لمنع ضياع تتبّع المسؤولية عبر الفروع. */
export async function handoverCustody(assetId: number, employeeId: number, note?: string) {
  const today = toDateStr();
  await withTx(async (tx) => {
    const a = await loadForUpdate(tx, assetId);
    if (a.status === "disposed") throw new Error("لا يمكن تسليم عهدة أصل مُستبعَد");
    if (a.custodianId === employeeId) throw new Error("الأصل بعهدة هذا الموظف أصلاً");

    // فحص حالة الموظف وفرعه ضمن المعاملة (FK يضمن وجود الصفّ فقط، لا حالته).
    const [emp] = await tx
      .select({ status: employees.employmentStatus, branchId: employees.branchId })
      .from(employees)
      .where(eq(employees.id, employeeId))
      .limit(1);
    if (!emp) throw new Error("الموظف غير موجود");
    if (emp.status !== "active") {
      throw new Error("لا يمكن تسليم عهدة لموظف ليس على رأس العمل");
    }
    if (a.branchId != null && emp.branchId != null && Number(a.branchId) !== Number(emp.branchId)) {
      throw new Error("لا يمكن تسليم عهدة لموظف من فرع مختلف عن فرع الأصل");
    }

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
