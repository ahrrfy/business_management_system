/**
 * فكّ ضغطة قارئ الباركود (HID) عبر **المفتاح الفيزيائيّ** `KeyboardEvent.code` بدل الحرف الناتج
 * `KeyboardEvent.key`.
 *
 * الجذر (بلاغ المالك «تظهر رموز أثناء القراءة»): قارئ الباركود يحاكي لوحة مفاتيح ويُرسل **مواقع
 * مفاتيح فيزيائية** (USB HID usage codes)، لا نصّاً. النظام/المتصفّح يترجم كلّ موقع إلى `event.key`
 * حسب **تخطيط لوحة المفاتيح النشط**؛ فتحت التخطيط العربي (101/102) يصبح الرقم/الحرف رمزاً عربياً
 * (`1`⇐`١` أو رمز، `INV`⇐`÷آ{`…). أمّا `event.code` فيبقى **ثابتاً مستقلاً عن التخطيط**
 * (`Digit1`، `KeyQ`، `Minus`…) لأنّه يصف الموقع الفيزيائيّ الذي أرسله القارئ — فهو المصدر الموثوق
 * لفكّ مدخل القارئ تحت **أيّ** تخطيط (عربي/كردي/فارسي/لاتيني) بلا خرائط ترجمة هشّة لكلّ تخطيط.
 *
 * الاستعمال: يُستدعى **حصراً** على ضغطاتٍ مؤكَّدةٍ أنّها من ومضة قارئ (كشف التوقيت في
 * `client/src/lib/barcodeScanTiming.ts`). لا يُطبَّق على الكتابة البشرية (وإلّا حوّل بحث المستخدم
 * العربيّ إلى لاتينيّ خطأً)، ولذلك يبقى `barcodeScanTiming` هو من يقرّر متى يُطبَّق.
 *
 * ملاحظة: خريطة المواقع أدناه تتبع لوحة US-QWERTY الفيزيائية — وهي ما يبعثه القارئ فعلياً بصرف
 * النظر عن تخطيط النظام. الحالة (كبيرة/صغيرة) تُشتقّ من `shiftKey`؛ ومطابقة الباركود في الخادم غير
 * حسّاسة للحالة، فحفظُ الحالة كما بُثّت لا يضرّ المطابقة.
 */

interface KeyCap {
  /** الحرف عند غياب Shift. */
  base: string;
  /** الحرف مع Shift (إن اختلف). */
  shift?: string;
}

