// مزامنة النموذج المحلي + استعلامات الأوفلاين — الشريحة ٢ من خطة الأوفلاين.
//
// المزامنة (أونلاين فقط): تقارن نسخاً رخيصة (offline.versions) وتجلب اللقطة الكاملة عند
// التغيّر فقط؛ المخزون يُجلب في كل مزامنة (يتغيّر مع كل بيع). المحفّزات: الإقلاع، كل ١٥
// دقيقة، وفور العودة من انقطاع.
//
// الاستعلامات (أوفلاين): بحث/مسح/تسعير من Dexie تُنتج صفوفاً بشكل `PosRow` نفسه الذي
// يستهلكه الكاشير من catalog.posList — فيبقى بقية POS بلا أي تغيير. تكافؤ البحث العربي
// مضمون بنيوياً: `searchText` طُبِّع خادمياً بنفس `normalizeSearchText` المشترك الذي نطبّع
// به الاستعلام هنا.

import { useEffect } from "react";
import type {
  OfflineCatalogRow,
  OfflineCatalogSnapshot,
  OfflineCustomersSnapshot,
  OfflinePriceTier,
  OfflineStockRow,
  OfflineVersions,
} from "@shared/offlineCatalog";
import { normalizeSearchText } from "@shared/searchNormalize";
import { canonicalizeBarcodeInput } from "@shared/barcodeNormalize";
import { trpc } from "@/lib/trpc";
import { connectivity } from "./connectivity";
import { getMeta, offlineDb, requestPersistentStorage, setMeta } from "./db";

const META_CATALOG_VERSION = "catalogVersion";
const META_CUSTOMERS_VERSION = "customersVersion";
const META_STOCK_BRANCH = "stockBranchId";
const META_LAST_SYNC = "lastSyncAt";
const SYNC_INTERVAL_MS = 15 * 60_000;

export interface OfflineSyncApi {
  versions(): Promise<OfflineVersions>;
  catalogSnapshot(): Promise<OfflineCatalogSnapshot>;
  stockSnapshot(branchId: number): Promise<OfflineStockRow[]>;
  customersSnapshot(): Promise<OfflineCustomersSnapshot>;
}

export interface OfflineSyncResult {
  catalogRefreshed: boolean;
  customersRefreshed: boolean;
  catalogRows: number;
  stockRows: number;
}

let syncInFlight = false;

/** مزامنة واحدة كاملة — آمنة الفشل (انقطاع منتصفها = لا شيء يتلف؛ Dexie معاملات ذرّية). */
export async function syncOfflineCache(api: OfflineSyncApi, branchId: number): Promise<OfflineSyncResult | null> {
  if (syncInFlight) return null;
  syncInFlight = true;
  try {
    const versions = await api.versions();

    let catalogRefreshed = false;
    let catalogRows = 0;
    if ((await getMeta(META_CATALOG_VERSION)) !== versions.catalogVersion) {
      const snap = await api.catalogSnapshot();
      await offlineDb.transaction("rw", offlineDb.catalog, offlineDb.meta, async () => {
        await offlineDb.catalog.clear();
        await offlineDb.catalog.bulkPut(snap.rows);
        await offlineDb.meta.put({ key: META_CATALOG_VERSION, value: snap.version });
      });
      catalogRefreshed = true;
      catalogRows = snap.rows.length;
      void requestPersistentStorage();
    }

    let customersRefreshed = false;
    if ((await getMeta(META_CUSTOMERS_VERSION)) !== versions.customersVersion) {
      const snap = await api.customersSnapshot();
      await offlineDb.transaction("rw", offlineDb.customers, offlineDb.meta, async () => {
        await offlineDb.customers.clear();
        await offlineDb.customers.bulkPut(snap.rows);
        await offlineDb.meta.put({ key: META_CUSTOMERS_VERSION, value: snap.version });
      });
      customersRefreshed = true;
    }

    const stock = await api.stockSnapshot(branchId);
    await offlineDb.transaction("rw", offlineDb.stock, offlineDb.meta, async () => {
      await offlineDb.stock.clear();
      await offlineDb.stock.bulkPut(stock);
      await offlineDb.meta.put({ key: META_STOCK_BRANCH, value: String(branchId) });
    });

    await setMeta(META_LAST_SYNC, new Date().toISOString());
    return { catalogRefreshed, customersRefreshed, catalogRows, stockRows: stock.length };
  } catch {
    // فشل الشبكة/الخادم أثناء المزامنة ليس خطأ مستخدم — الكاش الحالي يبقى صالحاً كما هو.
    return null;
  } finally {
    syncInFlight = false;
  }
}

