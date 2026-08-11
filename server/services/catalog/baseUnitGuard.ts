import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { branchStock, inventoryMovements, productUnits, productVariants } from "../../../drizzle/schema";
import type { Tx } from "../../db";

/**
 * وحدة الأساس الجديدة المقصودة — مُميَّزةٌ بمسارها كي تُطابَق دلالة كلّ مُحدِّث بدقّة (Codex جولة٥):
 *  • `by:"id"` — المسار الحامل للمعرّف (`catalog/productUpdate`) يُحدِّث الوحدة بمعرّفها فيُعيد تسميتها
 *    **في مكانها**؛ فمعرّفٌ مطابقٌ لصفّ الأساس = آمن، ومعرّفٌ مختلفٌ **أو غيابُ معرّفٍ (صفٌّ جديد)** =
 *    استبدالٌ يُرفَض. (لا نرجع لمقارنة الاسم هنا: اسمٌ جديدٌ بنفس اسم الأساس **يُدرَج** صفّاً ويُعطّل القديم.)
 *  • `by:"name"` — مسار القالب المشترك (`productEditService`) يطابق بالاسم؛ فيُقارَن الاسم المخزَّن **الخام**
 *    بالاسم المُرسَل **المقصوص** (دلالة `upsertVariantUnits` حرفاً — لا قصَّ للمخزَّن).
 */
export type IntendedBase = { by: "id"; unitId: number | null } | { by: "name"; unitName: string };

/**
 * حارس ثبات وحدة الأساس (تدقيق ١١/٨ — بعد خمس جولات مراجعة Codex العدائية).
 *
 * الأرصدة والحركات والوصفات والحجوزات وأوامر الشراء وبنود الفواتير/العروض/الطلبات كلّها مخزَّنة أو
 * مرتبطة **بالوحدة الأساس** (كمّيةً مُقوَّمةً بالأساس، أو معرّفَ وحدةٍ يُشير إليه). فتغيير **هويّة** وحدة
 * الأساس لمتغيّرٍ قائم — تبديلاً أو استبدالاً — إمّا يعيد تفسير تلك الكمّيات صامتاً (١٤٤ قطعة تصير ١٤٤
 * درزناً) أو يُدلّي معرّفات الوحدة في العروض/الطلبات المعلّقة فيتعذّر تنفيذها.
 *
 * جولات Codex برهنت أنّ حصر «كل مخزنٍ مُقوَّمٍ بالأساس» بلا قاع وأنّ قراءة تلك الحالة تحت التزامن تفتح
 * سباقاتٍ لا تنتهي. فالقاعدة **الأبسط والأمتن**: وحدة الأساس **ثابتةٌ** لمتغيّرٍ قائمٍ له أساس — كشفاً
 * بمقارنةٍ ساكنةٍ لصفّ الأساس وحده (لا حصرَ ارتباطاتٍ يتقادم، ولا أقفال branchStock تُجامِد البيع). صفّ
 * الأساس المرجعيّ يُحلّ من **كل** صفوف الأساس (النشط مُفضَّلاً، وإلّا أحدث معطَّل) فلا يُخدَع بأساسٍ معطَّل.
 *
 * الاستثناء الوحيد — تثبيت الأساس **أوّل مرّة** لمتغيّرٍ بلا صفّ أساسٍ إطلاقاً — نتيجتُه تعتمد حالةً
 * متغيّرة، فنُسلسِل المُهيّئين المتزامنين بقفل صفّ المتغيّر ثمّ نُعيد القراءة قراءةً قافلة (Codex جولة٥ P2).
 *
 * يُستدعى من **كلا** مساري التعديل كي لا يتسرّب التغيير عبر المسار القديم. التصحيح بإنشاء متغيّرٍ جديد.
 */
type UnitRow = { id: number; name: string | null; isBaseUnit: boolean | null; isActive: boolean | null; factor: string };

/** الأساس الفعليّ (يطابق الحلّ القانونيّ في inventory/reorder.ts:213-229 للبيانات المستوردة القديمة، مع
 *  التقاط الأساس المُعطَّل — Codex جولات ٤/٦): وحدةٌ نشطةٌ بعَلَم الأساس (الأحدث) ← وحدةٌ نشطةٌ معاملها ١
 *  (قديمٌ بلا عَلَم) ← وحدةُ أساسٍ مُعطَّلة (الأحدث) ← لا شيء (لا أساسَ يُحمى بعد).
 *  `ambiguous` (Codex جولة٨ P2): وُجود أكثر من صفٍّ في **طبقة الأولويّة الفائزة** (لا قيدَ تفرّدٍ يمنعه) ⇒
 *  الأساس الحقيقيّ ملتبس، فأيّ تعديلٍ قد يُبقي أحدها ويُحوّل الآخر فتُفسَّر مراجعه — يُرفَض التعديل. */
function resolveEffectiveBase(rows: UnitRow[]): { base?: UnitRow; ambiguous: boolean } {
  const byIdDesc = (a: UnitRow, b: UnitRow) => Number(b.id) - Number(a.id);
  const tiers = [
    rows.filter((u) => u.isBaseUnit && u.isActive),
    rows.filter((u) => u.isActive && Number(u.factor) === 1),
    rows.filter((u) => u.isBaseUnit),
  ];
  for (const tier of tiers) {
    if (tier.length) return { base: tier.sort(byIdDesc)[0], ambiguous: tier.length > 1 };
  }
  return { base: undefined, ambiguous: false };
}

