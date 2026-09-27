import { TRPCError } from "@trpc/server";
import { and, eq, inArray } from "drizzle-orm";
import {
  accrualObligations,
  fixedAssets,
  receipts,
} from "../../../drizzle/schema";
import { createPostingIntent, creditLine, debitLine } from "../accounting/postingEngine";
import { fixedAssetAccrualReversal } from "../accounting/accrualPosting";
import { transitionAccrualObligationTx } from "../accounting/accrualObligations";
import { postEntry } from "../ledgerService";
import { money, toDbMoney } from "../money";
import { type Actor, withTx } from "../tx";
import { companyBranchScope } from "../companyBranchScope";
import { loadForUpdate } from "./helpers";
import { getAsset } from "./queries";
import { logAuditTx } from "../auditService";
import { appErrorMessage } from "@shared/errors";
import type { Decimal } from "decimal.js";

/**
 * تحويل أصل إلى أصل افتتاحي سابق لبناء النظام:
 * يُستعمل عندما يكون الأصل قد أُدخل بالخطأ كطلب دفع نقدي وله سند صرف نقدي معلّق.
 * 1) يلغي أي سند صرف نقدي معلق مرتبط باقتناء هذا الأصل (فيُزال من «مطلوب مني الآن»).
 * 2) يعكس التزام الاستحقاق النقدي (ACCRUED_EXPENSES) ويغلقه.
 * 3) يرحل قيد OPENING_FIXED_ASSET في الدفتر (مدين للأصول الثابتة، ودائن لحقوق الملكية الافتتاحية).
 * 4) يحافظ على الأصل نشطاً وبالخدمة وبكامل بياناته وعهدته.
 */
