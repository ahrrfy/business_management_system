import { TRPCError } from "@trpc/server";
import { and, eq, gt, ne, or, sql } from "drizzle-orm";
import {
  branchStock,
  bundleComponents,
  inventoryMovements,
  productUnits,
  purchaseOrderItems,
  purchaseOrders,
  reservationStock,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";

/**
 * وحدة الأساس الجديدة المقصودة — تُعرَّف إمّا بمعرّف صفّها المُرسَل (المسار الحامل للمعرّفات
 * `catalog/productUpdate`) أو باسمها (مسار القالب المشترك `productEditService`، حيث `upsertVariantUnits`
 * يطابق القالب بالوحدات القائمة **بالاسم**). أحدهما يكفي؛ يُفضَّل المعرّف حين يتوفّر.
 */
export type IntendedBase = { unitId?: number | null; unitName?: string | null };

/**
 * حارس تبديل وحدة الأساس (تدقيق ١١/٨ — بعد جولتَي مراجعة Codex العدائية).
 *
 * الأرصدة والحركات والوصفات والحجوزات وأوامر الشراء المفتوحة كلّها مخزَّنة **بالوحدة الأساس** بلا
 * معرّف وحدة؛ فتبديل **هويّة** وحدة الأساس لمتغيّرٍ سبق ارتباطه يعيد تفسير كل تلك القيم صامتاً
 * (١٤٤ قطعة تصير ١٤٤ درزناً). لكن **إعادة تسمية** وحدة الأساس نفسها (نفس الصفّ، تبقى مِعامِلاً ١)
 * لا تعيد التفسير — فرفضها خطأ (إيجابيّة كاذبة تكسر تعديلاً مشروعاً). لذا:
 *
 *   • الكشف **بالهويّة لا بالاسم** (Codex P2): التبديل = ترقية صفٍّ قائمٍ آخر إلى الأساس (معرّف مختلف)؛
 *     أمّا اسمٌ جديدٌ كليّاً فيُدرَج صفَّ أساسٍ جديداً بمِعامل ١ = نفس حجم الأساس ⇒ إعادة تسمية مسموحة.
 *   • تغطية **كل** المخازن المُقوَّمة بالأساس (Codex P1): رصيد + حركات + مكوّنات بكج (لا رصيد/حركة لها)
 *     + حجز محجوز + بنود أمر شراء مفتوحة (تُفسَّر عند الاستلام قبل أيّ حركة).
 *   • قفل صفوف `branchStock` **أوّلاً — قبل تحديث صفّ المتغيّر** (Codex P1/P2): يوافق ترتيب القفل في
 *     مسارات استلام المخزون (`gifts/inbound`: branchStock ← productVariants) فلا جمود، ويتسلسل مع
 *     `applyMovement` (يقفل branchStock قبل كتابة الحركة). والكمية تُقرأ **داخل** القفل، وفحص الحركة
 *     قراءةٌ قافلة، كي نرى الحالة التي التزمت قبل حصولنا على القفل لا لقطة المعاملة القديمة.
 *
 * يُستدعى من **كلا** مساري التعديل كي لا يتسرّب التبديل عبر المسار القديم.
 *
 * ⚠️ بقيّةٌ مُصارَحٌ بها: متغيّرٌ جديدٌ تماماً بلا **أيّ** ارتباط (لا رصيد ولا صفّ `branchStock` ولا حركة
 * ولا بكج/حجز/أمر) لا يُقفَل شيءٌ له، فقد يتسابق تبديل أساسه مع أوّل حركةٍ له على الإطلاق (بيع افتتاحيّ
 * بالسالب). حالةٌ فلكيّة (كلاهما عمليّة مدير/افتتاح) وأثرها منعدمٌ عملياً — مقبولةٌ صراحةً.
 */
export async function assertBaseUnitSwapSafe(
  tx: Tx,
  variantId: number,
  intended: IntendedBase,
): Promise<void> {
  const vid = Number(variantId);
  if (!Number.isInteger(vid) || vid <= 0) return;

  // (١) اقفل صفوف الرصيد أوّلاً — واقرأ الكمية داخل القفل (لا بقراءةٍ لاحقة تعتمد لقطة المعاملة).
  const lockedStock = await tx
    .select({ q: branchStock.quantity })
    .from(branchStock)
    .where(eq(branchStock.variantId, vid))
    .for("update");

  // (٢) وحدة الأساس **النشطة** الحالية (هويّةً واسماً). الوحدة المُعطَّلة تبقى isBaseUnit=true فلا تُحتسَب.
  const curBase = (
    await tx
      .select({ id: productUnits.id, name: productUnits.unitName })
      .from(productUnits)
      .where(and(eq(productUnits.variantId, vid), eq(productUnits.isBaseUnit, true), eq(productUnits.isActive, true)))
      .limit(1)
  )[0];
  if (!curBase) return; // متغيّرٌ جديد بلا أساسٍ ملتزمٍ بعد.

  // (٣) هل تتبدّل **هويّة** الأساس؟ إعادة تسمية الصفّ نفسه (أو اسمٌ جديدٌ كليّاً) ليست تبديلاً.
  if (!(await baseIdentityChanges(tx, vid, curBase, intended))) return;

  // (٤) ارفض فقط إن وُجد ارتباطٌ ملتزمٌ مُقوَّمٌ بالأساس يعيد التبديل تفسيره.
  const anyStock = lockedStock.some((r) => (r.q ?? 0) !== 0);
  if (anyStock || (await hasBaseDenominatedDependency(tx, vid))) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "لا يمكن تبديل وحدة الأساس لصنفٍ له رصيدٌ أو حركاتٌ أو ارتباطاتٌ سابقة (بكج/حجز/أمر شراء مفتوح) — كلّها مخزَّنة بالوحدة الأساس فالتبديل يعيد تفسيرها. أنشئ متغيّراً جديداً بالوحدة الجديدة بدل التبديل.",
    });
  }
}

