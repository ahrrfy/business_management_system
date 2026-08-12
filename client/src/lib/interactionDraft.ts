/**
 * شبكة أمان عامة للإدخالات التي لم تُربط بعد بمسودة نوعية.
 *
 * لا تحلّ هذه محلّ مسودة النموذج الصريحة (فهي تعرف هيكل الحالة كاملاً)، لكنها
 * تلتقط قيم عناصر الإدخال الظاهرة قبل تحديث قسري/تعطل تحميل جزء من الواجهة.
 * التخزين في sessionStorage (لا يبقى على جهاز مشترك بعد إغلاق جلسة المتصفح)،
 * محدود المدة، ولا يشمل كلمات المرور أو الملفات أو
 * الحقول التي تعلن `data-no-draft`.
 */

const PREFIX = "alroya.interaction-draft.v1:";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type FieldSnapshot = {
  key: string;
  kind: "input" | "textarea" | "select" | "contenteditable";
  inputType?: string;
  value: string;
  checked?: boolean;
};

type DraftSnapshot = { savedAt: number; fields: FieldSnapshot[] };

let dirty = false;
let dirtyPath: string | null = null;

function storageKey(path = window.location.pathname): string {
  return PREFIX + path;
}

function isSafeField(el: Element): el is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLElement {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || el instanceof HTMLElement)) return false;
  if (el.closest("[data-no-draft]")) return false;
  if (el instanceof HTMLInputElement) {
    const type = el.type.toLowerCase();
    if (["password", "file", "hidden", "submit", "button", "reset", "image"].includes(type)) return false;
    if (["current-password", "new-password", "one-time-code"].includes(el.autocomplete)) return false;
  }
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || el.getAttribute("contenteditable") === "true";
}

function fieldKey(el: Element, index: number): string {
  const identified = el.getAttribute("data-draft-key") || (el as HTMLInputElement).name || el.id;
  return identified ? `id:${identified}` : `position:${index}`;
}

function editableFields(): Element[] {
  return Array.from(document.querySelectorAll("input, textarea, select, [contenteditable='true']")).filter(isSafeField);
}

/** تسجل أن المستخدم عدّل إدخالاً؛ تستعملها واجهة التحديث لتفادي أي إنعاش صامت. */
export function noteInteraction(): void {
  dirty = true;
  dirtyPath = window.location.pathname;
}

export function hasUnsavedInteraction(): boolean {
  return dirty && dirtyPath === window.location.pathname;
}

/** يبدأ نطاقاً جديداً عند انتقال SPA؛ لا نحمل «تعديل سابق حُفظ» إلى شاشة أخرى. */
export function beginInteractionScope(path: string): void {
  if (dirtyPath !== path) {
    dirty = false;
    dirtyPath = null;
  }
}

/** يحفظ لقطة آنية، وليس في unload: الكتابة غير المتزامنة عند إغلاق الصفحة غير موثوقة. */
export function saveInteractionDraft(): boolean {
  if (typeof window === "undefined") return false;
  const fields = editableFields().map((el, index): FieldSnapshot => {
    const key = fieldKey(el, index);
    if (el instanceof HTMLInputElement) return { key, kind: "input", inputType: el.type, value: el.value, checked: el.checked };
    if (el instanceof HTMLTextAreaElement) return { key, kind: "textarea", value: el.value };
    if (el instanceof HTMLSelectElement) return { key, kind: "select", value: el.value };
    return { key, kind: "contenteditable", value: el.textContent ?? "" };
  });
  if (!fields.length) return false;
  try {
    sessionStorage.setItem(storageKey(), JSON.stringify({ savedAt: Date.now(), fields } satisfies DraftSnapshot));
    return true;
  } catch {
    return false;
  }
}

function readDraft(): DraftSnapshot | null {
  try {
    const raw = sessionStorage.getItem(storageKey());
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DraftSnapshot;
    if (!parsed || !Array.isArray(parsed.fields) || !Number.isFinite(parsed.savedAt) || Date.now() - parsed.savedAt > MAX_AGE_MS) {
      sessionStorage.removeItem(storageKey());
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function hasRecoverableInteractionDraft(): boolean {
  return readDraft() !== null;
}

export function discardInteractionDraft(): void {
  try { sessionStorage.removeItem(storageKey()); } catch { /* مساحة المتصفح غير متاحة */ }
}

/** يعيد إدخال DOM ثم يطلق input/change كي تحدّث React حالتها أيضاً. */
export function restoreInteractionDraft(): boolean {
  const draft = readDraft();
  if (!draft) return false;
  const elements = editableFields();
  let restored = 0;
  for (const field of draft.fields) {
    const element = elements.find((el, index) => fieldKey(el, index) === field.key);
    if (!element) continue;
    if (element instanceof HTMLInputElement) {
      if (field.inputType && element.type !== field.inputType) continue;
      if (field.inputType === "checkbox" || field.inputType === "radio") element.checked = !!field.checked;
      else element.value = field.value;
    } else if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      element.value = field.value;
    } else {
      element.textContent = field.value;
    }
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    restored++;
  }
  if (restored) {
    dirty = true;
    dirtyPath = window.location.pathname;
  }
  return restored > 0;
}
