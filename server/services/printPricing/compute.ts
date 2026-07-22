// نواة حساب تسعير الطباعة الرقمية — **دالّة نقيّة** (بلا DB/سياق) لتسهيل الاختبار.
//
// كل حساب مالي عبر decimal.js + money.ts (§٥: ممنوع parseFloat/Number على المال). المحمّل
// (index.ts) يقرأ الإعدادات من القاعدة ويحلّ المعرّفات إلى صفوف، ثم يستدعي هذه الدالّة.
//
// النموذج (ديجيتال، قرار المالك ٢٢/٧):
//   • صغير المقاس: الأوجه = النسخ × الصفحات × (١ أو ٢) ؛ كلفة الطباعة = الأوجه × سعر الوجه
//     (الورق مشمول) + [ورق مميّز] + التشطيب + التجهيز.
//   • عريض (فلكس): المساحة = العرض × الارتفاع × الكمية (م²) ؛ الكلفة = المساحة × سعر المتر +
//     التشطيب + التجهيز.
// السعر المقترح = الكلفة × (١+هامش٪) [MARGIN] أو الكلفة نفسها [DIRECT].
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { money, round2, sumMoney, toDbMoney } from "../money";
import type {
  CostLine,
  FinishingUnit,
  PaperUpchargeUnit,
  PricingMode,
  PrintEstimateInput,
  PrintEstimateResult,
} from "@shared/printPricing";

/** إعدادات التسعير المحلولة (من الصفّ المفرد). */
export interface ResolvedPricingSettings {
  pricingMode: PricingMode;
  defaultMarginPercent: string;
  setupFee: string;
}

export interface ResolvedPaperUpcharge {
  name: string;
  unit: PaperUpchargeUnit;
  upcharge: string;
}
export interface ResolvedMedia {
  name: string;
  pricePerSqm: string;
}
export interface ResolvedFinishing {
  name: string;
  unit: FinishingUnit;
  price: string;
}

/** كل ما تحتاجه الدالّة النقيّة — يحلّه المحمّل من القاعدة مسبقاً. */
export interface ResolvedEstimateConfig {
  settings: ResolvedPricingSettings;
  /** صغير: سعر الوجه لـ(المقاس، النمط) — إلزاميّ لـSMALL. */
  facePrice?: string;
  /** ورق مميّز مختار (أو null). */
  paperUpcharge?: ResolvedPaperUpcharge | null;
  /** عريض: الوسيط المختار — إلزاميّ لـWIDE. */
  media?: ResolvedMedia;
  /** خيارات التشطيب المختارة (بالترتيب). */
  finishings: ResolvedFinishing[];
}

/** يُنسّق عدداً عربيّ العرض بلا كسور زائدة (للتفاصيل النصّية فقط — ليس مالاً). */
function n(x: Decimal | number | string): string {
  return new Decimal(x).toDecimalPlaces(3).toString();
}

/** يبني سطر تشطيب واحد: الكمّية حسب الوحدة (لكل نسخة/كمية × units، أو لكل شغلة ×١). */
function finishingLine(f: ResolvedFinishing, index: number, units: number): CostLine {
  const multiplier = f.unit === "PER_COPY" ? units : 1;
  const amount = round2(money(f.price).times(multiplier));
  return {
    key: `finishing:${index}`,
    label: `تشطيب: ${f.name}`,
    amount: toDbMoney(amount),
    detail: f.unit === "PER_COPY" ? `${toDbMoney(f.price)} × ${units}` : `${toDbMoney(f.price)} (للشغلة)`,
  };
}

/**
 * يحسب تقدير التسعير من مدخلٍ وإعدادٍ محلولَين. **نقيّة** (لا آثار جانبية).
 * يرمي BAD_REQUEST عند نقص إعدادٍ إلزاميّ (سعر وجه/وسيط) — رسالة عربية واضحة.
 */
