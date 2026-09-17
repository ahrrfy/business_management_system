import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { eq } from "drizzle-orm";

import { productUnits } from "../../../drizzle/schema";
import type { Tx } from "../../db";

export interface WorkOrderBaseSnapshotSource {
  baseVariantId: number | string | null;
  baseProductUnitId: number | string | null;
  baseBaseQuantity: number | string | null;
  baseConsumesInventory: boolean | number | null;
}

export interface WorkOrderBaseInventorySnapshot {
  variantId: number;
  productUnitId: number;
  baseQuantity: number;
  consumesInventory: boolean;
}

/**
 * يقرأ لقطة الصنف الأساس قراءةً fail-closed. بقاء baseVariantId وحده يعني أمراً تاريخياً
 * لا نعرف وحدته ولا كمية الأساس التي كان يجب خصمها؛ التخمين عند البدء/التسليم يكرر الثغرة.
 */
export function requireWorkOrderBaseSnapshot(
  workOrder: WorkOrderBaseSnapshotSource,
): WorkOrderBaseInventorySnapshot | null {
  if (workOrder.baseVariantId == null) {
    if (
      workOrder.baseProductUnitId != null ||
      workOrder.baseBaseQuantity != null ||
      workOrder.baseConsumesInventory != null
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر قراءة لقطة الصنف الأساس لأمر الشغل",
          why: "توجد بيانات وحدة أو كمية بلا صنف أساس مرتبط",
          doThis: "راجع سلامة أمر الشغل قبل متابعة التنفيذ",
        }),
      });
    }
    return null;
  }

  if (
    workOrder.baseProductUnitId == null ||
    workOrder.baseBaseQuantity == null ||
    workOrder.baseConsumesInventory == null
  ) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: "تعذّر تنفيذ أمر الشغل التاريخي بأمان",
        why: "الصنف الأساس محفوظ بلا لقطة وحدة وكمية استهلاك موثوقة",
        doThis: "أنشئ أمراً جديداً من الصنف والوحدة الصحيحين أو نفّذ تصحيحاً إدارياً موثقاً",
      }),
    });
  }

  const variantId = Number(workOrder.baseVariantId);
  const productUnitId = Number(workOrder.baseProductUnitId);
  const baseQuantity = Number(workOrder.baseBaseQuantity);
  if (
    !Number.isSafeInteger(variantId) || variantId <= 0 ||
    !Number.isSafeInteger(productUnitId) || productUnitId <= 0 ||
    !Number.isSafeInteger(baseQuantity) || baseQuantity <= 0
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذّر تنفيذ أمر الشغل",
        why: "لقطة الصنف الأساس تحتوي معرّفاً أو كمية غير صالحة",
        doThis: "راجع سلامة أمر الشغل قبل متابعة التنفيذ",
      }),
    });
  }

  return {
    variantId,
    productUnitId,
    baseQuantity,
    consumesInventory:
      workOrder.baseConsumesInventory === true ||
      Number(workOrder.baseConsumesInventory) === 1,
  };
}

export interface WorkOrderMaterialSnapshotRow {
  variantId: number | string;
  baseQuantity: number | string;
  isBaseMaterial: boolean | number;
}

/** يثبت أن الصنف المادي الأساسي ما زال ضمن مواد الأمر ولم يُحذف أو يُخفَّض بعد الإنشاء. */
export function assertBaseMaterialInvariant(
  snapshot: WorkOrderBaseInventorySnapshot | null,
  materials: readonly WorkOrderMaterialSnapshotRow[],
): void {
  const marked = materials.filter(
    (material) =>
      material.isBaseMaterial === true || Number(material.isBaseMaterial) === 1,
  );

  if (snapshot == null || !snapshot.consumesInventory) {
    if (marked.length > 0) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر تنفيذ مواد أمر الشغل",
          why: "يوجد سطر مادة أساس على أمر خدمة أو أمر بلا صنف أساس",
          doThis: "راجع مواد الأمر وصحح السطر المعلّم قبل المتابعة",
        }),
      });
    }
    return;
  }

  const base = marked[0];
  if (
    marked.length !== 1 ||
    Number(base?.variantId) !== snapshot.variantId ||
    !Number.isSafeInteger(Number(base?.baseQuantity)) ||
    Number(base?.baseQuantity) < snapshot.baseQuantity
  ) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: "تعذّر بدء أمر الشغل لأن مادته الأساسية غير مكتملة",
        why: `يلزم سطر أساس واحد للصنف #${snapshot.variantId} بكمية لا تقل عن ${snapshot.baseQuantity} وحدة أساس`,
        doThis: "أعد الصنف الأساس وكمّيته المحفوظة إلى مواد الأمر ثم أعد المحاولة",
      }),
    });
  }
}

/** يثبت أن FK الوحدة لم يُعد توجيهه إلى متغيّر آخر قبل كتابة بند الفاتورة. */
export async function assertBaseProductUnitBinding(
  tx: Tx,
  snapshot: WorkOrderBaseInventorySnapshot,
): Promise<void> {
  const unit = (
    await tx
      .select({ variantId: productUnits.variantId })
      .from(productUnits)
      .where(eq(productUnits.id, snapshot.productUnitId))
      .for("update")
      .limit(1)
  )[0];
  if (!unit || Number(unit.variantId) !== snapshot.variantId) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: "تعذّر إصدار فاتورة أمر الشغل",
        why: "وحدة الصنف الأساس المحفوظة لم تعد مرتبطة بالصنف نفسه",
        doThis: "راجع تعريف وحدات المنتج ونفّذ تصحيحاً إدارياً موثقاً قبل التسليم",
      }),
    });
  }
}
