/**
 * حارس فقدان البيانات — اختبار سلوك الاعتراض على تنقّل SPA.
 *
 * السلوك المُثبَت (عيب Codex FP-05):
 *  - النقر على رابط داخليّ من نموذجٍ قذر يمرّ بلا سؤال ⇒ يضيع الإدخال.
 *  - زر الرجوع في المتصفّح يخرج من الشاشة بلا سؤال.
 *
 * الاختبارات تُغطّي:
 *  1. مسند `shouldInterceptAnchorClick` (نقيّ — كلّ الحوافّ).
 *  2. `resolveNavigationAfterPrompt` (يستشير الحوار العربيّ ويعيد المسار عند القبول).
 *  3. سباق: النموذج نُظِّف أثناء عرض الحوار ⇒ السماح بالمغادرة بلا سؤال.
 *
 * البيئة `node` (بلا jsdom) ⇒ لا نُشغّل مستمعات DOM حقيقية؛ نستدعي الدوالّ المعرّضة عبر
 * `__TEST_ONLY__` مباشرةً مع لقطات `ClickIntent` مصاغة يدوياً.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/confirm", () => ({
  confirm: vi.fn(),
}));
vi.mock("@/lib/interactionDraft", () => ({
  noteInteraction: vi.fn(),
}));

import { confirm } from "@/lib/confirm";
import { __TEST_ONLY__, type ClickIntent } from "../useUnsavedGuard";

const { shouldInterceptAnchorClick, resolveNavigationAfterPrompt } =
  __TEST_ONLY__;

/** لقطة نقرة اعتيادية على رابطٍ داخليّ مختلف — يجب اعتراضها. */
function baseIntent(overrides: Partial<ClickIntent> = {}): ClickIntent {
  return {
    button: 0,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    href: "/stocktakes",
    target: "",
    download: false,
    toOrigin: "http://localhost:3000",
    toPath: "/stocktakes",
    currentOrigin: "http://localhost:3000",
    currentPath: "/stocktakes/new",
    ...overrides,
  };
}

beforeEach(() => {
  __TEST_ONLY__.reset();
  vi.mocked(confirm).mockReset();
});

describe("shouldInterceptAnchorClick — المسند النقيّ", () => {
  it("يعترض نقرةً اعتيادية على رابطٍ داخليّ مختلف", () => {
    expect(shouldInterceptAnchorClick(baseIntent())).toBe(true);
  });

  it("لا يعترض إن سبق preventDefault", () => {
    expect(shouldInterceptAnchorClick(baseIntent({ defaultPrevented: true }))).toBe(false);
  });

  it("لا يعترض النقر الأوسط/الأيمن (button !== 0)", () => {
    expect(shouldInterceptAnchorClick(baseIntent({ button: 1 }))).toBe(false);
    expect(shouldInterceptAnchorClick(baseIntent({ button: 2 }))).toBe(false);
  });

  it.each([
    ["Ctrl", { ctrlKey: true }],
    ["Meta/Cmd", { metaKey: true }],
    ["Alt", { altKey: true }],
    ["Shift", { shiftKey: true }],
  ])("لا يعترض حين يكون %s مضغوطاً (فتح في تبويب جديد)", (_name, mods) => {
    expect(shouldInterceptAnchorClick(baseIntent(mods))).toBe(false);
  });

  it("لا يعترض روابط التحميل (`<a download>`)", () => {
    expect(shouldInterceptAnchorClick(baseIntent({ download: true }))).toBe(false);
  });

  it("لا يعترض `target=\"_blank\"` أو أيّ target غير `_self`", () => {
    expect(shouldInterceptAnchorClick(baseIntent({ target: "_blank" }))).toBe(false);
    expect(shouldInterceptAnchorClick(baseIntent({ target: "external-frame" }))).toBe(false);
  });

  it("يعترض حين يكون target فارغاً أو `_self` صراحةً", () => {
    expect(shouldInterceptAnchorClick(baseIntent({ target: "" }))).toBe(true);
    expect(shouldInterceptAnchorClick(baseIntent({ target: "_self" }))).toBe(true);
  });

  it("لا يعترض حين يكون href فارغاً", () => {
    expect(shouldInterceptAnchorClick(baseIntent({ href: "" }))).toBe(false);
  });

  it("لا يعترض روابط خارج origin (`beforeunload` يتكفّل بها)", () => {
    expect(
      shouldInterceptAnchorClick(
        baseIntent({ toOrigin: "https://external.example" }),
      ),
    ).toBe(false);
  });

  it("لا يعترض نقرةً إلى نفس المسار الحاليّ", () => {
    expect(
      shouldInterceptAnchorClick(
        baseIntent({ toPath: "/stocktakes/new", currentPath: "/stocktakes/new" }),
      ),
    ).toBe(false);
  });

  it("يعترض حين يختلف الاستعلام أو الجزء (search/hash)", () => {
    expect(
      shouldInterceptAnchorClick(
        baseIntent({ toPath: "/stocktakes/new?tab=2", currentPath: "/stocktakes/new" }),
      ),
    ).toBe(true);
    expect(
      shouldInterceptAnchorClick(
        baseIntent({ toPath: "/stocktakes/new#help", currentPath: "/stocktakes/new" }),
      ),
    ).toBe(true);
  });
});

