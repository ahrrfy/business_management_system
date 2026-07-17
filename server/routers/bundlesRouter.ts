// راوتر البكج (باندل/بكج) — قراءة الوصفة الحاليّة + تعديلها (managerProcedure).
//
// نطاق هذا الراوتر: تعديل مكوّنات بكجٍ **موجود** (product.isBundle=true) بعد إنشائه.
// إنشاء المنتج البكج نفسه (مع وصفته الأولى) يمرّ عبر `catalog.createProduct` — نمط منسجم مع البقية.
//
// RBAC: نطاق `products` (نفس بوّابة إضافة/تعديل المنتجات) — المدير فقط يعدّل بكجاً، والقارئ يشاهد الوصفة.
// Idempotency: التعديل يستبدل الوصفة كاملةً — لا حاجة لمفتاح idempotency (نمط PUT بلا مضاعفات).
import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { bundleComponents, invoiceItems, products, productUnits, productVariants } from "../../drizzle/schema";
import { logAudit } from "../services/auditService";
import { resolveBarcodeOwner } from "../services/catalog/barcodeAliases";
import { getBundleDefinitions, replaceBundleComponents } from "../services/bundleService";
import { getDb } from "../db";
import { withTx } from "../services/tx";
import { canSeeCostForUser, productsManagerProcedure, productsReadProcedure, router } from "../trpc";

const componentInputSchema = z.object({
  componentVariantId: z.number().int().positive(),
  componentBaseQuantity: z.number().int().positive(),
  componentUnitId: z.number().int().positive().nullish(),
  sortOrder: z.number().int().min(0).max(999).optional(),
  notes: z.string().max(500).nullish(),
});

