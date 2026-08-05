// نسخة محليّة من بلاطات خدمات الطباعة — طبقة القراءة لكاشير الطباعة دون اتصال.
//
// لماذا نسخةٌ مستقلّة لا `offlineSearchCatalog`؟ لأن شاشة الطباعة **شبكة بلاطات** لا مربّع بحث:
// تعرض القائمة كاملةً مبوّبةً بالفئات، وتحتاج شكل `printPos.services` حرفياً (سعر الوحدة،
// الفئة، اسم الوحدة). تحويل صفوف كتالوج البحث إلى هذا الشكل كان سيُدخل مطابقةً هشّة تنجرف مع
// أيّ تغييرٍ في العقد. تخزين الاستجابة كما هي يُبقي الشاشة **مطابقةً** أونلاين وأوفلاين.
//
// الحجم: قائمة الخدمات عشراتُ عناصر لا آلاف — تخزينها كاملةً في `meta` أرخص وأدقّ من فهرسةٍ
// خاصّة بها في Dexie. تُحدَّث كلّما نجح الجلب أونلاين، فتبقى النسخة آخرَ ما رآه هذا الجهاز.

import { getMeta, setMeta } from "./db";

const KEY = "printServicesSnapshot";

interface Snapshot<T> {
  savedAt: string;
  tier: string;
  items: T[];
}

/** يحفظ آخر قائمة خدمات وصلت من الخادم. يفشل بصمت (حصّة/وضع خاص) — الطبقة اختيارية. */
export async function cachePrintServices<T>(tier: string, items: T[]): Promise<void> {
  if (!items.length) return; // لا نستبدل نسخةً صالحة بقائمةٍ فارغة (خطأ جلبٍ عابر).
  try {
    await setMeta(KEY, JSON.stringify({ savedAt: new Date().toISOString(), tier, items } satisfies Snapshot<T>));
  } catch {
    /* تجاهُل: الفشل هنا لا يكسر التشغيل الأونلايني */
  }
}

/** يقرأ النسخة المحليّة. `null` = لا نسخة بعد (الجهاز لم يعمل أونلاين قط على هذه الشاشة). */
export async function readCachedPrintServices<T>(tier: string): Promise<{ items: T[]; savedAt: string } | null> {
  try {
    const raw = await getMeta(KEY);
    if (!raw) return null;
    const snap = JSON.parse(raw) as Snapshot<T>;
    if (!Array.isArray(snap.items) || snap.items.length === 0) return null;
    // فئة سعرٍ مختلفة ⇒ لا نُقدّم أسعاراً لا تخصّها (بيعٌ بسعرٍ خاطئ أسوأ من شاشةٍ فارغة).
    if (snap.tier !== tier) return null;
    return { items: snap.items, savedAt: snap.savedAt };
  } catch {
    return null;
  }
}
