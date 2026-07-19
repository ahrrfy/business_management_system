// قاعدة العمل دون اتصال (IndexedDB عبر Dexie) — الشريحة ٢ من خطة الأوفلاين.
// تحمل «نموذج قراءة» الكتالوج/المخزون/العملاء الذي يُبقي الكاشير قادراً على التصفح والمسح
// والتسعير أثناء الانقطاع، وجدول `outbox` (يُستعمل في الشريحة ٣) لطابور المبيعات الملتقطة.
// المخزن دائم قدر الإمكان: نطلب navigator.storage.persist() عند أول تهيئة (منع الإخلاء
// التلقائي)؛ ومسح بيانات المتصفح يبقى قادراً على محوه — لذا تحذير صريح في شاشة الإعداد
// وسياسة «لا مسح والطابور غير فارغ» (الشريحة ٥).

import Dexie, { type Table } from "dexie";
import type { OfflineCatalogRow, OfflineCustomerRow, OfflineStockRow } from "@shared/offlineCatalog";

export interface OfflineMetaRow {
  key: string;
  value: string;
}

/** عنصر طابور المبيعات الأوفلاينية — يُملأ في الشريحة ٣؛ الجدول معرَّف من الآن كي لا نحتاج
 *  ترقية نسخة Dexie لاحقاً. الحمولة بشكل CreateSaleInput (عقد الخادم) + بيانات العرض. */
export interface OfflineOutboxItem {
  clientRequestId: string;
  kind: "SALE";
  payload: unknown;
  offlineReceiptNumber: string;
  capturedAt: string;
  shiftId: number | null;
  branchId: number;
  status: "QUEUED" | "SENDING" | "SENT" | "PARKED";
  attempts: number;
  lastError: string | null;
  /** إجمالي الفاتورة نصاً decimal — لصمّام سقف قيمة الطابور. */
  total: string;
  /** الرقم الرسمي INV بعد الترحيل الناجح — درج المزامنة يعرض ربط OFF ↔ INV. */
  resultInvoiceNumber?: string;
}

/** مفاتيح WebCrypto المخزونة (CryptoKey غير قابل للاستخراج — structured clone يحفظه بلا كشف). */
export interface OfflineKeyRow {
  name: string;
  key: CryptoKey;
}

/** ملف التعريف الأوفلايني للجهاز (ش٥): هوية آخر مستخدم دخل أونلاين + PIN مجزّأ PBKDF2 —
 *  حراسة واجهة عند الإقلاع دون اتصال، لا تشفيرَ هوية (يُصارَح المالك). */
export interface OfflineProfileRow {
  key: "profile";
  userId: number;
  name: string;
  role: string;
  branchId: number | null;
  pinSalt: Uint8Array | null;
  pinHash: Uint8Array | null;
  savedAt: string;
}

class OfflineDb extends Dexie {
  catalog!: Table<OfflineCatalogRow, number>;
  stock!: Table<OfflineStockRow, number>;
  customers!: Table<OfflineCustomerRow, number>;
  meta!: Table<OfflineMetaRow, string>;
  outbox!: Table<OfflineOutboxItem, string>;
  keys!: Table<OfflineKeyRow, string>;
  profile!: Table<OfflineProfileRow, string>;

  constructor() {
    super("alroya-offline");
    this.version(1).stores({
      // *allBarcodes فهرس multiEntry: بحث المسح بضربة فهرس واحدة عبر الأساسي والبدائل معاً.
      catalog: "productUnitId, variantId, productId, *allBarcodes",
      stock: "variantId",
      customers: "id",
      meta: "key",
      outbox: "clientRequestId, status, capturedAt",
    });
    // ش٥: مفاتيح التشفير + ملف الجهاز (ترقية جمعية — بيانات النسخة ١ تبقى كما هي).
    this.version(2).stores({
      keys: "name",
      profile: "key",
    });
  }
}

export const offlineDb = new OfflineDb();

export async function getMeta(key: string): Promise<string | null> {
  try {
    const row = await offlineDb.meta.get(key);
    return row?.value ?? null;
  } catch {
    return null;
  }
}

export async function setMeta(key: string, value: string): Promise<void> {
  try {
    await offlineDb.meta.put({ key, value });
  } catch {
    // وضع خاص/حصة ممتلئة — الطبقة اختيارية: فشل الكتابة لا يكسر التشغيل الأونلايني.
  }
}

let persistRequested = false;

/** طلب التخزين الدائم (منع إخلاء IndexedDB تلقائياً عند ضغط القرص) — مرة واحدة لكل جلسة.
 *  النتيجة تُحفظ في meta ليعرضها إعداد الجهاز (الشريحة ٥) مع تحذير مسح بيانات المتصفح. */
export async function requestPersistentStorage(): Promise<boolean> {
  if (persistRequested) return (await getMeta("storagePersisted")) === "1";
  persistRequested = true;
  try {
    const persisted = (await navigator.storage?.persist?.()) ?? false;
    await setMeta("storagePersisted", persisted ? "1" : "0");
    return persisted;
  } catch {
    return false;
  }
}
