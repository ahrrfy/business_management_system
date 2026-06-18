/**
 * البحث الشامل الذرّي عبر كل وحدات النظام.
 *
 * نقطة دخول موحَّدة تستقبل استعلاماً نصيّاً (نص/باركود/رقم وثيقة/هاتف)
 * وتُرجع نتائج مُجمَّعة بالنوع، مع توجيه دقيق لمكانها في النظام.
 *
 * **تصنيف النمط (classifyQuery):**
 *  - BARCODE     : أرقام صرفة بطول ٨-١٤ (يطابق EAN-8/12/13/UPC-A + باركود داخلي).
 *  - DOC_NUMBER  : بادئة `INV-/QT-/PO-/WO-/SR-/PR-` أو رقم صرف قصير (≤٧ خانات).
 *  - PHONE       : يبدأ بـ`+` أو يطابق نمط هاتف (≥٧ خانات بعد التطبيع).
 *  - TEXT        : كل ما عداه — اسم/SKU/مدينة/ملاحظة.
 *
 * **RBAC (يتطابق مع trpc.ts):**
 *  - الكاشير: لا يرى الموردين، المشتريات، المصاريف (إدارة فقط) — تُحجب من النتائج.
 *  - عزل الفرع: الفواتير/عروض الأسعار/أوامر الشغل/المصاريف تُقيَّد بفرع المستخدم
 *    إن لم يكن admin/manager (يطابق نمط branchScopedProcedure).
 *  - البيانات الرئيسية (منتجات/عملاء/موردين) عابرة الفروع دائماً.
 *
 * **الأداء:** Promise.all يُشغّل كل الاستعلامات بالتوازي (مجموع زمن = أبطأ استعلام
 * لا مجموعها)، وكل استعلام محدود بـlimit ٥-٨ ⇒ مجموع نتائج ≤٦٤ صفّاً مهما كان النمط.
 */