/** خريطة المفاتيح الفيزيائية (US-QWERTY) إلى محارفها — ما يبعثه قارئ HID مهما كان تخطيط النظام. */
const PHYSICAL_KEYS: Readonly<Record<string, KeyCap>> = Object.freeze({
  // صفّ الأرقام العلويّ
  Digit1: { base: "1", shift: "!" },
  Digit2: { base: "2", shift: "@" },
  Digit3: { base: "3", shift: "#" },
  Digit4: { base: "4", shift: "$" },
  Digit5: { base: "5", shift: "%" },
  Digit6: { base: "6", shift: "^" },
  Digit7: { base: "7", shift: "&" },
  Digit8: { base: "8", shift: "*" },
  Digit9: { base: "9", shift: "(" },
  Digit0: { base: "0", shift: ")" },

  // الحروف — الحالة تُشتقّ من Shift
  KeyA: { base: "a", shift: "A" },
  KeyB: { base: "b", shift: "B" },
  KeyC: { base: "c", shift: "C" },
  KeyD: { base: "d", shift: "D" },
  KeyE: { base: "e", shift: "E" },
  KeyF: { base: "f", shift: "F" },
  KeyG: { base: "g", shift: "G" },
  KeyH: { base: "h", shift: "H" },
  KeyI: { base: "i", shift: "I" },
  KeyJ: { base: "j", shift: "J" },
  KeyK: { base: "k", shift: "K" },
  KeyL: { base: "l", shift: "L" },
  KeyM: { base: "m", shift: "M" },
  KeyN: { base: "n", shift: "N" },
  KeyO: { base: "o", shift: "O" },
  KeyP: { base: "p", shift: "P" },
  KeyQ: { base: "q", shift: "Q" },
  KeyR: { base: "r", shift: "R" },
  KeyS: { base: "s", shift: "S" },
  KeyT: { base: "t", shift: "T" },
  KeyU: { base: "u", shift: "U" },
  KeyV: { base: "v", shift: "V" },
  KeyW: { base: "w", shift: "W" },
  KeyX: { base: "x", shift: "X" },
  KeyY: { base: "y", shift: "Y" },
  KeyZ: { base: "z", shift: "Z" },

  // علامات الترقيم (تظهر في Code39/Code128 وبادئات المستندات مثل INV-)
  Minus: { base: "-", shift: "_" },
  Equal: { base: "=", shift: "+" },
  BracketLeft: { base: "[", shift: "{" },
  BracketRight: { base: "]", shift: "}" },
  Backslash: { base: "\\", shift: "|" },
  Semicolon: { base: ";", shift: ":" },
  Quote: { base: "'", shift: '"' },
  Backquote: { base: "`", shift: "~" },
  Comma: { base: ",", shift: "<" },
  Period: { base: ".", shift: ">" },
  Slash: { base: "/", shift: "?" },
  Space: { base: " " },

  // لوحة الأرقام الجانبية (قارئ في وضع numeric keypad — NumLock مفعّل)
  Numpad0: { base: "0" },
  Numpad1: { base: "1" },
  Numpad2: { base: "2" },
  Numpad3: { base: "3" },
  Numpad4: { base: "4" },
  Numpad5: { base: "5" },
  Numpad6: { base: "6" },
  Numpad7: { base: "7" },
  Numpad8: { base: "8" },
  Numpad9: { base: "9" },
  NumpadDecimal: { base: "." },
  NumpadDivide: { base: "/" },
  NumpadMultiply: { base: "*" },
  NumpadSubtract: { base: "-" },
  NumpadAdd: { base: "+" },
});

/**
 * يفكّ موقع مفتاحٍ فيزيائيّ إلى محرفه المقصود. يُعيد `null` للمواقع غير القابلة للطباعة
 * (مفاتيح تحكّم/وظائف) أو غير المعروفة — فيلجأ المستدعي إلى `event.key`.
 */
export function decodeScannerKeyCode(code: string, shiftKey: boolean): string | null {
  const cap = PHYSICAL_KEYS[code];
  if (!cap) return null;
  return shiftKey && cap.shift != null ? cap.shift : cap.base;
}

/** الحدّ الأدنى لما يلزم من حدث لوحة المفاتيح لفكّ ضغطة قارئ. */
export interface ScannerKeyEvent {
  /** الموقع الفيزيائيّ المستقلّ عن التخطيط (`KeyboardEvent.code`). */
  code?: string;
  /** الحرف الناتج حسب التخطيط النشط (`KeyboardEvent.key`) — احتياطيّ. */
  key: string;
  shiftKey?: boolean;
}

/**
 * يُعيد المحرف المقصود لضغطة قارئ:
 * ١. أولاً عبر المفتاح الفيزيائيّ `code` (مستقلّ عن التخطيط) — يصحّح التشوّه العربيّ من جذره.
 * ٢. فإن كان `code` غائباً أو غير معروف، يعود إلى `key` (يُطبَّع لاحقاً بخريطة الطبقة في
 *    `normalizeBarcodeScannerInput` كشبكة أمانٍ للأحداث المُركَّبة/القديمة).
 */
export function scannerCharFromEvent(e: ScannerKeyEvent): string {
  if (e.code) {
    const decoded = decodeScannerKeyCode(e.code, e.shiftKey === true);
    if (decoded != null) return decoded;
  }
  return e.key;
}
