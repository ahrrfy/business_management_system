import { useEffect, useId } from "react";
import { confirm } from "@/lib/confirm";
import { noteInteraction } from "@/lib/interactionDraft";

/**
 * حارس فقدان البيانات — يعترض جميع مسارات المغادرة حين يحمل النموذج تعديلاتٍ غير محفوظة:
 *
 * 1. **`beforeunload`** (كما كان): تحديث الصفحة، إغلاق التبويب، الانتقال إلى موقع خارجيّ —
 *    يعرض حوار المتصفّح القياسيّ (بلا مؤثّرٍ للنصّ المخصّص في المتصفّحات الحديثة).
 * 2. **⭐ نقر رابط SPA داخليّ (wouter)**: يستمع في **طور التقاط** النقرة على `document` قبل
 *    أن يصل الحدث إلى مُعالج React الاصطناعيّ لـ`<Link>` (React 17+ يربط على جذر التطبيق،
 *    فطور التقاط `document` يسبقه). عند dirty=true يستدعي `preventDefault` +
 *    `stopPropagation`، ويعرض `confirm()` عربيّاً موحّداً؛ إن قبل المستخدم المغادرة، ينفّذ
 *    `history.pushState` — وwouter monkey-patches الدالّة فتُحدَّث الشجرة تلقائياً.
 * 3. **⭐ التنقّل البرمجيّ عبر wouter (`navigate()`) أو أيّ استدعاءٍ لـ`pushState`/`replaceState`**:
 *    نُرصّع الدالّتين — نحتفظ بالأصليّتين ونبدّلهما بغلافٍ يفحص `anyDirty()` **قبل** التنفيذ.
 *    عند dirty=true وتغيّر المسار، يوقف الغلاف نداء الأصليّة ويعرض الحوار؛ بعد قبول
 *    المستخدم يُستدعى المرجعُ الأصليّ ذاته بنفس الوسائط. علَم `bypassPopstate`
 *    (وحيدُ الاستعمال داخل الوحدة) يمنع إعادة الاعتراض على استرجاعنا الداخليّ.
 *    (كان الرصعُ سابقاً يقرأ `lastPath` **بعد** التنفيذ فقط — فيمرّ `navigate()` بلا حوار.)
 * 4. **⭐ زر الرجوع في المتصفّح (`popstate`)**: `popstate` يُطلَق **بعد** تغيّر URL ولا يمكن
 *    إلغاؤه؛ فنستعيد المسار السابق فوراً بـ`pushState` ثمّ نعرض الحوار — إن قبل المستخدم،
 *    نطلق `history.back()` **مرّةً واحدة** بعلَم `bypassPopstate` (بدل `pushState` جديد كان
 *    يُنتج سجلَّ `[A, B, A]` فيعود Back القادم إلى B لا X). المعالج يفحص العلَم قبل أيّ
 *    منطقٍ ويعود صامتاً — فيُتمّ المتصفّح المسار الأصليّ للمستخدم بلا تراكم سجلّ.
 *
 * **سبب التصميم بسجلٍّ مركزيّ**: قد يكون في الشجرة أكثر من نموذجٍ يستدعي الحارس (مثل
 * محرّر ضمن حوار داخل شاشة قابلة للتعديل). نُبقي مجموعةً واحدة (`dirty: Set<string>`)
 * ونُثبّت المستمعات مرّةً واحدة على أوّل تسجيل dirty، ونُزيلها عند تفريغ السجلّ —
 * فلا مستمعاتٍ معلّقة تُبقي حواراً على شاشةٍ نظيفة.
 *
 * **حماية السباقات**: قد ينجح الحفظ أثناء عرض الحوار (isDirty يعود false)؛ ندع الحوار
 * يفتح لكنّا نفحص `anyDirty()` بعد `await`، وإن خلا السجلّ سمحنا بالانتقال بلا سؤال.
 *
 * ⛔ لا `window.confirm`: يحرسه `check:no-window-dialogs` — نستعمل `confirm()` من
 * `@/lib/confirm` الذي يوفّر AlertDialog عربيّ RTL بواجهة النظام.
 */

