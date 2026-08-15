// دورة حياة الأصل بعد الإنشاء: تسليم عهدة + تسجيل/إنهاء صيانة.
import { TRPCError } from "@trpc/server";
import { and, eq, isNull } from "drizzle-orm";
import { assetCustodyLog, assetMaintenance, employees, fixedAssets, receipts } from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { postEntry } from "../ledgerService";
import { assertCashOutAvailable } from "../cash/cashAvailability";
import { money, toDateStr, toDbMoney } from "../money";
import { type Actor, withTx } from "../tx";
import { companyBranchScope } from "../companyBranchScope";
import { loadForUpdate } from "./helpers";
import { getAsset } from "./queries";

/** تسليم عهدة: يُغلق العهدة الجارية ويفتح أخرى للموظف الجديد، ويحدّث صاحب العهدة.
 *  يتحقّق من أنّ الموظف نشط (employmentStatus='active') لمنع تسجيل عهدة على موظف منتهي/في إجازة،
 *  ومن توافق فرع الأصل مع فرع الموظف لمنع ضياع تتبّع المسؤولية عبر الفروع. */
export async function handoverCustody(assetId: number, employeeId: number, note: string | undefined, actor: Actor) {
  const scope = companyBranchScope(actor);
  const today = toDateStr();
  await withTx(async (tx) => {
    const a = await loadForUpdate(tx, assetId, scope);
    if (a.status === "disposed") throw new Error("لا يمكن تسليم عهدة أصل مُستبعَد");
    if (a.custodianId === employeeId) throw new Error("الأصل بعهدة هذا الموظف أصلاً");

    // فحص حالة الموظف وفرعه ضمن المعاملة (FK يضمن وجود الصفّ فقط، لا حالته).
    const [emp] = await tx
      .select({ status: employees.employmentStatus, branchId: employees.branchId })
      .from(employees)
      .where(eq(employees.id, employeeId))
      .for("update")
      .limit(1);
    if (!emp) throw new Error("الموظف غير موجود");
    if (emp.status !== "active") {
      throw new Error("لا يمكن تسليم عهدة لموظف ليس على رأس العمل");
    }
    if (a.branchId != null && (emp.branchId == null || Number(a.branchId) !== Number(emp.branchId))) {
      throw new Error("لا يمكن تسليم عهدة لموظف من فرع مختلف عن فرع الأصل");
    }

    await tx
      .update(assetCustodyLog)
      .set({ toDate: today })
      .where(and(eq(assetCustodyLog.assetId, assetId), isNull(assetCustodyLog.toDate)));
    await tx.insert(assetCustodyLog).values({ assetId, employeeId, fromDate: today, toDate: null, note: note ?? null });
    await tx.update(fixedAssets).set({ custodianId: employeeId }).where(eq(fixedAssets.id, assetId));
  });
  return getAsset(assetId, scope);
}

export interface MaintenanceInput {
  type: string;
  vendor?: string | null;
  cost?: string | number | null;
  note?: string | null;
  maintDate?: string;
}