export async function reclassifyAssetToOpening(assetId: number, actor: Actor) {
  if (!actor.isOwner) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "صلاحية غير كافية لتحويل الأصل",
        why: "تحويل الأصول الرأسمالية إلى رصيد افتتاحي وإلغاء سندات الصرف محصور بحساب المالك حصراً",
        doThis: "سجل الدخول بحساب مالك معتمد لتنفيذ هذا التحويل",
      }),
    });
  }
  const scope = companyBranchScope(actor);

  await withTx(async (tx) => {
    const asset = await loadForUpdate(tx, assetId, scope);
    if (asset.status === "disposed") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذر تحويل الأصل المستبعد",
          why: "الأصل مُستبعد ومُخرج من الخدمة مسبقاً",
          doThis: "لا يمكن تعديل القيود الافتتاحية لأصل تم استبعاده وتصفيته",
        }),
      });
    }
    if (asset.supplierId != null) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذر تحويل أصل مسجل على ذمة مورد",
          why: "الأصل مرتبط بمورد مسجل ومثبت في حسابات الذمم الدائنة",
          doThis: "قم بتسوية أو تصحيح فاتورة المورد عبر شاشة المشتريات أولاً",
        }),
      });
    }

    // ابحث عن التزام الاستحقاق النقدي المعلق
    const [obligation] = await tx
      .select()
      .from(accrualObligations)
      .where(
        and(
          eq(accrualObligations.assetId, assetId),
          eq(accrualObligations.kind, "ASSET_ACQUISITION_CASH"),
        ),
      )
      .for("update")
      .limit(1);

    if (obligation && obligation.status === "PAID") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذر تحويل أصل تم سداد قيمته",
          why: "تم صرف القيمة النقدية لهذا الأصل من الخزينة بسند صرف معتمد بالفعل",
          doThis: "استخدم إجراء طلب تصحيح الاقتناء واسترداد النقد إذا كان الصرف قد تم بطريق الخطأ",
        }),
      });
    }

    const occurredAt = new Date();
    const value = money(asset.purchaseValue);

    // 1. إلغاء أي سند صرف نقدي معلق مرتبط باقتناء هذا الأصل
    const pendingReceipts = await tx
      .select()
      .from(receipts)
      .where(
        and(
          eq(receipts.referenceNumber, `ASSET-ACQ-${assetId}`),
          eq(receipts.approvalStatus, "PENDING_APPROVAL"),
        ),
      )
      .for("update");

    for (const r of pendingReceipts) {
      await tx
        .update(receipts)
        .set({
          status: "FAILED",
          approvalStatus: "REJECTED",
          approvedBy: actor.userId,
          approvedAt: occurredAt,
          internalNote:
            (r.internalNote ?? "") +
            "\n[أُلغي السند: تم تحويل الأصل إلى أصل افتتاحي سابق لبناء النظام وسُدد مسبقاً]",
          description:
            (r.description ?? "") + " (أُلغي: أصل افتتاحي سابق لبناء النظام)",
        })
        .where(eq(receipts.id, r.id));
    }

    // 2. إن وُجد التزام استحقاق نقدي، اعكسه وأغلقه
    if (obligation && obligation.status !== "RECOGNITION_REVERSED") {
      // عكس قيد الاستحقاق القديم أولاً للحصول على accountingEntryId المطلوب لعقد RECOGNITION_REVERSED
      const reversal = fixedAssetAccrualReversal(value);
      const revEntry = await postEntry(tx, {
        entryType: "ADJUST",
        branchId: Number(asset.branchId),
        amount: value.neg(),
        entryDate: occurredAt,
        postingIntent: reversal.intent,
        postingSourceComponents: reversal.sourceComponents,
        dedupeKey: `ACCRUAL:REVERSAL_RECLASSIFY:${assetId}`,
        createdBy: actor.userId,
        notes: `عكس التزام الاستحقاق النقدي لتحويل الأصل ${asset.code} إلى أصل افتتاحي`,
      });

      await transitionAccrualObligationTx(tx, {
        obligationId: Number(obligation.id),
        expectedStatus: obligation.status as never,
        nextStatus: "RECOGNITION_REVERSED",
        eventType: "RECOGNITION_REVERSED",
        actorId: actor.userId,
        accountingEntryId: revEntry,
        evidenceReference: "تحويل إلى أصل افتتاحي سابق لبناء النظام وسُدد مسبقاً",
        dedupeKey: `ACCRUAL:RECLASSIFY_OPENING:${obligation.id}`,
      });
    }

    // 3. إثبات القيد الافتتاحي في الدفتر المحاسبي
    const depr = money(asset.accumulatedDepreciation ?? "0");
    const netBookValue = value.minus(depr);
    const lines = [debitLine("FIXED_ASSETS", value)];
    const roleCredits: Record<string, Decimal> = {
      OPENING_EQUITY: netBookValue,
    };
    if (depr.gt(0)) {
      lines.push(creditLine("ACCUMULATED_DEPRECIATION", depr));
      roleCredits.ACCUMULATED_DEPRECIATION = depr;
    }
    lines.push(creditLine("OPENING_EQUITY", netBookValue));
    const sourceComponents = {
      roleDebits: { FIXED_ASSETS: value },
      roleCredits,
    } as const;

    await postEntry(tx, {
      entryType: "OPENING",
      branchId: Number(asset.branchId),
      amount: value,
      entryDate: new Date(asset.purchaseDate),
      postingIntent: createPostingIntent(
        "OPENING_FIXED_ASSET",
        "OPENING",
        lines,
        sourceComponents,
      ),
      postingSourceComponents: sourceComponents,
      dedupeKey: `ASSET_OPENING:${assetId}`,
      notes: `إثبات أصل ${asset.code} كأصل افتتاحي سابق لبناء النظام (ممول من رأس المال)`,
      createdBy: actor.userId,
    });

    // 4. تحديث حالة إثبات الأصل ليكون نشطاً وموثقاً
    await tx
      .update(fixedAssets)
      .set({
        recognitionStatus: "ACTIVE",
      })
      .where(eq(fixedAssets.id, assetId));

    // 5. سجل التدقيق
    await logAuditTx(
      tx,
      {
        user: { id: actor.userId, branchId: actor.branchId ?? null } as never,
        req: undefined as never,
      },
      {
        action: "asset.reclassify_to_opening",
        entityType: "fixedAsset",
        entityId: assetId,
        branchId: actor.branchId ?? null,
        newValue: {
          assetCode: asset.code,
          purchaseValue: asset.purchaseValue,
          reclassifiedBy: actor.userId,
          notes: `تحويل الأصل ${asset.code} إلى أصل افتتاحي سابق لبناء النظام وإلغاء طلب الصرف النقدي`,
        },
      },
    );
  });

  return getAsset(assetId, scope);
}
