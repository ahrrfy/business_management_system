/**
 * seedPrintPos — بذرة قسم الطباعة والاستنساخ (idempotent، مستقلّة عن seed.ts).
 * تُنشئ: ٥ فئات خدمات + مستهلكات (ورق/حبر…) كمنتجات مخزنية برصيد افتتاحي + خدمات الطباعة
 * (productType=PRINT_SERVICE بأسعار RETAIL) + وصفات تربط الخدمات المستهلِكة بموادها.
 *
 * التشغيل:  pnpm exec tsx server/seedPrintPos.ts   (أو أضِف سكربت seed:print)
 * الأسعار/الكلف تقريبية للعرض — يعدّلها المالك من شاشة المنتجات/التسعير لاحقاً.
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import {
  branches,
  categories,
  productPrices,
  productUnits,
  productVariants,
  products,
  productionRecipeLines,
  productionRecipes,
  users,
} from "../drizzle/schema";
import { getDb } from "./db";
import { setStock } from "./services/inventoryService";
import { PRINT_SERVICE_TYPE } from "./services/printSaleService";
import { withTx } from "./services/tx";

const insertId = (r: unknown): number => Number((r as any)[0]?.insertId ?? (r as any).insertId);

async function main() {
  const dbOrNull = getDb();
  if (!dbOrNull) throw new Error("DATABASE_URL is required to seed");
  const db = dbOrNull; // نوع غير قابل لـnull ⇒ صالح داخل الدوال المتداخلة (ensureCategory)

  const main = (await db.select().from(branches).where(eq(branches.code, "MAIN")).limit(1))[0];
  if (!main) throw new Error("الفرع الرئيسي MAIN غير موجود — شغّل pnpm seed أولاً");
  const mainId = Number(main.id);
  const admin = (await db.select().from(users).where(eq(users.role, "admin")).limit(1))[0];
  const adminId = admin ? Number(admin.id) : null;

  // ── فئات الخدمات الخمس (مبوّبة كتبويبات الشاشة) ──
  async function ensureCategory(name: string): Promise<number> {
    const ex = (await db.select().from(categories).where(eq(categories.name, name)).limit(1))[0];
    if (ex) return Number(ex.id);
    const r = await db.insert(categories).values({ name });
    return insertId(r);
  }
  const CAT = {
    copy: await ensureCategory("استنساخ وطباعة"),
    photo: await ensureCategory("طباعة صور"),
    eserv: await ensureCategory("خدمات إلكترونية"),
    design: await ensureCategory("تنضيد وتصميم"),
    finish: await ensureCategory("تغليف وإنهاء"),
  };
  const matCatId = await ensureCategory("مستهلكات الطباعة");

  // ── مستهلكات (ورق/حبر…) كمنتجات مخزنية برصيد افتتاحي — منتج عادي (productType=null) ──
  type Material = { sku: string; name: string; unit: string; cost: string; opening: number };
  const MATERIALS: Material[] = [
    { sku: "MAT-PAPER-A4", name: "ورق طباعة A4", unit: "ورقة", cost: "35", opening: 5000 },
    { sku: "MAT-PAPER-A3", name: "ورق طباعة A3", unit: "ورقة", cost: "70", opening: 3000 },
    { sku: "MAT-PHOTO", name: "ورق صور", unit: "ورقة", cost: "250", opening: 1000 },
    { sku: "MAT-PHOTO-A4", name: "ورق صور A4 لامع", unit: "ورقة", cost: "400", opening: 500 },
    { sku: "MAT-INK-BK", name: "حبر/تونر أسود", unit: "وحدة", cost: "20", opening: 4000 },
    { sku: "MAT-INK-CLR", name: "حبر/تونر ملوّن", unit: "وحدة", cost: "120", opening: 4000 },
    { sku: "MAT-LAM", name: "شريحة لامينيت A4", unit: "شريحة", cost: "200", opening: 800 },
    { sku: "MAT-BIND-WIRE", name: "سلك تجليد حلزوني", unit: "سلك", cost: "300", opening: 600 },
    { sku: "MAT-COVER", name: "غلاف تجليد شفاف", unit: "غلاف", cost: "150", opening: 600 },
  ];
  const matVarId = new Map<string, number>();
  for (const m of MATERIALS) {
    const ex = (await db.select().from(productVariants).where(eq(productVariants.sku, m.sku)).limit(1))[0];
    if (ex) { matVarId.set(m.sku, Number(ex.id)); continue; }
    const pr = await db.insert(products).values({ name: m.name, categoryId: matCatId });
    const productId = insertId(pr);
    const vr = await db.insert(productVariants).values({ productId, sku: m.sku, costPrice: m.cost, minStock: 100, reorderPoint: 200 });
    const variantId = insertId(vr);
    await db.insert(productUnits).values({ variantId, unitName: m.unit, conversionFactor: "1", isBaseUnit: true });
    if (m.opening > 0) {
      await withTx((tx) => setStock(tx, { variantId, branchId: mainId, targetQuantity: m.opening, referenceType: "OPENING", notes: "رصيد افتتاحي — مستهلكات الطباعة", createdBy: adminId ?? undefined }));
    }
    matVarId.set(m.sku, variantId);
  }

  // ── خدمات الطباعة (productType=PRINT_SERVICE) + سعر RETAIL + وصفة مواد اختيارية ──
  type Service = {
    sku: string; name: string; unit: string; price: string; categoryId: number;
    recipe?: Array<{ sku: string; qty: number }>;
  };
  const SERVICES: Service[] = [
    // استنساخ وطباعة
    { sku: "PSVC-CP-A4-BW", name: "تصوير A4 أبيض/أسود", unit: "ورقة", price: "250", categoryId: CAT.copy, recipe: [{ sku: "MAT-PAPER-A4", qty: 1 }, { sku: "MAT-INK-BK", qty: 1 }] },
    { sku: "PSVC-CP-A4-CLR", name: "تصوير A4 ملوّن", unit: "ورقة", price: "500", categoryId: CAT.copy, recipe: [{ sku: "MAT-PAPER-A4", qty: 1 }, { sku: "MAT-INK-CLR", qty: 1 }] },
    { sku: "PSVC-CP-A3-BW", name: "تصوير A3 أبيض/أسود", unit: "ورقة", price: "500", categoryId: CAT.copy, recipe: [{ sku: "MAT-PAPER-A3", qty: 1 }, { sku: "MAT-INK-BK", qty: 2 }] },
    { sku: "PSVC-CP-A3-CLR", name: "تصوير A3 ملوّن", unit: "ورقة", price: "1000", categoryId: CAT.copy, recipe: [{ sku: "MAT-PAPER-A3", qty: 1 }, { sku: "MAT-INK-CLR", qty: 2 }] },
    { sku: "PSVC-CP-WA-BW", name: "طباعة من واتساب/تلكرام", unit: "ورقة", price: "250", categoryId: CAT.copy, recipe: [{ sku: "MAT-PAPER-A4", qty: 1 }, { sku: "MAT-INK-BK", qty: 1 }] },
    { sku: "PSVC-CP-WA-CLR", name: "طباعة ملف ملوّن", unit: "ورقة", price: "500", categoryId: CAT.copy, recipe: [{ sku: "MAT-PAPER-A4", qty: 1 }, { sku: "MAT-INK-CLR", qty: 1 }] },
    // طباعة صور
    { sku: "PSVC-PH-ID", name: "صورة شخصية (٦ نسخ)", unit: "طقم", price: "3000", categoryId: CAT.photo, recipe: [{ sku: "MAT-PHOTO", qty: 1 }, { sku: "MAT-INK-CLR", qty: 2 }] },
    { sku: "PSVC-PH-DOC", name: "صورة معاملات رسمية", unit: "صورة", price: "1000", categoryId: CAT.photo, recipe: [{ sku: "MAT-PHOTO", qty: 1 }, { sku: "MAT-INK-CLR", qty: 1 }] },
    { sku: "PSVC-PH-10X15", name: "طباعة صورة ١٠×١٥", unit: "صورة", price: "1000", categoryId: CAT.photo, recipe: [{ sku: "MAT-PHOTO", qty: 1 }, { sku: "MAT-INK-CLR", qty: 1 }] },
    { sku: "PSVC-PH-A4", name: "طباعة صورة A4 لامعة", unit: "صورة", price: "2000", categoryId: CAT.photo, recipe: [{ sku: "MAT-PHOTO-A4", qty: 1 }, { sku: "MAT-INK-CLR", qty: 2 }] },
    // خدمات إلكترونية (بلا مواد)
    { sku: "PSVC-ES-FORM", name: "تقديم استمارة إلكترونية", unit: "خدمة", price: "5000", categoryId: CAT.eserv },
    { sku: "PSVC-ES-BOOK", name: "حجز إلكتروني", unit: "خدمة", price: "5000", categoryId: CAT.eserv },
    { sku: "PSVC-ES-UPLOAD", name: "تدقيق ورفع مستند", unit: "خدمة", price: "3000", categoryId: CAT.eserv },
    { sku: "PSVC-ES-PAY", name: "دفع فاتورة/تسديد", unit: "خدمة", price: "2000", categoryId: CAT.eserv },
    // تنضيد وتصميم (بلا مواد؛ إكسل/تصميم سعرهما يدوي)
    { sku: "PSVC-DS-TYPE", name: "تفريغ خط يد ← وورد", unit: "صفحة", price: "1000", categoryId: CAT.design },
    { sku: "PSVC-DS-EXCEL", name: "جدول إكسل", unit: "خدمة", price: "3000", categoryId: CAT.design },
    { sku: "PSVC-DS-DESIGN", name: "تصميم مطبوعة", unit: "تصميم", price: "10000", categoryId: CAT.design },
    { sku: "PSVC-DS-RESEARCH", name: "تنضيد بحث/تقرير", unit: "صفحة", price: "750", categoryId: CAT.design },
    // تغليف وإنهاء
    { sku: "PSVC-FN-LAM", name: "تغليف حراري A4 (لامينيت)", unit: "ورقة", price: "1000", categoryId: CAT.finish, recipe: [{ sku: "MAT-LAM", qty: 1 }] },
    { sku: "PSVC-FN-BIND", name: "تجليد حلزوني", unit: "نسخة", price: "2000", categoryId: CAT.finish, recipe: [{ sku: "MAT-BIND-WIRE", qty: 1 }, { sku: "MAT-COVER", qty: 1 }] },
    { sku: "PSVC-FN-CUT", name: "قص / تقطيع", unit: "عملية", price: "250", categoryId: CAT.finish },
  ];

  let created = 0;
  for (const s of SERVICES) {
    let variantId: number;
    let productUnitId: number;
    const exVar = (await db.select().from(productVariants).where(eq(productVariants.sku, s.sku)).limit(1))[0];
    if (exVar) {
      variantId = Number(exVar.id);
      const exUnit = (await db.select().from(productUnits).where(eq(productUnits.variantId, variantId)).limit(1))[0];
      productUnitId = Number(exUnit.id);
    } else {
      const pr = await db.insert(products).values({ name: s.name, productType: PRINT_SERVICE_TYPE, categoryId: s.categoryId });
      const productId = insertId(pr);
      const vr = await db.insert(productVariants).values({ productId, sku: s.sku, costPrice: "0" });
      variantId = insertId(vr);
      const ur = await db.insert(productUnits).values({ variantId, unitName: s.unit, conversionFactor: "1", isBaseUnit: true });
      productUnitId = insertId(ur);
      await db.insert(productPrices).values({ productUnitId, priceTier: "RETAIL", price: s.price });
      created++;
    }
    // الوصفة (idempotent بالاسم الفريد) — اسم مميّز بالـSKU كي لا يصطدم بوصفات الإنتاج.
    if (s.recipe?.length) {
      const recipeName = `[طباعة] ${s.name} (${s.sku})`;
      const exRec = (await db.select().from(productionRecipes).where(eq(productionRecipes.name, recipeName)).limit(1))[0];
      if (!exRec) {
        const rr = await db.insert(productionRecipes).values({
          name: recipeName, outputVariantId: variantId, outputProductUnitId: productUnitId,
          laborPerOutputBase: "0", wasteStdPct: "0", isActive: true, createdBy: adminId ?? undefined,
        });
        const recipeId = insertId(rr);
        for (const rl of s.recipe) {
          const inVar = matVarId.get(rl.sku);
          if (inVar == null) throw new Error(`المادة ${rl.sku} غير مبذورة`);
          await db.insert(productionRecipeLines).values({ recipeId, inputVariantId: inVar, qtyPerOutputBase: String(rl.qty) });
        }
      }
    }
  }

  console.log(`✓ بذرة الطباعة: ${MATERIALS.length} مادة + ${SERVICES.length} خدمة (${created} جديدة) + وصفات. الفرع MAIN #${mainId}.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("seedPrintPos failed:", e);
    process.exit(1);
  });
