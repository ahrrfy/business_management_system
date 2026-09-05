/**
 * useSaveShortcuts — سجلّ «الأعمقُ تركيباً يفوز» (م٦).
 *
 * العلّة المُثبَتة: صفحةٌ تربط Ctrl+S وتُصيّر داخلها نموذجاً يربطه أيضاً ⇒ حفظان متزامنان على السجلّ
 * نفسه (أمسكته الجولة البصريّة: طلبان في دفعة tRPC واحدة والثاني يسقط على UNIQUE النسخ).
 * البيئة `node` بلا DOM ⇒ نختبر المسندَ النقيّ `activeHandlers` على مداخلَ مصاغةٍ يدوياً، ونحرس المصدر نصّياً.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { __TEST_ONLY__ } from "../useSaveShortcuts";

const { activeHandlers } = __TEST_ONLY__;
const SOURCE = readFileSync(new URL("../useSaveShortcuts.ts", import.meta.url), "utf8");

const entry = (name: string, enabled = true) => ({
  ref: { current: { onSave: () => name, enabled } },
});

describe("activeHandlers — آخرُ مدخلٍ مُفعَّل يفوز", () => {
  it("لا مداخل ⇒ لا معالِج (Ctrl+S يمرّ إلى المتصفّح كما كان)", () => {
    expect(activeHandlers([])).toBeNull();
  });

  it("مدخلٌ واحد ⇒ هو الفعّال", () => {
    expect(activeHandlers([entry("page")])?.onSave?.()).toBe("page");
  });

  it("صفحةٌ ثمّ نموذجٌ ابن ⇒ الابنُ وحده يستقبل Ctrl+S (لا حفظ مزدوج)", () => {
    expect(activeHandlers([entry("page"), entry("child")])?.onSave?.()).toBe("child");
  });

  it("الابنُ المعطَّل (isPending) لا يُسقط الاختصارَ على الصفحة فوقه إلّا حين يكون هو نفسه مُفعَّلاً — يُعاد الدور لمن قبله", () => {
    expect(activeHandlers([entry("page"), entry("child", false)])?.onSave?.()).toBe("page");
    expect(activeHandlers([entry("page", false), entry("child", false)])).toBeNull();
  });

  it("تفكيكُ الابن يُعيد الدور للصفحة (ترتيبُ التركيب هو ترتيبُ الأولوية)", () => {
    const page = entry("page");
    const child = entry("child");
    const stack = [page, child];
    stack.splice(stack.indexOf(child), 1);
    expect(activeHandlers(stack)?.onSave?.()).toBe("page");
  });
});

describe("المصدر — مستمعٌ واحد وسجلٌّ ثابت الموضع", () => {
  it("يُثبّت المستمع مرّةً واحدة على النافذة ويُسجّل المدخل عند التركيب فقط (لا يقفز عند تبدّل enabled)", () => {
    expect(SOURCE).toContain('window.addEventListener("keydown", keydownHandler)');
    expect(SOURCE).toMatch(/useEffect\(\(\) => \{\s*const entry: Entry = \{ ref \};\s*stack\.push\(entry\);/);
    expect(SOURCE).toContain("}, []);");
    expect(SOURCE).toContain("ref.current = { onSave, onCancel, enabled };");
  });

  it("حراسةُ الطبقات المتراكبة باقية: لا Ctrl+S داخل حوارٍ مشروط، ولا Esc فوق طبقةٍ مفتوحة", () => {
    expect(SOURCE).toContain("if (modalOpen() || !active.onSave) return;");
    expect(SOURCE).toContain("if (anyOverlayOpen()) return;");
  });
});
