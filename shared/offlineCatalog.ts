// عقد لقطات العمل دون اتصال (الشريحة ٢ من خطة الأوفلاين) — مشترك بين الخادم والعميل.
// الفلسفة: الخادم مصدر الحقيقة الوحيد؛ العميل يحمل «نموذج قراءة» مسطّحاً للكتالوج يكفي
// للتصفح والمسح والتسعير أثناء الانقطاع. صفّ واحد لكل (منتج × لون × وحدة) بأسعار الفئات
// الثلاث معاً — فيبقى اختيار الفئة قراراً محلياً لحظياً بلا رحلة خادم.

export type OfflinePriceTier = "RETAIL" | "WHOLESALE" | "GOVERNMENT";

export interface OfflineCatalogRow {
  productUnitId: number;
  productId: number;
  productName: string;
  variantId: number;
  variantName: string | null;
  color: string | null;
  colorHex: string | null;
  size: string | null;
  sku: string;
  unitName: string;
  /** معامل التحويل للوحدة الأساس — نصّ decimal كما في القاعدة (§٥: لا أرقام عائمة للمال/الكميات). */
  conversionFactor: string;
  barcode: string | null;
  /** كل الباركودات الصالحة للوحدة: الأساسي + البدائل — فضاء بحث المسح الموحّد. */
  allBarcodes: string[];
  isBaseUnit: boolean;
  isService: boolean;
  isBundle: boolean;
  isCustomizable: boolean;
  isPrintService: boolean;
  /** أسعار الفئات الثلاث نصوصاً decimal؛ null = لا سعر معرّفاً للوحدة×الفئة (نفس دلالة الخادم:
   *  لا fallback بين الفئات — غياب السعر يمنع البيع). */
  priceRetail: string | null;
  priceWholesale: string | null;
  priceGovernment: string | null;
  /** نصّ بحث مُطبَّع مسبقاً بـ`normalizeSearchText` المشترك — تكافؤ تام مع بحث الخادم. */
  searchText: string;
}

export interface OfflineStockRow {
  variantId: number;
  /** الرصيد بالوحدة الأساس لفرع الجهاز — استرشادي أثناء الانقطاع (قد يتقادم). */
  qty: number;
  /** ٢٤/٨ — المحجوز النشط لهذا الصنف: يشمل الحجز الرسميّ (`reservationStock`) + تخصيصات
   *  الطلبات الإلكترونيّة النشطة (loadOnlineAllocatedBase). لقطةٌ قديمة (قبل التوسيع) لا تحمله
   *  ⇒ العميل يعتبرها «مجهولة» ولا يعرض ATP. */
  reservedBase?: number;
  /** ٢٤/٨ — «المتاح للبيع» النهائيّ (`max(0, qty - reservedBase)` للأصناف العاديّة، وطاقة
   *  المكوّنات للبكج). حاسمٌ للعميل: وجودُه يعني «معروف»، غيابُه يعني «مجهول — انتظر تحديثاً». */
  availableBase?: number;
  /** ٢٤/٨ — البكج لا يملك `branchStock`، طاقتُه من `loadVariantAvailability`. العلمُ يُميّزه
   *  للعميل كي يعرف أنّ الصفر هنا ليس عطبَ بياناتٍ بل حساباً حاكماً. */
  isBundle?: boolean;
}

export interface OfflineCustomerRow {
  id: number;
  name: string;
  phone: string | null;
  defaultPriceTier: OfflinePriceTier | null;
  /** ⚠️ عمداً بلا رصيد ولا سقف ائتمان: الأوفلاين نقدي فقط (قرار مالك ١٨/٧)، ولا نخزّن
   *  ذمم العملاء على جهاز الكاشير. */
  searchText: string;
}

export interface OfflineVersions {
  /** بصمة بنية الكتالوج والأسعار — تغيّرها يستدعي جلب لقطة كتالوج كاملة. */
  catalogVersion: string;
  /** بصمة جدول العملاء النشطين. */
  customersVersion: string;
}

export interface OfflineCatalogSnapshot {
  version: string;
  generatedAt: string;
  rows: OfflineCatalogRow[];
}

export interface OfflineCustomersSnapshot {
  version: string;
  rows: OfflineCustomerRow[];
}