export async function addMaintenance(assetId: number, m: MaintenanceInput, actor: Actor) {
  const scope = companyBranchScope(actor);
  await withTx(async (tx) => {
    const a = await loadForUpdate(tx, assetId, scope);
    if (a.status === "disposed") throw new Error("لا يمكن تسجيل صيانة لأصل مُستبعَد");
    const cost = money(m.cost ?? "0");
    const maintDate = m.maintDate ?? toDateStr();
    const res = await tx.insert(assetMaintenance).values({
      assetId,
      maintDate,
      type: m.type,
      vendor: m.vendor ?? null,
      cost: toDbMoney(cost),
      note: m.note ?? null,
    });
    const maintId = extractInsertId(res);
    // قيد تلقائيّ عند كل دفع (§٥، تدقيق ١٧/٧): تكلفة الصيانة النقدية تخرج نقداً من الخزينة بإيصال OUT +
    // قيد PAYMENT_OUT (نمط اقتناء الأصل النقديّ create.ts). كان صفّ الصيانة يُدرَج بلا أثرٍ ماليّ ⇒
    // مالٌ يُدفَع بلا قيد دفتريّ ولا نقصٍ في الخزينة. الصيانة الصفرية (كفالة) لا تُرحّل قيداً.
    if (cost.gt(0)) {
      const branchId = a.branchId != null ? Number(a.branchId) : (actor.branchId ?? null);
      if (branchId == null) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "دفع صيانة الأصل نقداً يتطلب فرعاً محدداً لخزينة الصرف",
        });
      }
      await assertCashOutAvailable(tx, {
        branchId,
        cashBucket: "TREASURY",
        amount: cost,
        operation: "دفع صيانة الأصل نقداً",
      });
      const rRes = await tx.insert(receipts).values({
        branchId,
        cashBucket: "TREASURY",
        direction: "OUT",
        amount: toDbMoney(cost),
        paymentMethod: "CASH",
        status: "COMPLETED",
        createdBy: actor.userId,
        description: `صيانة أصل ${a.code ?? assetId}`,
      });
      const receiptId = extractInsertId(rRes);
      await postEntry(tx, {
        entryType: "PAYMENT_OUT",
        branchId,
        receiptId,
        amount: cost,
        entryDate: new Date(maintDate),
        dedupeKey: `ASSET_MAINT:${maintId}`,
        notes: `صيانة أصل ${a.code ?? assetId} — ${m.type}`,
      });
    }
    // الأصل قيد الصيانة الآن (إن لم يكن مُستبعَداً).
    if (a.status !== "retired") {
      await tx.update(fixedAssets).set({ status: "maintenance" }).where(eq(fixedAssets.id, assetId));
    }
  });
  return getAsset(assetId, scope);
}

/**
 * إعادة العهدة إلى الشركة من دون تسليمها لموظف جديد.
 * يغلق كل سجل مفتوح للأصل تحت قفل الصف، ويزيل custodianId فقط؛ ربط الجهاز
 * أصلٌ تشغيلي مستقل عن عهدة الموظف ولذلك يبقى كما هو.
 */
export async function returnCustody(assetId: number, actor: Actor) {
  const scope = companyBranchScope(actor);
  const today = toDateStr();
  await withTx(async (tx) => {
    const asset = await loadForUpdate(tx, assetId, scope);
    if (asset.status === "disposed") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن إعادة عهدة أصل مُستبعَد" });
    }
    if (asset.custodianId == null) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "الأصل بلا عهدة مفتوحة" });
    }

    const openRows = await tx
      .select({ id: assetCustodyLog.id, employeeId: assetCustodyLog.employeeId })
      .from(assetCustodyLog)
      .where(and(eq(assetCustodyLog.assetId, assetId), isNull(assetCustodyLog.toDate)))
      .for("update");
    if (!openRows.some((row) => Number(row.employeeId) === Number(asset.custodianId))) {
      throw new TRPCError({ code: "CONFLICT", message: "سجل العهدة المفتوح غير متطابق مع الأصل" });
    }

    await tx
      .update(assetCustodyLog)
      .set({ toDate: today })
      .where(and(eq(assetCustodyLog.assetId, assetId), isNull(assetCustodyLog.toDate)));
    // Returning employee custody is independent from device pairing.
    await tx.update(fixedAssets).set({ custodianId: null }).where(eq(fixedAssets.id, assetId));
  });
  return getAsset(assetId, scope);
}

/** إعادة أصل من الصيانة إلى الخدمة. */
export async function returnFromMaintenance(assetId: number, actor: Actor) {
  const scope = companyBranchScope(actor);
  await withTx(async (tx) => {
    const a = await loadForUpdate(tx, assetId, scope);
    if (a.status !== "maintenance") throw new Error("الأصل ليس في حالة صيانة");
    await tx.update(fixedAssets).set({ status: "active" }).where(eq(fixedAssets.id, assetId));
  });
  return getAsset(assetId, scope);
}
