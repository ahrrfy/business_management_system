// إخراج من الخدمة (retired) أو استبعاد ببيع/خردة (disposed) مع احتساب الربح/الخسارة.
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, eq, isNull } from "drizzle-orm";
import {
  assetCustodyLog,
  fixedAssets,
  receipts,
} from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import {
  createPostingIntent,
  creditLine,
  debitLine,
  signedPostingLines,
  type AccountRole,
  type JournalLine,
  type PostingSourceComponents,
} from "../accounting/postingEngine";
import { postEntry } from "../ledgerService";
import { money, toDbMoney } from "../money";
import { type Actor, withTx } from "../tx";
import { companyBranchScope } from "../companyBranchScope";
import { computeDepreciation } from "./depreciation";
import { loadForUpdate } from "./helpers";
import { getAsset } from "./queries";
import { lockMaterializedCashReceiptSourceForWrite } from "../cash/cashAvailability";

export interface DisposeInput {
  kind: "retired" | "disposed";
  date: string;
  reason?: string | null;
  value?: string | number | null;
}

/** قيد إلغاء الاعتراف الكامل بالأصل: gross cost + contra asset + gain/loss + cash proceeds. */
export function fullDisposalLines(
  purchaseValue: Decimal,
  accumulatedDepreciation: Decimal,
  proceeds: Decimal,
  gain: Decimal,
  cashRole: AccountRole = "TREASURY_CASH",
): JournalLine[] {
  const lines: JournalLine[] = [];
  if (proceeds.gt(0)) lines.push(debitLine(cashRole, proceeds));
  if (accumulatedDepreciation.gt(0)) {
    lines.push(debitLine("ACCUMULATED_DEPRECIATION", accumulatedDepreciation));
  }
  if (gain.lt(0)) lines.push(debitLine("ASSET_DISPOSAL_LOSS", gain.abs()));
  if (purchaseValue.gt(0))
    lines.push(creditLine("FIXED_ASSETS", purchaseValue));
  if (gain.gt(0)) lines.push(creditLine("ASSET_DISPOSAL_GAIN", gain));
  return lines;
}

/** Independent role evidence derived from the disposal facts, not from intent lines. */
export function fullDisposalSourceComponents(
  purchaseValue: Decimal,
  accumulatedDepreciation: Decimal,
  proceeds: Decimal,
  gain: Decimal,
  cashRole: AccountRole = "TREASURY_CASH",
): PostingSourceComponents {
  const roleDebits: Partial<Record<AccountRole, Decimal>> = {};
  const roleCredits: Partial<Record<AccountRole, Decimal>> = {};
  if (proceeds.gt(0)) roleDebits[cashRole] = proceeds;
  if (accumulatedDepreciation.gt(0)) {
    roleDebits.ACCUMULATED_DEPRECIATION = accumulatedDepreciation;
  }
  if (gain.lt(0)) roleDebits.ASSET_DISPOSAL_LOSS = gain.abs();
  if (purchaseValue.gt(0)) roleCredits.FIXED_ASSETS = purchaseValue;
  if (gain.gt(0)) roleCredits.ASSET_DISPOSAL_GAIN = gain;
  return { roleDebits, roleCredits };
}

/**
 * الجزء المتبقّي من إلغاء الاعتراف بعد أن أثبت PAYMENT_IN النقد مقابل FIXED_ASSETS بالمتحصّل.
 * قد يكون رصيد FIXED_ASSETS المتبقي مديناً إن تجاوز الربح الإهلاك المتراكم؛ نوجّهه بإشارته الفعلية.
 */