/**
 * محفّزات المزامنة — يُركَّب مرة في شاشة الكاشير (ولاحقاً قارئ الأسعار). لا يعمل إلا
 * بفرع معلوم ولا يزامن إلا أونلاين.
 */
export function useOfflineCatalogSync(branchId: number | null | undefined) {
  const utils = trpc.useUtils();
  useEffect(() => {
    if (!branchId) return;
    const api: OfflineSyncApi = {
      versions: () => utils.client.offline.versions.query(),
      catalogSnapshot: () => utils.client.offline.catalogSnapshot.query(),
      stockSnapshot: (b) => utils.client.offline.stockSnapshot.query({ branchId: b }),
      customersSnapshot: () => utils.client.offline.customersSnapshot.query(),
    };
    const kick = () => {
      if (connectivity.get() === "online") void syncOfflineCache(api, branchId);
    };
    kick();
    const interval = window.setInterval(kick, SYNC_INTERVAL_MS);
    const unsubscribe = connectivity.subscribe((s) => {
      if (s === "online") kick();
    });
    return () => {
      window.clearInterval(interval);
      unsubscribe();
    };
  }, [branchId, utils]);
}

// ── استعلامات الأوفلاين (شكل PosRow) ────────────────────────────────────────

/** شكل صفّ الكاشير كما يستهلكه POS من catalog.posList — نبنيه هنا حرفياً (تكافؤ عقد). */
export interface OfflinePosRow {
  productId: number;
  productName: string;
  variantId: number;
  variantName: string | null;
  color: string | null;
  size: string | null;
  sku: string;
  productUnitId: number;
  unitName: string;
  conversionFactor: string;
  barcode: string | null;
  isBaseUnit: boolean;
  price: string | null;
  stockBase: number;
  /** ٢٤/٨ — المحجوز النشط للصنف على فرع الجهاز (رسميّ + طلبات إلكترونيّة). */
  reservedBase: number;
  /** ٢٤/٨ — «المتاح للبيع» الحاكم من `loadVariantAvailability` الخادميّ (كلّ مصادر الحجز
   *  + طاقة البكج المشتقّة). `null` = مجهول (لقطةٌ قديمة قبل التوسيع أو فرعٌ لا يطابق
   *  META_STOCK_BRANCH ⇒ POS.tsx يعرض «جارٍ التحقّق» بأمان). Codex P1×٤ على PR #737. */
  availableBase: number | null;
  isService: boolean;
  /** «يُباع بالطلب» (0318): يُحفَظ في لقطة الأوفلاين كي لا تعود الشاشة تقول «نافذ» بلا اتصال
   *  على صنفٍ يقبله الخادم — مسارُ الأوفلاين متساهلٌ أصلاً (`allowNegativeStock`)، والوسمُ
   *  وحده كان سيحجب الكاشير المنقطع عن بيعٍ سيُرحَّل بنجاح عند العودة. */
  allowBackorder: boolean;
  isCustomizable: boolean;
  isPrintService: boolean;
  isContractPrice: boolean;
  isBundle: boolean;
  promotionId: number | null;
  promotionName: string | null;
  promotionDiscountForUnit: string;
  promotionEffectivePrice: string | null;
}

function tierPrice(row: OfflineCatalogRow, tier: OfflinePriceTier): string | null {
  if (tier === "WHOLESALE") return row.priceWholesale;
  if (tier === "GOVERNMENT") return row.priceGovernment;
  return row.priceRetail;
}

async function toPosRow(
  row: OfflineCatalogRow,
  tier: OfflinePriceTier,
  currentBranchId: number,
  cachedBranchId: number | null,
): Promise<OfflinePosRow> {
  const stock = await offlineDb.stock.get(row.variantId);
  const qty = stock?.qty ?? 0;
  const reservedBase = stock?.reservedBase ?? 0;
  // ٢٤/٨ (Codex P1×٤ على PR #737): `availableBase` يبقى **مجهولاً** (null) في ثلاث حالات
  // كي لا يُعلن ATP كاذباً:
  //   ⑴ لقطةٌ قديمة قبل توسيع العقد — تعرف بغياب `availableBase` من الخادم (لا وجود له في
  //      اللقطات المخزَّنة سابقاً في IndexedDB قبل ترقية العقد).
  //   ⑵ فرعُ اللقطة المحفوظة لا يطابق الفرعَ الحاليّ (تبديلٌ لم يُوفَّق باللقطة بعد).
  //   ⑶ الصفّ ذاته مفقود (لم يصل الترحيلُ الأوّل، صنفٌ جديد لم يُلتقَط بعد).
  // POS.tsx يعرض «جارٍ التحقّق» في هذه الحالات بأمان — قرارٌ سلوكيٌّ قائم في `stockState`.
  const branchMatches = cachedBranchId != null && cachedBranchId === currentBranchId;
  const hasFreshAtp = stock?.availableBase != null;
  const availableBase = branchMatches && hasFreshAtp ? stock.availableBase! : null;
  return {
    productId: row.productId,
    productName: row.productName,
    variantId: row.variantId,
    variantName: row.variantName,
    color: row.color,
    size: row.size,
    sku: row.sku,
    productUnitId: row.productUnitId,
    unitName: row.unitName,
    conversionFactor: row.conversionFactor,
    barcode: row.barcode,
    isBaseUnit: row.isBaseUnit,
    price: tierPrice(row, tier),
    stockBase: qty,
    reservedBase,
    availableBase,
    isService: row.isService,
    allowBackorder: row.allowBackorder,
    isCustomizable: row.isCustomizable,
    isPrintService: row.isPrintService,
    // أسعار العقود والعروض والكوبونات أونلاين فقط (قرار الخطة) — الحقول بثوابتها المحايدة.
    isContractPrice: false,
    isBundle: row.isBundle,
    promotionId: null,
    promotionName: null,
    promotionDiscountForUnit: "0.00",
    promotionEffectivePrice: null,
  };
}

