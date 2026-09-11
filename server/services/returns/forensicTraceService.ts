/**
 * ForensicTraceService — محرك التحري والتقصي الجنائي للفواتير المفقودة وقارئ الباركود الشامل.
 *
 * يوفر ٤ عدسات تقصٍّ ذكية لاستخراج الفواتير الأصلية عند فقدان الفاتورة الورقية أو تلفها:
 *  ١) عدسة باركود الصنف أو رمزه (SKU & Barcode Trace): البحث في فواتير آخر N يوماً للصنف وحساب أدنى سعر بيع تاريخي.
 *  ٢) عدسة البطاقة البنكية والدفع الإلكتروني (Card & External Payment Trace): البحث بآخر ٤ أرقام أو المرجع البنكي.
 *  ٣) عدسة هوية العميل ورقم الهاتف (Customer Phone & Name Trace): كشف سجل المشتريات للعميل.
 *  ٤) عدسة الوردية والتاريخ (Shift & Date Window Trace): حصر فواتير وردية معينة.
 *
 * بالإضافة إلى وظيفة المسح الكوني (universalBarcodeScan) لتحديد وجهة أي باركود ممسوح.
 */
import { and, desc, eq, gte, inArray, isNotNull, like, lte, or, sql } from "drizzle-orm";
import {
  customers,
  deliveryConsignments,
  externalPaymentAttempts,
  invoiceItems,
  invoices,
  productUnits,
  productVariants,
  products,
  purchaseReturns,
  receipts,
  users,
  workOrders,
} from "../../../drizzle/schema";
import { getDb } from "../../db";
import type { Actor } from "../tx";

export type ForensicSearchMode = "ITEM_BARCODE" | "CARD_LAST4" | "CUSTOMER_PHONE" | "DATE_SHIFT";

export interface ForensicTraceInput {
  query: string;
  mode: ForensicSearchMode;
  days?: number;
  shiftId?: number | null;
  dateFrom?: string | null;
  dateTo?: string | null;
}

export interface TracedInvoiceResult {
  invoiceId: number;
  invoiceNumber: string;
  createdAt: Date;
  branchId: number;
  total: string;
  paidAmount: string;
  status: string;
  customerName: string | null;
  customerPhone: string | null;
  cashierName: string | null;
  matchedItem?: {
    variantId: number;
    productName: string;
    sku: string | null;
    soldQuantity: number;
    unitPrice: string;
    itemTotal: string;
    returnedQuantity: number;
  } | null;
  paymentDetails?: {
    method: string;
    reference: string | null;
  } | null;
}

export interface ForensicTraceOutput {
  mode: ForensicSearchMode;
  query: string;
  results: TracedInvoiceResult[];
  lowestHistoricalPrice?: string | null;
  lowestPrice60Days?: string | null;
  scannedProduct?: {
    id: number;
    name: string;
    sku: string | null;
    barcode: string | null;
  } | null;
}

export interface UniversalScanResult {
  recognized: boolean;
  kind: "INVOICE" | "WORK_ORDER" | "DELIVERY" | "PURCHASE_RETURN" | "PRODUCT" | "UNKNOWN";
  id?: number;
  number?: string;
  title?: string;
  extra?: Record<string, unknown>;
}

