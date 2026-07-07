// تحديث منتج قائم: ترويسة + متغيّر(ات) + وحدات + أسعار في معاملة واحدة.
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { productPrices, productUnits, productVariants, products } from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { toDbMoney } from "../money";
import type { PriceTier } from "../pricing";
import { type Actor, withTx } from "../tx";

export interface UpdateProductUnitInput {
  id?: number; // existing unit id (omit for new)
  unitName: string;
  conversionFactor: string;
  barcode?: string | null;
  isBaseUnit?: boolean;
  prices?: Array<{ priceTier: PriceTier; price: string }>;
}

export interface UpdateProductVariantInput {
  id: number; // variants are not added/removed via edit for now
  sku: string;
  variantName?: string | null;
  color?: string | null;
  size?: string | null;
  costPrice: string;
  units: UpdateProductUnitInput[];
}

export interface UpdateProductInput {
  productId: number;
  name: string;
  categoryId?: number | null;
  isCustomizable?: boolean;
  isActive?: boolean;
  variants: UpdateProductVariantInput[];
}

/** Update a product header + its variant(s) + units + prices in one transaction.
 *  - Existing units (by id) are UPDATEd and their prices replaced.
 *  - New units (no id) are INSERTed with their prices.
 *  - Units present in DB but absent from input are soft-deactivated (isActive=false). */
export async function updateProduct(input: UpdateProductInput, _actor: Actor) {
  return withTx(async (tx) => {
    if (!input.name.trim()) throw new TRPCError({ code: "BAD_REQUEST", message: "اسم المنتج مطلوب" });
    if (!input.variants.length) throw new TRPCError({ code: "BAD_REQUEST", message: "المنتج يحتاج متغيّراً واحداً على الأقل" });

    const p = (await tx.select().from(products).where(eq(products.id, input.productId)).limit(1))[0];
    if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "المنتج غير موجود" });

    // gstack B12 (٧/٧/٢٦): مرآة قيود إنشاء البكج على مسار التعديل — كانت غائبة فيسمح تعديل بكج بإضافة
    // متغيّر ثانٍ (متغيّر «شبح» بلا وصفة، مصنَّف BUNDLE، يفشل عند البيع بـPRECONDITION_FAILED) أو
    // بتعطيل وحدة الأساس. نفرض هنا: بكج = متغيّر واحد فقط + وحدة أساس واحدة فقط.
    if (p.isBundle) {
      if (input.variants.length !== 1) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "البكج لا يقبل إلّا متغيّراً واحداً — احذف المتغيّرات الإضافية" });
      }
      const baseUnitsCount = input.variants[0].units.filter((u) => u.isBaseUnit).length;
      if (baseUnitsCount !== 1) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "البكج لا يقبل إلّا وحدة أساس واحدة" });
      }
    }

    await tx
      .update(products)
      .set({
        name: input.name.trim(),
        categoryId: input.categoryId ?? null,
        isCustomizable: input.isCustomizable ?? !!p.isCustomizable,
        ...(input.isActive != null ? { isActive: input.isActive } : {}),
      })
      .where(eq(products.id, input.productId));

    for (const v of input.variants) {
      if (!v.units.some((u) => u.isBaseUnit))
        throw new TRPCError({ code: "BAD_REQUEST", message: `المتغيّر ${v.sku} يحتاج وحدة أساس واحدة` });
      if (v.units.filter((u) => u.isBaseUnit).length > 1)
        throw new TRPCError({ code: "BAD_REQUEST", message: `المتغيّر ${v.sku} يحتاج وحدة أساس واحدة فقط` });

      // Variant header.
      await tx
        .update(productVariants)
        .set({
          sku: v.sku,
          variantName: v.variantName ?? null,
          color: v.color ?? null,
          size: v.size ?? null,
          costPrice: toDbMoney(v.costPrice),
        })
        .where(eq(productVariants.id, v.id));

      // Existing units for this variant.
      const existing = await tx.select().from(productUnits).where(eq(productUnits.variantId, v.id));
      const keepIds = new Set<number>();

      for (const u of v.units) {
        let productUnitId: number;
        if (u.id) {
          productUnitId = u.id;
          await tx
            .update(productUnits)
            .set({
              unitName: u.unitName,
              conversionFactor: u.conversionFactor,
              barcode: u.barcode ?? null,
              isBaseUnit: !!u.isBaseUnit,
              isActive: true,
            })
            .where(eq(productUnits.id, u.id));
          // Replace prices for this unit.
          await tx.delete(productPrices).where(eq(productPrices.productUnitId, u.id));
        } else {
          const uRes = await tx.insert(productUnits).values({
            variantId: v.id,
            unitName: u.unitName,
            conversionFactor: u.conversionFactor,
            barcode: u.barcode ?? null,
            isBaseUnit: !!u.isBaseUnit,
          });
          productUnitId = extractInsertId(uRes);
        }
        keepIds.add(productUnitId);
        for (const pr of u.prices ?? []) {
          await tx
            .insert(productPrices)
            .values({ productUnitId, priceTier: pr.priceTier, price: toDbMoney(pr.price) });
        }
      }

      // Soft-deactivate units that are no longer present (preserve history).
      for (const existing0 of existing) {
        if (!keepIds.has(Number(existing0.id))) {
          await tx.update(productUnits).set({ isActive: false }).where(eq(productUnits.id, Number(existing0.id)));
        }
      }
    }

    return { productId: input.productId };
  });
}
