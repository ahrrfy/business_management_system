// دورة حياة الأصل بعد الإنشاء: تسليم عهدة + تسجيل/إنهاء صيانة.
import { TRPCError } from "@trpc/server";
import { and, eq, isNull } from "drizzle-orm";
import { assetCustodyLog, assetMaintenance, employees, fixedAssets } from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { lockCashSourceForUpdate } from "../cash/cashAvailability";
import { money, toDateStr, toDbMoney } from "../money";
import { type Actor, withTx } from "../tx";
import { companyBranchScope } from "../companyBranchScope";
import { loadForUpdate } from "./helpers";
import { getAsset } from "./queries";
import { createSystemPaymentRequestTx } from "../voucher/create";

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
    const cost = money(m.cost ?? "0");
    // المعاينة لا تُعتمد كحقيقة أعمال؛ غرضها تحديد mutex الخزينة فقط. ترتيب جميع
    // المسارات النقدية للأصل هو branch/source → asset، ثم نعيد التحقق تحت قفل الأصل.
    const previewConds = [eq(fixedAssets.id, assetId)];
    if (scope.branchId != null) previewConds.push(eq(fixedAssets.branchId, scope.branchId));
    const [preview] = await tx
      .select({ branchId: fixedAssets.branchId })
      .from(fixedAssets)
      .where(and(...previewConds))
      .limit(1);
    if (!preview) throw new TRPCError({ code: "NOT_FOUND", message: "الأصل غير موجود" });
    const previewBranchId = preview.branchId != null ? Number(preview.branchId) : (actor.branchId ?? null);
    if (cost.gt(0)) {
      if (previewBranchId == null) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "دفع صيانة الأصل نقداً يتطلب فرعاً محدداً لخزينة الصرف",
        });
      }
      await lockCashSourceForUpdate(tx, {
        branchId: previewBranchId,
        cashBucket: "TREASURY",
        shiftId: null,
      });
    }
    const a = await loadForUpdate(tx, assetId, scope);
    const branchId = a.branchId != null ? Number(a.branchId) : (actor.branchId ?? null);
    if (cost.gt(0) && branchId !== previewBranchId) {
      throw new TRPCError({ code: "CONFLICT", message: "تغيّر فرع الأصل أثناء تسجيل الصيانة — أعد المحاولة" });
    }
    if (a.status === "disposed") throw new Error("لا يمكن تسجيل صيانة لأصل مُستبعَد");
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
    // تسجيل الصيانة يثبت الحدث التشغيلي فقط؛ الدفع الخارجي طلبٌ معلّق لا يلمس الخزينة/الدفتر
    // حتى ينفذه مالك نشط مختلف عبر approveVoucher. الصيانة الصفرية (كفالة) بلا طلب دفع.
    if (cost.gt(0)) {
      if (branchId == null) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "دفع صيانة الأصل نقداً يتطلب فرعاً محدداً لخزينة الصرف",
        });
      }
      await createSystemPaymentRequestTx(tx, {
        branchId,
        amount: toDbMoney(cost),
        paymentMethod: "CASH",
        partyType: "OTHER",
        counterpartyName: m.vendor?.trim() || `صيانة أصل ${a.code ?? assetId}`,
        description: `صيانة أصل ${a.code ?? assetId} — ${m.type}`,
        referenceNumber: `ASSET-MAINT-${maintId}`,
        voucherDate: maintDate,
        clientRequestId: `asset-maintenance-${maintId}`,
      }, actor, { kind: "ASSET_MAINTENANCE", assetId, maintenanceId: maintId });
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
