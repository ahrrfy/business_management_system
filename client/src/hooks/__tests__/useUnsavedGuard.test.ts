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

import { beforeEach, describe, expect, it, vi } from "vitest";

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
