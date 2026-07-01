// بحث البيانات الرئيسية العابرة للفروع: المنتجات (+الباركود) والعملاء والموردون.
import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import { customers, productUnits, productVariants, products, suppliers } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { escLike } from "../../lib/sqlLike";
import type { SearchKind, SearchResult } from "./types";

// ────────────────────────────── المنتجات + الوحدات + الباركود ──────────────────────────────

async function searchProducts(
  db: NonNullable<ReturnType<typeof getDb>>,
  kind: SearchKind,
  query: string,
  limit: number,
): Promise<SearchResult[]> {
  // الباركود: تطابق دقيق على productUnits.barcode (UNIQUE) ⇒ أعلى رتبة (rank=0).
  if (kind === "BARCODE") {
    const rows = await db
      .select({
        unitId: productUnits.id,
        variantId: productVariants.id,
        productId: products.id,
        productName: products.name,
        variantName: productVariants.variantName,
        sku: productVariants.sku,
        unitName: productUnits.unitName,
        barcode: productUnits.barcode,
      })
      .from(productUnits)
      .innerJoin(productVariants, eq(productVariants.id, productUnits.variantId))
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(and(eq(productUnits.barcode, query), eq(products.isActive, true)))
      .limit(limit);

    return rows.map((r) => ({
      type: "PRODUCT" as const,
      id: r.productId,
      title: r.variantName ? `${r.productName} — ${r.variantName}` : r.productName,
      subtitle: `${r.sku} · ${r.unitName}`,
      meta: r.barcode,
      // وجهة الـhub مع q (يُحمِّل الصفّ في القائمة الخادمية) + focus (يُبرزه ويمرّر إليه).
      route: `/inventory?tab=products&q=${encodeURIComponent(query)}&focus=${r.productId}`,
      rank: 0,
    }));
  }
  if (kind === "PHONE" || kind === "DOC_NUMBER") return []; // المنتجات لا تُطابِق هاتفاً ولا رقم وثيقة

  const like_ = `%${escLike(query)}%`;
  const rows = await db
    .select({
      id: products.id,
      name: products.name,
      sku: productVariants.sku,
    })
    .from(products)
    .leftJoin(productVariants, eq(productVariants.productId, products.id))
    .where(and(
      eq(products.isActive, true),
      or(sql`${products.name} LIKE ${like_} ESCAPE '!'`, sql`${productVariants.sku} LIKE ${like_} ESCAPE '!'`),
    ))
    .orderBy(asc(products.name), desc(products.id))
    .limit(limit);

  // dedupe بـid (المنتج له عدة متغيّرات).
  const seen = new Set<number>();
  const out: SearchResult[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({
      type: "PRODUCT",
      id: r.id,
      title: r.name,
      subtitle: r.sku ?? null,
      meta: null,
      route: `/inventory?tab=products&q=${encodeURIComponent(query)}&focus=${r.id}`,
      rank: r.name.toLowerCase().startsWith(query.toLowerCase()) ? 1 : 2,
    });
  }
  return out;
}

// ────────────────────────────── العملاء ──────────────────────────────

async function searchCustomers(
  db: NonNullable<ReturnType<typeof getDb>>,
  kind: SearchKind,
  query: string,
  limit: number,
): Promise<SearchResult[]> {
  if (kind === "BARCODE") return []; // العملاء بلا باركود
  if (kind === "DOC_NUMBER" && !/^\d+$/.test(query)) return []; // مُعرّف وثيقة كامل ⇒ ليس عميلاً

  const like_ = `%${escLike(query)}%`;
  const conds = [
    eq(customers.isActive, true),
    or(
      sql`${customers.name} LIKE ${like_} ESCAPE '!'`,
      sql`${customers.phone} LIKE ${like_} ESCAPE '!'`,
      sql`${customers.phone2} LIKE ${like_} ESCAPE '!'`,
      sql`${customers.phone3} LIKE ${like_} ESCAPE '!'`,
      sql`${customers.whatsapp} LIKE ${like_} ESCAPE '!'`,
      sql`${customers.legacyCode} LIKE ${like_} ESCAPE '!'`,
    ),
  ];
  const rows = await db
    .select({
      id: customers.id,
      name: customers.name,
      phone: customers.phone,
      city: customers.city,
      legacyCode: customers.legacyCode,
      balance: customers.currentBalance,
    })
    .from(customers)
    .where(and(...conds))
    .orderBy(asc(customers.name), desc(customers.id))
    .limit(limit);

  return rows.map((r) => ({
    type: "CUSTOMER" as const,
    id: r.id,
    title: r.name,
    subtitle: [r.phone, r.city].filter(Boolean).join(" · ") || null,
    meta: r.legacyCode ? `قديم: ${r.legacyCode}` : null,
    route: `/customers?tab=list&q=${encodeURIComponent(query)}&focus=${r.id}`,
    rank: r.name.toLowerCase().startsWith(query.toLowerCase()) ? 1 : 2,
  }));
}

// ────────────────────────────── الموردين ──────────────────────────────

async function searchSuppliers(
  db: NonNullable<ReturnType<typeof getDb>>,
  kind: SearchKind,
  query: string,
  limit: number,
): Promise<SearchResult[]> {
  if (kind === "BARCODE") return [];
  if (kind === "DOC_NUMBER" && !/^\d+$/.test(query)) return [];

  const like_ = `%${escLike(query)}%`;
  const rows = await db
    .select({
      id: suppliers.id,
      name: suppliers.name,
      phone: suppliers.phone,
      city: suppliers.city,
      legacyCode: suppliers.legacyCode,
    })
    .from(suppliers)
    .where(and(
      eq(suppliers.isActive, true),
      or(
        sql`${suppliers.name} LIKE ${like_} ESCAPE '!'`,
        sql`${suppliers.phone} LIKE ${like_} ESCAPE '!'`,
        sql`${suppliers.phone2} LIKE ${like_} ESCAPE '!'`,
        sql`${suppliers.phone3} LIKE ${like_} ESCAPE '!'`,
        sql`${suppliers.legacyCode} LIKE ${like_} ESCAPE '!'`,
      ),
    ))
    .orderBy(asc(suppliers.name), desc(suppliers.id))
    .limit(limit);

  return rows.map((r) => ({
    type: "SUPPLIER" as const,
    id: r.id,
    title: r.name,
    subtitle: [r.phone, r.city].filter(Boolean).join(" · ") || null,
    meta: r.legacyCode ? `قديم: ${r.legacyCode}` : null,
    route: `/suppliers/${r.id}/edit`,
    rank: r.name.toLowerCase().startsWith(query.toLowerCase()) ? 1 : 2,
  }));
}


export { searchProducts, searchCustomers, searchSuppliers };