import { and, asc, desc, eq, like, or, sql } from "drizzle-orm";
import {
  customers,
  expenses,
  invoices,
  productUnits,
  productVariants,
  products,
  purchaseOrders,
  quotations,
  suppliers,
  workOrders,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { escapeLike } from "../lib/sqlLike";

export type SearchEntityType =
  | "PRODUCT"
  | "INVOICE"
  | "QUOTATION"
  | "PURCHASE_ORDER"
  | "WORK_ORDER"
  | "CUSTOMER"
  | "SUPPLIER"
  | "EXPENSE";

export type SearchKind = "BARCODE" | "DOC_NUMBER" | "PHONE" | "TEXT";

export type SearchResult = {
  type: SearchEntityType;
  id: number;
  title: string;
  subtitle: string | null;
  meta: string | null;
  route: string;
  /** 0 = تطابق تامّ (باركود/رقم وثيقة)، 1+ = جزئي. أصغر = أقرب للبداية. */
  rank: number;
};

const DOC_PREFIX_RX = /^(INV|QT|PO|WO|SR|PR)[-\s]?/i;
const NUM_ONLY_RX = /^\d+$/;
const PHONE_PREFIX_RX = /^\+/;

export function classifyQuery(raw: string): { kind: SearchKind; query: string } {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { kind: "TEXT", query: "" };

  // باركود ماسح ضوئي: أرقام صرفة + طول قياسي.
  if (NUM_ONLY_RX.test(trimmed) && trimmed.length >= 8 && trimmed.length <= 14) {
    return { kind: "BARCODE", query: trimmed };
  }
  // مُعرّف وثيقة بصيغة المشروع: INV-2606-1234 / QT-... / PO-... / WO-... / SR-... / PR-...
  if (DOC_PREFIX_RX.test(trimmed)) {
    return { kind: "DOC_NUMBER", query: trimmed };
  }
  // رقم وثيقة قصير (المالك يكتب أحياناً «9164» قاصداً QT-2606-9164).
  if (NUM_ONLY_RX.test(trimmed) && trimmed.length <= 7) {
    return { kind: "DOC_NUMBER", query: trimmed };
  }
  // هاتف بصيغة E.164 (+9647...). نمرّر بقية الأنماط لـTEXT (البحث في الهاتف يظل يعمل عبر LIKE).
  if (PHONE_PREFIX_RX.test(trimmed)) {
    return { kind: "PHONE", query: trimmed };
  }
  return { kind: "TEXT", query: trimmed };
}

export type GlobalSearchInput = {
  query: string;
  /** فرع المستخدم؛ null = elevated (admin/manager) يبحث عبر الفروع. */
  branchId: number | null;
  role: string;
  /** الحد لكل كيان (افتراضي ٦). */
  perEntityLimit?: number;
  /** قصر البحث على أنواع محدّدة (اختياري). */
  scopes?: SearchEntityType[];
};

const MASTER_DATA_TYPES: ReadonlyArray<SearchEntityType> = ["PRODUCT", "CUSTOMER", "SUPPLIER"];
const BRANCH_SCOPED_TYPES: ReadonlyArray<SearchEntityType> = [
  "INVOICE",
  "QUOTATION",
  "PURCHASE_ORDER",
  "WORK_ORDER",
  "EXPENSE",
];

/** الأنواع المخفيّة عن الكاشير (إدارة/مدير فأعلى). */
const MANAGER_ONLY_TYPES: ReadonlyArray<SearchEntityType> = ["SUPPLIER", "PURCHASE_ORDER", "EXPENSE"];

function isElevated(role: string) {
  return role === "admin" || role === "manager";
}

function canSeeType(role: string, type: SearchEntityType): boolean {
  if (isElevated(role) || role === "accountant") return true;
  return !MANAGER_ONLY_TYPES.includes(type);
}

export async function globalSearch(input: GlobalSearchInput): Promise<SearchResult[]> {
  const db = getDb();
  if (!db) return [];

  const { kind, query } = classifyQuery(input.query);
  if (!query) return [];

  const perEntityLimit = Math.min(Math.max(input.perEntityLimit ?? 6, 1), 20);
  const elevated = isElevated(input.role);
  // قصر الفرع: لـelevated نمرّر null (يبحث في كل الفروع)، لغيرهم نقيّد بفرعه.
  const scopedBranchId = elevated ? null : input.branchId;

  const requested = new Set<SearchEntityType>(
    (input.scopes ?? [...MASTER_DATA_TYPES, ...BRANCH_SCOPED_TYPES]).filter((t) => canSeeType(input.role, t)),
  );

  const tasks: Promise<SearchResult[]>[] = [];

  if (requested.has("PRODUCT")) tasks.push(searchProducts(db, kind, query, perEntityLimit));
  if (requested.has("CUSTOMER")) tasks.push(searchCustomers(db, kind, query, perEntityLimit));
  if (requested.has("SUPPLIER") && canSeeType(input.role, "SUPPLIER"))
    tasks.push(searchSuppliers(db, kind, query, perEntityLimit));

  if (requested.has("INVOICE")) tasks.push(searchInvoices(db, kind, query, perEntityLimit, scopedBranchId));
  if (requested.has("QUOTATION")) tasks.push(searchQuotations(db, kind, query, perEntityLimit, scopedBranchId));
  if (requested.has("WORK_ORDER")) tasks.push(searchWorkOrders(db, kind, query, perEntityLimit, scopedBranchId));
  if (requested.has("PURCHASE_ORDER") && canSeeType(input.role, "PURCHASE_ORDER"))
    tasks.push(searchPurchaseOrders(db, kind, query, perEntityLimit, scopedBranchId));
  if (requested.has("EXPENSE") && canSeeType(input.role, "EXPENSE"))
    tasks.push(searchExpenses(db, kind, query, perEntityLimit, scopedBranchId));

  const groups = await Promise.all(tasks);
  return groups.flat().sort((a, b) => a.rank - b.rank);
}

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
      route: `/products?focus=${r.productId}`,
      rank: 0,
    }));
  }
  if (kind === "PHONE" || kind === "DOC_NUMBER") return []; // المنتجات لا تُطابِق هاتفاً ولا رقم وثيقة

  const like_ = `%${escapeLike(query)}%`;
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
      or(like(products.name, like_), like(productVariants.sku, like_)),
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
      route: `/products?focus=${r.id}`,
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

  const like_ = `%${escapeLike(query)}%`;
  const conds = [
    eq(customers.isActive, true),
    or(
      like(customers.name, like_),
      like(customers.phone, like_),
      like(customers.phone2, like_),
      like(customers.phone3, like_),
      like(customers.whatsapp, like_),
      like(customers.legacyCode, like_),
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
    route: `/customers?focus=${r.id}`,
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

  const like_ = `%${escapeLike(query)}%`;
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
        like(suppliers.name, like_),
        like(suppliers.phone, like_),
        like(suppliers.phone2, like_),
        like(suppliers.phone3, like_),
        like(suppliers.legacyCode, like_),
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

// ────────────────────────────── فواتير البيع ──────────────────────────────

async function searchInvoices(
  db: NonNullable<ReturnType<typeof getDb>>,
  kind: SearchKind,
  query: string,
  limit: number,
  scopedBranchId: number | null,
): Promise<SearchResult[]> {
  if (kind === "PHONE") return [];

  const conds: any[] = [];
  if (scopedBranchId !== null) conds.push(eq(invoices.branchId, scopedBranchId));

  // باركود ⇒ يطابق رقم فاتورة بالضبط، أو رقم فاتورة يحتوي الباركود (نادر لكن المالك يطلبه: مسح ⇒ فاتورة).
  if (kind === "BARCODE" || kind === "DOC_NUMBER") {
    const like_ = `%${escapeLike(query)}%`;
    conds.push(or(eq(invoices.invoiceNumber, query), like(invoices.invoiceNumber, like_)));
  } else {
    const like_ = `%${escapeLike(query)}%`;
    // نص ⇒ نطابق رقم الفاتورة أو ملاحظة (الملاحظات أحياناً تحوي اسم عميل/مرجع).
    conds.push(or(like(invoices.invoiceNumber, like_), like(invoices.notes, like_)));
  }

  const rows = await db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      customerName: customers.name,
      total: invoices.total,
      invoiceDate: invoices.invoiceDate,
      status: invoices.status,
    })
    .from(invoices)
    .leftJoin(customers, eq(customers.id, invoices.customerId))
    .where(and(...conds))
    .orderBy(desc(invoices.invoiceDate), desc(invoices.id))
    .limit(limit);

  const STATUS_LABEL: Record<string, string> = {
    CANCELLED: " · ملغاة",
    RETURNED: " · مُرجَعة",
  };
  return rows.map((r) => ({
    type: "INVOICE" as const,
    id: r.id,
    title: r.invoiceNumber,
    subtitle: r.customerName ?? "عميل نقدي",
    meta: `${r.total} د.ع · ${formatDate(r.invoiceDate)}${STATUS_LABEL[r.status ?? ""] ?? ""}`,
    route: `/invoices/${r.id}`,
    rank: r.invoiceNumber === query ? 0 : 1,
  }));
}