/** ٢٤/٨ (Codex #٤ على PR #737): يقرأ الفرعَ المُخزَّن مع اللقطة، فيمرّرُه `toPosRow` كي يحرس
 *  ATP من عرض رصيدِ فرعٍ آخر بعد تبديلٍ لم يُوفَّق. `null` = لم تُخزَّن اللقطة بعد أصلاً. */
async function getCachedStockBranchId(): Promise<number | null> {
  const raw = await getMeta(META_STOCK_BRANCH);
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** بحث الكتالوج محلياً: كل كلمات الاستعلام (مُطبَّعةً) يجب أن ترد في searchText. */
export async function offlineSearchCatalog(
  query: string,
  tier: OfflinePriceTier,
  branchId: number,
  opts?: { includePrintServices?: boolean; limit?: number },
): Promise<OfflinePosRow[]> {
  const normalized = normalizeSearchText(query);
  const tokens = normalized.split(/\s+/).filter(Boolean).slice(0, 5);
  if (!tokens.length) return [];
  const limit = opts?.limit ?? 20;
  const includePrint = opts?.includePrintServices ?? false;

  const matches: OfflineCatalogRow[] = [];
  await offlineDb.catalog
    .filter((row) => {
      if (!includePrint && row.isPrintService) return false;
      return tokens.every((t) => row.searchText.includes(t));
    })
    .until(() => matches.length >= limit * 3)
    .each((row) => {
      matches.push(row);
    });

  // ترتيب تقريبي يماثل الخادم: من يبدأ بأول كلمة أولاً، ثم الأحدث (id أكبر).
  matches.sort((a, b) => {
    const aStarts = a.searchText.startsWith(tokens[0]) ? 0 : 1;
    const bStarts = b.searchText.startsWith(tokens[0]) ? 0 : 1;
    if (aStarts !== bStarts) return aStarts - bStarts;
    return b.productId - a.productId;
  });

  const cachedBranch = await getCachedStockBranchId();
  return Promise.all(matches.slice(0, limit).map((row) => toPosRow(row, tier, branchId, cachedBranch)));
}

/** مطابقة باركود (الأساسي أو أي بديل) بضربة فهرس multiEntry واحدة. */
export async function offlineFindByBarcode(
  code: string,
  tier: OfflinePriceTier,
  branchId: number,
): Promise<OfflinePosRow | null> {
  // (٤/٩) نُطبّع مُدخل المسح كما يُطبّعه المسارُ الأونلاين (`canonicalizeBarcodeInput`: تقليم + طيّ
  // الأرقام العربية-الهندية) لا مجرّد trim: باركودات اللقطة مخزَّنةٌ مُطبَّعةً (الكتابة تُطبّع دائماً)،
  // فإدخالٌ يدويّ بأرقامٍ عربية أونلاين يُحلّ وأوفلاين كان يفشل — تناقضٌ يُغلَق هنا بلا تغيير اللقطة.
  const canonical = canonicalizeBarcodeInput(code);
  if (!canonical) return null;
  const row = await offlineDb.catalog.where("allBarcodes").equals(canonical).first();
  if (!row) return null;
  const cachedBranch = await getCachedStockBranchId();
  return toPosRow(row, tier, branchId, cachedBranch);
}

/** آخر مزامنة ناجحة (ISO) — لصمّام «عمر الكاش» في الشريحة ٣ ولشاشة الحالة. */
export async function getLastSyncAt(): Promise<string | null> {
  return getMeta(META_LAST_SYNC);
}
