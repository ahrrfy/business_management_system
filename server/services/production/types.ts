// أنواع عقد الإنتاج المشترك (عامة + داخلية للحزمة).
import type Decimal from "decimal.js";

export interface ProductionLineInput {
  variantId: number;
  /** إن وُجد مع quantity ⇒ يُحوّل لكمية أساس عبر convertToBaseQuantity (يفرض الصحّة). */
  productUnitId?: number | null;
  quantity?: string;
  /** بديل مباشر: كمية أساس (عدد صحيح موجب). */
  baseQuantity?: number;
  /** OUTPUT فقط: نسبة توزيع يدوية اختيارية (كلّها يدوي بمجموع≈100 أو كلّها تناسبي). */
  manualSharePct?: string | null;
}

export interface CreateProductionInput {
  branchId: number;
  /** اختياري عند تمرير run (التشغيل بوصفة) — الخادم يوسّع الوصفة بدلاً منهما. */
  inputs?: ProductionLineInput[];
  outputs?: ProductionLineInput[];
  /** عمالة/تشغيل يدوي تُضاف لكلفة المخرجات (افتراضي 0). */
  laborCost?: string | null;
  notes?: string | null;
  linkedWorkOrderId?: number | null;
  linkedRecipeId?: number | null;
  /** السماح بصنف يكون مدخلاً ومخرجاً في آن (نادر؛ افتراضياً مرفوض لأنه يُفسد WAVG). */
  allowSelfConvert?: boolean;
  /** idempotency: نقرة مزدوجة/إعادة إرسال بنفس المفتاح ⇒ مستند واحد. */
  clientRequestId?: string | null;
  /**
   * مسار «التشغيل بوصفة» (بديل آمن للمدخلات/المخرجات اليدوية): الخادم يوسّع الوصفة بنفسه فيمنع تلاعب الكلفة.
   * نموذج «الدفعة تقود الاستهلاك»: الاستهلاك = qtyPerOutputBase × batch؛ السليم = batch − scrap.
   * عند وجوده تُتجاهل inputs/outputs/laborCost ويُحسب كل شيء من الوصفة + يُسجَّل قيد WASTAGE للهدر غير الطبيعي.
   */
  run?: {
    recipeId: number;
    batchQty: number;
    scrapQty?: number;
    /** عمالة لكل وحدة (تجاوز اختياري لعمالة الوصفة). */
    laborPerUnit?: string | null;
  } | null;
}

/** بارامترات تفريق الهدر لتشغيل بوصفة (تُملأ من resolveRunPlan ثم يُحسب abnormalLoss في القلب بعد معرفة الكلفة). */
interface SpoilageParams {
  batch: number;
  scrap: number;
  good: number;
  wasteStdPct: Decimal;
}

interface ResolvedLine {
  variantId: number;
  productUnitId: number | null;
  quantity: string;
  baseQuantity: number;
  manualSharePct: string | null;
}

interface RunPlan {
  inLines: ResolvedLine[];
  outLines: ResolvedLine[];
  laborCost: Decimal;
  spoilage: SpoilageParams;
}

export interface CreateProductionResult {
  productionOrderId: number;
  docNumber: string;
  totalCost: string;
  idempotent?: boolean;
}

export interface ListProductionFilters {
  branchId?: number | null;
  status?: "CONFIRMED" | "CANCELLED" | null;
  limit?: number;
}

export interface RunPreviewResult {
  recipeId: number;
  recipeName: string | null;
  outputVariantId: number;
  outputProductUnitId: number;
  outputName: string | null;
  outputSku: string | null;
  outputUnitName: string | null;
  batch: number;
  good: number;
  scrap: number;
  yieldPct: number; // 0..1
  wasteStdPct: string; // كسر
  normalAllow: number;
  abnormalUnits: number;
  abnormalLoss: string;
  absorbedCost: string;
  unitCost: string; // كلفة الوحدة السليمة
  materialsCost: string;
  laborCost: string;
  totalCost: string;
  anyShort: boolean;
  inputs: Array<{
    variantId: number;
    productName: string | null;
    sku: string | null;
    perOutputBase: string;
    consumed: number;
    available: number | null;
    short: boolean;
    unitCost: string;
    lineCost: string;
  }>;
  wavg: { oldQty: number; oldCost: string; addQty: number; newQty: number; newCost: string };
}


// تصدير داخلي للحزمة فقط (يستهلكه helpers/create) — لا يُعاد تصديره من البرميل productionService.ts.
export type { SpoilageParams, ResolvedLine, RunPlan };