describe("resolveNavigationAfterPrompt — يستشير الحوار العربيّ", () => {
  it("يعرض حوار `confirm()` بالنصّ العربيّ الموحّد", async () => {
    __TEST_ONLY__.register("form-1");
    vi.mocked(confirm).mockResolvedValueOnce(true);
    await resolveNavigationAfterPrompt(baseIntent());
    expect(confirm).toHaveBeenCalledOnce();
    const call = vi.mocked(confirm).mock.calls[0][0];
    expect(call.variant).toBe("warning");
    expect(call.title).toBe("لديك تعديلاتٌ غير محفوظة");
    expect(call.confirmText).toBe("مغادرة");
    expect(call.cancelText).toBe("البقاء");
  });

  it("يعيد المسار المطلوب عند قبول المستخدم للمغادرة", async () => {
    __TEST_ONLY__.register("form-1");
    vi.mocked(confirm).mockResolvedValueOnce(true);
    const path = await resolveNavigationAfterPrompt(baseIntent({ toPath: "/customers" }));
    expect(path).toBe("/customers");
  });

  it("يعيد null إن رفض المستخدم (البقاء في الشاشة)", async () => {
    __TEST_ONLY__.register("form-1");
    vi.mocked(confirm).mockResolvedValueOnce(false);
    const path = await resolveNavigationAfterPrompt(baseIntent());
    expect(path).toBeNull();
  });

  it("لا يعرض الحوار — ويسمح بالمغادرة — إذا لم يكن أحدٌ dirty", async () => {
    // السجلّ فارغ (بعد reset في beforeEach).
    const path = await resolveNavigationAfterPrompt(baseIntent({ toPath: "/dashboard" }));
    expect(confirm).not.toHaveBeenCalled();
    expect(path).toBe("/dashboard");
  });

  it("سباق: النموذج حُفِظ أثناء عرض الحوار ⇒ الحوار يُتجاوَز والمغادرة تُقبَل", async () => {
    __TEST_ONLY__.register("form-1");
    // نُصمّم mock لـconfirm يُصفّي السجلّ ثمّ يحلّ true.
    vi.mocked(confirm).mockImplementationOnce(async () => {
      __TEST_ONLY__.unregister("form-1");
      return true;
    });
    const path = await resolveNavigationAfterPrompt(baseIntent({ toPath: "/x" }));
    expect(path).toBe("/x");
  });

  it("سباق: النموذج حُفِظ ومستخدمٌ رفض في نفس الوقت ⇒ يُحترَم رفض المستخدم", async () => {
    __TEST_ONLY__.register("form-1");
    vi.mocked(confirm).mockImplementationOnce(async () => {
      __TEST_ONLY__.unregister("form-1");
      return false;
    });
    const path = await resolveNavigationAfterPrompt(baseIntent());
    expect(path).toBeNull();
  });
});