export async function forensicTraceInvoices(
  input: ForensicTraceInput,
  actor: Actor
): Promise<ForensicTraceOutput> {
  const db = getDb();
  if (!db) {
    return { mode: input.mode, query: input.query, results: [] };
  }

  const days = Math.min(Math.max(input.days ?? 30, 1), 180);
  const cutoffDate = new Date(Date.now() - days * 86_400_000);

  const scopedBranchId = actor.role === "admin" || !actor.branchId ? null : actor.branchId;
  const q = input.query.trim();

  // ═════════════════════════════════════════════════════════════════════
  // ١) عدسة باركود الصنف (ITEM_BARCODE)
  // ═════════════════════════════════════════════════════════════════════
  if (input.mode === "ITEM_BARCODE") {
    // نبحث عن الصنف أولاً بالباركود أو الـ SKU أو الاسم
    const matchingVariants = await db
      .select({
        variantId: productVariants.id,
        productId: products.id,
        productName: products.name,
        sku: productVariants.sku,
        barcode: productUnits.barcode,
      })
      .from(productVariants)
      .innerJoin(products, eq(productVariants.productId, products.id))
      .leftJoin(productUnits, eq(productUnits.variantId, productVariants.id))
      .where(
        or(
          eq(productUnits.barcode, q),
          eq(productVariants.sku, q),
          like(products.name, `%${q}%`)
        )
      )
      .limit(10);

    if (matchingVariants.length === 0) {
      return {
        mode: input.mode,
        query: q,
        results: [],
        lowestHistoricalPrice: null,
      };
    }

    const variantIds = Array.from(new Set(matchingVariants.map((v) => v.variantId)));
    const firstMatch = matchingVariants[0];

    // حساب أدنى سعر بيع تاريخي خلال ٦٠ يوماً (لقياس بروتوكول الإرجاع بدون فاتورة)
    const sixtyDaysAgo = new Date(Date.now() - 60 * 86_400_000);

    const [lowestPriceRow] = await db
      .select({
        minPrice: sql<string>`MIN(${invoiceItems.unitPrice})`,
      })
      .from(invoiceItems)
      .innerJoin(invoices, eq(invoiceItems.invoiceId, invoices.id))
      .where(
        and(
          inArray(invoiceItems.variantId, variantIds),
          gte(invoices.createdAt, sixtyDaysAgo),
          scopedBranchId != null ? eq(invoices.branchId, scopedBranchId) : sql`1=1`
        )
      );

    // استخراج الفواتير التي بيع فيها هذا الصنف خلال فترة البحث
    const invoiceRows = await db
      .select({
        invoiceId: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        createdAt: invoices.createdAt,
        branchId: invoices.branchId,
        total: invoices.total,
        paidAmount: invoices.paidAmount,
        status: invoices.status,
        customerName: customers.name,
        customerPhone: customers.phone,
        cashierName: users.name,
        variantId: invoiceItems.variantId,
        soldQuantity: invoiceItems.quantity,
        unitPrice: invoiceItems.unitPrice,
        itemTotal: invoiceItems.total,
        returnedQuantity: invoiceItems.returnedBaseQuantity,
      })
      .from(invoiceItems)
      .innerJoin(invoices, eq(invoiceItems.invoiceId, invoices.id))
      .leftJoin(customers, eq(invoices.customerId, customers.id))
      .leftJoin(users, eq(invoices.createdBy, users.id))
      .where(
        and(
          inArray(invoiceItems.variantId, variantIds),
          gte(invoices.createdAt, cutoffDate),
          scopedBranchId != null ? eq(invoices.branchId, scopedBranchId) : sql`1=1`
        )
      )
      .orderBy(desc(invoices.createdAt))
      .limit(50);

    const results: TracedInvoiceResult[] = invoiceRows.map((r) => ({
      invoiceId: Number(r.invoiceId),
      invoiceNumber: r.invoiceNumber,
      createdAt: r.createdAt,
      branchId: Number(r.branchId),
      total: String(r.total),
      paidAmount: String(r.paidAmount),
      status: r.status,
      customerName: r.customerName,
      customerPhone: r.customerPhone,
      cashierName: r.cashierName,
      matchedItem: {
        variantId: Number(r.variantId),
        productName: firstMatch.productName,
        sku: firstMatch.sku,
        soldQuantity: Number(r.soldQuantity),
        unitPrice: String(r.unitPrice),
        itemTotal: String(r.itemTotal),
        returnedQuantity: Number(r.returnedQuantity ?? 0),
      },
    }));

    return {
      mode: input.mode,
      query: q,
      results,
      lowestHistoricalPrice: lowestPriceRow?.minPrice ? String(lowestPriceRow.minPrice) : null,
      lowestPrice60Days: lowestPriceRow?.minPrice ? String(lowestPriceRow.minPrice) : null,
      scannedProduct: {
        id: Number(firstMatch.productId),
        name: firstMatch.productName,
        sku: firstMatch.sku,
        barcode: firstMatch.barcode,
      },
    };
  }

  // ═════════════════════════════════════════════════════════════════════
  // ٢) عدسة الدفع والبطاقة (CARD_LAST4)
  // ═════════════════════════════════════════════════════════════════════
  if (input.mode === "CARD_LAST4") {
    // نبحث في externalPaymentAttempts و receipts
    const attempts = await db
      .select({
        invoiceId: externalPaymentAttempts.invoiceId,
        reference: externalPaymentAttempts.externalReference,
        method: externalPaymentAttempts.paymentMethod,
      })
      .from(externalPaymentAttempts)
      .where(
        and(
          isNotNull(externalPaymentAttempts.invoiceId),
          or(
            like(externalPaymentAttempts.externalReference, `%${q}%`),
            like(externalPaymentAttempts.normalizedReference, `%${q.toUpperCase()}%`)
          ),
          gte(externalPaymentAttempts.createdAt, cutoffDate),
          scopedBranchId != null ? eq(externalPaymentAttempts.branchId, scopedBranchId) : sql`1=1`
        )
      )
      .limit(30);

    const receiptMatches = await db
      .select({
        invoiceId: receipts.invoiceId,
        reference: receipts.referenceNumber,
        method: receipts.paymentMethod,
      })
      .from(receipts)
      .where(
        and(
          isNotNull(receipts.invoiceId),
          like(receipts.referenceNumber, `%${q}%`),
          gte(receipts.createdAt, cutoffDate),
          scopedBranchId != null ? eq(receipts.branchId, scopedBranchId) : sql`1=1`
        )
      )
      .limit(30);

    const candidateInvoiceIds = Array.from(
      new Set(
        [...attempts, ...receiptMatches]
          .map((m) => (m.invoiceId ? Number(m.invoiceId) : null))
          .filter((id): id is number => id != null && id > 0)
      )
    );

    if (candidateInvoiceIds.length === 0) {
      return { mode: input.mode, query: q, results: [] };
    }

    const invoiceRows = await db
      .select({
        invoiceId: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        createdAt: invoices.createdAt,
        branchId: invoices.branchId,
        total: invoices.total,
        paidAmount: invoices.paidAmount,
        status: invoices.status,
        customerName: customers.name,
        customerPhone: customers.phone,
        cashierName: users.name,
      })
      .from(invoices)
      .leftJoin(customers, eq(invoices.customerId, customers.id))
      .leftJoin(users, eq(invoices.createdBy, users.id))
      .where(inArray(invoices.id, candidateInvoiceIds))
      .orderBy(desc(invoices.createdAt));

    return {
      mode: input.mode,
      query: q,
      results: invoiceRows.map((r) => ({
        invoiceId: Number(r.invoiceId),
        invoiceNumber: r.invoiceNumber,
        createdAt: r.createdAt,
        branchId: Number(r.branchId),
        total: String(r.total),
        paidAmount: String(r.paidAmount),
        status: r.status,
        customerName: r.customerName,
        customerPhone: r.customerPhone,
        cashierName: r.cashierName,
      })),
    };
  }

  // ═════════════════════════════════════════════════════════════════════
  // ٣) عدسة العميل ورقم الهاتف (CUSTOMER_PHONE)
  // ═════════════════════════════════════════════════════════════════════
  if (input.mode === "CUSTOMER_PHONE") {
    const invoiceRows = await db
      .select({
        invoiceId: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        createdAt: invoices.createdAt,
        branchId: invoices.branchId,
        total: invoices.total,
        paidAmount: invoices.paidAmount,
        status: invoices.status,
        customerName: customers.name,
        customerPhone: customers.phone,
        cashierName: users.name,
      })
      .from(invoices)
      .innerJoin(customers, eq(invoices.customerId, customers.id))
      .leftJoin(users, eq(invoices.createdBy, users.id))
      .where(
        and(
          or(like(customers.phone, `%${q}%`), like(customers.name, `%${q}%`)),
          gte(invoices.createdAt, cutoffDate),
          scopedBranchId != null ? eq(invoices.branchId, scopedBranchId) : sql`1=1`
        )
      )
      .orderBy(desc(invoices.createdAt))
      .limit(50);

    return {
      mode: input.mode,
      query: q,
      results: invoiceRows.map((r) => ({
        invoiceId: Number(r.invoiceId),
        invoiceNumber: r.invoiceNumber,
        createdAt: r.createdAt,
        branchId: Number(r.branchId),
        total: String(r.total),
        paidAmount: String(r.paidAmount),
        status: r.status,
        customerName: r.customerName,
        customerPhone: r.customerPhone,
        cashierName: r.cashierName,
      })),
    };
  }

  // ═════════════════════════════════════════════════════════════════════
  // ٤) عدسة الوردية والتاريخ (DATE_SHIFT)
  // ═════════════════════════════════════════════════════════════════════
  if (input.mode === "DATE_SHIFT") {
    const shiftId = input.shiftId ? Number(input.shiftId) : null;
    const dateFrom = input.dateFrom ? new Date(input.dateFrom) : cutoffDate;
    const dateTo = input.dateTo ? new Date(input.dateTo) : new Date();

    const invoiceRows = await db
      .select({
        invoiceId: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        createdAt: invoices.createdAt,
        branchId: invoices.branchId,
        total: invoices.total,
        paidAmount: invoices.paidAmount,
        status: invoices.status,
        customerName: customers.name,
        customerPhone: customers.phone,
        cashierName: users.name,
      })
      .from(invoices)
      .leftJoin(customers, eq(invoices.customerId, customers.id))
      .leftJoin(users, eq(invoices.createdBy, users.id))
      .where(
        and(
          shiftId ? eq(invoices.shiftId, shiftId) : sql`1=1`,
          gte(invoices.createdAt, dateFrom),
          lte(invoices.createdAt, dateTo),
          scopedBranchId != null ? eq(invoices.branchId, scopedBranchId) : sql`1=1`
        )
      )
      .orderBy(desc(invoices.createdAt))
      .limit(50);

    return {
      mode: input.mode,
      query: q,
      results: invoiceRows.map((r) => ({
        invoiceId: Number(r.invoiceId),
        invoiceNumber: r.invoiceNumber,
        createdAt: r.createdAt,
        branchId: Number(r.branchId),
        total: String(r.total),
        paidAmount: String(r.paidAmount),
        status: r.status,
        customerName: r.customerName,
        customerPhone: r.customerPhone,
        cashierName: r.cashierName,
      })),
    };
  }

  return { mode: input.mode, query: q, results: [] };
}

