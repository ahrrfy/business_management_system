import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { productUnits, productVariants } from "../../../drizzle/schema";
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
export async function assertBaseUnitStable(tx: Tx, variantId: number, intended: IntendedBase): Promise<void> {
  const vid = Number(variantId);
  if (!Number.isInteger(vid) || vid <= 0) return;

  const whereBase = and(eq(productUnits.variantId, vid), eq(productUnits.isBaseUnit, true));
  const baseCols = { id: productUnits.id, name: productUnits.unitName };
  let curBase = (
    await tx.select(baseCols).from(productUnits).where(whereBase).orderBy(desc(productUnits.isActive), desc(productUnits.id)).limit(1)
  )[0];

  if (!curBase) {
    // تثبيت الأساس أوّل مرّة: سلسِل المُهيّئين المتزامنين على صفّ المتغيّر (لا قيدَ تفرّدٍ لعَلَم الأساس في
    // productUnits)، ثمّ أعِد القراءة **قراءةً قافلة** كي ترى أساساً قد يكون أنشأه تعديلٌ آخر والتزم قبلنا.
    // محصورٌ بهذا المسار النادر ⇒ لا قفلَ للتعديل العاديّ ولا ناقلَ جمودٍ جديد.
    await tx.select({ id: productVariants.id }).from(productVariants).where(eq(productVariants.id, vid)).for("update");
    curBase = (
      await tx.select(baseCols).from(productUnits).where(whereBase).orderBy(desc(productUnits.isActive), desc(productUnits.id)).limit(1).for("share")
    )[0];
    if (!curBase) return; // ما زال لا أساس ⇒ نحن أوّل مُهيّئ (نحمل قفل صفّ المتغيّر حتى الالتزام) ⇒ يُسمح.
  }

  // تغيّرت هويّة الأساس؟ (كلٌّ بدلالة مُحدِّثه — انظر IntendedBase أعلاه.)
  const changed =
    intended.by === "id"
      ? intended.unitId == null || Number(intended.unitId) !== Number(curBase.id)
      : (curBase.name ?? "") !== (intended.unitName ?? "").trim();
  if (!changed) return;

  throw new TRPCError({
    code: "BAD_REQUEST",
    message:
      "لا يمكن تبديل وحدة الأساس أو إعادة تسميتها لمتغيّرٍ قائم — كلّ الأرصدة والحركات والحجوزات وأوامر الشراء والعروض/الطلبات مخزَّنة أو مرتبطة بالوحدة الأساس، فتغييرها يُفسد تفسيرها أو يُدلّي مراجعها. أنشئ متغيّراً جديداً بالوحدة الصحيحة بدل التغيير.",
  });
}
