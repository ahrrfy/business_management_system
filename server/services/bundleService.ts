// bundles (٧/٧/٢٦): إدارة المنتجات المركّبة (باندل/بكج) — القراءات + الكتابات + التوسيع لحظة البيع.
//
// النموذج الذهني (مطابق لِتصميم CLAUDE.md §٤ ودلالة §٥ في المخزون):
//   * البكج = منتج بـ`products.isBundle=true` له متغيّر واحد (لَون افتراضي غير مستعمَل هنا) بوحدة أساس
//     يحمل باركوداً وسعراً كأيّ منتج. لكنّه **بلا رصيد مخزنيّ** — `branchStock` لا تُنشَأ له.
//   * الوصفة في `bundleComponents` تحدّد كم وحدة أساس من كل مكوّن تدخل في وحدة أساس واحدة من البكج.
//   * المكوّنات **منتجات بسيطة** — النَست ممنوع (بكج داخل بكج) لتلافي التعقيد الرياضي/المحاسبي.
//
// دلالة التكلفة (تُثبَّت لحظة البيع لا لحظة إنشاء البكج — قرار مالك ٧/٧):
//   unitCost لكل قاعدة من البكج = Σ( componentVariant.costPrice × componentBaseQuantity )
//   استعمل تكلفة WAVG المحدَّثة في `productVariants.costPrice` — نفس المصدر الذي يستعمله snapshotUnitCost.
//
// ثوابت الأمان (يفرضها هذا الملف — لا تتجاوزها):
//   B1  عدم النَست: كل مكوّن يجب أن يكون متغيّراً لمنتج `isBundle=false`.
//   B2  التفعيل: كل مكوّن يجب أن يكون `isActive=true` (متغيّر) وينتمي لمنتج `isActive=true`.
//   B3  الكميّة الصحيحة الموجبة: componentBaseQuantity > 0 عدد صحيح (يفرضه CHECK في 0057 + هذا الفحص).
//   B4  الفرادة: مكوّن واحد لكل زوج (bundle, component) — يُدار بالكميّة، لا بالتكرار.
//   B5  الحذف الآمن: FK cascade على البكج (يذهب مع منتجه) + restrict على المكوّن (يمنع حذفه إن استعمل).
//   B6  الحدّ الأدنى: كل بكج يجب أن يحوي مكوّناً واحداً على الأقلّ (لا معنى لبكج فارغ).
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, eq, inArray } from "drizzle-orm";
import { bundleComponents, productVariants, products } from "../../drizzle/schema";
import type { Tx } from "../db";
import { extractInsertId } from "../lib/insertId";
import { money, toDbMoney } from "./money";

/** واحدة من صفوف الوصفة كما تُخزَّن — نموذج القراءة العامّ. */
export interface BundleComponentRow {
  id: number;
  bundleVariantId: number;
  componentVariantId: number;
  componentBaseQuantity: number;
  componentUnitId: number | null;
  sortOrder: number;
  notes: string | null;
}

/** مدخل الكتابة: صفٌّ يريد المدير حفظه للبكج (بدون معرِّف). */
export interface BundleComponentInput {
  componentVariantId: number;
  componentBaseQuantity: number;
  componentUnitId?: number | null;
  sortOrder?: number;
  notes?: string | null;
}

/** نتيجة التحقّق من صحّة الوصفة قبل الحفظ — تُستعمَل داخل معاملة الكتابة. */
export interface ValidatedComponent extends Required<Pick<BundleComponentInput, "componentVariantId" | "componentBaseQuantity">> {
  componentUnitId: number | null;
  sortOrder: number;
  notes: string | null;
  costPrice: string; // WAVG الحيّ للمكوّن — يُخزَّن هنا لتفادي قراءة ثانية عند حساب التكلفة اللحظية.
}

/** يميّز نوع المتغيّر لحظة البيع — يُستعمَل في مسار البيع كي يفرّق التعامل. */
export type VariantKind = "STOCKED" | "SERVICE" | "BUNDLE";