/**
 * قارئ الباركود الشامل (Universal Barcode Scan)
 * يتعرف تلقائياً على نوع أي باركود ممسوح ويحدد المعاملة بدقة.
 */
export async function universalBarcodeScan(
  rawBarcode: string,
  actor: Actor
): Promise<UniversalScanResult> {
  const db = getDb();
  if (!db) {
    return { recognized: false, kind: "UNKNOWN" };
  }

  const trimmed = rawBarcode.trim();
  if (!trimmed) {
    return { recognized: false, kind: "UNKNOWN" };
  }

  const scopedBranchId = actor.role === "admin" || !actor.branchId ? null : actor.branchId;

  // ١) هل هي فاتورة بيع؟ (INV-XXXX أو رقم مباشر)
  if (trimmed.startsWith("INV-") || (/^\d+$/.test(trimmed) && trimmed.length <= 8)) {
    const inv = (
      await db
        .select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          total: invoices.total,
          status: invoices.status,
        })
        .from(invoices)
        .where(
          and(
            or(
              eq(invoices.invoiceNumber, trimmed),
              /^\d+$/.test(trimmed) ? eq(invoices.id, Number(trimmed)) : sql`1=0`
            ),
            scopedBranchId != null ? eq(invoices.branchId, scopedBranchId) : sql`1=1`
          )
        )
        .limit(1)
    )[0];

    if (inv) {
      return {
        recognized: true,
        kind: "INVOICE",
        id: Number(inv.id),
        number: inv.invoiceNumber,
        title: `فاتورة بيع #${inv.invoiceNumber}`,
        extra: { total: String(inv.total), status: inv.status },
      };
    }
  }

  // ٢) هل هو أمر شغل مطبعة واستنساخ؟ (WO-XXXX)
  if (trimmed.startsWith("WO-") || trimmed.includes("WO")) {
    const wo = (
      await db
        .select({
          id: workOrders.id,
          orderNumber: workOrders.orderNumber,
          title: workOrders.title,
          salePrice: workOrders.salePrice,
          deposit: workOrders.deposit,
        })
        .from(workOrders)
        .where(
          and(
            eq(workOrders.orderNumber, trimmed),
            scopedBranchId != null ? eq(workOrders.branchId, scopedBranchId) : sql`1=1`
          )
        )
        .limit(1)
    )[0];

    if (wo) {
      return {
        recognized: true,
        kind: "WORK_ORDER",
        id: Number(wo.id),
        number: wo.orderNumber,
        title: `أمر شغل #${wo.orderNumber} - ${wo.title}`,
        extra: { salePrice: String(wo.salePrice), deposit: String(wo.deposit) },
      };
    }
  }

  // ٣) هل هو طرد شحن وتوصيل؟ (CN-XXXX أو DLV-XXXX)
  if (trimmed.startsWith("CN-") || trimmed.startsWith("DLV-") || trimmed.startsWith("PK-")) {
    const cnRow = (
      await db
        .select({
          id: deliveryConsignments.id,
          consignmentNumber: deliveryConsignments.consignmentNumber,
          invoiceId: deliveryConsignments.invoiceId,
        })
        .from(deliveryConsignments)
        .where(
          and(
            eq(deliveryConsignments.consignmentNumber, trimmed),
            scopedBranchId != null ? eq(deliveryConsignments.branchId, scopedBranchId) : sql`1=1`
          )
        )
        .limit(1)
    )[0];

    if (cnRow) {
      return {
        recognized: true,
        kind: "DELIVERY",
        id: Number(cnRow.id),
        number: cnRow.consignmentNumber,
        title: `طرد توصيل #${cnRow.consignmentNumber}`,
        extra: { invoiceId: Number(cnRow.invoiceId) },
      };
    }
  }

  // ٤) هل هو مرتجع شراء لمورد؟ (PR-XXXX)
  if (trimmed.startsWith("PR-")) {
    const pr = (
      await db
        .select({
          id: purchaseReturns.id,
          returnNumber: purchaseReturns.returnNumber,
          status: purchaseReturns.status,
        })
        .from(purchaseReturns)
        .where(eq(purchaseReturns.returnNumber, trimmed))
        .limit(1)
    )[0];

    if (pr) {
      return {
        recognized: true,
        kind: "PURCHASE_RETURN",
        id: Number(pr.id),
        number: pr.returnNumber,
        title: `مرتجع مشتريات #${pr.returnNumber}`,
        extra: { status: pr.status },
      };
    }
  }

  // ٥) هل هو باركود صنف أو منتج؟ (EAN-13, SKU...)
  const unitMatch = (
    await db
      .select({
        unitId: productUnits.id,
        productId: products.id,
        productName: products.name,
        barcode: productUnits.barcode,
        sku: productVariants.sku,
        variantId: productVariants.id,
      })
      .from(productUnits)
      .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(or(eq(productUnits.barcode, trimmed), eq(productVariants.sku, trimmed)))
      .limit(1)
  )[0];

  if (unitMatch) {
    return {
      recognized: true,
      kind: "PRODUCT",
      id: Number(unitMatch.variantId),
      number: unitMatch.barcode ?? unitMatch.sku ?? trimmed,
      title: `صنف: ${unitMatch.productName}`,
      extra: {
        productId: Number(unitMatch.productId),
        variantId: Number(unitMatch.variantId),
        sku: unitMatch.sku,
        barcode: unitMatch.barcode,
      },
    };
  }

  return { recognized: false, kind: "UNKNOWN", number: trimmed };
}
