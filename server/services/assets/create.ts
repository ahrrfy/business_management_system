// إنشاء أصل: ترقيم AST-#### + قيد اقتناء (AP لمورّد أو نقد خزينة) + عهدة ابتدائية اختيارية.
import { desc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { accountingEntries, assetCustodyLog, branches, employees, fixedAssets, kioskDevices, suppliers } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { createPostingIntent, creditLine, debitLine, signedPostingLines } from "../accounting/postingEngine";
import { adjustSupplierBalance, postEntry } from "../ledgerService";
import { money, toDateStr, toDbMoney } from "../money";
import { type Actor, withTx } from "../tx";
import { companyBranchScope, resolveTargetBranch } from "../companyBranchScope";
import { getAsset } from "./queries";
import { createSystemPaymentRequestTx, finalizeOwnerSystemVoucherTx } from "../voucher/create";
import { fixedAssetAccrualRecognition } from "../accounting/accrualPosting";
import { createAccrualObligationTx, transitionAccrualObligationTx } from "../accounting/accrualObligations";
import { idempotencyHash, payloadHashMatches } from "../idempotency";
import type { AssetAcquisitionType } from "@shared/assets";
import { appErrorMessage } from "@shared/errors";
import type { Decimal } from "decimal.js";

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
  acquisitionEvidenceReference?: string | null;
  clientRequestId: string;
  acquisitionType?: AssetAcquisitionType;
  accumulatedDepreciation?: string | null;
}