// -----------------------------------------------------------------------------
// السجلّ المركزيّ ومصانع URL
// -----------------------------------------------------------------------------

const dirty = new Set<string>();
let installed = false;
let lastPath = "";

/**
 * ⭐ مراجع الأصليّتين قبل الترقيع (Codex #979 P1). نحتفظ بها لسببين:
 *  - `uninstall()` يستعيدها فنترك التاريخَ نظيفاً بلا آثار رَصعنا.
 *  - `handlePopState` يستعمل `originalPushState` مباشرةً لاسترجاع URL بلا استفزاز
 *     الغلاف الجديد لفتح حوارٍ متكرّر (re-entrancy).
 */
let originalPushState: History["pushState"] | null = null;
let originalReplaceState: History["replaceState"] | null = null;

/**
 * ⭐ علَم يُستهلَك مرّة واحدة (Codex #979 P2). نضبطه قبل `history.back()` عند قبول
 * المستخدم المغادرة عبر Back؛ يفحصه معالج `popstate` أوّلاً ويصفّره ويعود بلا حوار —
 * فيُتمّ المتصفّح المسار الأصليّ بلا سؤالٍ ثانٍ وبلا `pushState` يُضيف سجلاً مكرّراً.
 */
let bypassPopstate = false;

function currentPath(): string {
  if (typeof window === "undefined") return "";
  return (
    window.location.pathname + window.location.search + window.location.hash
  );
}

function anyDirty(): boolean {
  return dirty.size > 0;
}

// -----------------------------------------------------------------------------
// المسند النقيّ: هل نعترض نقرة الرابط؟
// -----------------------------------------------------------------------------

/** لقطةٌ محايدة للنقرة والرابط — تُبنى من الحدث الحيّ في الإنتاج، وتُصاغ يدوياً في الاختبار. */
export type ClickIntent = Readonly<{
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
  href: string; // قيمة `<a href>` الحرفيّة
  target: string; // قيمة `<a target>` — "_blank" مثلاً
  download: boolean;
  toOrigin: string; // origin الرابط بعد الحلّ إلى URL مطلق
  toPath: string; // pathname + search + hash للرابط
  currentOrigin: string;
  currentPath: string;
}>;

/**
 * يقرّر بشكلٍ محضٍ (بلا DOM حيّ) ما إذا كنّا نعترض هذه النقرة.
 *
 * القواعد المرفوضة (نترك السلوك الافتراضي):
 *  - النقرة أُلغيت بمعالجٍ سابق (`defaultPrevented`).
 *  - زرّ غير أيسر (وسط/يمين).
 *  - مفاتيح مضغوطة (Ctrl/Cmd/Alt/Shift): «فتح في تبويب» أو تحديد سياق.
 *  - `<a download>` أو `target="_blank"`/غير `_self`: تحميلات ونوافذ جانبية.
 *  - `href` فارغ.
 *  - origin مختلف: رابطٌ خارجيّ ⇒ `beforeunload` يتكفّل به.
 *  - نفس المسار الحاليّ: لا انتقال حقيقيّ.
 */
export function shouldInterceptAnchorClick(intent: ClickIntent): boolean {
  if (intent.defaultPrevented) return false;
  if (intent.button !== 0) return false;
  if (intent.ctrlKey || intent.metaKey || intent.altKey || intent.shiftKey)
    return false;
  if (intent.download) return false;
  if (intent.target && intent.target !== "" && intent.target !== "_self")
    return false;
  if (!intent.href) return false;
  if (intent.toOrigin !== intent.currentOrigin) return false;
  if (intent.toPath === intent.currentPath) return false;
  return true;
}

// -----------------------------------------------------------------------------
// حوار التأكيد ومحلّل «ماذا بعد الموافقة؟» (نقيّ)
// -----------------------------------------------------------------------------