/**
 * نوع كل متغيّر (bulk): STOCKED = سلعة عادية بمخزون، SERVICE = خدمة، BUNDLE = بكج (تُوسَّع مكوّناته).
 * يُستعمَل في `sale/create.ts` لتوجيه المنطق بلا استعلامات إفرادية.
 */
export async function classifyVariants(tx: Tx, variantIds: number[]): Promise<Map<number, VariantKind>> {
  const map = new Map<number, VariantKind>();
  if (!variantIds.length) return map;
  const ids = Array.from(new Set(variantIds));
  const rows = await tx
    .select({
      variantId: productVariants.id,
      isService: products.isService,
      isBundle: products.isBundle,
    })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(inArray(productVariants.id, ids));
  for (const r of rows) {
    const vid = Number(r.variantId);
    // ترتيب الأسبقية: BUNDLE أقوى من SERVICE (منتج مركّب لا يمكن أن يكون خدمة بحكم قيود الإنشاء
    // في bundleService.createBundleProduct، لكن نُثبّت الأسبقية دفاعياً).
    if (r.isBundle) map.set(vid, "BUNDLE");
    else if (r.isService) map.set(vid, "SERVICE");
    else map.set(vid, "STOCKED");
  }
  return map;
}

/**
 * B1+B2+B3: يتحقّق أن كل مكوّن صالحٌ للاستعمال في بكج (منتج نشط غير مركّب، متغيّر نشط، كميّة صحيحة موجبة)،
 * ثم يجلب `costPrice` (WAVG) لتضمينه في النتيجة لتفادي round-trip ثانٍ في حاسبة التكلفة اللحظية.
 * ينسّق كذلك مع B4 عبر رفض التكرار داخل الحمولة قبل ضرب قيد UNIQUE.
 */
export async function validateBundleComponents(
  tx: Tx,
  bundleVariantId: number,
  raw: BundleComponentInput[]
): Promise<ValidatedComponent[]> {
  if (!raw.length) {
    // B6: بكج بلا مكوّنات = خطأ منطقي (لا يمكن بيعه ولا تحسب تكلفته). نمنعه عند الإنشاء والتعديل.
    throw new TRPCError({ code: "BAD_REQUEST", message: "البكج يحتاج مكوّناً واحداً على الأقلّ" });
  }

  // فرادة داخلية قبل ضرب DB — رسالة أوضح للمستخدم.
  const seen = new Set<number>();
  for (const c of raw) {
    if (!Number.isFinite(c.componentVariantId) || c.componentVariantId <= 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "معرّف المكوّن غير صالح" });
    }
    if (seen.has(c.componentVariantId)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `المكوّن #${c.componentVariantId} مكرّر في القائمة — زد الكميّة بدل تكرار السطر`,
      });
    }
    seen.add(c.componentVariantId);
    if (!Number.isInteger(c.componentBaseQuantity) || c.componentBaseQuantity <= 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `كميّة المكوّن يجب أن تكون عدداً صحيحاً موجباً (المكوّن #${c.componentVariantId})`,
      });
    }
    // B1 الاحترازي: بكج لا يحوي نفسه (سيمسكه أيضاً فحص isBundle أدناه، لكن رسالة أوضح هنا).
    if (Number(c.componentVariantId) === Number(bundleVariantId)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "البكج لا يمكن أن يحوي نفسه كمكوّن" });
    }
  }

  const componentIds = Array.from(seen);
  const rows = await tx
    .select({
      variantId: productVariants.id,
      variantActive: productVariants.isActive,
      productActive: products.isActive,
      productIsBundle: products.isBundle,
      productIsService: products.isService,
      productIsConsignment: products.isConsignment,
      costPrice: productVariants.costPrice,
      productName: products.name,
      variantSku: productVariants.sku,
    })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(inArray(productVariants.id, componentIds));

  const byId = new Map<number, (typeof rows)[number]>();
  for (const r of rows) byId.set(Number(r.variantId), r);

  const validated: ValidatedComponent[] = [];
  for (const c of raw) {
    const r = byId.get(c.componentVariantId);
    if (!r) {
      throw new TRPCError({ code: "NOT_FOUND", message: `المكوّن #${c.componentVariantId} غير موجود` });
    }
    // B2:
    if (r.variantActive === false || r.productActive === false) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `المكوّن «${r.productName} — ${r.variantSku}» معطّل — فعّله أو استبدله`,
      });
    }
    // B1:
    if (r.productIsBundle) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `«${r.productName}» بكج بحدّ ذاته — البكج لا يحتوي على بكج (النَست ممنوع)`,
      });
    }
    // منتج خدمي لا يُخزَّن ⇒ لا معنى لتضمينه في بكج قابل للبيع كبضاعة. (يمكن رفع القيد لاحقاً إن طُلب.)
    if (r.productIsService) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `«${r.productName}» منتج خدمي — لا يصلح مكوّناً في بكج بضاعة`,
      });
    }
    // بضاعة الأمانة (§٥-ط، الحارس ٢): صنف أمانة ليس ملكنا — لقطة مكوّنات البكج تسطّح المودِع وتفسد
    // التقاط التزامه عند بيع البكج ⇒ لا يُضمَّن في بكج.
    if (r.productIsConsignment) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `«${r.productName}» بضاعة أمانة — لا تُضمَّن في بكج (تُباع مباشرةً)`,
      });
    }
    validated.push({
      componentVariantId: c.componentVariantId,
      componentBaseQuantity: c.componentBaseQuantity,
      componentUnitId: c.componentUnitId ?? null,
      sortOrder: c.sortOrder ?? 0,
      notes: (c.notes ?? "").trim() || null,
      costPrice: String(r.costPrice ?? "0"),
    });
  }
  return validated;
}