export function disposalAdjustmentLines(
  purchaseValue: Decimal,
  accumulatedDepreciation: Decimal,
  proceeds: Decimal,
  gain: Decimal,
  cashRole: AccountRole = "TREASURY_CASH",
): JournalLine[] {
  if (proceeds.isZero()) {
    return fullDisposalLines(
      purchaseValue,
      accumulatedDepreciation,
      proceeds,
      gain,
      cashRole,
    );
  }
  const lines: JournalLine[] = [];
  if (accumulatedDepreciation.gt(0)) {
    lines.push(debitLine("ACCUMULATED_DEPRECIATION", accumulatedDepreciation));
  }
  const fixedResidual = purchaseValue.minus(proceeds);
  if (fixedResidual.gt(0))
    lines.push(creditLine("FIXED_ASSETS", fixedResidual));
  else if (fixedResidual.lt(0))
    lines.push(debitLine("FIXED_ASSETS", fixedResidual.abs()));
  if (gain.gt(0)) lines.push(creditLine("ASSET_DISPOSAL_GAIN", gain));
  else if (gain.lt(0))
    lines.push(debitLine("ASSET_DISPOSAL_LOSS", gain.abs()));
  return lines;
}

/** Independent role evidence for the residual derecognition after proceeds posting. */
export function disposalAdjustmentSourceComponents(
  purchaseValue: Decimal,
  accumulatedDepreciation: Decimal,
  proceeds: Decimal,
  gain: Decimal,
  cashRole: AccountRole = "TREASURY_CASH",
): PostingSourceComponents {
  if (proceeds.isZero()) {
    return fullDisposalSourceComponents(
      purchaseValue,
      accumulatedDepreciation,
      proceeds,
      gain,
      cashRole,
    );
  }
  const roleDebits: Partial<Record<AccountRole, Decimal>> = {};
  const roleCredits: Partial<Record<AccountRole, Decimal>> = {};
  if (accumulatedDepreciation.gt(0)) {
    roleDebits.ACCUMULATED_DEPRECIATION = accumulatedDepreciation;
  }
  const fixedResidual = purchaseValue.minus(proceeds);
  if (fixedResidual.gt(0)) roleCredits.FIXED_ASSETS = fixedResidual;
  else if (fixedResidual.lt(0)) roleDebits.FIXED_ASSETS = fixedResidual.abs();
  if (gain.gt(0)) roleCredits.ASSET_DISPOSAL_GAIN = gain;
  else if (gain.lt(0)) roleDebits.ASSET_DISPOSAL_LOSS = gain.abs();
  return { roleDebits, roleCredits };
}