export async function createAsset(input: CreateAssetInput, actor: Actor) {
  const scope = companyBranchScope(actor);
  const targetBranchId = resolveTargetBranch(scope, input.branchId, { required: false });
  const clientRequestId = input.clientRequestId.trim();
  const isOpening = input.acquisitionType === "OPENING";
  const rawEvidence = (input.acquisitionEvidenceReference ?? "").trim();
  const evidenceReference = isOpening && !rawEvidence ? "رصيد افتتاحي سابق لبناء النظام" : rawEvidence;
  const freeBeneficiary = input.acquisitionBeneficiaryName?.trim() ?? "";
  const placeholderEvidence = new Set(["-", "لا يوجد", "بدون", "none", "n/a"]);
  const genericBeneficiaries = new Set(["البائع", "المورد", "صاحب الأصل", "vendor", "supplier", "unknown"]);
  if (
    !clientRequestId ||
    (!isOpening && (!evidenceReference || placeholderEvidence.has(evidenceReference.toLocaleLowerCase("ar-IQ"))))
  ) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "مفتاح الطلب ومرجع مستند الاقتناء إلزاميان" });
  }
  if (isOpening && input.supplierId != null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذر تسجيل الأصل الافتتاحي مع ربط بمورد",
        why: "الأصول الافتتاحية السابقة لبناء النظام تم تمويلها مسبقاً وتُثبت مقابل حقوق الملكية الافتتاحية",
        doThis: "احذف اختيار المورد لتسجيله كرصيد افتتاحي، أو اختر نوع الشراء الآجل إذا كان شراءً جديداً على الحساب",
      }),
    });
  }
  if (
    !isOpening &&
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
    acquisitionType: input.acquisitionType ?? (input.supplierId ? "NEW_PURCHASE_SUPPLIER" : "NEW_PURCHASE_CASH"),
    acquisitionBeneficiaryName: freeBeneficiary || null,
    acquisitionEvidenceReference: evidenceReference,
    accumulatedDepreciation: input.accumulatedDepreciation ? toDbMoney(input.accumulatedDepreciation) : "0.00",
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
      if (!payloadHashMatches(requestPayloadHash, existing.requestPayloadHash)) {
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
    const initialDepreciation = isOpening ? money(input.accumulatedDepreciation ?? "0") : money("0");
    if (initialDepreciation.gt(value)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذر حفظ الأصل برصيد إهلاك متراكم غير متطابق",
          why: `الإهلاك المتراكم السابق (${initialDepreciation.toFixed(2)}) يتجاوز تكلفة الشراء الأصلية (${value.toFixed(2)})`,
          doThis: "أدخل مجمع إهلاك سابق أقل من أو يساوي قيمة الشراء، أو اتركه فارغاً",
        }),
      });
    }
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
      salvageValue: toDbMoney(input.category === "land" ? "0" : (input.salvageValue ?? "0")),
      usefulLifeYears: input.category === "land" ? 0 : input.usefulLifeYears,
      depreciationMethod: input.depreciationMethod ?? "sl",
      accumulatedDepreciation: toDbMoney(initialDepreciation),
      condition: input.condition ?? null,
      warrantyEnd: input.warrantyEnd ?? null,
      linkedDeviceId: input.linkedDeviceId ?? null,
      clientRequestId,
      requestPayloadHash,
      // إضافة سجل الأصل هنا هي مستند الحيازة/الجاهزية للاستخدام.
      // الأصل الافتتاحي يُثبت فوراً بحقوق الملكية؛ غير المدفوع يُقابله ACCRUED_EXPENSES حتى التسوية.
      isActive: true,
    });
    const newId = extractInsertId(res);

    // FI-01/FA-01: اقتناء الأصل يُرحَّل للدفتر:
    // ١) أصل سابق لبناء النظام (افتتاحي) ⇒ قيد OPENING مقابل OPENING_EQUITY (بلا صرف نقدي وبلا سند).
    // ٢) شراء آجل من مورّد ⇒ ذمم دائنة AP + قيد PURCHASE (يُسدَّد لاحقاً بسند).
    // ٣) شراء نقدي حديث بلا مورّد ⇒ نقد PAYMENT_OUT من الخزينة عبر سند صرف نظامي يخضع للاعتماد.
    const acqBranch = targetBranchId;
    const acqDate = new Date(input.purchaseDate);
    if (value.gt(0)) {
      if (acqBranch == null) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "إثبات اقتناء الأصل يتطلب فرعاً مالياً محدداً" });
      }
      if (isOpening) {
        const netBookValue = value.minus(initialDepreciation);
        const lines = [debitLine("FIXED_ASSETS", value)];
        const roleCredits: Record<string, Decimal> = {
          OPENING_EQUITY: netBookValue,
        };
        if (initialDepreciation.gt(0)) {
          lines.push(creditLine("ACCUMULATED_DEPRECIATION", initialDepreciation));
          roleCredits.ACCUMULATED_DEPRECIATION = initialDepreciation;
        }
        lines.push(creditLine("OPENING_EQUITY", netBookValue));
        const sourceComponents = {
          roleDebits: { FIXED_ASSETS: value },
          roleCredits,
        } as const;

        await postEntry(tx, {
          entryType: "OPENING",
          branchId: acqBranch,
          amount: value,
          entryDate: acqDate,
          postingIntent: createPostingIntent(
            "OPENING_FIXED_ASSET",
            "OPENING",
            lines,
            sourceComponents,
          ),
          postingSourceComponents: sourceComponents,
          dedupeKey: `ASSET_OPENING:${newId}`,
          notes: `إثبات أصل ${code} كأصل افتتاحي سابق لبناء النظام (ممول من رأس المال)`,
          createdBy: actor.userId,
        });
      } else if (input.supplierId) {
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
        try {
          await finalizeOwnerSystemVoucherTx(tx, request.receiptId, actor);
        } catch (e: any) {
          // إذا كان رصيد الخزينة غير كافٍ للصرف الفوري، يظل السند بانتظار الاعتماد (PENDING_APPROVAL)
          // وتظل ذمة الاستحقاق قائمة (PAYMENT_PENDING) والأصل نشطاً وفق العقد المحاسبي (paymentPending: true).
          if (
            e instanceof TRPCError &&
            e.code === "PRECONDITION_FAILED" &&
            (e.message.includes("الخزينة") || e.message.includes("المتاح") || e.message.includes("غير ممول"))
          ) {
            // رصيد الخزينة غير كافٍ للصرف الفوري — السند يبقى معلقاً ليُصرف لاحقاً عند تغذية الخزينة
          } else {
            throw e;
          }
        }
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
