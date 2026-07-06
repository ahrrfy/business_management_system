// بند 12ب (٧/٧): التسعير التعاقدي الخاص بعميل (عقود الدوائر الحكومية).
// سعر تعاقدي نشط لوحدة منتج يتقدّم على سعر الفئة (RETAIL/WHOLESALE/GOVERNMENT) في **نقطتَي**
// العرض (catalog/pos.ts ⇒ شارة isContractPrice في POS) والفرض (sale/create.ts ⇒ اختيار السعر
// عند غياب unitPriceOverride صريح) — النقطتان تستهلكان `resolveContractPrices` نفسها = مصدر
// حقيقة واحد، فلا ينجرف المعروض عن المفروض.
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  customerContractPrices,
  customers,
  products,
  productUnits,
  productVariants,
} from "../../drizzle/schema";
import type { DB, Tx } from "../db";
import { money, toDbMoney } from "./money";
import { requireDb, withTx, type Actor } from "./tx";

/** سطر عرضي لشاشة الإدارة: السعر التعاقدي + هوية (المنتج × المتغيّر × الوحدة) للقراءة البشرية. */
export interface ContractPriceListRow {
  id: number;
  customerId: number;
  productUnitId: number;
  price: string;
  isActive: boolean;
  note: string | null;
  updatedAt: Date;
  productId: number;
  productName: string;
  variantName: string | null;
  color: string | null;
  size: string | null;
  sku: string;
  unitName: string;
  /** سعر الفئة الحالي لفئة العميل الافتراضية — يُجلَب في الراوتر/الشاشة عند الحاجة، ليس هنا. */
}

/** كل الأسعار التعاقدية لعميل (النشطة والمعطَّلة — شاشة الإدارة تحتاج كليهما لإعادة التفعيل). */
export async function listContractPricesForCustomer(customerId: number): Promise<ContractPriceListRow[]> {
  const db = requireDb();
  const rows = await db
    .select({
      id: customerContractPrices.id,
      customerId: customerContractPrices.customerId,
      productUnitId: customerContractPrices.productUnitId,
      price: customerContractPrices.price,
      isActive: customerContractPrices.isActive,
      note: customerContractPrices.note,
      updatedAt: customerContractPrices.updatedAt,
      productId: products.id,
      productName: products.name,
      variantName: productVariants.variantName,
      color: productVariants.color,
      size: productVariants.size,
      sku: productVariants.sku,
      unitName: productUnits.unitName,
    })
    .from(customerContractPrices)
    .innerJoin(productUnits, eq(customerContractPrices.productUnitId, productUnits.id))
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(eq(customerContractPrices.customerId, customerId))
    .orderBy(desc(customerContractPrices.updatedAt));
  return rows.map((r) => ({
    ...r,
    id: Number(r.id),
    customerId: Number(r.customerId),
    productUnitId: Number(r.productUnitId),
    productId: Number(r.productId),
    isActive: !!r.isActive,
  }));
}

export interface UpsertContractPriceInput {
  customerId: number;
  productUnitId: number;
  /** سعر > 0 بدقة 2dp (moneyString في الراوتر). */
  price: string;
  note?: string | null;
}

/**
 * إضافة/تحديث سعر تعاقدي — UNIQUE (customerId × productUnitId) يحسم السباق بنيوياً:
 * `onDuplicateKeyUpdate` ذرّي على مستوى MySQL ⇒ متسابقان متزامنان يلتقيان على **صف واحد**
 * (الأخير يكتب سعره) ولا يظهر صف ثانٍ أبداً — لا حاجة لنمط isDupEntry/إعادة محاولة.
 * إعادة إدخال سعر لوحدة معطَّلة التعاقد تعيد تفعيلها (isActive=true) — هذا هو القصد الإداري.
 */
