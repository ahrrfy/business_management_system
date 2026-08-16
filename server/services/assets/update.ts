// تعديل بيانات أصل قائم (لا يشمل العهدة/الحالة/الاستبعاد — لها مساراتها).
import { TRPCError } from "@trpc/server";
import { eq, like, sql } from "drizzle-orm";
import { accountingEntries, fixedAssets } from "../../../drizzle/schema";
import {
  createPostingIntent,
  signedPostingLines,
} from "../accounting/postingEngine";
import { postEntry } from "../ledgerService";
import { money, toDateStr, toDbMoney } from "../money";
import { type Actor, withTx } from "../tx";
import { companyBranchScope, resolveTargetBranch } from "../companyBranchScope";
import { computeDepreciation } from "./depreciation";
import { loadForUpdate } from "./helpers";
import { getAsset } from "./queries";

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

function dbDay(value: unknown): string {
  return value instanceof Date
    ? toDateStr(value)
    : String(value ?? "").slice(0, 10);
}

/**
 * تعدّل البيانات الوصفية وتقديرات الإهلاك فقط. قيمة الاقتناء ومورّده وفرعه
 * وتاريخه حقائق مستندية مُرحّلة؛ تعديلها من نموذج عام كان ينشئ قبضاً نقدياً
 * وهمياً لعكس شراء سابق. لذلك تبقى immutable ويحتاج تصحيحها مستنداً مالياً
 * مستقلاً بإثبات واعتماد وعكس append-only.
 */
export async function updateAsset(
  id: number,
  input: UpdateAssetInput,
  actor: Actor,
) {
  if (!(input.usefulLifeYears > 0)) {
    throw new Error("العمر الإنتاجي يجب أن يكون أكبر من صفر");
  }
  const scope = companyBranchScope(actor);

  await withTx(async (tx) => {
    const asset = await loadForUpdate(tx, id, scope);
    if (asset.status === "disposed") {
      throw new Error("لا يمكن تعديل أصل مُستبعَد");
    }
    if (asset.isActive === false) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "سجل الأصل غير نشط؛ عالج حالته قبل تعديل بياناته",
      });
    }

    const oldBranchId =
      asset.branchId == null ? null : Number(asset.branchId);
    const targetBranchId = resolveTargetBranch(
      scope,
      input.branchId !== undefined ? input.branchId : oldBranchId,
      { required: false },
    );
    const oldSupplierId =
      asset.supplierId == null ? null : Number(asset.supplierId);
    const targetSupplierId = input.supplierId ?? null;
    const oldValue = money(asset.purchaseValue ?? "0");
    const targetValue = money(input.purchaseValue);
    const oldPurchaseDate = dbDay(asset.purchaseDate);
    const acquisitionFactChanged =
      oldBranchId !== targetBranchId ||
      oldSupplierId !== targetSupplierId ||
      !oldValue.eq(targetValue) ||
      oldPurchaseDate !== input.purchaseDate;

    if (acquisitionFactChanged) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "لا تُعدَّل قيمة الاقتناء أو مورّده أو فرعه أو تاريخه من شاشة الأصل. يلزم مستند تصحيح مالي مستقل مع إثبات واعتماد؛ لم يُنشأ أي إيصال أو قيد.",
      });
    }

    const oldAccumulated = money(asset.accumulatedDepreciation ?? "0");
    const depreciationInputsChanged =
      !money(asset.salvageValue ?? "0").eq(
        money(input.salvageValue ?? "0"),
      ) ||
      Number(asset.usefulLifeYears) !== input.usefulLifeYears ||
      ((asset.depreciationMethod ?? "sl") as string) !==
        (input.depreciationMethod ?? "sl");

    await tx
      .update(fixedAssets)
      .set({
        name: input.name,
        category: input.category as never,
        brand: input.brand ?? null,
        serial: input.serial ?? null,
        location: input.location ?? null,
        salvageValue: toDbMoney(input.salvageValue ?? "0"),
        usefulLifeYears: input.usefulLifeYears,
        depreciationMethod: input.depreciationMethod ?? "sl",
        condition: input.condition ?? null,
        warrantyEnd: input.warrantyEnd ?? null,
      })
      .where(eq(fixedAssets.id, id));

    // إعادة تقدير العمر/التخريد/الطريقة لا تعيد كتابة التاريخ. إن سبق ترحيل
    // الإهلاك، نثبت فرق المتراكم بقيد append-only داخل المعاملة نفسها.
    if (depreciationInputsChanged && oldAccumulated.gt(0)) {
      const correctedAccumulated = money(
        computeDepreciation(
          {
            purchaseValue: oldValue.toFixed(2),
            salvageValue: input.salvageValue ?? "0",
            usefulLifeYears: input.usefulLifeYears,
            depreciationMethod: input.depreciationMethod ?? "sl",
            purchaseDate: oldPurchaseDate,
            status: asset.status,
          },
          new Date(),
        ).accumulated,
      );
      const delta = correctedAccumulated.minus(oldAccumulated);
      if (!delta.isZero()) {
        const [prior] = await tx
          .select({ count: sql<number>`COUNT(*)` })
          .from(accountingEntries)
          .where(like(accountingEntries.dedupeKey, `DEPR_ADJ:${id}:%`));
        const sequence = Number(prior?.count ?? 0) + 1;
        await postEntry(tx, {
          entryType: "ADJUST",
          branchId: oldBranchId,
          cost: delta,
          profit: delta.neg(),
          amount: delta,
          postingIntent: createPostingIntent(
            "ADJUST_DEPRECIATION",
            "ADJUST",
            signedPostingLines(
              "DEPRECIATION_EXPENSE",
              "ACCUMULATED_DEPRECIATION",
              delta,
            ),
          ),
          entryDate: new Date(),
          dedupeKey: `DEPR_ADJ:${id}:${sequence}`,
          notes: `تصحيح تقدير الإهلاك المتراكم للأصل ${asset.code ?? id}`,
          createdBy: actor.userId,
        });
        await tx
          .update(fixedAssets)
          .set({ accumulatedDepreciation: toDbMoney(correctedAccumulated) })
          .where(eq(fixedAssets.id, id));
      }
    }
  });

  return getAsset(id, scope);
}
