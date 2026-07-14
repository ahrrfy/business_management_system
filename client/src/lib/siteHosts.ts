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

/** أصل الدومين العام (قابل للتجاوز ببيئة البناء عند تغيير الدومين مستقبلاً). */
export const PUBLIC_ORIGIN: string =
  (import.meta.env?.VITE_PUBLIC_SITE_ORIGIN as string | undefined) ?? "https://alarabiya.online";

/** أصل دومين الشركة (النظام الداخلي). */
export const INTERNAL_ORIGIN: string =
  (import.meta.env?.VITE_INTERNAL_SITE_ORIGIN as string | undefined) ?? "https://srv1548487.hstgr.cloud";

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

/** الصفحات العامة (تُخدَم على الدومين العام). أي مسار آخر = داخليّ بحكم التعريف. */
export const PUBLIC_PATHS = ["/store", "/apply"] as const;

/** هل المسار صفحة عامة؟ (يشمل المسارات الفرعية مثل /store/xyz) */
export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
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
  const onPublic = isPublicHost(hostname);
  const onInternal = isInternalHost(hostname);
  if (!onPublic && !onInternal) return null; // تطوير/معاينة — لا سياسة
  if (pathname === "/") return null; // الجذر يعني شيئاً مختلفاً على كل مضيف (مقصود)
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

/**
 * رابط المتجر للزبون: على مضيف معروف (إنتاج) ⇒ الدومين العام دائماً (هو ما يُشارَك مع الزبائن)؛
 * على مضيف تطوير ⇒ رابط نسبي كي يعمل محلياً.
 */
export function storefrontUrl(hostname: string = typeof window !== "undefined" ? window.location.hostname : ""): string {
  return isPublicHost(hostname) || isInternalHost(hostname) ? `${PUBLIC_ORIGIN}/store` : "/store";
}

/** رابط صفحة الوظائف العامة — بنفس منطق رابط المتجر. */
export function careersUrl(hostname: string = typeof window !== "undefined" ? window.location.hostname : ""): string {
  return isPublicHost(hostname) || isInternalHost(hostname) ? `${PUBLIC_ORIGIN}/apply` : "/apply";
}