// ────────────────────────────── عروض الأسعار ──────────────────────────────

async function searchQuotations(
  db: NonNullable<ReturnType<typeof getDb>>,
  kind: SearchKind,
  query: string,
  limit: number,
  scopedBranchId: number | null,
): Promise<SearchResult[]> {
  if (kind === "PHONE") return [];

  const conds: any[] = [];
  if (scopedBranchId !== null) conds.push(eq(quotations.branchId, scopedBranchId));

  const like_ = `%${escapeLike(query)}%`;
  if (kind === "BARCODE" || kind === "DOC_NUMBER") {
    conds.push(or(eq(quotations.quoteNumber, query), like(quotations.quoteNumber, like_)));
  } else {
    conds.push(or(like(quotations.quoteNumber, like_), like(quotations.notes, like_)));
  }

  const rows = await db
    .select({
      id: quotations.id,
      quoteNumber: quotations.quoteNumber,
      customerName: customers.name,
      total: quotations.total,
      quoteDate: quotations.quoteDate,
    })
    .from(quotations)
    .leftJoin(customers, eq(customers.id, quotations.customerId))
    .where(and(...conds))
    .orderBy(desc(quotations.quoteDate), desc(quotations.id))
    .limit(limit);

  return rows.map((r) => ({
    type: "QUOTATION" as const,
    id: r.id,
    title: r.quoteNumber,
    subtitle: r.customerName ?? "عميل نقدي",
    meta: `${r.total} د.ع · ${formatDate(r.quoteDate)}`,
    route: `/quotations/${r.id}`,
    rank: r.quoteNumber === query ? 0 : 1,
  }));
}

// ────────────────────────────── أوامر الشغل ──────────────────────────────

