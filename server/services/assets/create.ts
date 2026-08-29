// إنشاء أصل: ترقيم AST-#### + قيد اقتناء (AP لمورّد أو نقد خزينة) + عهدة ابتدائية اختيارية.
import { desc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { accountingEntries, assetCustodyLog, branches, employees, fixedAssets, kioskDevices, suppliers } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { createPostingIntent, signedPostingLines } from "../accounting/postingEngine";
import { adjustSupplierBalance, postEntry } from "../ledgerService";
import { money, toDateStr, toDbMoney } from "../money";
import { type Actor, withTx } from "../tx";
import { companyBranchScope, resolveTargetBranch } from "../companyBranchScope";
import { getAsset } from "./queries";
import { createSystemPaymentRequestTx } from "../voucher/create";
import { fixedAssetAccrualRecognition } from "../accounting/accrualPosting";
import { createAccrualObligationTx, transitionAccrualObligationTx } from "../accounting/accrualObligations";
import { idempotencyHash } from "../idempotency";

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
  acquisitionBeneficiaryName?: string | null;
  acquisitionEvidenceReference: string;
  clientRequestId: string;
}

export async function createAsset(input: CreateAssetInput, actor: Actor) {
  const scope = companyBranchScope(actor);
  const targetBranchId = resolveTargetBranch(scope, input.branchId, { required: false });
  const clientRequestId = input.clientRequestId.trim();
  const evidenceReference = input.acquisitionEvidenceReference.trim();
  const freeBeneficiary = input.acquisitionBeneficiaryName?.trim() ?? "";
  const placeholderEvidence = new Set(["-", "لا يوجد", "بدون", "none", "n/a"]);
  const genericBeneficiaries = new Set(["البائع", "المورد", "صاحب الأصل", "vendor", "supplier", "unknown"]);
  if (
    !clientRequestId ||
    !evidenceReference ||
    placeholderEvidence.has(evidenceReference.toLocaleLowerCase("ar-IQ"))
  ) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "مفتاح الطلب ومرجع مستند الاقتناء إلزاميان" });
  }
  if (
    input.supplierId == null &&
    (
      !freeBeneficiary ||
      freeBeneficiary.toLocaleLowerCase("ar-IQ") === input.name.trim().toLocaleLowerCase("ar-IQ") ||
      genericBeneficiaries.has(freeBeneficiary.toLocaleLowerCase("ar-IQ"))
    )
  ) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "اسم البائع الحقيقي إلزامي ولا يجوز أن يكون اسم الأصل" });
  }
  if (input.supplierId != null && actor.isOwner !== true) {
    throw new TRPCError({ code: "FORBIDDEN", message: "إثبات اقتناء أصل على ذمة مورّد يتطلب اعتماد المالك الصريح" });
  }
  const requestPayloadHash = idempotencyHash({
    ...input,
    branchId: targetBranchId,
    acquisitionBeneficiaryName: freeBeneficiary || null,
    acquisitionEvidenceReference: evidenceReference,
    clientRequestId,
  });
  const id = await withTx(async (tx) => {
    const [existing] = await tx
      .select({ id: fixedAssets.id, requestPayloadHash: fixedAssets.requestPayloadHash })
      .from(fixedAssets)
      .where(eq(fixedAssets.clientRequestId, clientRequestId))
      .for("update")
      .limit(1);
    if (existing) {
      if (existing.requestPayloadHash !== requestPayloadHash) {
        throw new TRPCError({ code: "CONFLICT", message: "تعارض idempotency: مفتاح إنشاء الأصل استُعمل ببيانات مختلفة" });
      }
      return Number(existing.id);
    }
    if (targetBranchId != null) {
      const [branch] = await tx
        .select({ id: branches.id })
        .from(branches)
        .where(eq(branches.id, targetBranchId))
        .for("update")
        .limit(1);
      if (!branch) throw new TRPCError({ code: "BAD_REQUEST", message: "الفرع غير موجود" });
    }
    if (input.linkedDeviceId != null) {
      const [device] = await tx
        .select({ branchId: kioskDevices.branchId })
        .from(kioskDevices)
        .where(eq(kioskDevices.id, input.linkedDeviceId))
        .for("update")
        .limit(1);
      if (!device) throw new TRPCError({ code: "BAD_REQUEST", message: "جهاز البصمة غير موجود" });
      if (targetBranchId == null || Number(device.branchId) !== targetBranchId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "جهاز البصمة تابع لفرع مختلف" });
      }
    }
    const code = await nextAssetCode(tx);
    const value = money(input.purchaseValue);
    const [res] = await tx.insert(fixedAssets).values({
      code,
      name: input.name,
      category: input.category as never,
      brand: input.brand ?? null,
      serial: input.serial ?? null,
      branchId: targetBranchId,
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
      clientRequestId,
      requestPayloadHash,
      // إضافة سجل الأصل هنا هي مستند الحيازة/الجاهزية للاستخدام. توقيت السداد لا
      // يغيّر وجود الأصل: غير المدفوع يبقى نشطاً ويقابله ACCRUED_EXPENSES حتى التسوية.
      isActive: true,
    });
    const newId = extractInsertId(res);

    // FI-01/FA-01 (تدقيق ٢٠/٦، قرار المالك «كل إضافة = شراء جديد يُقيَّد»، ولا أصول قائمة سابقاً):
    // اقتناء الأصل يُرحَّل للدفتر فيُقابله التزام/نقد ⇒ لا تُنفَخ حقوق الملكية (أصل بلا مصدر تمويل).
    // مورّد ⇒ ذمم دائنة AP + قيد PURCHASE (يُسدَّد لاحقاً بسند). بلا مورّد ⇒ نقد PAYMENT_OUT من الخزينة.
    const acqBranch = targetBranchId;
    const acqDate = new Date(input.purchaseDate);
    if (value.gt(0)) {
      if (acqBranch == null) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "إثبات اقتناء الأصل يتطلب فرعاً مالياً محدداً" });
      }
      if (input.supplierId) {
        const [supplier] = await tx
          .select({ id: suppliers.id, name: suppliers.name, isActive: suppliers.isActive })
          .from(suppliers)
          .where(eq(suppliers.id, input.supplierId))
          .for("update")
          .limit(1);
        if (!supplier || supplier.isActive === false) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "مورّد الأصل غير موجود أو غير نشط" });
        }
        const sourceComponents = {
          roleDebits: { FIXED_ASSETS: value },
          roleCredits: { AP: value },
        } as const;
        await postEntry(tx, {
          entryType: "PURCHASE", branchId: acqBranch, supplierId: input.supplierId,
          cost: value, amount: value, entryDate: acqDate,
          postingIntent: createPostingIntent(
            "PURCHASE_FIXED_ASSET",
            "PURCHASE",
            signedPostingLines("FIXED_ASSETS", "AP", value),
            sourceComponents,
          ),
          postingSourceComponents: sourceComponents,
          dedupeKey: `ASSET_ACQ:${newId}`, notes: `اقتناء أصل ${code} (آجل — مورّد)`,
        });
        await adjustSupplierBalance(tx, input.supplierId, value);
        const [recognitionEntry] = await tx
          .select({ id: accountingEntries.id })
          .from(accountingEntries)
          .where(eq(accountingEntries.dedupeKey, `ASSET_ACQ:${newId}`))
          .limit(1);
        if (!recognitionEntry) throw new Error("قيد اقتناء الأصل على ذمة المورّد مفقود");
        await createAccrualObligationTx(tx, {
          kind: "ASSET_ACQUISITION_SUPPLIER",
          branchId: Number(acqBranch),
          assetId: newId,
          sourceKey: `ASSET_ACQ:${newId}`,
          recognizedAmount: toDbMoney(value),
          initialStatus: "PAYABLE_UNSETTLED",
          beneficiaryType: "SUPPLIER",
          beneficiarySupplierId: input.supplierId,
          beneficiaryName: supplier.name,
          evidenceReference,
          plannedPaymentMethod: "CASH",
          clientRequestId: `asset-obligation-${clientRequestId}`,
          recognizedBy: actor.userId,
          recognizedAt: acqDate,
          recognitionAccountingEntryId: Number(recognitionEntry.id),
        });
      } else {
        if (acqBranch == null) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "شراء أصل نقداً يتطلب فرعاً محدداً لخزينة الصرف",
          });
        }
        const accrual = fixedAssetAccrualRecognition(value);
        const recognitionDedupe = `ASSET_ACCRUAL:${newId}`;
        await postEntry(tx, {
          entryType: "ADJUST",
          branchId: acqBranch,
          amount: value,
          entryDate: acqDate,
          postingIntent: accrual.intent,
          postingSourceComponents: accrual.sourceComponents,
          dedupeKey: recognitionDedupe,
          notes: `إثبات أصل ${code} والتزام اقتنائه قبل السداد`,
          createdBy: actor.userId,
        });
        const [recognitionEntry] = await tx
          .select({ id: accountingEntries.id })
          .from(accountingEntries)
          .where(eq(accountingEntries.dedupeKey, recognitionDedupe))
          .limit(1);
        if (!recognitionEntry) throw new Error("قيد إثبات الأصل المستحق مفقود");
        const obligation = await createAccrualObligationTx(tx, {
          kind: "ASSET_ACQUISITION_CASH",
          branchId: acqBranch,
          assetId: newId,
          sourceKey: recognitionDedupe,
          recognizedAmount: toDbMoney(value),
          initialStatus: "ACCRUED_UNPAID",
          beneficiaryType: "OTHER",
          beneficiaryName: freeBeneficiary,
          evidenceReference,
          plannedPaymentMethod: "CASH",
          clientRequestId: `asset-obligation-${clientRequestId}`,
          recognizedBy: actor.userId,
          recognizedAt: acqDate,
          recognitionAccountingEntryId: Number(recognitionEntry.id),
        });
        const request = await createSystemPaymentRequestTx(tx, {
          branchId: acqBranch,
          amount: toDbMoney(value),
          paymentMethod: "CASH",
          partyType: "OTHER",
          counterpartyName: freeBeneficiary,
          description: `اقتناء أصل ${code} (طلب دفع نقدي)`,
          referenceNumber: `ASSET-ACQ-${newId}`,
          voucherDate: input.purchaseDate,
          clientRequestId: `asset-acquisition-${clientRequestId}`,
        }, actor, {
          kind: "ASSET_ACQUISITION",
          assetId: newId,
          obligationId: Number(obligation.id),
          obligationSourceHash: obligation.sourceHash,
          beneficiaryType: "OTHER",
          beneficiaryId: null,
          beneficiaryNameSnapshot: freeBeneficiary,
          sourceEvidenceReference: obligation.evidenceReference,
        });
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
    }

    // إن سُلّم بعهدة عند الإنشاء، افتح سطر عهدة جارية من تاريخ الشراء.
    // حرّاس العهدة (تدقيق ١٧/٧): كان الإسناد يُدرَج بلا فحص، فيُمكن فتح عهدة على موظف منتهي الخدمة أو من
    // فرعٍ آخر — بينما handoverCustody يرفضهما. نطبّق نفس الحارسين هنا (نشط + توافق الفرع) لتوحيد الضمان.
    if (input.custodianId) {
      const [emp] = await tx
        .select({ status: employees.employmentStatus, branchId: employees.branchId })
        .from(employees)
        .where(eq(employees.id, input.custodianId))
        .for("update")
        .limit(1);
      if (!emp) throw new Error("الموظف (صاحب العهدة) غير موجود");
      if (emp.status !== "active") throw new Error("لا يمكن تسليم عهدة لموظف ليس على رأس العمل");
      const assetBranch = targetBranchId;
      if (assetBranch != null && (emp.branchId == null || Number(assetBranch) !== Number(emp.branchId))) {
        throw new Error("لا يمكن تسليم عهدة لموظف من فرع مختلف عن فرع الأصل");
      }
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
  // ن-٢-هـ: إشعارُ المُعتمِدين مُعالَجٌ مركزياً داخل createSystemPaymentRequestTx
  // عبر enqueuePostCommit (راجع voucher/create.ts + services/tx.ts).
  const asset = await getAsset(id, scope);
  return asset;
}