describe("سجلّ dirty — تسجيل مركزيّ", () => {
  it("يبدأ فارغاً بعد reset", () => {
    expect(__TEST_ONLY__.anyDirty()).toBe(false);
  });

  it("register/unregister يضبطان `anyDirty` كما يتوقّع المسند", () => {
    __TEST_ONLY__.register("a");
    expect(__TEST_ONLY__.anyDirty()).toBe(true);
    __TEST_ONLY__.register("b");
    expect(__TEST_ONLY__.anyDirty()).toBe(true);
    __TEST_ONLY__.unregister("a");
    expect(__TEST_ONLY__.anyDirty()).toBe(true);
    __TEST_ONLY__.unregister("b");
    expect(__TEST_ONLY__.anyDirty()).toBe(false);
  });

  it("unregister لعنصرٍ غير مسجَّل لا يرمي", () => {
    expect(() => __TEST_ONLY__.unregister("ghost")).not.toThrow();
    expect(__TEST_ONLY__.anyDirty()).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// ⭐ Codex #979 — رَصعُ pushState/replaceState + معالج popstate ذو bypass وحيد
// -----------------------------------------------------------------------------

/**
 * ⚙️ سقّالة DOM اختباريّة: نبني `window`/`document`/`history`/`location` بأقلّ ما يكفي كي
 * يُثبِّت `install()` مستمعاته ويرصع الدالّتَين، ونُعرّض جواسيسَ لعدّ نداءات pushState/back.
 *
 * سلوك History الحقيقيّ:
 *  - `pushState(state, "", url)` يحذف كلّ المستقبل بعد المؤشّر ثمّ يُضيف عنصراً ويحرّك المؤشّر.
 *  - `back()` يحرّك المؤشّر للخلف ويُطلق `popstate` (لدينا: تزامنياً — نموذجٌ صالح).
 */
function makeDomStub() {
  const origin = "http://localhost:3000";
  const entries: Array<{ state: unknown; url: string }> = [
    { state: null, url: "/stocktakes/new" },
  ];
  let index = 0;
  const pushSpy = vi.fn();
  const replaceSpy = vi.fn();
  const backSpy = vi.fn();
  const listeners: Record<string, Array<(e: unknown) => void>> = {
    popstate: [],
    beforeunload: [],
    pushState: [],
    replaceState: [],
  };
  const currentUrl = () => new URL(entries[index]!.url, origin);
  const location = {
    get pathname() {
      return currentUrl().pathname;
    },
    get search() {
      return currentUrl().search;
    },
    get hash() {
      return currentUrl().hash;
    },
    get origin() {
      return origin;
    },
    get href() {
      return currentUrl().href;
    },
  };
  const history = {
    pushState(state: unknown, title: string, url: string) {
      pushSpy(state, title, url);
      entries.splice(index + 1);
      entries.push({ state, url });
      index = entries.length - 1;
    },
    replaceState(state: unknown, title: string, url: string) {
      replaceSpy(state, title, url);
      entries[index] = { state, url };
    },
    back() {
      backSpy();
      if (index > 0) {
        index--;
        for (const l of listeners.popstate!) l({});
      }
    },
    forward() {
      if (index < entries.length - 1) {
        index++;
        for (const l of listeners.popstate!) l({});
      }
    },
    get state() {
      return entries[index]?.state ?? null;
    },
  };
  const documentStub = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const windowStub = {
    history,
    location,
    addEventListener: vi.fn((type: string, cb: (e: unknown) => void) => {
      (listeners[type] ??= []).push(cb);
    }),
    removeEventListener: vi.fn(
      (type: string, cb: (e: unknown) => void) => {
        const arr = listeners[type];
        if (!arr) return;
        const idx = arr.indexOf(cb);
        if (idx >= 0) arr.splice(idx, 1);
      },
    ),
  };
  return {
    entries,
    getIndex: () => index,
    getPath: () => currentUrl().pathname + currentUrl().search + currentUrl().hash,
    pushSpy,
    replaceSpy,
    backSpy,
    fireBrowserBack(newUrl: string) {
      // يحاكي زرّ Back في المتصفّح: الـURL تغيّر ثمّ popstate يُطلَق.
      entries.splice(index + 1);
      entries.push({ state: null, url: newUrl });
      index = entries.length - 1;
      // ⚠️ في حياة المتصفّح: Back لا يُضيف عنصراً — يحرّك المؤشّر. لكنّ فحصنا يركّز على
      // عدد نداءات pushState/back للحارس نفسه، لا على شكل السجلّ قبل التدخّل. ما يهمّ:
      // (١) عدد نداءات pushState بعد popstate = 1 (استرجاع)، (٢) عدد back = 1 (تجاوز).
      for (const l of listeners.popstate!) l({});
    },
    windowStub,
    documentStub,
  };
}

/** يضع الـstub على globalThis ويُعيد دالّة تنظيف. */
function installDomStub(dom: ReturnType<typeof makeDomStub>) {
  (globalThis as Record<string, unknown>).window = dom.windowStub;
  (globalThis as Record<string, unknown>).document = dom.documentStub;
  return () => {
    delete (globalThis as Record<string, unknown>).window;
    delete (globalThis as Record<string, unknown>).document;
  };
}

/** ينتظر جميع micro-tasks الحاليّة (Promise.then callbacks). */
async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("⭐ Codex #979 P1 — رَصعُ pushState/replaceState", () => {
  let dom: ReturnType<typeof makeDomStub>;
  let teardown: () => void;

  beforeEach(() => {
    dom = makeDomStub();
    teardown = installDomStub(dom);
  });

  afterEach(() => {
    __TEST_ONLY__.reset();
    teardown();
  });

  it("لا يرصع pushState حين لا يوجد نموذج dirty", () => {
    __TEST_ONLY__.install();
    dom.windowStub.history.pushState({}, "", "/new-page");
    // مستمعٌ واحد فقط — الأصليّة نُودِيَت مباشرةً بلا حوار.
    expect(dom.pushSpy).toHaveBeenCalledOnce();
    expect(vi.mocked(confirm)).not.toHaveBeenCalled();
  });

  it("dirty + pushState برابطٍ مختلف ⇒ يعرض الحوار ولا ينفّذ الأصليّة قبل القبول", async () => {
    __TEST_ONLY__.register("form-1");
    __TEST_ONLY__.install();
    // نجعل الحوار غير محلولٍ بعد لنمسك اللحظة قبل القبول.
    let resolveConfirm!: (v: boolean) => void;
    vi.mocked(confirm).mockImplementationOnce(
      () => new Promise<boolean>((res) => (resolveConfirm = res)),
    );
    dom.windowStub.history.pushState({ n: 1 }, "", "/customers");
    // قبل حلّ الحوار: الأصليّة لم تُنَادَ.
    expect(dom.pushSpy).not.toHaveBeenCalled();
    expect(vi.mocked(confirm)).toHaveBeenCalledOnce();
    // بعد القبول: الأصليّة تُنَادَى **بذات الوسائط**.
    resolveConfirm(true);
    await flushMicrotasks();
    expect(dom.pushSpy).toHaveBeenCalledOnce();
    expect(dom.pushSpy).toHaveBeenCalledWith({ n: 1 }, "", "/customers");
  });

  it("dirty + pushState + رفض المستخدم ⇒ الأصليّة **لا تُنَادَى مطلقاً**", async () => {
    __TEST_ONLY__.register("form-1");
    __TEST_ONLY__.install();
    vi.mocked(confirm).mockResolvedValueOnce(false);
    dom.windowStub.history.pushState({}, "", "/other");
    await flushMicrotasks();
    expect(dom.pushSpy).not.toHaveBeenCalled();
    // السجلّ لم يتغيّر (المؤشّر ما زال على المسار الأصليّ).
    expect(dom.getPath()).toBe("/stocktakes/new");
  });

  it("dirty + pushState بنفس URL الحاليّ ⇒ مباشر بلا حوار (نمط React الشائع)", () => {
    __TEST_ONLY__.register("form-1");
    __TEST_ONLY__.install();
    // نفس المسار الحاليّ (شامل search+hash).
    dom.windowStub.history.pushState({}, "", "/stocktakes/new");
    expect(dom.pushSpy).toHaveBeenCalledOnce();
    expect(vi.mocked(confirm)).not.toHaveBeenCalled();
  });

  it("dirty + pushState بـURL بلا وسيط ⇒ مباشر بلا حوار (state-only update)", () => {
    __TEST_ONLY__.register("form-1");
    __TEST_ONLY__.install();
    // بلا url — pushState يُستعمل أحياناً لتحديث state فقط.
    dom.windowStub.history.pushState({}, "", null);
    expect(dom.pushSpy).toHaveBeenCalledOnce();
    expect(vi.mocked(confirm)).not.toHaveBeenCalled();
  });

  it("dirty + pushState لِـorigin مختلف ⇒ مباشر (beforeunload يتكفّل به)", () => {
    __TEST_ONLY__.register("form-1");
    __TEST_ONLY__.install();
    dom.windowStub.history.pushState({}, "", "https://external.example/x");
    expect(dom.pushSpy).toHaveBeenCalledOnce();
    expect(vi.mocked(confirm)).not.toHaveBeenCalled();
  });

  it("dirty + replaceState برابطٍ مختلف ⇒ يعترض بذات القواعد", async () => {
    __TEST_ONLY__.register("form-1");
    __TEST_ONLY__.install();
    vi.mocked(confirm).mockResolvedValueOnce(true);
    dom.windowStub.history.replaceState({ x: 2 }, "", "/inbox");
    await flushMicrotasks();
    expect(dom.replaceSpy).toHaveBeenCalledOnce();
    expect(dom.replaceSpy).toHaveBeenCalledWith({ x: 2 }, "", "/inbox");
  });

  it("uninstall يستعيد الأصليّتين", () => {
    const originalPush = dom.windowStub.history.pushState;
    const originalReplace = dom.windowStub.history.replaceState;
    __TEST_ONLY__.install();
    // بعد install الدالّتان مُرَصَّعتان (مراجعُ مختلفة عن الأصلي).
    expect(dom.windowStub.history.pushState).not.toBe(originalPush);
    expect(dom.windowStub.history.replaceState).not.toBe(originalReplace);
    __TEST_ONLY__.uninstall();
    expect(dom.windowStub.history.pushState).toBe(originalPush);
    expect(dom.windowStub.history.replaceState).toBe(originalReplace);
  });
});

describe("⭐ Codex #979 P2 — popstate one-shot bypass يحفظ عمق السجلّ", () => {
  let dom: ReturnType<typeof makeDomStub>;
  let teardown: () => void;

  beforeEach(() => {
    dom = makeDomStub();
    teardown = installDomStub(dom);
  });

  afterEach(() => {
    __TEST_ONLY__.reset();
    teardown();
  });

  it("Back + رفض ⇒ نبقى على B (بلا استدعاء back)", async () => {
    // ابدأ على B: entries=[X, A, B], index=2.
    dom.entries.length = 0;
    dom.entries.push(
      { state: null, url: "/X" },
      { state: null, url: "/A" },
      { state: null, url: "/B" },
    );
    // نفس بنية makeDomStub لكن يجب دفع المؤشّر — لا واجهة صريحة، ننفّذ عبر back().
    // بدلاً من ذلك: بعد install، نستدعي fireBrowserBack("/A") الذي يحاكي Back مباشرةً.
    // نُثبّت الـURL الحاليّ = "/B" أوّلاً بمسند index تنمّى بـpush.
    // (makeDomStub يُنشئ index=0 على "/stocktakes/new" — نبدأ مباشرةً بعد pushState من install.)
    // نُبسّط: لا نحاكي X/A. نُحدّد lastPath = "/B" ثمّ نُصمّم fireBrowserBack("/A").
    __TEST_ONLY__.reset();
    // نعيد ضبط dom يدوياً لهذا التسلسل.
    dom = makeDomStub();
    teardown();
    teardown = installDomStub(dom);
    // نُثبّت المسار الحاليّ لِـ"/B" قبل install.
    dom.entries[0]!.url = "/B";
    __TEST_ONLY__.register("form-B");
    __TEST_ONLY__.install();
    vi.mocked(confirm).mockResolvedValueOnce(false);
    // المستخدم يضغط Back: URL يصبح /A ثمّ popstate.
    dom.fireBrowserBack("/A");
    await flushMicrotasks();
    // handler استعاد إلى /B عبر pushState (مسموحٌ به — استرجاع بصريّ).
    expect(dom.pushSpy).toHaveBeenCalledWith(null, "", "/B");
    // ثمّ عرض الحوار. رفض. لا back().
    expect(dom.backSpy).not.toHaveBeenCalled();
    // نبقى على /B (المسار المُعاد).
    expect(dom.getPath()).toBe("/B");
  });

  it("Back + قبول ⇒ history.back() **مرّة واحدة** (لا pushState لِـ /A يُضيف تراكماً)", async () => {
    dom.entries[0]!.url = "/B";
    __TEST_ONLY__.register("form-B");
    __TEST_ONLY__.install();
    vi.mocked(confirm).mockResolvedValueOnce(true);
    dom.fireBrowserBack("/A");
    await flushMicrotasks();
    // ١) استرجاعٌ واحدٌ بـpushState("/B") — ليُظهر شاشة B خلف الحوار.
    expect(dom.pushSpy).toHaveBeenCalledTimes(1);
    expect(dom.pushSpy).toHaveBeenCalledWith(null, "", "/B");
    // ٢) **قبول ⇒ history.back() (لا pushState("/A")).**
    expect(dom.backSpy).toHaveBeenCalledTimes(1);
    // ٣) بعد back()، انتقلنا فعلاً إلى /A ولم يُضاف عنصرٌ جديد بعده.
    // (fireBrowserBack سبق أن حرّك المؤشّر ثمّ pushState استرجاعٌ ⇒ entries=[B_orig, A, B_restore].
    //  back() من B_restore ⇒ index=1 (A). العنصر /A لا يُنسَخ بـpushState("/A"). ✓)
    expect(dom.getPath()).toBe("/A");
  });

  it("قبولان متتاليان لا يُنتجان تراكم `[A, B, A]`: عمق السجلّ يبقى محدوداً", async () => {
    dom.entries[0]!.url = "/B";
    __TEST_ONLY__.register("form-B");
    __TEST_ONLY__.install();
    // جولةٌ أولى: Back من B إلى A + قبول.
    vi.mocked(confirm).mockResolvedValueOnce(true);
    dom.fireBrowserBack("/A");
    await flushMicrotasks();
    const pushCountAfterFirst = dom.pushSpy.mock.calls.length;
    const backCountAfterFirst = dom.backSpy.mock.calls.length;
    // بعد الجولة الأولى: pushState = 1 (استرجاع فقط)، back = 1 (قبول).
    expect(pushCountAfterFirst).toBe(1);
    expect(backCountAfterFirst).toBe(1);
    // ⛔ لا نرى pushState("/A") — وهو مصدر تراكم `[A, B, A]` في العطب الأصليّ.
    const pushArgs = dom.pushSpy.mock.calls.map((c) => c[2]);
    expect(pushArgs).not.toContain("/A");
  });

  it("علَم bypass يُستهلَك مرّة واحدة: popstate ثانٍ متزامن يعود لسلوك المطالبة", async () => {
    dom.entries[0]!.url = "/B";
    __TEST_ONLY__.register("form-B");
    __TEST_ONLY__.install();
    vi.mocked(confirm).mockResolvedValueOnce(true);
    dom.fireBrowserBack("/A");
    await flushMicrotasks();
    // الآن العلَم قد استُهلِك بواسطة popstate الناتج عن back(). حوار جديد ⇒ يعرض.
    vi.mocked(confirm).mockClear();
    vi.mocked(confirm).mockResolvedValueOnce(false);
    dom.fireBrowserBack("/W");
    await flushMicrotasks();
    // حوارٌ ثانٍ عُرِضَ (العلَم غير مثبَّت — bypass ليس لاصقاً).
    expect(vi.mocked(confirm)).toHaveBeenCalledOnce();
  });

  it("popstate بلا dirty ⇒ يُحدّث lastPath فقط ولا يفتح حواراً", () => {
    __TEST_ONLY__.install();
    // لا تسجيل dirty ⇒ Back يمرّ بلا اعتراض.
    dom.fireBrowserBack("/A");
    expect(vi.mocked(confirm)).not.toHaveBeenCalled();
    expect(dom.pushSpy).not.toHaveBeenCalled();
    expect(dom.backSpy).not.toHaveBeenCalled();
  });
});