export const bundlesRouter = router({
  /** بحث على المكوّنات المؤهّلة (سلعة نشطة غير بكج وغير خدمة) — يكشف التكلفة ⇒ productsManagerProcedure.
   *  يُستعمَل في شاشة إنشاء البكج + شاشة تعديل الوصفة كي يفلتر البكجات/الخدمات مبكّراً بدل رفضها بعد الإرسال.
   *  يقبل نصّاً حرّاً و/أو فئة — أحدهما إلزامي (لتفادي مسح جدول كامل بلا فلتر). */
  searchComponents: productsManagerProcedure
    .input(
      z.object({
        q: z.string().max(120).optional(),
        categoryId: z.number().int().positive().nullish(),
        limit: z.number().int().positive().max(50).default(20),
      }),
    )
    .query(async ({ input }) => {
      const db = getDb();
      if (!db) return { items: [] };
      const q = (input.q ?? "").trim();
      const hasQ = q.length >= 1;
      const hasCat = input.categoryId != null;
      if (!hasQ && !hasCat) return { items: [] };
      const term = `%${q}%`;
      const conds = [
        eq(products.isBundle, false),
        eq(products.isService, false),
        eq(products.isActive, true),
        eq(productVariants.isActive, true),
      ];
      if (hasCat) conds.push(eq(products.categoryId, Number(input.categoryId)));
      if (hasQ) conds.push(sql`(${products.name} LIKE ${term} OR ${productVariants.sku} LIKE ${term})`);
      const rows = await db
        .select({
          variantId: productVariants.id,
          productId: productVariants.productId,
          productName: products.name,
          sku: productVariants.sku,
          costPrice: productVariants.costPrice,
        })
        .from(productVariants)
        .innerJoin(products, eq(productVariants.productId, products.id))
        .where(and(...conds))
        .limit(input.limit);
      return {
        items: rows.map((r) => ({
          variantId: Number(r.variantId),
          productId: Number(r.productId),
          productName: r.productName,
          sku: r.sku,
          costPrice: String(r.costPrice ?? "0"),
        })),
      };
    }),

  /** بحث بمكوّنٍ عبر الباركود (لقارئ الباركود اليدوي). يمرّ على الأساسيّ والبديل معاً عبر
   *  `resolveBarcodeOwner`. يعيد المتغيّر إن كان مؤهّلاً (لا بكج/خدمة، نشط). */
  lookupComponentByBarcode: productsManagerProcedure
    .input(z.object({ barcode: z.string().min(1).max(64) }))
    .query(async ({ input }) => {
      const db = getDb();
      if (!db) return { item: null };
      const owner = await resolveBarcodeOwner(db, input.barcode);
      if (!owner) return { item: null };
      const rows = await db
        .select({
          variantId: productVariants.id,
          productId: productVariants.productId,
          productName: products.name,
          sku: productVariants.sku,
          costPrice: productVariants.costPrice,
        })
        .from(productUnits)
        .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
        .innerJoin(products, eq(productVariants.productId, products.id))
        .where(
          and(
            eq(productUnits.id, owner.productUnitId),
            eq(products.isBundle, false),
            eq(products.isService, false),
            eq(products.isActive, true),
            eq(productVariants.isActive, true),
          ),
        )
        .limit(1);
      if (!rows[0]) return { item: null };
      const r = rows[0];
      return {
        item: {
          variantId: Number(r.variantId),
          productId: Number(r.productId),
          productName: r.productName,
          sku: r.sku,
          costPrice: String(r.costPrice ?? "0"),
        },
      };
    }),

  /** قراءة وصفة بكج بمعرّف المتغيّر الأب. تُستعمَل في شاشة إدارة البكج + POS للعرض. */
  getComponents: productsReadProcedure
    .input(z.object({ bundleVariantId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) return { components: [] };
      // حجب التكلفة عن غير المخوَّل (تدقيق ١٧/٧): البوّابة READ فيصلها الكاشير عبر API مباشرة ⇒ كان
      // يقرأ تكلفة شراء أيّ بكج. نُبقي البوّابة READ (لا نكسر أيّ مستهلك) ونُقنّع componentCostPrice.
      const showCost = canSeeCostForUser(ctx.user);
      const parent = await db
        .select({ isBundle: products.isBundle, productId: productVariants.productId, productName: products.name })
        .from(productVariants)
        .innerJoin(products, eq(productVariants.productId, products.id))
        .where(eq(productVariants.id, input.bundleVariantId))
        .limit(1);
      if (!parent[0]) throw new TRPCError({ code: "NOT_FOUND", message: "المتغيّر غير موجود" });
      if (!parent[0].isBundle) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "هذا المتغيّر لا ينتمي لمنتج بكج" });
      }
      // إعادة استعمال getBundleDefinitions على tx افتراضي بلا معاملة (اختيار سريع بلا locks).
      // ندمج بيانات العرض (اسم المنتج + SKU + التكلفة الحيّة) في استعلام واحد بدل استعمال الخدمة (تُعيد الأسطر فقط).
      const rows = await db
        .select({
          componentVariantId: bundleComponents.componentVariantId,
          componentBaseQuantity: bundleComponents.componentBaseQuantity,
          componentUnitId: bundleComponents.componentUnitId,
          sortOrder: bundleComponents.sortOrder,
          notes: bundleComponents.notes,
          productName: products.name,
          sku: productVariants.sku,
          costPrice: productVariants.costPrice,
          isActive: productVariants.isActive,
        })
        .from(bundleComponents)
        .innerJoin(productVariants, eq(bundleComponents.componentVariantId, productVariants.id))
        .innerJoin(products, eq(productVariants.productId, products.id))
        .where(eq(bundleComponents.bundleVariantId, input.bundleVariantId));
      const components = rows
        .map((r) => ({
          componentVariantId: Number(r.componentVariantId),
          componentBaseQuantity: Number(r.componentBaseQuantity),
          componentUnitId: r.componentUnitId == null ? null : Number(r.componentUnitId),
          sortOrder: Number(r.sortOrder ?? 0),
          notes: r.notes,
          componentProductName: r.productName,
          componentSku: r.sku,
          componentCostPrice: showCost ? String(r.costPrice ?? "0") : "0",
          isActive: !!r.isActive,
        }))
        .sort((a, b) => a.sortOrder - b.sortOrder);
      return { bundleProductName: parent[0].productName, components };
    }),

  /** استبدال وصفة البكج كاملةً — ذرّي (delete-then-insert داخل معاملة). لا مفتاح idempotency (semantics PUT).
   *  ⚠️ ملاحظة حرجة: تعديل الوصفة يؤثّر على مرتجعات مستقبلية لفواتير سابقة (المرتجع يستعمل الوصفة الحالية).
   *  الواجهة تنبّه المدير قبل الحفظ بعدد الفواتير الحيّة القابلة للإرجاع التي تستعمل هذا البكج (via preview أدناه). */
  setComponents: productsManagerProcedure
    .input(
      z.object({
        bundleVariantId: z.number().int().positive(),
        components: z.array(componentInputSchema).min(1).max(50),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const validated = await withTx(async (tx) => {
        return replaceBundleComponents(tx, input.bundleVariantId, input.components);
      });
      await logAudit(ctx, {
        action: "bundle.setComponents",
        entityType: "bundle",
        entityId: input.bundleVariantId,
        newValue: {
          count: validated.length,
          components: validated.map((v) => ({ variantId: v.componentVariantId, qty: v.componentBaseQuantity })),
        },
      });
      return { ok: true, count: validated.length };
    }),

  /** معاينة قبل التعديل: يخبر المدير كم فاتورةً حيّةً (قابلة للإرجاع) تستعمل هذا البكج،
   *  ليقرّر بوعي أن تعديل الوصفة قد يؤثّر على مرتجعات لاحقة لتلك الفواتير. لا يكتب شيئاً. */
  previewImpact: productsReadProcedure
    .input(z.object({ bundleVariantId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const db = getDb();
      if (!db) return { affectedInvoiceLineCount: 0 };
      const rows = await db
        .select({ id: invoiceItems.id })
        .from(invoiceItems)
        .where(eq(invoiceItems.variantId, input.bundleVariantId));
      // «الحيّة القابلة للإرجاع» = التي `returnedBaseQuantity < baseQuantity`. القراءة كاملةً ثم فلترة
      // على الذاكرة (عدد بكجات مباعة غير مرتجعة عادة صغير).
      const all = await db
        .select({
          baseQuantity: invoiceItems.baseQuantity,
          returnedBaseQuantity: invoiceItems.returnedBaseQuantity,
        })
        .from(invoiceItems)
        .where(eq(invoiceItems.variantId, input.bundleVariantId));
      const affected = all.filter((r) => (r.returnedBaseQuantity ?? 0) < r.baseQuantity).length;
      return { affectedInvoiceLineCount: affected, totalInvoiceLineCount: rows.length };
    }),
});