async function promptLeaveUnsaved(): Promise<boolean> {
  // سباق: قد يكون النموذج نُظِّف بين الاعتراض والحوار ⇒ نتجاوز الحوار.
  if (!anyDirty()) return true;
  return confirm({
    variant: "warning",
    title: "لديك تعديلاتٌ غير محفوظة",
    description: "المغادرة الآن ستُلغي هذه التعديلات — هل تُغادر؟",
    confirmText: "مغادرة",
    cancelText: "البقاء",
  });
}

/**
 * منطق «بعد اعتراض النقرة»: يعرض الحوار ويُعيد المسار المطلوب الانتقال إليه (أو `null` للبقاء).
 * منفصلٌ عن أيّ DOM حيّ لسهولة الاختبار وضبط السباقات.
 */
export async function resolveNavigationAfterPrompt(
  intent: ClickIntent,
): Promise<string | null> {
  const ok = await promptLeaveUnsaved();
  if (!ok) return null;
  // سباقٌ إضافيّ: النموذج قد يعود dirty=false أثناء الحوار — نسمح بالانتقال بلا سؤال.
  return intent.toPath;
}

// -----------------------------------------------------------------------------
// استخراج النيّة من حدثٍ حقيقيّ
// -----------------------------------------------------------------------------

function extractIntentFromEvent(event: MouseEvent): ClickIntent | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  const anchor = target.closest("a[href]");
  if (!(anchor instanceof HTMLAnchorElement)) return null;
  const rawHref = anchor.getAttribute("href") ?? "";
  if (!rawHref) return null;
  let resolved: URL;
  try {
    resolved = new URL(anchor.href, window.location.href);
  } catch {
    return null;
  }
  const cur = new URL(window.location.href);
  return {
    button: event.button,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    defaultPrevented: event.defaultPrevented,
    href: rawHref,
    target: anchor.getAttribute("target") ?? "",
    download: anchor.hasAttribute("download"),
    toOrigin: resolved.origin,
    toPath: resolved.pathname + resolved.search + resolved.hash,
    currentOrigin: cur.origin,
    currentPath: cur.pathname + cur.search + cur.hash,
  };
}

// -----------------------------------------------------------------------------
// ⭐ رصعُ pushState/replaceState — يعترض التنقّل البرمجيّ (Codex #979 P1)
// -----------------------------------------------------------------------------

/**
 * يُحلّل الوسيط `url` لدالّة `pushState`/`replaceState` إلى `pathname+search+hash` داخل
 * origin الحاليّ. يُرجع `null` إن كان الوسيط `undefined`/`null` أو `URL` غير قابل للحلّ أو
 * origin مختلف (فتلك حالاتٌ لا نعترضها).
 */
function targetPathFromHistoryUrl(
  url: string | URL | null | undefined,
): string | null {
  if (url === undefined || url === null) return null;
  if (typeof window === "undefined") return null;
  try {
    const resolved = new URL(String(url), window.location.href);
    if (resolved.origin !== window.location.origin) return null;
    return resolved.pathname + resolved.search + resolved.hash;
  } catch {
    return null;
  }
}

type HistoryStateFn = History["pushState"] | History["replaceState"];

/**
 * يُنتج غلافاً حول `history.pushState` أو `history.replaceState` يفحص `anyDirty()` قبل
 * تنفيذ التنقّل. ثلاثة مسارات:
 *  - غير dirty ⇒ نداءٌ مباشر للأصليّة.
 *  - dirty لكن `url` غيرُ قابلٍ للاعتراض (فارغ، أو origin آخر، أو نفس المسار الحاليّ) ⇒ مباشر.
 *  - dirty وanتقالٌ حقيقيّ ⇒ نوقف النداء، نفتح الحوار، وعند القبول نُطلق الأصليّة **بذات
 *     الوسائط**. الرفض يترك URL بلا تغيير.
 *
 * ⚠️ التنقّل يصير غيرَ متزامنٍ عمداً (المتّصل `wouter.navigate()` لا يفحص القيمة المُرجَعة).
 */