/**
 * كتابة/إعادة كتابة وصفة البكج بشكل ذرّي: تحقّق (يشمل B1..B6) ⇒ حذف الوصفة القديمة (إن وُجدت) ⇒ إدراج الجديدة.
 * تُستدعى من:
 *   - `createProduct` عند حفظ منتج بـ isBundle=true (bundleVariantId = المتغيّر الوحيد للمنتج).
 *   - راوتر `bundles.setComponents` عند تعديل وصفة بكج قائم.
 * على المستدعي فتح `withTx` — هذه الدالة لا تفتح معاملتها.
 */
export async function replaceBundleComponents(
  tx: Tx,
  bundleVariantId: number,
  raw: BundleComponentInput[]
): Promise<ValidatedComponent[]> {
  // احترازي: تأكيد أن bundleVariantId ينتمي لمنتج isBundle=true — يمنع الكتابة على متغيّر عادي بالخطأ.
  const parent = await tx
    .select({ isBundle: products.isBundle, variantActive: productVariants.isActive })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(eq(productVariants.id, bundleVariantId))
    .limit(1);
  if (!parent[0]) {
    throw new TRPCError({ code: "NOT_FOUND", message: "متغيّر البكج غير موجود" });
  }
  if (!parent[0].isBundle) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "هذا المتغيّر لا ينتمي لمنتج بكج" });
  }

  const validated = await validateBundleComponents(tx, bundleVariantId, raw);

  // حذف ثم إدراج — أبسط وأسلم من مطابقة الأسطر (الوصفة صغيرة عادةً — ≤٢٠ صفّاً).
  await tx.delete(bundleComponents).where(eq(bundleComponents.bundleVariantId, bundleVariantId));
  for (const v of validated) {
    await tx.insert(bundleComponents).values({
      bundleVariantId,
      componentVariantId: v.componentVariantId,
      componentBaseQuantity: v.componentBaseQuantity,
      componentUnitId: v.componentUnitId,
      sortOrder: v.sortOrder,
      notes: v.notes,
    });
  }
  return validated;
}

