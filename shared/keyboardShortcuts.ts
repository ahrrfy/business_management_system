/**
 * قاموس اختصارات لوحة المفاتيح — **مصدر الحقيقة الوحيد** للمفاتيح المُستعملة عبر النظام.
 *
 * السبب (مسح ٢٧/٨/٢٦): ١٦ صفحة تستعمل `window.addEventListener('keydown')` يدوياً بأنماط
 * مختلفة:
 *   • Ctrl+S يُطلق form.submit في نمطٍ / يُطلق setDirty في آخر
 *   • Escape يُغلق dialog في نمطٍ / يُلغي إجراءً في آخر
 *   • F2/F7 في الكاشير بلا توثيق ⇒ اختصارات سرّية
 *
 * التوحيد هنا يفيد ثلاث زوايا:
 *   1. `useSaveShortcuts` (الهوك المشترك) يستهلك القاموس بدل نصوص hardcoded
 *   2. `KeyboardShortcutsDialog` يعرض القائمة للمستخدم (يفتح بـ`?` أو `F1`)
 *   3. `ShortcutsBar` يعرض F-keys في الكاشير (على `pointer:fine` فقط)
 *
 * موقع `shared/`: نحتاجه على العميل وربّما لاحقاً على الخادم لو أُضيف واتساب/API خارجيّ يرسل
 * اختصارات (نادر، لكن الموقع الآمن).
 */

/**
 * تعريف اختصار واحد: المفتاح + معدِّلاته + وصفٌ عربيّ + سياقُ التفعيل.
 */
export interface KeyboardShortcut {
  /** المفتاح الرئيسي بالحرف كما يعطيه `event.key` (`s`, `Escape`, `F2`). */
  key: string;
  /** يلزم Ctrl (Windows/Linux) / Cmd (macOS). التطبيق يوحّدهما تلقائياً. */
  ctrl?: boolean;
  /** يلزم Shift. */
  shift?: boolean;
  /** يلزم Alt (Option على macOS). */
  alt?: boolean;
  /** نصّ عربيّ يظهر في `KeyboardShortcutsDialog`. */
  label: string;
  /** السياق: `global` (كل الشاشات) أو اسم شاشة (`pos`, `reception`, `crud-form`). */
  scope: "global" | "pos" | "reception" | "crud-form" | "invoice-editor";
  /** وصفٌ اختياريّ أطول للتوثيق. */
  description?: string;
}

/**
 * جميع الاختصارات المُعتمَدة رسمياً في النظام. الترتيب: عام أوّلاً ثم كل شاشة.
 */
export const KEYBOARD_SHORTCUTS = {
  // ── عامّة (كل الشاشات) ──────────────────────────────────────────────────
  saveForm: {
    key: "s",
    ctrl: true,
    label: "حفظ",
    scope: "crud-form",
    description: "حفظ النموذج الحاليّ — يستدعي submit تلقائياً في `<form>`.",
  },
  cancelDialog: {
    key: "Escape",
    label: "إغلاق/إلغاء",
    scope: "global",
    description: "يُغلق الحوار المفتوح أو يُلغي الإجراء الحاليّ.",
  },
  openShortcuts: {
    key: "?",
    shift: true,
    label: "قائمة الاختصارات",
    scope: "global",
    description: "يفتح `KeyboardShortcutsDialog` — عرض جميع الاختصارات المتاحة.",
  },
  openShortcutsF1: {
    key: "F1",
    label: "قائمة الاختصارات",
    scope: "global",
    description: "بديلٌ لـShift+? (سهل على لوحات RTL).",
  },
  quickSearch: {
    key: "k",
    ctrl: true,
    label: "بحث سريع",
    scope: "global",
    description: "يفتح Command Palette للبحث السريع (متى ما وُجد).",
  },

  // ── كاشير POS ──────────────────────────────────────────────────────────
  focusBarcode: {
    key: "F2",
    label: "التركيز على قارئ الباركود",
    scope: "pos",
    description: "ينقل التركيز لحقل الباركود في الكاشير — الأشيَع خلال الوردية.",
  },
  quickCustomer: {
    key: "F3",
    label: "اختيار عميل سريع",
    scope: "pos",
    description: "يفتح منتقي العملاء بدل النقر اليدويّ.",
  },
  finalizeSale: {
    key: "F7",
    label: "إنهاء البيع (نقدي/بطاقة)",
    scope: "pos",
    description: "يُشغّل مسار قبض السلة — يُظهر منتقي الطريقة إن لم تُحدَّد.",
  },

  // ── محرّر الفاتورة ──────────────────────────────────────────────────────
  addLine: {
    key: "Enter",
    label: "إضافة سطر",
    scope: "invoice-editor",
    description: "من حقل الباركود/البحث ⇒ يُضيف السطر الحاليّ إلى الجدول.",
  },
  duplicateLine: {
    key: "d",
    ctrl: true,
    label: "تكرار السطر",
    scope: "invoice-editor",
    description: "يُكرّر السطر الحاليّ بكمية 1.",
  },
} as const satisfies Record<string, KeyboardShortcut>;

export type KeyboardShortcutKey = keyof typeof KEYBOARD_SHORTCUTS;

/**
 * يبني نصّاً معروضاً لاختصار — للاستهلاك في `KeyboardShortcutsDialog` و `ShortcutsBar`.
 * أمثلة: «Ctrl+S»، «Esc»، «Shift+?»، «F2».
 *
 * ملاحظة: نستعمل «Ctrl» بدل «Cmd» لأنّ الأشيَع في السوق العراقيّ ويندوز؛ macOS يفهمها آلياً.
 */
export function formatShortcut(shortcut: KeyboardShortcut): string {
  const parts: string[] = [];
  if (shortcut.ctrl) parts.push("Ctrl");
  if (shortcut.shift) parts.push("Shift");
  if (shortcut.alt) parts.push("Alt");
  // مفتاح Escape يُعرَض بالاختصار الشائع «Esc»
  const key = shortcut.key === "Escape" ? "Esc" : shortcut.key.toUpperCase();
  parts.push(key);
  return parts.join("+");
}

/** كل مفاتيح القاموس — للاختبار النصّيّ. */
export const KEYBOARD_SHORTCUT_KEYS: readonly KeyboardShortcutKey[] = Object.keys(KEYBOARD_SHORTCUTS) as KeyboardShortcutKey[];