function makeHistoryInterceptor(original: HistoryStateFn): HistoryStateFn {
  return function interceptor(
    this: History,
    state: unknown,
    title: string,
    url?: string | URL | null,
  ): void {
    if (!anyDirty()) {
      original.call(this, state, title, url);
      return;
    }
    const target = targetPathFromHistoryUrl(url);
    if (target === null || target === currentPath()) {
      // لا نعترض: URL غيرُ محلّي، أو نفس المسار (نمطُ replaceState الشائع في React).
      original.call(this, state, title, url);
      return;
    }
    void promptLeaveUnsaved().then((ok) => {
      if (!ok) return;
      // ⭐ المرجع الأصليّ ذاته (المحفوظ قبل الرَصع) بنفس الوسائط.
      original.call(window.history, state, title, url);
      lastPath = target;
    });
  } as HistoryStateFn;
}

// -----------------------------------------------------------------------------
// مستمعو DOM
// -----------------------------------------------------------------------------

function handleClickCapture(event: MouseEvent): void {
  if (!anyDirty()) return;
  const intent = extractIntentFromEvent(event);
  if (!intent) return;
  if (!shouldInterceptAnchorClick(intent)) return;
  event.preventDefault();
  event.stopPropagation();
  void resolveNavigationAfterPrompt(intent).then((path) => {
    if (path !== null) {
      // wouter يرصع `pushState` عبر monkey-patch ⇒ الشجرة تتبع تلقائياً.
      window.history.pushState(null, "", path);
      lastPath = path;
    }
  });
}

function handleBeforeUnload(event: BeforeUnloadEvent): void {
  if (!anyDirty()) return;
  event.preventDefault();
  // مطلوبٌ في بعض المتصفّحات القديمة كي يظهر حوار التأكيد.
  event.returnValue = "";
}

function handlePopState(_event: PopStateEvent): void {
  // ⭐ Codex #979 P2: علَم يُستهلَك مرّة واحدة لتجاوز `back()` الذي أطلقناه بأنفسنا.
  if (bypassPopstate) {
    bypassPopstate = false;
    lastPath = currentPath();
    return;
  }
  const attempted = currentPath();
  if (!anyDirty()) {
    lastPath = attempted;
    return;
  }
  if (attempted === lastPath) return;
  const restore = lastPath;
  // نُعيد URL فوراً قبل عرض الحوار — حتى لا يظهر «شاشة الوجهة» خلف الحوار.
  // نستعمل **الأصليّة** مباشرةً لتجاوز رَصعنا (وإلّا فتح غلاف pushState حواراً ثانياً).
  const rawPushState =
    originalPushState ?? window.history.pushState.bind(window.history);
  rawPushState.call(window.history, null, "", restore);
  void promptLeaveUnsaved().then((ok) => {
    if (!ok) {
      lastPath = restore;
      return;
    }
    // ⭐ Codex #979 P2: `history.back()` بعلَم bypass — يُتمّ المسار الأصليّ للمستخدم
    // بلا `pushState` جديد يُنتج تراكم `[A, B, A]`. المعالج يفحص العلَم أوّلاً ويعود صامتاً.
    bypassPopstate = true;
    window.history.back();
  });
}

function handlePushLikeEvent(): void {
  // wouter يُطلق أحداث `pushState`/`replaceState` بعد كلّ تنقّلٍ ناجح.
  lastPath = currentPath();
}

// -----------------------------------------------------------------------------
// التركيب/الإزالة الكسولة
// -----------------------------------------------------------------------------

