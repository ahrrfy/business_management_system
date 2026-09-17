import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { asc, inArray } from "drizzle-orm";

import { productVariants, products } from "../../../drizzle/schema";
import type { Tx } from "../../db";

export interface StockedOwnedMaterial {
  id: number;
  name: string;
  costPrice: string;
}

export interface StockedOwnedMaterialOptions {
  /**
   * يسمح بالخمول فقط لعكس استهلاك تاريخي؛ حراس service/bundle/consignment تبقى صارمة.
   */
  allowInactiveVariantIds?: readonly number[];
}

/**
 * مواد الوصفات وأوامر الشغل يجب أن تكون مخزوناً مملوكاً فعلياً.
 *
 * إعادة التحقق وقت الاستهلاك مقصودة: قد تتغير حالة المنتج بعد تعريف الوصفة، ولا يجوز عندها
 * ترحيل COGS مقابل حركة no-op لخدمة، أو استهلاك بكج بلا رصيد ذاتي، أو أصل أمانة كأنه ملكنا.
 */
export async function assertStockedOwnedMaterials(
  tx: Tx,
  variantIds: readonly number[],
  context = "المادة",
  options: StockedOwnedMaterialOptions = {},
): Promise<Map<number, StockedOwnedMaterial>> {
  const ids = Array.from(new Set(variantIds.map(Number))).sort((a, b) => a - b);
  if (!ids.length) return new Map();
  const allowInactive = new Set(
    (options.allowInactiveVariantIds ?? []).map(Number),
  );

  // قفل الكتالوج الحاكم: products أولاً ثم productVariants، وكلاهما تصاعدي.
  // القراءة التمهيدية لا تقرر الأهلية؛ تستخرج الربط فقط، ثم نطابقه بعد current reads.
  const refs = await tx
    .select({
      id: productVariants.id,
      productId: productVariants.productId,
    })
    .from(productVariants)
    .where(inArray(productVariants.id, ids))
    .orderBy(asc(productVariants.id));
  const refByVariant = new Map(
    refs.map((row) => [Number(row.id), Number(row.productId)]),
  );
  const missingBeforeLock = ids.filter((id) => !refByVariant.has(id));
  if (missingBeforeLock.length) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: `تعذّر العثور على ${context}`,
        why: `المعرّفات غير موجودة: ${missingBeforeLock.map((id) => `#${id}`).join("، ")}`,
        doThis: "حدّث الوصفة واختر مواد موجودة ثم أعد المحاولة",
      }),
    });
  }

  const productIds = Array.from(new Set(refByVariant.values())).sort(
    (a, b) => a - b,
  );
  const lockedProducts = await tx
    .select({
      id: products.id,
      name: products.name,
      isActive: products.isActive,
      isService: products.isService,
      isBundle: products.isBundle,
      isConsignment: products.isConsignment,
    })
    .from(products)
    .where(inArray(products.id, productIds))
    .orderBy(asc(products.id))
    .for("update");
  const productById = new Map(
    lockedProducts.map((product) => [Number(product.id), product]),
  );

  const lockedVariants = await tx
    .select({
      id: productVariants.id,
      productId: productVariants.productId,
      isActive: productVariants.isActive,
      costPrice: productVariants.costPrice,
    })
    .from(productVariants)
    .where(inArray(productVariants.id, ids))
    .orderBy(asc(productVariants.id))
    .for("update");
  const variantById = new Map(
    lockedVariants.map((variant) => [Number(variant.id), variant]),
  );

  const byId = new Map<number, StockedOwnedMaterial>();
  for (const id of ids) {
    const variant = variantById.get(id);
    if (!variant) continue;
    const expectedProductId = refByVariant.get(id)!;
    const actualProductId = Number(variant.productId);
    if (actualProductId !== expectedProductId) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: `تغيّر ربط ${context} #${id} أثناء التحقق`,
          why: "نُقل المتغيّر إلى منتج آخر قبل اكتمال أقفال الكتالوج",
          doThis: "حدّث الصفحة ثم أعد اختيار المادة",
        }),
      });
    }
    const product = productById.get(actualProductId);
    if (!product) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: `تعذّر تثبيت ${context} #${id}`,
          why: "لم يعد المنتج المرتبط مطابقاً لنطاق الأقفال",
          doThis: "حدّث الصفحة ثم أعد اختيار المادة",
        }),
      });
    }
    const name = product.name || `#${id}`;
    // NULL في قواعد قديمة لا يُعدّ تفعيلًا؛ الفشل المغلق يمنع مادة غير مؤكدة الحالة.
    if (
      (variant.isActive !== true || product.isActive !== true) &&
      !allowInactive.has(id)
    ) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: `تعذّر استهلاك ${context} «${name}»`,
          why: "المنتج أو متغيّره معطّل",
          doThis: "فعّل المنتج ومتغيّره أو استبدل المادة في الوصفة",
        }),
      });
    }
    if (product.isService) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: `${context} «${name}» ليست مادة مخزنية`,
          why: "الصنف مصنّف كخدمة بلا رصيد مخزون",
          doThis: "اختر صنفاً مخزنياً مملوكاً كمادة خام",
        }),
      });
    }
    if (product.isBundle) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: `${context} «${name}» ليست مادة مخزنية مباشرة`,
          why: "الصنف بكج ورصيده مستمد من مكوّناته",
          doThis: "استخدم المكوّن المخزني داخل الوصفة بدلاً من البكج",
        }),
      });
    }
    if (product.isConsignment) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: `تعذّر استهلاك ${context} «${name}»`,
          why: "الصنف بضاعة أمانة وليست أصلاً مملوكاً للمنشأة",
          doThis: "استخدم مادة مملوكة أو سوِّ وضع الأمانة أولاً",
        }),
      });
    }
    byId.set(id, {
      id,
      name,
      costPrice: String(variant.costPrice ?? "0"),
    });
  }
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: `تعذّر العثور على ${context}`,
        why: `المعرّفات غير موجودة: ${missing.map((id) => `#${id}`).join("، ")}`,
        doThis: "حدّث الوصفة واختر مواد موجودة ثم أعد المحاولة",
      }),
    });
  }
  return byId;
}
