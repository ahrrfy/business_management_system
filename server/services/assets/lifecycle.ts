// دورة حياة الأصل بعد الإنشاء: تسليم عهدة + تسجيل/إنهاء صيانة.
import { TRPCError } from "@trpc/server";
import { and, eq, isNull } from "drizzle-orm";
import { accountingEntries, accrualObligationEvents, accrualObligations, assetCustodyLog, assetMaintenance, employees, expenses, fixedAssets, suppliers } from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { money, toDateStr, toDbMoney } from "../money";
import { type Actor, withTx } from "../tx";
import { companyBranchScope } from "../companyBranchScope";
import { loadForUpdate } from "./helpers";
import { getAsset } from "./queries";
import { createSystemPaymentRequestTx } from "../voucher/create";
import { postEntry } from "../ledgerService";
import { expenseAccrualRecognition } from "../accounting/accrualPosting";
import { createAccrualObligationTx, transitionAccrualObligationTx } from "../accounting/accrualObligations";
import { idempotencyHash, payloadHashMatches } from "../idempotency";

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
  vendorSupplierId?: number | null;
  cost?: string | number | null;
  note?: string | null;
  maintDate?: string;
  evidenceReference?: string | null;
  clientRequestId: string;
}

export async function addMaintenance(assetId: number, m: MaintenanceInput, actor: Actor) {
  const scope = companyBranchScope(actor);
  let paymentRequestReceiptId: number | null = null;
  const clientRequestId = m.clientRequestId.trim();
  const evidenceReference = m.evidenceReference?.trim() ?? "";
  const freeVendor = m.vendor?.trim() ?? "";
  const requestPayloadHash = idempotencyHash({
    assetId,
    type: m.type.trim(),
    vendor: freeVendor || null,
    vendorSupplierId: m.vendorSupplierId ?? null,
    cost: toDbMoney(m.cost ?? "0"),
    note: m.note?.trim() || null,
    maintDate: m.maintDate ?? toDateStr(),
    evidenceReference,
    clientRequestId,
  });
  if (!clientRequestId) throw new TRPCError({ code: "BAD_REQUEST", message: "مفتاح طلب الصيانة إلزامي" });
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
    if (cost.gt(0) && previewBranchId == null) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "إثبات صيانة الأصل يتطلب فرعاً مالياً محدداً" });
    }
    const a = await loadForUpdate(tx, assetId, scope);
    const branchId = a.branchId != null ? Number(a.branchId) : (actor.branchId ?? null);
    if (cost.gt(0) && branchId !== previewBranchId) {
      throw new TRPCError({ code: "CONFLICT", message: "تغيّر فرع الأصل أثناء تسجيل الصيانة — أعد المحاولة" });
    }
    if (a.status === "disposed") throw new Error("لا يمكن تسجيل صيانة لأصل مُستبعَد");
    const maintDate = m.maintDate ?? toDateStr();
    const [existing] = await tx
      .select({ id: assetMaintenance.id, requestPayloadHash: assetMaintenance.requestPayloadHash })
      .from(assetMaintenance)
      .where(eq(assetMaintenance.clientRequestId, clientRequestId))
      .for("update")
      .limit(1);
    if (existing) {
      if (!payloadHashMatches(requestPayloadHash, existing.requestPayloadHash)) {
        throw new TRPCError({ code: "CONFLICT", message: "تعارض idempotency: مفتاح الصيانة استُعمل ببيانات مختلفة" });
      }
      const [priorRequest] = await tx
        .select({ id: accrualObligationEvents.receiptId })
        .from(accrualObligationEvents)
        .innerJoin(accrualObligations, eq(accrualObligationEvents.obligationId, accrualObligations.id))
        .where(and(eq(accrualObligations.maintenanceId, Number(existing.id)), eq(accrualObligationEvents.eventType, "PAYMENT_REQUESTED")))
        .limit(1);
      paymentRequestReceiptId = priorRequest?.id == null ? null : Number(priorRequest.id);
      return;
    }
    if (cost.gt(0) && !evidenceReference) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "رقم فاتورة/وصل الصيانة إلزامي لإثبات الاستحقاق" });
    }
    if (
      cost.gt(0) &&
      new Set(["-", "لا يوجد", "بدون", "none", "n/a"]).has(
        evidenceReference.toLocaleLowerCase("ar-IQ"),
      )
    ) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "أدخل مرجع فاتورة/وصل صيانة حقيقياً" });
    }
    let beneficiaryName = freeVendor;
    if (cost.gt(0) && m.vendorSupplierId != null) {
      const [supplier] = await tx
        .select({ name: suppliers.name, isActive: suppliers.isActive })
        .from(suppliers)
        .where(eq(suppliers.id, m.vendorSupplierId))
        .limit(1);
      if (!supplier || supplier.isActive === false) throw new TRPCError({ code: "BAD_REQUEST", message: "جهة الصيانة المسجلة غير موجودة أو غير نشطة" });
      beneficiaryName = supplier.name.trim();
    }
    if (cost.gt(0) && !beneficiaryName) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "جهة الصيانة الحقيقية إلزامية عند وجود تكلفة" });
    }
    if (
      cost.gt(0) &&
      m.vendorSupplierId == null &&
      (
        beneficiaryName.toLocaleLowerCase("ar-IQ") === a.name.trim().toLocaleLowerCase("ar-IQ") ||
        new Set(["جهة الصيانة", "ورشة", "فني", "maintenance", "vendor", "unknown"]).has(
          beneficiaryName.toLocaleLowerCase("ar-IQ"),
        )
      )
    ) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "اسم جهة الصيانة العام/اسم الأصل غير مقبول؛ أدخل الطرف الحقيقي المثبت في المستند" });
    }
    const res = await tx.insert(assetMaintenance).values({
      assetId,
      maintDate,
      type: m.type,
      vendor: beneficiaryName || null,
      vendorSupplierId: m.vendorSupplierId ?? null,
      cost: toDbMoney(cost),
      note: m.note ?? null,
      evidenceReference: evidenceReference || null,
      clientRequestId,
      requestPayloadHash,
    });
    const maintId = extractInsertId(res);
    // تسجيل الصيانة يثبت الحدث والمصروف فوراً؛ الدفع الخارجي طلبٌ معلّق لا يلمس الخزينة
    // حتى ينفذه مالك نشط مختلف عبر approveVoucher. الصيانة الصفرية (كفالة) بلا طلب دفع.
    if (cost.gt(0)) {
      if (branchId == null) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "دفع صيانة الأصل نقداً يتطلب فرعاً محدداً لخزينة الصرف",
        });
      }
      // الاعتراف بالصيانة يقع عند تسجيل الخدمة، لا عند سدادها. receipt المعلّق هو
      // clearing قابل للرفض وإعادة التقديم؛ لا يكرر expense/ledger عند الدفع لاحقاً.
      const expenseResult = await tx.insert(expenses).values({
        branchId,
        shiftId: null,
        expenseDate: new Date(`${maintDate}T00:00:00.000Z`),
        category: "MAINTENANCE",
        amount: toDbMoney(cost),
        paymentMethod: "ACCRUAL",
        cashBucket: null,
        source: "ACCRUAL",
        description: `صيانة أصل ${a.code ?? assetId} — ${m.type}`,
        referenceNumber: `ASSET-MAINT-${maintId}`,
        payee: beneficiaryName,
        receiptId: null,
        status: "ACTIVE",
        createdBy: actor.userId,
      });
      const expenseId = extractInsertId(expenseResult);
      const maintenanceAccrual = expenseAccrualRecognition(
        "OPERATING_EXPENSE",
        cost,
      );
      const recognitionDedupe = `ASSET_MAINT_ACCRUAL:${maintId}`;
      await postEntry(tx, {
        entryType: "ADJUST",
        branchId,
        receiptId: null,
        amount: cost,
        postingIntent: maintenanceAccrual.intent,
        postingSourceComponents: maintenanceAccrual.sourceComponents,
        dedupeKey: recognitionDedupe,
        entryDate: new Date(`${maintDate}T00:00:00.000Z`),
        notes: `استحقاق صيانة أصل ${a.code ?? assetId} — ${m.type}`,
      });
      const [recognitionEntry] = await tx
        .select({ id: accountingEntries.id })
        .from(accountingEntries)
        .where(eq(accountingEntries.dedupeKey, recognitionDedupe))
        .limit(1);
      if (!recognitionEntry) throw new Error("قيد الاعتراف بصيانة الأصل مفقود");
      const obligation = await createAccrualObligationTx(tx, {
        kind: "ASSET_MAINTENANCE",
        branchId,
        expenseId,
        assetId,
        maintenanceId: maintId,
        sourceKey: recognitionDedupe,
        recognizedAmount: toDbMoney(cost),
        initialStatus: "ACCRUED_UNPAID",
        beneficiaryType: m.vendorSupplierId == null ? "OTHER" : "SUPPLIER",
        beneficiarySupplierId: m.vendorSupplierId ?? null,
        beneficiaryName,
        evidenceReference,
        plannedPaymentMethod: "CASH",
        clientRequestId: `asset-maintenance-obligation-${clientRequestId}`,
        recognizedBy: actor.userId,
        recognizedAt: new Date(`${maintDate}T00:00:00.000Z`),
        recognitionAccountingEntryId: Number(recognitionEntry.id),
      });
      const request = await createSystemPaymentRequestTx(tx, {
        branchId,
        amount: toDbMoney(cost),
        paymentMethod: "CASH",
        partyType: "OTHER",
        partyId: null,
        counterpartyName: beneficiaryName,
        description: `صيانة أصل ${a.code ?? assetId} — ${m.type}`,
        referenceNumber: `ASSET-MAINT-${maintId}`,
        voucherDate: maintDate,
        clientRequestId: `asset-maintenance-payment-${clientRequestId}`,
      }, actor, {
        kind: "ASSET_MAINTENANCE",
        assetId,
        maintenanceId: maintId,
        obligationId: Number(obligation.id),
        obligationSourceHash: obligation.sourceHash,
        beneficiaryType: obligation.beneficiaryType,
        beneficiaryId: obligation.beneficiarySupplierId == null ? null : Number(obligation.beneficiarySupplierId),
        beneficiaryNameSnapshot: beneficiaryName,
        sourceEvidenceReference: obligation.evidenceReference,
      });
      paymentRequestReceiptId = request.receiptId;
      await transitionAccrualObligationTx(tx, {
        obligationId: Number(obligation.id),
        expectedStatus: "ACCRUED_UNPAID",
        nextStatus: "PAYMENT_PENDING",
        eventType: "PAYMENT_REQUESTED",
        actorId: actor.userId,
        receiptId: request.receiptId,
        evidenceReference,
        dedupeKey: `ACCRUAL:PAYMENT_REQUESTED:${obligation.id}:${request.receiptId}`,
      });
    }
    // الأصل قيد الصيانة الآن (إن لم يكن مُستبعَداً).
    if (a.status !== "retired") {
      await tx.update(fixedAssets).set({ status: "maintenance" }).where(eq(fixedAssets.id, assetId));
    }
  });
  // ن-٢-هـ: إشعارُ المُعتمِدين مركزيّ في createSystemPaymentRequestTx (tx.ts.enqueuePostCommit).
  const asset = await getAsset(assetId, scope);
  return asset
    ? { ...asset, paymentPending: paymentRequestReceiptId != null, paymentRequestReceiptId }
    : null;
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
