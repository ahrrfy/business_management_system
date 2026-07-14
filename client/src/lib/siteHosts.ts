// سياسة الدومينَين — مصدر الحقيقة الوحيد لفصل «العام للناس» عن «الخاص بالشركة» (قرار المالك ١٤/٧):
//
//   • الدومين العام  https://alarabiya.online        ⇒ كل ما يخدم الناس: المتجر + صفحة الوظائف.
//   • دومين الشركة   https://srv1548487.hstgr.cloud  ⇒ كل ما هو داخلي: الدخول، لوحة الموظف، الكاشير،
//     التقارير، المخزون، لوحة المتجر (store-admin)، الكشك، بوّابة الجرد… إلخ.
//
// التطبيق واحد يُخدَم على المضيفَين (نفس عملية PM2 عبر كتلتَي nginx) ⇒ الفصل يُفرَض هنا في الواجهة:
// أي مسار داخلي فُتح على الدومين العام يُحوَّل لدومين الشركة، وأي صفحة عامة فُتحت على دومين الشركة
// تُحوَّل للدومين العام (الروابط القديمة تبقى تعمل بالتحويل بدل أن تنكسر).
//
// الجذر «/» استثناء مقصود: معناه يختلف بالمضيف (العام ⇒ المتجر، الشركة ⇒ لوحة الموظف) فلا يُحوَّل.
// على مضيف غير معروف (localhost/تطوير/معاينة) لا سياسة إطلاقاً — التطوير المحلي يعمل كما هو.

/** يزيل الشرطة المائلة الذيلية (وإلا بنَينا `https://host//pos`). */
const trimSlash = (s: string): string => s.replace(/\/+$/, "");

/** أصل الدومين العام (قابل للتجاوز ببيئة البناء عند تغيير الدومين مستقبلاً). */
export const PUBLIC_ORIGIN: string = trimSlash(
  (import.meta.env?.VITE_PUBLIC_SITE_ORIGIN as string | undefined) ?? "https://alarabiya.online",
);

/** أصل دومين الشركة (النظام الداخلي). */
export const INTERNAL_ORIGIN: string = trimSlash(
  (import.meta.env?.VITE_INTERNAL_SITE_ORIGIN as string | undefined) ?? "https://srv1548487.hstgr.cloud",
);

function hostOf(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return "";
  }
}

const PUBLIC_HOST = hostOf(PUBLIC_ORIGIN);
const INTERNAL_HOST = hostOf(INTERNAL_ORIGIN);

/** مضيفات الدومين العام (مع www). */
export const PUBLIC_HOSTS: string[] = PUBLIC_HOST ? [PUBLIC_HOST, `www.${PUBLIC_HOST}`] : [];
/** مضيفات دومين الشركة. */
export const INTERNAL_HOSTS: string[] = INTERNAL_HOST ? [INTERNAL_HOST] : [];

/** الصفحات العامة (بيتها الدومين العام) — تُحوَّل إليه إن فُتحت على دومين الشركة. */
export const PUBLIC_PATHS = ["/store", "/apply"] as const;

/**
 * مسارات **مشتركة**: مسموحة على المضيفَين ولا تُحوَّل أبداً — لأن **تطبيق المناديب على Play (TWA)
 * مبنيٌّ على alarabiya.online** ويحوي اختصار «توصيلاتي» (`twa/twa-manifest.json`): المندوب يسجّل
 * دخوله ويعمل **داخل** التطبيق على الدومين العام. تحويلها لدومين الشركة يقذف المندوب خارج نطاق
 * التطبيق (شريط متصفّح + جلسة جديدة — الكوكي مقصور على المضيف بلا `domain`) ⇒ كسرُ تطبيقٍ منشور.
 *
 * القائمة = ما يحتاجه المندوب **داخل تطبيقه** حصراً، لا أكثر (مراجعة عدائية ١٤/٧):
 *  • `/login`         — الدخول داخل التطبيق.
 *  • `/my-deliveries` — شاشته الذاتية (اختصار التطبيق).
 *  • `/account`       — «حسابي»: تغيير كلمة المرور. إلزاميّ: كل مستخدم جديد يُنشأ بـmustChangePassword
 *                        فأول دخول يقوده إلى `/account?mustChange=1` — تحويله كان يقذفه لمضيفٍ بلا
 *                        جلسة فينتهي بنموذج دخول فارغ بلا رجعة.
 * لا يُوسَّع لأي شاشة موظفين أخرى (الكاشير/التقارير/لوحة المتجر… داخلية وتُحوَّل).
 */
