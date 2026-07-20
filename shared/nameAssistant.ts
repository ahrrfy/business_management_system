/**
 * مساعد تسمية المنتج — طبقتان حتميّتان (بلا AI، بلا شبكة):
 *
 * ١) `suggestCleanName`: منظّف صيغة **عرضيّ** (display-space) يقترح صيغة موحّدة للاسم
 *    كما سيظهر في البيع/الفواتير/الملصقات. غير متلف: لا يُطبَّق إلا بنقرة المستخدم.
 *    ⚠️ هذا غير `normalizeSearchText` (فضاء البحث): هنا **نُبقي** الهمزات والتاء المربوطة
 *    كما كتبها المستخدم — نصلح التنسيق فقط (مسافات/كشيدة/تشكيل/أرقام/علامة الضرب/قياسات الورق).
 *
 * ٢) `findColorWordsInName`: يكشف اسم لونٍ داخل اسم المنتج (على قاموس بنك الألوان) —
 *    في نموذج المتغيّرات الألوانُ تُدار في المتغيّرات لا في الاسم، وإلا طُبعت الملصقات
 *    والتصدير «قلم أزرق أزرق» (الاسم الكامل = اسم المنتج + لون المتغيّر).
 *    كلمات ملتبسة في تجارة القرطاسية/الهدايا («رصاص» قلم رصاص، «فحم» فحم رسم، «جرافيت»…)
 *    مستثناة صراحةً كي لا يُزعج التنبيه على أسماء مشروعة.
 */
import { COLOR_BANK, normalizeColorName } from "./colorBank";

/* ============================ منظّف الصيغة ============================ */

// كشيدة + حركات التشكيل + الألف الخنجرية — ضجيج تنسيقي في أسماء المنتجات.
const TATWEEL_AND_DIACRITICS = /[ـً-ْٰ]/g;
const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩"; // ٠-٩
const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹"; // ۰-۹
// فواصل بادئة/لاحقة عالقة (شرطة/فاصلة عربية ،/نقطة/شرطة سفلية/سلاش).
const EDGE_SEPARATORS = /^[\s\-_,،./]+|[\s\-_,،./]+$/g;

/** يوحّد الأرقام العربية-الهندية والفارسية إلى لاتينية (اتفاقية النظام في الأسعار/الباركود). */
function unifyDigits(s: string): string {
  let out = "";
  for (const ch of s) {
    const ai = ARABIC_DIGITS.indexOf(ch);
    const pi = PERSIAN_DIGITS.indexOf(ch);
    out += ai >= 0 ? String(ai) : pi >= 0 ? String(pi) : ch;
  }
  return out;
}

/**
 * يقترح صيغة منسَّقة للاسم. حتميّ وغير متلف — القرار للمستخدم.
 * القواعد (محافظة عمداً — صفر إيجابيات كاذبة تقريباً):
 *  - إزالة الكشيدة والتشكيل، توحيد الأرقام إلى لاتينية.
 *  - «70x100»/«70*100»/«70 × 100» ⇒ «70×100» (مقاسات المطبعة).
 *  - «a4»/«b5» ككلمة مستقلة ⇒ «A4»/«B5».
 *  - مسافات متعددة ⇒ واحدة، وحذف الفواصل العالقة في الأطراف.
 *  - حذف الكلمة المكرّرة تكراراً متتالياً حرفياً («قلم قلم جاف» ⇒ «قلم جاف»).
 */
export function suggestCleanName(raw: string): string {
  let s = (raw ?? "").replace(TATWEEL_AND_DIACRITICS, "");
  s = unifyDigits(s);
  // علامة الضرب بين رقمين — أشيع أنماط مقاسات الورق/البنرات.
  s = s.replace(/(\d)\s*[x×X*]\s*(\d)/g, "$1×$2");
  // قياسات الورق اللاتينية القياسية (a0-a9/b0-b9 ككلمة مستقلة) بالحرف الكبير.
  s = s.replace(/\b([abAB])([0-9])\b/g, (_m, l: string, d: string) => l.toUpperCase() + d);
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(EDGE_SEPARATORS, "");
  // كلمة مكرّرة متتالية حرفياً = خطأ طباعة شبه مؤكَّد.
  const tokens = s.split(" ").filter((t, i, arr) => i === 0 || t !== arr[i - 1]);
  return tokens.join(" ");
}

/* ============================ كاشف الألوان في الاسم ============================ */

/**
 * كلمات تُطابق قاموس الألوان لكنها **أسماء بضائع حقيقية** في القرطاسية/الفنون/الهدايا —
 * مستثناة من التنبيه (التنبيه إرشادي، والإيجابيات الكاذبة تقتل ثقته):
 * قلم رصاص، فحم رسم، طباشير، قلم جرافيت، مسطرة ستيل/تيتانيوم، طين/رمل (أدوات فنية)،
 * قلم زيتي (حبر زيتي)، ورق ذهب (تذهيب)، شوكولاتة/كراميل (هدايا)، بخور عود، كحلة.
 */
const AMBIGUOUS_PRODUCT_WORDS = [
  "رصاص",
  "فحم",
  "طباشير",
  "جرافيت",
  "غرافيت",
  "ستيل",
  "تيتانيوم",
  "طين",
  "رمل",
  "زيتي",
  "ذهب",
  "شوكولاته",
  "شكولاته",
  "شوكولاتة",
  "كراميل",
  "عود",
  "كحلة",
];

// خريطة مبنيّة مرّة: مفتاح مُطبَّع (اسم/مرادف) ⇒ الاسم المعياري للعرض. تُستبعد المفاتيح
// الملتبسة والقصيرة جداً (<٣ محارف مثل «دم»/«قش» — احتمال التصادم أعلى من نفعها).
const COLOR_LOOKUP: Map<string, string> = (() => {
  const ambiguous = new Set(AMBIGUOUS_PRODUCT_WORDS.map((w) => normalizeColorName(w)));
  const m = new Map<string, string>();
  for (const entry of COLOR_BANK) {
    for (const key of [entry.name, ...(entry.aliases ?? [])]) {
      const norm = normalizeColorName(key);
      if (norm.length < 3 || ambiguous.has(norm)) continue;
      if (!m.has(norm)) m.set(norm, entry.name);
    }
  }
  return m;
})();

/** أطول عبارة لونية في القاموس (كلمات) — «أزرق منتصف الليل» = ٣. */
const MAX_COLOR_PHRASE_WORDS = 3;

/**
 * يكشف ألواناً داخل اسم منتج ويعيد أسماءها المعيارية (مرتّبة بأول ظهور، بلا تكرار).
 * المطابقة بنافذة منزلقة ٣⇐١ كلمات (الأطول يفوز)، مع محاولة إسقاط «ال» التعريف
 * للكلمة المفردة («القلم الأزرق» ⇒ أزرق).
 */
export function findColorWordsInName(name: string): string[] {
  const tokens = normalizeColorName(name).split(" ").filter(Boolean);
  const found: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    let matched = false;
    for (let w = Math.min(MAX_COLOR_PHRASE_WORDS, tokens.length - i); w >= 1 && !matched; w--) {
      const phrase = tokens.slice(i, i + w).join(" ");
      let canonical = COLOR_LOOKUP.get(phrase);
      if (!canonical && w === 1 && phrase.startsWith("ال") && phrase.length >= 5) {
        canonical = COLOR_LOOKUP.get(phrase.slice(2));
      }
      if (canonical) {
        if (!found.includes(canonical)) found.push(canonical);
        i += w;
        matched = true;
      }
    }
    if (!matched) i++;
  }
  return found;
}