/** رصيدٌ حاليّ ≠ 0 أو أيّ حركةٍ تاريخية لهذا المتغيّر — كلاهما مُقوَّمٌ بالوحدة الأساس ويُشير إلى المتغيّر
 *  لا إلى وحدة (applyMovement يقبل variantId + كمّيةً بالأساس بلا صفّ وحدة)، فقد يوجدان بلا أيّ وحدةٍ أصلاً. */
async function hasBaseDenominatedQuantities(tx: Tx, vid: number): Promise<boolean> {
  const stock = await tx.select({ q: branchStock.quantity }).from(branchStock).where(eq(branchStock.variantId, vid));
  if (stock.some((r) => (r.q ?? 0) !== 0)) return true;
  const mv = await tx.select({ id: inventoryMovements.id }).from(inventoryMovements).where(eq(inventoryMovements.variantId, vid)).limit(1);
  return mv.length > 0;
}

export async function assertBaseUnitStable(tx: Tx, variantId: number, intended: IntendedBase): Promise<void> {
  const vid = Number(variantId);
  if (!Number.isInteger(vid) || vid <= 0) return;

  const cols = {
    id: productUnits.id,
    name: productUnits.unitName,
    isBaseUnit: productUnits.isBaseUnit,
    isActive: productUnits.isActive,
    factor: productUnits.conversionFactor,
  };
  let units = await tx.select(cols).from(productUnits).where(eq(productUnits.variantId, vid));
  let resolved = resolveEffectiveBase(units);

  if (!resolved.base) {
    // تثبيت الأساس أوّل مرّة (لا أساسَ فعليّاً): سلسِل المُهيّئين المتزامنين على صفّ المتغيّر (لا قيدَ تفرّدٍ
    // لعَلَم الأساس في productUnits)، ثمّ أعِد القراءة **قراءةً قافلة** كي ترى أساساً أنشأه تعديلٌ آخر والتزم
    // قبلنا. محصورٌ بهذا المسار النادر ⇒ لا قفلَ للتعديل العاديّ ولا ناقلَ جمودٍ جديد.
    await tx.select({ id: productVariants.id }).from(productVariants).where(eq(productVariants.id, vid)).for("update");
    units = await tx.select(cols).from(productUnits).where(eq(productUnits.variantId, vid)).for("share");
    resolved = resolveEffectiveBase(units);
    if (!resolved.base) {
      // Codex جولة٨ P1: applyMovement يقبل variantId + كمّيةً بالأساس بلا صفّ وحدة، فقد يوجد رصيدٌ/حركةٌ
      // لمتغيّرٍ يتيمٍ (أو استيرادٍ ناقص) بلا أيّ وحدة. تثبيت أساسٍ اعتباطيٍّ حينئذٍ يُعيد تفسير تلك الكمّيات
      // صامتاً ⇒ نرفض ونطلب هجرةً صريحة؛ نسمح فقط إن كان المتغيّر خالياً فعلاً (لا رصيد ولا حركة).
      if (await hasBaseDenominatedQuantities(tx, vid)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "لهذا المتغيّر رصيدٌ أو حركاتٌ مخزنيّةٌ بلا وحدةِ أساسٍ مُعرَّفة — تثبيت أساسٍ الآن يعيد تفسير كمّياته صامتاً. يلزم تصحيحٌ صريحٌ للبيانات قبل تعيين الأساس.",
        });
      }
      return; // خالٍ تماماً ⇒ نحن أوّل مُهيّئ (نحمل قفل صفّ المتغيّر حتى الالتزام) ⇒ يُسمح.
    }
  }

  // Codex جولة٨ P2: طبقةُ الأولويّة الفائزة فيها أكثر من صفّ ⇒ الأساس ملتبس، فلا نختار اعتباطاً — نرفض.
  if (resolved.ambiguous) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "للمتغيّر أكثر من وحدة أساسٍ متساويةِ الأولويّة (حالةٌ شاذّة) — لا يمكن تحديد الأساس بلا لبس. صحّح وحدات المتغيّر أوّلاً.",
    });
  }
  const curBase = resolved.base;

  // تغيّرت هويّة الأساس؟ (كلٌّ بدلالة مُحدِّثه — انظر IntendedBase أعلاه.)
  //  • by:"id" — مقارنةٌ حتميّةٌ بالمعرّف (productUpdate يُحدِّث بالمعرّف).
  //  • by:"name" — مسار القالب يطابق بالاسم عبر `existing.find` **غير مرتَّب**؛ فلا يكفي تطابق الاسم الخام
  //    مع الأساس، بل يجب أن يكون هذا الاسمُ **غير ملتبس** (صفٌّ واحدٌ فقط يحمله) وإلّا قد يُعيد المُحدِّث
  //    تفعيل صفٍّ مكرّرِ الاسمِ آخر ويُعطّل الأساس الحاليّ فتتدلّى مراجعه (Codex جولة٦ P2).
  let changed: boolean;
  if (intended.by === "id") {
    changed = intended.unitId == null || Number(intended.unitId) !== Number(curBase.id);
  } else {
    const want = (intended.unitName ?? "").trim();
    changed = (curBase.name ?? "") !== want || units.filter((u) => (u.name ?? "") === want).length > 1;
  }
  if (!changed) return;

  throw new TRPCError({
    code: "BAD_REQUEST",
    message:
      "لا يمكن تبديل وحدة الأساس أو إعادة تسميتها لمتغيّرٍ قائم — كلّ الأرصدة والحركات والحجوزات وأوامر الشراء والعروض/الطلبات مخزَّنة أو مرتبطة بالوحدة الأساس، فتغييرها يُفسد تفسيرها أو يُدلّي مراجعها. أنشئ متغيّراً جديداً بالوحدة الصحيحة بدل التغيير.",
  });
}