export async function upsertContractPrice(
  input: UpsertContractPriceInput,
  actor: Actor
): Promise<{ id: number; updated: boolean }> {
  const priceD = money(input.price);
  if (!priceD.gt(0)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "السعر التعاقدي يجب أن يكون أكبر من صفر" });
  }
  const priceDb = toDbMoney(priceD);
  return withTx(async (tx) => {
    const cust = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.id, input.customerId))
      .limit(1);
    if (!cust[0]) throw new TRPCError({ code: "NOT_FOUND", message: "العميل غير موجود" });

    // وحدة المنتج يجب أن تكون موجودة وسلسلتها (وحدة/متغيّر/منتج) نشطة — لا عقد على صنف ميت.
    const unit = await tx
      .select({
        id: productUnits.id,
        unitActive: productUnits.isActive,
        variantActive: productVariants.isActive,
        productActive: products.isActive,
      })
      .from(productUnits)
      .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(eq(productUnits.id, input.productUnitId))
      .limit(1);
    if (!unit[0]) throw new TRPCError({ code: "NOT_FOUND", message: "وحدة المنتج غير موجودة" });
    if (unit[0].unitActive === false || unit[0].variantActive === false || unit[0].productActive === false) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "وحدة المنتج معطَّلة — لا يمكن ربط سعر تعاقدي بها" });
    }

    const existing = await tx
      .select({ id: customerContractPrices.id })
      .from(customerContractPrices)
      .where(
        and(
          eq(customerContractPrices.customerId, input.customerId),
          eq(customerContractPrices.productUnitId, input.productUnitId)
        )
      )
      .limit(1);

    await tx
      .insert(customerContractPrices)
      .values({
        customerId: input.customerId,
        productUnitId: input.productUnitId,
        price: priceDb,
        isActive: true,
        note: input.note?.trim() || null,
        createdBy: actor.userId,
      })
      .onDuplicateKeyUpdate({
        set: { price: priceDb, isActive: true, note: input.note?.trim() || null },
      });

    // نُعيد id الصف الفعلي (الموجود عند التحديث، أو المُدرَج حديثاً).
    const after = await tx
      .select({ id: customerContractPrices.id })
      .from(customerContractPrices)
      .where(
        and(
          eq(customerContractPrices.customerId, input.customerId),
          eq(customerContractPrices.productUnitId, input.productUnitId)
        )
      )
      .limit(1);
    return { id: Number(after[0]!.id), updated: !!existing[0] };
  });
}

/** تعطيل/تفعيل سعر تعاقدي — المعطَّل يبقى ظاهراً في شاشة الإدارة ولا يسري على البيع. */
export async function setContractPriceActive(id: number, isActive: boolean): Promise<{ id: number }> {
  const db = requireDb();
  const row = await db
    .select({ id: customerContractPrices.id })
    .from(customerContractPrices)
    .where(eq(customerContractPrices.id, id))
    .limit(1);
  if (!row[0]) throw new TRPCError({ code: "NOT_FOUND", message: "السعر التعاقدي غير موجود" });
  await db.update(customerContractPrices).set({ isActive }).where(eq(customerContractPrices.id, id));
  return { id };
}

/** حذف صلب لسعر تعاقدي — لا مرجعية تاريخية عليه (بنود الفواتير تُخزّن unitPrice لقطةً مستقلة). */
export async function removeContractPrice(id: number): Promise<{ id: number }> {
  const db = requireDb();
  const row = await db
    .select({ id: customerContractPrices.id })
    .from(customerContractPrices)
    .where(eq(customerContractPrices.id, id))
    .limit(1);
  if (!row[0]) throw new TRPCError({ code: "NOT_FOUND", message: "السعر التعاقدي غير موجود" });
  await db.delete(customerContractPrices).where(eq(customerContractPrices.id, id));
  return { id };
}

/**
 * حلّ الأسعار التعاقدية **النشطة** لعميل على مجموعة وحدات — استعلام واحد رخيص (inArray على
 * فهرس idx_contract_customer) ⇒ Map<productUnitId, price>. تقبل Tx (فرض البيع داخل المعاملة)
 * أو DB (عرض POS خارجها) — نفس الدالة في النقطتين = لا انجراف بين العرض والفرض.
 */
export async function resolveContractPrices(
  executor: Tx | DB,
  customerId: number,
  productUnitIds: number[]
): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (!productUnitIds.length) return map;
  const uniqueIds = Array.from(new Set(productUnitIds));
  const rows = await executor
    .select({
      productUnitId: customerContractPrices.productUnitId,
      price: customerContractPrices.price,
    })
    .from(customerContractPrices)
    .where(
      and(
        eq(customerContractPrices.customerId, customerId),
        eq(customerContractPrices.isActive, true),
        inArray(customerContractPrices.productUnitId, uniqueIds)
      )
    );
  for (const r of rows) map.set(Number(r.productUnitId), String(r.price));
  return map;
}