export const SHARED_PATHS = ["/login", "/my-deliveries", "/account"] as const;

function matches(pathname: string, list: readonly string[]): boolean {
  return list.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** هل المسار صفحة عامة؟ (يشمل المسارات الفرعية مثل /store/xyz) */
export function isPublicPath(pathname: string): boolean {
  return matches(pathname, PUBLIC_PATHS);
}

/** هل المسار مشترك بين المضيفَين (لا يُحوَّل في أي اتجاه)؟ */
export function isSharedPath(pathname: string): boolean {
  return matches(pathname, SHARED_PATHS);
}

export function isPublicHost(hostname: string): boolean {
  return PUBLIC_HOSTS.includes(hostname);
}
export function isInternalHost(hostname: string): boolean {
  return INTERNAL_HOSTS.includes(hostname);
}

/**
 * قلب السياسة — دالة نقيّة قابلة للاختبار: أي أصلٍ يجب أن يخدم هذا (المضيف، المسار)؟
 * `null` = ابقَ حيث أنت (مضيف تطوير غير معروف، أو المسار في مكانه الصحيح، أو الجذر).
 */
export function resolveHostRedirect(hostname: string, pathname: string): "public" | "internal" | null {
  // حارس سوء ضبط: أصلان بنفس المضيف (أو أصل غير صالح) ⇒ التحويل سيقود لنفس الرابط = إعادة تحميل لا نهائية.
  if (!PUBLIC_HOST || !INTERNAL_HOST || PUBLIC_HOST === INTERNAL_HOST) return null;
  const onPublic = isPublicHost(hostname);
  const onInternal = isInternalHost(hostname);
  if (!onPublic && !onInternal) return null; // تطوير/معاينة — لا سياسة
  if (pathname === "/") return null; // الجذر يعني شيئاً مختلفاً على كل مضيف (مقصود)
  if (isSharedPath(pathname)) return null; // تطبيق المناديب (TWA) يعيش على الدومين العام
  if (onPublic && !isPublicPath(pathname)) return "internal";
  if (onInternal && isPublicPath(pathname)) return "public";
  return null;
}

/** يبني الوجهة الكاملة مع حفظ المسار والاستعلام والمرساة (لا تُفقَد روابط عميقة). */
export function redirectTargetUrl(
  kind: "public" | "internal",
  loc: { pathname: string; search: string; hash: string },
): string {
  const origin = kind === "public" ? PUBLIC_ORIGIN : INTERNAL_ORIGIN;
  return `${origin}${loc.pathname}${loc.search}${loc.hash}`;
}

const currentHost = (): string => (typeof window !== "undefined" ? window.location.hostname : "");
const currentOrigin = (): string => (typeof window !== "undefined" ? window.location.origin : "");
const isKnownHost = (hostname: string): boolean => isPublicHost(hostname) || isInternalHost(hostname);

/**
 * أصل الروابط **العامة** التي تُشارَك مع الناس (تُنسَخ/تُرسَل/تُطبَع): على مضيف إنتاجي ⇒ الدومين
 * العام **دائماً** — حتى لو كان الموظف يتصفّح دومين الشركة، فالرابط المنشور للناس يجب أن يحمل
 * `alarabiya.online`. على مضيف تطوير ⇒ الأصل الحالي (كي تعمل الروابط محلياً).
 */
function publicOriginFor(hostname: string): string {
  return isKnownHost(hostname) ? PUBLIC_ORIGIN : currentOrigin();
}

/**
 * أصل الروابط **الداخلية** التي تُشارَك مع الموظفين (بوّابة الجرد، مُشغّل الكشك…): على مضيف
 * إنتاجي ⇒ دومين الشركة **دائماً** (لا يتبع المضيف الذي صادف أن الموظف يتصفّحه)؛ وفي التطوير ⇒
 * الأصل الحالي.
 */
export function internalUrl(path = "", hostname: string = currentHost()): string {
  return `${isKnownHost(hostname) ? INTERNAL_ORIGIN : currentOrigin()}${path}`;
}

/** رابط المتجر للزبون (يُشارَك/يُفتح) — الدومين العام. */
export function storefrontUrl(hostname: string = currentHost()): string {
  return `${publicOriginFor(hostname)}/store`;
}

/** رابط صفحة الوظائف العامة (يُنسَخ ويُنشر في إعلانات التوظيف) — الدومين العام. */
export function careersUrl(hostname: string = currentHost()): string {
  return `${publicOriginFor(hostname)}/apply`;
}