/** إخراج من الخدمة (retired) أو استبعاد ببيع/خردة (disposed) مع احتساب الربح/الخسارة. */
export async function disposeAsset(
  assetId: number,
  input: DisposeInput,
  actor: Actor,
) {
  const scope = companyBranchScope(actor);
  await withTx(async (tx) => {
    // مسار اعتماد اقتناء الأصل يقفل الخزينة قبل الأصل. نأخذ معاينة غير قافلة للفرع
    // ثم نتبع الترتيب نفسه حتى لا نصنع دورة asset → treasury مقابل treasury → asset.
    let prelockedCashBranchId: number | null = null;
    const requestedProceeds =
      input.kind === "disposed" ? money(input.value ?? "0") : new Decimal(0);
    if (requestedProceeds.gt(0)) {
      const previewConditions = [eq(fixedAssets.id, assetId)];
      if (scope.branchId != null) {
        previewConditions.push(eq(fixedAssets.branchId, scope.branchId));
      }
      const [preview] = await tx
        .select({ branchId: fixedAssets.branchId })
        .from(fixedAssets)
        .where(and(...previewConditions))
        .limit(1);
      if (preview) {
        prelockedCashBranchId =
          preview.branchId != null ? Number(preview.branchId) : actor.branchId || null;
        await lockMaterializedCashReceiptSourceForWrite(tx, {
          branchId: prelockedCashBranchId,
          shiftId: null,
          cashBucket: "TREASURY",
          paymentMethod: "CASH",
          status: "COMPLETED",
          approvalStatus: "APPROVED",
        });
      }
    }
    const a = await loadForUpdate(tx, assetId, scope);
    const lockedAssetBranchId =
      a.branchId != null ? Number(a.branchId) : actor.branchId || null;
    if (prelockedCashBranchId != null && lockedAssetBranchId !== prelockedCashBranchId) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "تغيّر فرع الأصل أثناء قفل مصدر النقد؛ أعد المحاولة",
      });
    }
    if (a.status === "disposed") throw new Error("الأصل مُستبعَد سلفاً");
    await tx
      .update(assetCustodyLog)
      .set({ toDate: input.date })
      .where(
        and(
          eq(assetCustodyLog.assetId, assetId),
          isNull(assetCustodyLog.toDate),
        ),
      );

    // FI-02 (سدّ فجوة الاتّساق، تحقّق عدائي ٢٠/٦): رحّل أيّ إهلاك غير مُرحَّل حتى تاريخ التصرّف قبل
    // الاحتساب ⇒ المتراكم المخزَّن = computeDepreciation(التاريخ).accumulated. بدونه (إن لم يُشغَّل
    // الترحيل الشهري) يَخرج الأصل من الميزانية بقيمة دفترية منفوخة فتتسرّب القيمة من حقوق الملكية بلا
    // اعتراف بمصروف الإهلاك في P&L. dedupeKey DEPR:id:DISP فريد (مرّة واحدة عند التصرّف).
    const accumTarget = money(
      computeDepreciation(
        {
          purchaseValue: a.purchaseValue,
          salvageValue: a.salvageValue ?? "0",
          usefulLifeYears: a.usefulLifeYears,
          depreciationMethod: (a.depreciationMethod as "sl" | "db") ?? "sl",
          purchaseDate: a.purchaseDate as unknown as string,
          status: a.status,
          disposalDate: input.date,
        },
        new Date(input.date),
      ).accumulated,
    );
    const catchUp = accumTarget.sub(money(a.accumulatedDepreciation ?? "0"));
    if (catchUp.gt(0)) {
      await postEntry(tx, {
        entryType: "ADJUST",
        branchId:
          a.branchId != null ? Number(a.branchId) : actor.branchId || null,
        cost: catchUp,
        profit: catchUp.neg(),
        amount: catchUp,
        postingIntent: createPostingIntent(
          "ADJUST_DEPRECIATION",
          "ADJUST",
          signedPostingLines(
            "DEPRECIATION_EXPENSE",
            "ACCUMULATED_DEPRECIATION",
            catchUp,
          ),
        ),
        entryDate: new Date(input.date),
        dedupeKey: `DEPR:${assetId}:DISP`,
        notes: `إهلاك حتى التصرّف لأصل ${a.code}`,
      });
      await tx
        .update(fixedAssets)
        .set({ accumulatedDepreciation: toDbMoney(accumTarget) })
        .where(eq(fixedAssets.id, assetId));
    }

    // FA-02 (تدقيق ٢٠/٦، قرار المالك): التصرّف يُرحَّل للدفتر — نقد + ربح/خسارة (كانا يُهمَلان: نقد غير
    // مرئيّ والربح/الخسارة يُحسَب للعرض فقط). NBV عند تاريخ التصرّف (computeDepreciation يَتوقّف عند
    // disposalDate). الربح/الخسارة = المتحصّل − NBV. (الاتساق الكامل مع الميزانية يكتمل مع FI-02 قيد الإهلاك.)
    const nbv = money(
      computeDepreciation(
        {
          purchaseValue: a.purchaseValue,
          salvageValue: a.salvageValue ?? "0",
          usefulLifeYears: a.usefulLifeYears,
          depreciationMethod: (a.depreciationMethod as "sl" | "db") ?? "sl",
          purchaseDate: a.purchaseDate as unknown as string,
          status: a.status,
          disposalDate: input.date,
        },
        new Date(input.date),
      ).bookValue,
    );
    const proceeds = requestedProceeds;
    const purchaseValue = money(a.purchaseValue ?? "0");
    const gain = proceeds.minus(nbv);
    const branchId =
      a.branchId != null ? Number(a.branchId) : actor.branchId || null;
    const entryDate = new Date(input.date);

    // (أ) النقد المتحصّل: إيصال IN (خزينة) + قيد PAYMENT_IN ⇒ النقد مرئيّ في الدفتر والخزينة (لا يُجيَّب).
    if (proceeds.gt(0)) {
      const rRes = await tx.insert(receipts).values({
        branchId,
        cashBucket: "TREASURY",
        direction: "IN",
        amount: toDbMoney(proceeds),
        paymentMethod: "CASH",
        status: "COMPLETED",
        createdBy: actor.userId,
      });
      const receiptId = extractInsertId(rRes);
      const proceedsLines = gain.isZero()
        ? fullDisposalLines(
            purchaseValue,
            accumTarget,
            proceeds,
            gain,
            "TREASURY_CASH",
          )
        : signedPostingLines(
            "TREASURY_CASH",
            "FIXED_ASSETS",
            proceeds,
          );
      const postingSourceComponents = gain.isZero()
        ? fullDisposalSourceComponents(
            purchaseValue,
            accumTarget,
            proceeds,
            gain,
            "TREASURY_CASH",
          )
        : {
            roleDebits: { TREASURY_CASH: proceeds },
            roleCredits: { FIXED_ASSETS: proceeds },
          } as const;
      await postEntry(tx, {
        entryType: "PAYMENT_IN",
        branchId,
        receiptId,
        amount: proceeds,
        paymentMethod: "CASH",
        postingIntent: createPostingIntent(
          "PAYMENT_IN_OTHER",
          "PAYMENT_IN",
          proceedsLines,
          postingSourceComponents,
        ),
        postingSourceComponents,
        entryDate,
        dedupeKey: `ASSET_DISP:${assetId}`,
        notes: `متحصّل تصرّف بأصل ${a.code}`,
      });
    }

    // (ب) الربح/الخسارة = المتحصّل − NBV (موجب=ربح إيراد، سالب=خسارة) ⇒ يَظهر في P&L.
    //     retired (بلا متحصّل) ⇒ خسارة = −NBV (شطب القيمة الدفترية المتبقّية).
    // حتى الأصل المُهلك بالكامل بلا متحصّل يحتاج مستند إلغاء اعتراف: Dr contra / Cr gross.
    // صفّ ADJUST الصفري هنا لا يغيّر P&L ولا النقد؛ دوره حمل intent الميزانية القابل للتدقيق.
    const needsBalanceSheetDerecognition =
      proceeds.isZero() && gain.isZero() && purchaseValue.gt(0);
    if (!gain.isZero() || needsBalanceSheetDerecognition) {
      const adjustmentLines = disposalAdjustmentLines(
        purchaseValue,
        accumTarget,
        proceeds,
        gain,
        "TREASURY_CASH",
      );
      const postingSourceComponents = disposalAdjustmentSourceComponents(
        purchaseValue,
        accumTarget,
        proceeds,
        gain,
        "TREASURY_CASH",
      );
      await postEntry(tx, {
        entryType: "ADJUST",
        branchId,
        revenue: gain,
        profit: gain,
        amount: gain,
        postingIntent: createPostingIntent(
          "ADJUST_ASSET_DISPOSAL",
          "ADJUST",
          adjustmentLines,
          postingSourceComponents,
        ),
        postingSourceComponents,
        entryDate,
        dedupeKey: `ASSET_DISP_PL:${assetId}`,
        notes: `ربح/خسارة تصرّف بأصل ${a.code} (متحصّل ${proceeds.toFixed(2)} − NBV ${nbv.toFixed(2)})`,
      });
    }

    await tx
      .update(fixedAssets)
      .set({
        status: input.kind,
        disposalDate: input.date,
        disposalReason: input.reason ?? null,
        disposalValue:
          input.kind === "disposed" ? toDbMoney(input.value ?? "0") : null,
        custodianId: null,
      })
      .where(eq(fixedAssets.id, assetId));
  });
  return getAsset(assetId, scope);
}
