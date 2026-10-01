/**
 * shelfAnalyticsService — محرك إحصائيات وتحليلات المستفيدين من خدمة استعلام أسعار الرفوف بالباركود.
 *
 * يوفر:
 *  ١. تسجيل عمليات الاستعلام والمسح آلياً وبأمان كامل (Zero Impact on Lookup Latency).
 *  ٢. حصر دقيق لأعداد المستفيدين الحقيقيين (Unique Beneficiaries / Distinct Visitors).
 *  ٣. مؤشرات الأداء الحيوية (إجمالي الاستعلامات، معدل النجاح، استعلامات اليوم).
 *  ٤. توزيع نشاط الفروع (الرئيسي vs المبيعات).
 *  ٥. قائمة أكثر الأصناف استعلاماً وبحثاً من قِبل الزبائن (Top Scanned Products).
 *  ٦. تصنيف أجهزة الزبائن (iOS / Android / Desktop).
 *  ٧. منحنى النشاط الزمني وساعات الذروة في المعرض.
 *  ٨. سجل العمليات والنشاط المباشر واللحظي (Live Scan Stream).
 *  ٩. مسح وتصفير سجلات الاستعلامات والبيانات التجريبية والبدء من الصفر.
 */
import { createHash } from "node:crypto";
import { and, count, countDistinct, desc, eq, gte, lt, sql } from "drizzle-orm";
import {
  branches,
  categories,
  productImages,
  productPrices,
  productUnits,
  productVariants,
  products,
  shelfLookupLogs,
  type ShelfLookupLog,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { logger } from "../logger";
import { baghdadTodayUtcRange } from "./businessDay";

const RETAIL = "RETAIL" as const;

export type ShelfDateRange = "today" | "7d" | "30d" | "all";

export interface RecordShelfLookupParams {
  visitorId: string;
  barcode: string;
  branchId?: number | null;
  productId?: number | null;
  productName?: string | null;
  found: boolean;
  deviceType?: string;
  ip?: string;
  userAgent?: string;
}

export interface ShelfBeneficiariesStats {
  totalScans: number;
  uniqueBeneficiaries: number;
  todayScans: number;
  todayBeneficiaries: number;
  foundScans: number;
  notFoundScans: number;
  successRate: number;
  deviceBreakdown: {
    ios: number;
    android: number;
    desktop: number;
    other: number;
  };
  branchBreakdown: Array<{
    branchId: number | null;
    branchName: string;
    branchCode: string | null;
    scanCount: number;
    beneficiaryCount: number;
  }>;
  topProducts: Array<{
    productId: number;
    productName: string;
    brand: string | null;
    category: string | null;
    barcode: string;
    scanCount: number;
    price: string | null;
    imageUrl: string | null;
  }>;
  activityTimeline: Array<{
    label: string;
    date: string;
    scans: number;
    beneficiaries: number;
  }>;
  recentScans: Array<{
    id: number;
    barcode: string;
    productName: string | null;
    branchId: number | null;
    branchName: string | null;
    found: boolean;
    deviceType: string;
    createdAt: string;
  }>;
}

/** تجزئة عنوان IP بصورة آمنة أحادية الاتجاه لمنع كشف أي خصوصية */
function hashIp(ip?: string): string | null {
  if (!ip) return null;
  try {
    return createHash("sha256").update(`shelf-salt-${ip}`).digest("hex").slice(0, 32);
  } catch {
    return null;
  }
}

/** توقيت بداية اليوم في بغداد (UTC+3) محولاً إلى UTC من مصدر الحقيقة المعتمد */
export function getBaghdadStartOfToday(): Date {
  return baghdadTodayUtcRange().start;
}

/** تحديد تاريخ البداية وفق نطاق الفلترة */
function getStartDateForRange(range: ShelfDateRange): Date | null {
  const now = new Date();
  if (range === "today") {
    return baghdadTodayUtcRange().start;
  }
  if (range === "7d") {
    return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  }
  if (range === "30d") {
    return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  }
  return null; // all
}

/**
 * تسجيل عملية مسح واستعلام باركود في السجل بطريقة آمنة غير معرقلة.
 */
export async function recordShelfLookupEvent(params: RecordShelfLookupParams): Promise<void> {
  const db = getDb();
  if (!db) return;

  const visitorId = String(params.visitorId || "anon").trim().slice(0, 64);
  const barcode = String(params.barcode || "").trim().slice(0, 64);
  if (!barcode) return;

  let branchId = params.branchId != null && params.branchId > 0 ? Number(params.branchId) : null;
  let productId = params.productId != null && params.productId > 0 ? Number(params.productId) : null;
  const productName = params.productName ? String(params.productName).trim().slice(0, 255) : null;
  const deviceType = params.deviceType ? String(params.deviceType).trim().slice(0, 32) : "unknown";
  const ipHash = hashIp(params.ip);
  const userAgent = params.userAgent ? String(params.userAgent).trim().slice(0, 255) : null;

  try {
    await db.insert(shelfLookupLogs).values({
      visitorId,
      branchId,
      barcode,
      productId,
      productName,
      found: Boolean(params.found),
      deviceType,
      ipHash,
      userAgent,
    });
  } catch (err: any) {
    const isFkError =
      err?.code === "ER_NO_REFERENCED_ROW_2" ||
      err?.code === "ER_NO_REFERENCED_ROW" ||
      err?.cause?.code === "ER_NO_REFERENCED_ROW_2" ||
      err?.cause?.code === "ER_NO_REFERENCED_ROW" ||
      String(err?.message || "").includes("foreign key constraint fails") ||
      String(err?.cause?.message || "").includes("foreign key constraint fails");

    // في حال تعذر الإدراج بسبب قيد مفتاح أجنبي لفرع أو منتج غير موجود، نعيد الإدراج بمفاتيح فارغة لضمان عدم ضياع عملية الاستعلام
    if (isFkError) {
      try {
        await db.insert(shelfLookupLogs).values({
          visitorId,
          branchId: null,
          barcode,
          productId: null,
          productName,
          found: Boolean(params.found),
          deviceType,
          ipHash,
          userAgent,
        });
        return;
      } catch {
        // إخفاق صامت
      }
    }
    // تسجيل الخطأ دون التأثير على استجابة العميل
    logger.warn({ err, barcode }, "shelf.lookup.log_failed");
  }
}

/**
 * استخراج مؤشرات وإحصائيات المستفيدين الكاملة لخدمة استعلام الرفوف.
 */
export async function getShelfBeneficiariesStats(options?: {
  branchId?: number;
  range?: ShelfDateRange;
}): Promise<ShelfBeneficiariesStats> {
  const db = getDb();
  if (!db) {
    return createEmptyStats();
  }

  const range = options?.range ?? "7d";
  const branchId = options?.branchId && options.branchId > 0 ? Number(options.branchId) : undefined;
  const startDate = getStartDateForRange(range);
  const { start: todayStart, endExclusive: todayEndExclusive } = baghdadTodayUtcRange();



  // بناء شروط التصفية
  const whereClauses = [];
  if (branchId) {
    whereClauses.push(eq(shelfLookupLogs.branchId, branchId));
  }
  if (startDate) {
    whereClauses.push(gte(shelfLookupLogs.createdAt, startDate));
  }
  const mainFilter = whereClauses.length > 0 ? and(...whereClauses) : undefined;

  // ١. المقاييس الإجمالية للنطاق المختار
  const [totalsRow] = await db
    .select({
      totalScans: count(shelfLookupLogs.id),
      uniqueBeneficiaries: countDistinct(shelfLookupLogs.visitorId),
      foundScans: sql<number>`COALESCE(SUM(CASE WHEN ${shelfLookupLogs.found} = 1 THEN 1 ELSE 0 END), 0)`,
      notFoundScans: sql<number>`COALESCE(SUM(CASE WHEN ${shelfLookupLogs.found} = 0 THEN 1 ELSE 0 END), 0)`,
    })
    .from(shelfLookupLogs)
    .where(mainFilter);

  // ٢. مقاييس اليوم (بتوقيت بغداد - نصف مفتوح)
  const todayFilter = branchId
    ? and(
        eq(shelfLookupLogs.branchId, branchId),
        gte(shelfLookupLogs.createdAt, todayStart),
        lt(shelfLookupLogs.createdAt, todayEndExclusive),
      )
    : and(
        gte(shelfLookupLogs.createdAt, todayStart),
        lt(shelfLookupLogs.createdAt, todayEndExclusive),
      );

  const [todayRow] = await db
    .select({
      todayScans: count(shelfLookupLogs.id),
      todayBeneficiaries: countDistinct(shelfLookupLogs.visitorId),
    })
    .from(shelfLookupLogs)
    .where(todayFilter);

  const totalScans = Number(totalsRow?.totalScans ?? 0);
  const uniqueBeneficiaries = Number(totalsRow?.uniqueBeneficiaries ?? 0);
  const foundScans = Number(totalsRow?.foundScans ?? 0);
  const notFoundScans = Number(totalsRow?.notFoundScans ?? 0);
  const successRate = totalScans > 0 ? Math.round((foundScans / totalScans) * 1000) / 10 : 100;

  // ٣. توزيع الأجهزة
  const deviceRows = await db
    .select({
      deviceType: shelfLookupLogs.deviceType,
      scanCount: count(shelfLookupLogs.id),
    })
    .from(shelfLookupLogs)
    .where(mainFilter)
    .groupBy(shelfLookupLogs.deviceType);

  const deviceBreakdown = { ios: 0, android: 0, desktop: 0, other: 0 };
  for (const r of deviceRows) {
    const dt = (r.deviceType || "").toLowerCase();
    const c = Number(r.scanCount ?? 0);
    if (dt === "ios" || dt.includes("iphone") || dt.includes("ipad")) {
      deviceBreakdown.ios += c;
    } else if (dt === "android") {
      deviceBreakdown.android += c;
    } else if (dt === "desktop" || dt === "windows" || dt === "mac") {
      deviceBreakdown.desktop += c;
    } else {
      deviceBreakdown.other += c;
    }
  }

  // ٤. توزيع الفروع
  const branchRows = await db
    .select({
      branchId: shelfLookupLogs.branchId,
      branchName: branches.name,
      branchCode: branches.code,
      scanCount: count(shelfLookupLogs.id),
      beneficiaryCount: countDistinct(shelfLookupLogs.visitorId),
    })
    .from(shelfLookupLogs)
    .leftJoin(branches, eq(shelfLookupLogs.branchId, branches.id))
    .where(startDate ? gte(shelfLookupLogs.createdAt, startDate) : undefined)
    .groupBy(shelfLookupLogs.branchId, branches.name, branches.code);

  const branchBreakdown = branchRows.map((r) => ({
    branchId: r.branchId ? Number(r.branchId) : null,
    branchName: r.branchName || "عام (كافة الفروع)",
    branchCode: r.branchCode || null,
    scanCount: Number(r.scanCount ?? 0),
    beneficiaryCount: Number(r.beneficiaryCount ?? 0),
  }));

  // ٥. أكثر الأصناف استعلاماً وبحثاً من الزبائن
  const topProductsRows = await db
    .select({
      productId: shelfLookupLogs.productId,
      logProductName: shelfLookupLogs.productName,
      dbProductName: products.name,
      brand: products.brand,
      category: categories.name,
      barcode: shelfLookupLogs.barcode,
      scanCount: count(shelfLookupLogs.id),
      price: productPrices.price,
      imageUrl: productImages.url,
    })
    .from(shelfLookupLogs)
    .leftJoin(products, eq(shelfLookupLogs.productId, products.id))
    .leftJoin(categories, eq(products.categoryId, categories.id))
    .leftJoin(
      productVariants,
      and(
        eq(productVariants.productId, products.id),
        eq(productVariants.isActive, true),
      ),
    )
    .leftJoin(
      productUnits,
      and(
        eq(productUnits.variantId, productVariants.id),
        eq(productUnits.isBaseUnit, true),
      ),
    )
    .leftJoin(
      productPrices,
      and(
        eq(productPrices.productUnitId, productUnits.id),
        eq(productPrices.priceTier, RETAIL),
      ),
    )
    .leftJoin(
      productImages,
      and(
        eq(productImages.productId, products.id),
        eq(productImages.isPrimary, true),
        eq(productImages.reviewStatus, "APPROVED"),
      ),
    )
    .where(
      mainFilter
        ? and(mainFilter, sql`${shelfLookupLogs.productId} IS NOT NULL`)
        : sql`${shelfLookupLogs.productId} IS NOT NULL`,
    )
    .groupBy(
      shelfLookupLogs.productId,
      shelfLookupLogs.productName,
      products.name,
      products.brand,
      categories.name,
      shelfLookupLogs.barcode,
      productPrices.price,
      productImages.url,
    )
    .orderBy(desc(count(shelfLookupLogs.id)))
    .limit(10);

  const topProducts = topProductsRows.map((r) => ({
    productId: Number(r.productId),
    productName: r.dbProductName || r.logProductName || "منتج غير محدد",
    brand: r.brand || null,
    category: r.category || null,
    barcode: r.barcode,
    scanCount: Number(r.scanCount ?? 0),
    price: r.price ? String(r.price) : null,
    imageUrl: r.imageUrl || null,
  }));

  // ٦. المنحنى الزمني وساعات الذروة
  let activityTimeline: Array<{ label: string; date: string; scans: number; beneficiaries: number }> = [];

  if (range === "today") {
    // تقسيم اليوم إلى فترات كل 3 ساعات بتوقيت بغداد
    const hourlyRows = await db
      .select({
        hourBucket: sql<number>`FLOOR(HOUR(DATE_ADD(${shelfLookupLogs.createdAt}, INTERVAL 3 HOUR)) / 3) * 3`,
        scans: count(shelfLookupLogs.id),
        beneficiaries: countDistinct(shelfLookupLogs.visitorId),
      })
      .from(shelfLookupLogs)
      .where(todayFilter)
      .groupBy(sql`FLOOR(HOUR(DATE_ADD(${shelfLookupLogs.createdAt}, INTERVAL 3 HOUR)) / 3) * 3`);

    const hourMap = new Map<number, { scans: number; beneficiaries: number }>();
    for (const r of hourlyRows) {
      hourMap.set(Number(r.hourBucket), {
        scans: Number(r.scans ?? 0),
        beneficiaries: Number(r.beneficiaries ?? 0),
      });
    }

    const slots = [
      { h: 9, label: "9:00 ص - 12:00 م" },
      { h: 12, label: "12:00 م - 3:00 م" },
      { h: 15, label: "3:00 م - 6:00 م" },
      { h: 18, label: "6:00 م - 9:00 م" },
      { h: 21, label: "9:00 م - 12:00 ص" },
    ];

    activityTimeline = slots.map((s) => {
      const data = hourMap.get(s.h) || { scans: 0, beneficiaries: 0 };
      return {
        label: s.label,
        date: `${s.h}:00`,
        scans: data.scans,
        beneficiaries: data.beneficiaries,
      };
    });
  } else {
    // تجميع يومي لآخر 7 أو 30 يوماً
    const dailyRows = await db
      .select({
        dayYmd: sql<string>`DATE_FORMAT(DATE_ADD(${shelfLookupLogs.createdAt}, INTERVAL 3 HOUR), '%Y-%m-%d')`,
        scans: count(shelfLookupLogs.id),
        beneficiaries: countDistinct(shelfLookupLogs.visitorId),
      })
      .from(shelfLookupLogs)
      .where(mainFilter)
      .groupBy(sql`DATE_FORMAT(DATE_ADD(${shelfLookupLogs.createdAt}, INTERVAL 3 HOUR), '%Y-%m-%d')`)
      .orderBy(sql`DATE_FORMAT(DATE_ADD(${shelfLookupLogs.createdAt}, INTERVAL 3 HOUR), '%Y-%m-%d')`);

    activityTimeline = dailyRows.map((r) => {
      const parts = String(r.dayYmd).split("-");
      const shortLabel = parts.length === 3 ? `${parts[1]}/${parts[2]}` : String(r.dayYmd);
      return {
        label: shortLabel,
        date: String(r.dayYmd),
        scans: Number(r.scans ?? 0),
        beneficiaries: Number(r.beneficiaries ?? 0),
      };
    });
  }

  // ٧. سجل أحدث العمليات اللحظية (Live Stream)
  const recentLogs = await db
    .select({
      id: shelfLookupLogs.id,
      barcode: shelfLookupLogs.barcode,
      productName: shelfLookupLogs.productName,
      branchId: shelfLookupLogs.branchId,
      branchName: branches.name,
      found: shelfLookupLogs.found,
      deviceType: shelfLookupLogs.deviceType,
      createdAt: shelfLookupLogs.createdAt,
    })
    .from(shelfLookupLogs)
    .leftJoin(branches, eq(shelfLookupLogs.branchId, branches.id))
    .where(mainFilter)
    .orderBy(desc(shelfLookupLogs.createdAt))
    .limit(20);

  const recentScans = recentLogs.map((r) => ({
    id: Number(r.id),
    barcode: r.barcode,
    productName: r.productName || null,
    branchId: r.branchId ? Number(r.branchId) : null,
    branchName: r.branchName || "عام",
    found: Boolean(r.found),
    deviceType: r.deviceType || "unknown",
    createdAt: r.createdAt.toISOString(),
  }));

  return {
    totalScans,
    uniqueBeneficiaries,
    todayScans: Number(todayRow?.todayScans ?? 0),
    todayBeneficiaries: Number(todayRow?.todayBeneficiaries ?? 0),
    foundScans,
    notFoundScans,
    successRate,
    deviceBreakdown,
    branchBreakdown,
    topProducts,
    activityTimeline,
    recentScans,
  };
}

/** كائن بيانات فارغ للسلامة */
function createEmptyStats(): ShelfBeneficiariesStats {
  return {
    totalScans: 0,
    uniqueBeneficiaries: 0,
    todayScans: 0,
    todayBeneficiaries: 0,
    foundScans: 0,
    notFoundScans: 0,
    successRate: 100,
    deviceBreakdown: { ios: 0, android: 0, desktop: 0, other: 0 },
    branchBreakdown: [],
    topProducts: [],
    activityTimeline: [],
    recentScans: [],
  };
}

/**
 * مسح وتصفير كافة سجلات استعلامات الرفوف والبيانات الوهمية للبدء من الصفر بحركات حقيقية فقط.
 */
export async function purgeShelfLookupLogs(): Promise<number> {
  const db = getDb();
  if (!db) return 0;

  try {
    const [res] = await db.execute(sql`DELETE FROM ${shelfLookupLogs}`);
    return Number((res as any)?.affectedRows ?? 0);
  } catch (err) {
    logger.error({ err }, "shelf.lookup.purge_failed");
    throw err;
  }
}
