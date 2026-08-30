/**
 * كاش TTL أحادي الرحلة (single-flight) داخل العملية — فحص معمارية الحمل ٣٠/٨/٢٦.
 *
 * الغرض: القراءات المكلفة التي تتفرّع لعشرات الاستعلامات (تنبيهات الإدارة ~40 استعلاماً،
 * فحص جاهزية كتالوج المتجر) كانت تُعاد كاملةً لكل مستدعٍ متزامن فتبتلع مجمّع الاتصالات.
 * هذا الكاش يجمع المستدعين المتزامنين على **تحميلةٍ واحدة** (in-flight dedup) ويعيد
 * النتيجة لمدّة TTL قصيرة.
 *
 * العقد:
 * - الفشل لا يُكيَّش أبداً: خطأ التحميل ينتشر للجميع ويُمحى من الرحلات الجارية،
 *   فالمحاولة التالية تبدأ طازجة.
 * - العزل مسؤولية المفتاح: مفتاح كاشٍ لقراءةٍ معزولة بشركة/فرع يجب أن يتضمّنهما —
 *   الكاش نفسه لا يعرف السياق (انظر مستدعيه: يضمّنون companyId درءاً لتسريبٍ نائم
 *   في وضع تعدّد الشركات).
 * - `maxEntries` طردٌ بأقدم إدراج (Map يحفظ ترتيب الإدراج، والتحديث يعيد الإدراج آخراً).
 * - الاختبارات تتجاوز الكاش من عند المستدعي (NODE_ENV=test) لا من هنا — كي تبقى
 *   المكتبة نفسها قابلة للاختبار.
 *
 * ⚠️ **`invalidate`/`clear` محلّيّتان للعملية الواحدة** (مراجعة Codex على #901): الإنتاج
 * عنقودُ PM2 بعدّة عمّال، ومسحُ كاشِ العامل الذي عالج الكتابة **لا يمسّ** كاشات إخوته —
 * فيبقى معظم المستخدمين على القيمة القديمة حتى تنقضي TTL، والمسحُ يوهم بإبطالٍ لم يقع.
 * لإبطالٍ فوريّ عبر العنقود: **اجعل رمز النسخة جزءاً من المفتاح** (عمودُ `updatedAt`
 * أو عدّادُ نسخةٍ يُقرأ أصلاً في نفس الطلب) — كما في `storeSettingsService`. استعمل
 * `invalidate`/`clear` للحالة المحلّية الخالصة أو للاختبارات فقط.
 */
export interface TtlCache<K, V> {
  get(key: K, loader: () => Promise<V>): Promise<V>;
  invalidate(key: K): void;
  clear(): void;
}

export function createTtlCache<K, V>(opts: { ttlMs: number; maxEntries?: number }): TtlCache<K, V> {
  const { ttlMs } = opts;
  const maxEntries = opts.maxEntries ?? 100;
  const values = new Map<K, { at: number; value: V }>();
  const inFlight = new Map<K, Promise<V>>();
  // حقبة الإبطال (مراجعة عدائية ٣٠/٨): تحميلٌ بدأ قبل invalidate/clear يحمل لقطةً قديمة —
  // لو كُيِّشت نتيجته **بعد** الإبطال لأبطلت الإبطالَ نفسه TTL كاملة (مثال حيّ: المالك يفتح
  // المتجر فيُبطل كاش الجاهزية، وتحميلُ زائرٍ بدأ قبل الفتح يعود بـ«غير جاهز» فيظهر المتجر
  // مغلقاً دقيقة). النتيجة تعود لمنتظريها لكنها لا تُخزَّن إلا إن بقيت حقبتها هي الحالية.
  let epoch = 0;
  return {
    async get(key: K, loader: () => Promise<V>): Promise<V> {
      const hit = values.get(key);
      if (hit && Date.now() - hit.at <= ttlMs) {
        // إعادة الإدراج عند الإصابة ⇒ الطرد بأقلّ استعمالاً حديثاً (LRU) لا بأقدم إدراج (FIFO).
        // بـFIFO كان المفتاح **الأسخن** يُطرد بعد `maxEntries` مفتاحاً جديداً مهما كثرت قراءاته
        // — وحيث يكون جزءٌ من المفتاح مُدخَلاً من الجمهور (نصّ بحث)، يكفي زاحفٌ ببضع مئات
        // مصطلحاتٍ ليُبقي الكاش فارغاً دائماً فيعود كلّ طلبٍ إلى المسح الكامل (٣١/٨/٢٦).
        values.delete(key);
        values.set(key, hit);
        return hit.value;
      }
      const pending = inFlight.get(key);
      if (pending) return pending;
      const startEpoch = epoch;
      // إسنادٌ مؤكَّد: جسم async يحوّل حتى الرمي المتزامن إلى رفضٍ لاحق، فـfinally لا يعمل
      // قبل اكتمال الإسناد أبداً — والمقارنة بالهوية تحمي تحميلةً أحدث من محو finally القديمة.
      let load!: Promise<V>;
      load = (async () => {
        try {
          const value = await loader();
          if (epoch === startEpoch) {
            values.delete(key);
            values.set(key, { at: Date.now(), value });
            if (values.size > maxEntries) {
              const oldest = values.keys().next().value;
              if (oldest !== undefined) values.delete(oldest);
            }
          }
          return value;
        } finally {
          // لا تمحُ تحميلةً أحدث حلّت محلّنا بعد إبطالٍ أثناء رحلتنا.
          if (inFlight.get(key) === load) inFlight.delete(key);
        }
      })();
      inFlight.set(key, load);
      return load;
    },
    invalidate(key: K): void {
      epoch += 1;
      values.delete(key);
      inFlight.delete(key);
    },
    clear(): void {
      epoch += 1;
      values.clear();
      inFlight.clear();
    },
  };
}