async function searchWorkOrders(
  db: NonNullable<ReturnType<typeof getDb>>,
  kind: SearchKind,
  query: string,
  limit: number,
  scopedBranchId: number | null,
): Promise<SearchResult[]> {
  if (kind === "PHONE") return [];

  const conds: any[] = [];
  if (scopedBranchId !== null) conds.push(eq(workOrders.branchId, scopedBranchId));

  const like_ = `%${escapeLike(query)}%`;
  if (kind === "BARCODE" || kind === "DOC_NUMBER") {
    conds.push(or(eq(workOrders.orderNumber, query), like(workOrders.orderNumber, like_)));
  } else {
    conds.push(or(like(workOrders.orderNumber, like_), like(workOrders.title, like_)));
  }

  const rows = await db
    .select({
      id: workOrders.id,
      orderNumber: workOrders.orderNumber,
      title: workOrders.title,
      customerName: customers.name,
      status: workOrders.status,
      createdAt: workOrders.createdAt,
    })
    .from(workOrders)
    .leftJoin(customers, eq(customers.id, workOrders.customerId))
    .where(and(...conds))
    .orderBy(desc(workOrders.createdAt), desc(workOrders.id))
    .limit(limit);

  return rows.map((r) => ({
    type: "WORK_ORDER" as const,
    id: r.id,
    title: `${r.orderNumber} — ${r.title}`,
    subtitle: r.customerName ?? "بلا عميل",
    meta: `${r.status} · ${formatDate(r.createdAt)}`,
    route: `/work-orders/${r.id}`,
    rank: r.orderNumber === query ? 0 : 1,
  }));
}

// ────────────────────────────── أوامر الشراء ──────────────────────────────

async function searchPurchaseOrders(
  db: NonNullable<ReturnType<typeof getDb>>,
  kind: SearchKind,
  query: string,
  limit: number,
  scopedBranchId: number | null,
): Promise<SearchResult[]> {
  if (kind === "PHONE") return [];

  const conds: any[] = [];
  if (scopedBranchId !== null) conds.push(eq(purchaseOrders.branchId, scopedBranchId));

  const like_ = `%${escapeLike(query)}%`;
  if (kind === "BARCODE" || kind === "DOC_NUMBER") {
    conds.push(or(eq(purchaseOrders.poNumber, query), like(purchaseOrders.poNumber, like_)));
  } else {
    conds.push(or(like(purchaseOrders.poNumber, like_), like(purchaseOrders.notes, like_)));
  }

  const rows = await db
    .select({
      id: purchaseOrders.id,
      poNumber: purchaseOrders.poNumber,
      supplierName: suppliers.name,
      total: purchaseOrders.total,
      orderDate: purchaseOrders.orderDate,
      status: purchaseOrders.status,
    })
    .from(purchaseOrders)
    .leftJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
    .where(and(...conds))
    .orderBy(desc(purchaseOrders.orderDate), desc(purchaseOrders.id))
    .limit(limit);

  return rows.map((r) => ({
    type: "PURCHASE_ORDER" as const,
    id: r.id,
    title: r.poNumber,
    subtitle: r.supplierName ?? "—",
    meta: `${r.total} د.ع · ${r.status}`,
    // لا صفحة تفاصيل مستقلّة بعد ⇒ نُمرّر للقائمة مع فلتر التركيز.
    route: `/purchases?focus=${r.id}`,
    rank: r.poNumber === query ? 0 : 1,
  }));
}

// ────────────────────────────── المصاريف ──────────────────────────────

async function searchExpenses(
  db: NonNullable<ReturnType<typeof getDb>>,
  kind: SearchKind,
  query: string,
  limit: number,
  scopedBranchId: number | null,
): Promise<SearchResult[]> {
  if (kind === "BARCODE" || kind === "PHONE") return [];

  const conds: any[] = [eq(expenses.status, "ACTIVE")];
  if (scopedBranchId !== null) conds.push(eq(expenses.branchId, scopedBranchId));

  const like_ = `%${escapeLike(query)}%`;
  conds.push(or(
    like(expenses.description, like_),
    like(expenses.referenceNumber, like_),
    like(expenses.payee, like_),
  ));

  const rows = await db
    .select({
      id: expenses.id,
      description: expenses.description,
      payee: expenses.payee,
      amount: expenses.amount,
      expenseDate: expenses.expenseDate,
      category: expenses.category,
      referenceNumber: expenses.referenceNumber,
    })
    .from(expenses)
    .where(and(...conds))
    .orderBy(desc(expenses.expenseDate), desc(expenses.id))
    .limit(limit);

  return rows.map((r) => ({
    type: "EXPENSE" as const,
    id: r.id,
    title: r.description?.slice(0, 80) || r.payee || `مصروف #${r.id}`,
    subtitle: [r.payee, r.referenceNumber].filter(Boolean).join(" · ") || r.category,
    meta: `${r.amount} د.ع · ${r.expenseDate}`,
    route: `/expenses?focus=${r.id}`,
    rank: 2,
  }));
}

// ────────────────────────────── أدوات ──────────────────────────────

function formatDate(d: Date | string | null): string {
  if (!d) return "—";
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return String(d);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