/**
 * قراءة وصفات مجموعة من البكجات دفعةً واحدة (نمط D1: لا N+1).
 * تعود Map<bundleVariantId, ComponentRow[]>. تُستعمَل في مسار البيع + شاشات العرض.
 */
export async function getBundleDefinitions(
  tx: Tx,
  bundleVariantIds: number[]
): Promise<Map<number, BundleComponentRow[]>> {
  const map = new Map<number, BundleComponentRow[]>();
  if (!bundleVariantIds.length) return map;
  const ids = Array.from(new Set(bundleVariantIds));
  const rows = await tx
    .select()
    .from(bundleComponents)
    .where(inArray(bundleComponents.bundleVariantId, ids));
  for (const r of rows) {
    const bid = Number(r.bundleVariantId);
    const list = map.get(bid) ?? [];
    list.push({
      id: Number(r.id),
      bundleVariantId: bid,
      componentVariantId: Number(r.componentVariantId),
      componentBaseQuantity: Number(r.componentBaseQuantity),
      componentUnitId: r.componentUnitId == null ? null : Number(r.componentUnitId),
      sortOrder: Number(r.sortOrder ?? 0),
      notes: r.notes,
    });
    map.set(bid, list);
  }
  // ترتيب داخل كل مجموعة بحسب sortOrder (استقرار العرض).
  Array.from(map.values()).forEach((list: BundleComponentRow[]) => list.sort((a, b) => a.sortOrder - b.sortOrder));
  return map;
}

/**
 * حساب تكلفة الوحدة الأساس للبكج لحظياً = Σ( componentCost × componentBaseQuantity ).
 * تُقرأ التكاليف الحيّة من `productVariants.costPrice` (WAVG) — عبر استعلامٍ واحد لكل المكوّنات.
 * تُستعمَل في مسار البيع كبديل لـ`snapshotUnitCost(v.costPrice)` للمتغيّرات المصنّفة BUNDLE.
 *
 * `defsByBundle`: نتيجة `getBundleDefinitions` — يُمرَّر لتفادي إعادة القراءة إن استُدعيت في مسار بيعٍ محمَّل.
 */
export async function computeBundleUnitCosts(
  tx: Tx,
  bundleVariantIds: number[],
  defsByBundle: Map<number, BundleComponentRow[]>
): Promise<Map<number, string>> {
  const costMap = new Map<number, string>();
  if (!bundleVariantIds.length) return costMap;

  // اجمع كل المكوّنات عبر كل البكجات كي نقرأ التكاليف بقراءة واحدة (D1 pattern).
  const componentIds = new Set<number>();
  for (const bid of bundleVariantIds) {
    const list = defsByBundle.get(bid) ?? [];
    for (const c of list) componentIds.add(c.componentVariantId);
  }
  if (!componentIds.size) {
    // بكجات بلا مكوّنات — نُرجع صفراً لكلٍّ (لن يبيعها validate، لكن نأمن ضدّ استعمال خاطئ).
    for (const bid of bundleVariantIds) costMap.set(bid, "0");
    return costMap;
  }
  const rows = await tx
    .select({ id: productVariants.id, costPrice: productVariants.costPrice })
    .from(productVariants)
    .where(inArray(productVariants.id, Array.from(componentIds)));
  const wavg = new Map<number, string>();
  for (const r of rows) wavg.set(Number(r.id), String(r.costPrice ?? "0"));

  for (const bid of bundleVariantIds) {
    const list = defsByBundle.get(bid) ?? [];
    let sum = new Decimal(0);
    for (const c of list) {
      const componentCost = money(wavg.get(c.componentVariantId) ?? "0");
      sum = sum.plus(componentCost.mul(c.componentBaseQuantity));
    }
    costMap.set(bid, toDbMoney(sum));
  }
  return costMap;
}