export function computePrintEstimate(
  input: PrintEstimateInput,
  config: ResolvedEstimateConfig,
): PrintEstimateResult {
  const lines: CostLine[] = [];
  let units: number;
  let faces: number | undefined;
  let sheets: number | undefined;
  let areaSqm: string | undefined;

  if (input.category === "SMALL") {
    if (config.facePrice == null) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "لا يوجد سعر وجه مضبوط لهذا المقاس والنمط — أضِفه في إعدادات تسعير الطباعة أولاً.",
      });
    }
    sheets = input.copies * input.pagesPerCopy;
    faces = sheets * input.sides;
    units = input.copies;

    // كلفة الطباعة (الورق مشمول في سعر الوجه).
    const printCost = round2(money(config.facePrice).times(faces));
    lines.push({
      key: "print",
      label: "كلفة الطباعة (الورق مشمول)",
      amount: toDbMoney(printCost),
      detail: `${faces} وجه × ${toDbMoney(config.facePrice)}`,
    });

    // ورق مميّز اختياريّ — زيادةٌ لكل وجه أو لكل ورقة.
    if (config.paperUpcharge) {
      const pu = config.paperUpcharge;
      const qty = pu.unit === "PER_FACE" ? faces : sheets;
      const amount = round2(money(pu.upcharge).times(qty));
      lines.push({
        key: "paper-upcharge",
        label: `ورق مميّز: ${pu.name}`,
        amount: toDbMoney(amount),
        detail: `${toDbMoney(pu.upcharge)} × ${qty} ${pu.unit === "PER_FACE" ? "وجه" : "ورقة"}`,
      });
    }
  } else {
    if (config.media == null) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "لم يُختَر وسيط طباعة عريضة صالح — أضِف الوسائط في إعدادات تسعير الطباعة أولاً.",
      });
    }
    units = input.quantity;
    // المساحة بالمتر المربّع (دقّة كاملة داخلياً؛ العرض ٣ منازل).
    const area = money(input.width).times(money(input.height)).times(input.quantity);
    areaSqm = area.toDecimalPlaces(3).toString();

    const printCost = round2(money(config.media.pricePerSqm).times(area));
    lines.push({
      key: "print",
      label: `طباعة عريضة: ${config.media.name}`,
      amount: toDbMoney(printCost),
      detail: `${n(area)}م² × ${toDbMoney(config.media.pricePerSqm)}`,
    });
  }

  // التشطيب (مشترك بين الفئتين) — units = النسخ (صغير) أو الكمية (عريض).
  config.finishings.forEach((f, i) => lines.push(finishingLine(f, i, units)));

  // رسم التجهيز/التصميم (اختياريّ) — يُطبَّق افتراضياً إن كان > 0.
  const applySetup = input.applySetupFee !== false;
  if (applySetup && money(config.settings.setupFee).gt(0)) {
    lines.push({
      key: "setup",
      label: "رسم التجهيز/التصميم",
      amount: toDbMoney(config.settings.setupFee),
    });
  }

  const totalCost = sumMoney(lines.map((l) => l.amount));

  // الهامش والسعر المقترح.
  const mode = config.settings.pricingMode;
  const marginPercent =
    mode === "MARGIN"
      ? money(input.marginPercentOverride ?? config.settings.defaultMarginPercent)
      : new Decimal(0);
  const factor = new Decimal(1).plus(marginPercent.div(100));
  const suggestedPrice = mode === "MARGIN" ? round2(totalCost.times(factor)) : round2(totalCost);
  const unitPrice = units > 0 ? round2(money(suggestedPrice).div(units)) : round2(suggestedPrice);

  return {
    category: input.category,
    faces,
    sheets,
    areaSqm,
    units,
    lines,
    totalCost: toDbMoney(totalCost),
    pricingMode: mode,
    marginPercent: marginPercent.toDecimalPlaces(3).toString(),
    suggestedPrice: toDbMoney(suggestedPrice),
    unitPrice: toDbMoney(unitPrice),
  };
}