/** يقرّر إن كانت هويّة وحدة الأساس ستتبدّل (لا مجرّد اسمها). */
async function baseIdentityChanges(
  tx: Tx,
  vid: number,
  curBase: { id: number; name: string | null },
  intended: IntendedBase,
): Promise<boolean> {
  const curId = Number(curBase.id);
  // المسار الحامل للمعرّف: نفس الصفّ ⇒ إعادة تسمية/لا تغيير ⇒ آمن؛ صفٌّ قائمٌ آخر ⇒ تبديل.
  if (intended.unitId != null) return Number(intended.unitId) !== curId;

  const want = (intended.unitName ?? "").trim();
  if (!want || want === (curBase.name ?? "").trim()) return false; // نفس الاسم ⇒ نفس الأساس ⇒ آمن.

  // مسار القالب بالاسم: هل يُطابق الاسمُ الجديد صفَّ وحدةٍ **قائماً نشطاً** غير الأساس الحاليّ؟
  // (نعم ⇒ ترقية وحدةٍ ماديّةٍ مختلفة = تبديل. لا ⇒ إدراج صفٍّ جديدٍ بمِعامل ١ = إعادة تسمية مسموحة.)
  const target = (
    await tx
      .select({ id: productUnits.id })
      .from(productUnits)
      .where(and(eq(productUnits.variantId, vid), eq(productUnits.unitName, want), eq(productUnits.isActive, true)))
      .limit(1)
  )[0];
  return !!target && Number(target.id) !== curId;
}

/** أيّ ارتباطٍ ملتزمٍ مُقوَّمٍ بالوحدة الأساس (عدا الرصيد الحاليّ الذي يُفحَص تحت القفل في المُستدعي). */
async function hasBaseDenominatedDependency(tx: Tx, vid: number): Promise<boolean> {
  // حركات — قراءةٌ قافلة (share) كي نرى الحركة التي التزمت قبل حصولنا على قفل الرصيد.
  const mv = await tx
    .select({ id: inventoryMovements.id })
    .from(inventoryMovements)
    .where(eq(inventoryMovements.variantId, vid))
    .limit(1)
    .for("share");
  if (mv.length) return true;

  // مكوّنات بكج — `componentBaseQuantity` مُقوَّمة بأساس البكج **وأساس المكوّن** معاً؛ والبكج بلا رصيد/حركة.
  const bc = await tx
    .select({ id: bundleComponents.id })
    .from(bundleComponents)
    .where(or(eq(bundleComponents.bundleVariantId, vid), eq(bundleComponents.componentVariantId, vid)))
    .limit(1);
  if (bc.length) return true;

  // حجزٌ محجوز — `reservedBase` مُقوَّمٌ بالأساس ومستقلٌّ عن `branchStock.quantity`.
  const rs = await tx
    .select({ id: reservationStock.id })
    .from(reservationStock)
    .where(and(eq(reservationStock.variantId, vid), gt(reservationStock.reservedBase, 0)))
    .limit(1);
  if (rs.length) return true;

  // بنود أمر شراءٍ مفتوحة (لم تُستلَم كاملةً، وأمرها غير ملغى) — `baseQuantity` يُفسَّر عند الاستلام قبل أيّ حركة.
  const po = await tx
    .select({ id: purchaseOrderItems.id })
    .from(purchaseOrderItems)
    .innerJoin(purchaseOrders, eq(purchaseOrderItems.purchaseOrderId, purchaseOrders.id))
    .where(
      and(
        eq(purchaseOrderItems.variantId, vid),
        ne(purchaseOrders.status, "CANCELLED"),
        sql`COALESCE(${purchaseOrderItems.receivedBaseQuantity}, 0) < ${purchaseOrderItems.baseQuantity}`,
      ),
    )
    .limit(1);
  return po.length > 0;
}