function install(): void {
  if (installed) return;
  if (typeof window === "undefined" || typeof document === "undefined") return;
  installed = true;
  lastPath = currentPath();
  // ⭐ Codex #979 P1: احفظ الأصليّتين (قد تكونان مُرَصَّعتَين مسبقاً بـwouter — لا يهمّ،
  // نغلف الحالة الراهنة ونعيدها كما هي عند `uninstall`)، ثمّ ركّب الغلاف.
  originalPushState = window.history.pushState;
  originalReplaceState = window.history.replaceState;
  window.history.pushState = makeHistoryInterceptor(
    originalPushState,
  ) as History["pushState"];
  window.history.replaceState = makeHistoryInterceptor(
    originalReplaceState,
  ) as History["replaceState"];
  // capture=true: نسبق مُعالج React الاصطناعيّ لـ`<Link>` (المربوط على جذر التطبيق).
  document.addEventListener("click", handleClickCapture, true);
  window.addEventListener("popstate", handlePopState);
  window.addEventListener("beforeunload", handleBeforeUnload);
  window.addEventListener("pushState", handlePushLikeEvent as EventListener);
  window.addEventListener("replaceState", handlePushLikeEvent as EventListener);
}

function uninstall(): void {
  if (!installed) return;
  if (typeof window === "undefined" || typeof document === "undefined") return;
  installed = false;
  // ⭐ Codex #979 P1: استعادة الأصليّتين — تنظيفٌ متماثلٌ للرَصع.
  if (originalPushState) window.history.pushState = originalPushState;
  if (originalReplaceState) window.history.replaceState = originalReplaceState;
  originalPushState = null;
  originalReplaceState = null;
  bypassPopstate = false;
  document.removeEventListener("click", handleClickCapture, true);
  window.removeEventListener("popstate", handlePopState);
  window.removeEventListener("beforeunload", handleBeforeUnload);
  window.removeEventListener("pushState", handlePushLikeEvent as EventListener);
  window.removeEventListener(
    "replaceState",
    handlePushLikeEvent as EventListener,
  );
}

// -----------------------------------------------------------------------------
// الواجهة العامة
// -----------------------------------------------------------------------------

/**
 * يسجّل حالة «قذارة» النموذج مركزياً. مرّر `isDirty=true` فقط عندما يكون هناك تعديلٌ فعليّ
 * لم يُحفظ (لا افتراضياً على شاشة الإنشاء الفارغة، وإلّا تدرّب المستخدم على تجاهل الحوار).
 * أعد `isDirty=false` فور نجاح الحفظ حتى يتسنّى للحارس السماح بالمغادرة بلا سؤال.
 */
export function useUnsavedGuard(isDirty: boolean): void {
  const id = useId();
  useEffect(() => {
    if (!isDirty) {
      dirty.delete(id);
      if (dirty.size === 0) uninstall();
      return;
    }
    // يبلّغ مدير PWA أيضاً بوجود إدخالٍ حديث (شبكة أمانٍ للإدخالات غير المرتبطة بمسودة).
    noteInteraction();
    dirty.add(id);
    install();
    return () => {
      dirty.delete(id);
      if (dirty.size === 0) uninstall();
    };
  }, [id, isDirty]);
}

// -----------------------------------------------------------------------------
// تصديرات للاختبار فقط
// -----------------------------------------------------------------------------

/** @internal — واجهة اختبارية؛ لا تستعملها في كود الإنتاج. */
export const __TEST_ONLY__ = {
  shouldInterceptAnchorClick,
  resolveNavigationAfterPrompt,
  targetPathFromHistoryUrl,
  handlePopState,
  install,
  uninstall,
  register(id: string): void {
    dirty.add(id);
  },
  unregister(id: string): void {
    dirty.delete(id);
  },
  reset(): void {
    // نُنظّف الرَصع أوّلاً حتى نعيد globalThis.history إلى الأصليّة قبل حذف الاختبار للـstubs.
    uninstall();
    dirty.clear();
    installed = false;
    lastPath = "";
    originalPushState = null;
    originalReplaceState = null;
    bypassPopstate = false;
  },
  anyDirty,
  isInstalled: () => installed,
};
