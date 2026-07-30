/**
 * barcodeSymbology.ts — كشف نوع ترميز الباركود (Symbology Detection).
 *
 * وحدة نقيّة (بلا DOM/شبكة/DB) قابلة للاختبار — تُميّز:
 *   EAN-13 · EAN-8 · UPC-A · UPC-E · ITF-14 · ISBN-13 · GS1-128 · Code39 · Code128 · INTERNAL.
 *
 * لماذا: مؤشّر حالة الحقل الحالي (`barcodeState` في client/src/lib/variants.ts) يفترض EAN-13
 * حصراً ⇒ أيّ باركود صحيح من عائلة أخرى (Code128 داخلي، UPC-A ١٢ رقماً، EAN-8، ITF-14…)
 * يُوسَم «invalid — يُقبل مع ذلك»، وهي رسالة كاذبة تشخيصياً. هذه الوحدة تحلّ التشخيص فقط —
 * سياسة الحفظ تبقى في `variants.ts` (نقبل أيّ سلسلة غير مكرّرة، ونعرض النوع صراحةً).
 *
 * قرارا المالك (٣٠/٧):
 *   ١. البادئة الداخلية = نطاق GS1 المعياريّ 20-29 (لا يتصادم مع أيّ مصنِّع في العالم).
 *      كنّا نستخدم 621 — وهي فعلياً نطاق GS1-Egypt (مصنِّعون مسجَّلون في مصر) ⇒ خطر تصادم نظريّ.
 *   ٢. باركود مصنّعي بخانة تحقّق فاسدة: يُقبَل مع بادج «ترميز غير قياسي» — الرفض يوقف بضاعة حقيقية.
 */

/** أنواع الترميز التي يكشفها المحلّل. */
export type SymbologyKind =
  | "empty"           // فارغ
  | "EAN-13"          // ١٣ رقماً + خانة تحقّق صحيحة (وزن ١/٣)
  | "EAN-13-INTERNAL" // EAN-13 صحيح في النطاق الداخلي المعياريّ (20-29)
  | "ISBN-13"         // EAN-13 صحيح ببادئة 978/979 (كتاب)
  | "EAN-8"           // ٨ أرقام + خانة تحقّق (وزن ٣/١)
  | "UPC-A"           // ١٢ رقماً + خانة تحقّق (وزن ٣/١)
  | "UPC-E"           // ٨ أرقام (٦+خانتَي حراسة) — للمنتجات الأمريكية الصغيرة
  | "ITF-14"          // ١٤ رقماً + خانة تحقّق (وزن ٣/١) — الكراتين الشحنية
  | "GS1-128"         // Code128 برأس FNC1 (]C1) أو Application Identifiers مثل (01)
  | "Code39"          // A-Z 0-9 - . SPACE $ / + %
  | "Code128"         // ASCII قابل للطباعة، أوسع تغطيةً
  | "INTERNAL"        // بادئتنا المخصَّصة (ALR*) — رمز داخلي غير EAN
  | "unknown";        // لا يطابق أيّاً مما سبق

/** نتيجة الكشف الكاملة — discriminated بـkind، مع علامة الصلاحية ونصّ العرض. */
export interface SymbologyResult {
  /** نوع الترميز المكتشف. */
  kind: SymbologyKind;
  /** خانة تحقّق الترميز مطابقة (أو النوع بلا خانة تحقّق أصلاً). */
  valid: boolean;
  /** النص المطبَّع (نفس المدخل بعد trim). */
  normalized: string;
  /** اسم عربيّ قصير للعرض في البادج. */
  label: string;
  /** سبب رفض الصلاحية (إن كان `valid=false` مع نوع معروف). */
  reason?: string;
}

/* ============================ خوارزميات خانات التحقّق ============================ */

/**
 * EAN-13 mod-10: أوزان ١ للمواضع الفردية (١، ٣، ٥…) و٣ للزوجية (٢، ٤، ٦…) من اليسار.
 * ملاحظة: التوقيع يقبل ١٢ أو ١٣ حرفاً — إن كانت ١٣ يتجاهل الأخير (الحساب على أوّل ١٢).
 */
export function ean13CheckDigit(d12or13: string): number {
  const d = d12or13.slice(0, 12);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += (+d[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10;
}

/**
 * UPC-A و EAN-8 و ITF-14 يشتركون بنفس القاعدة: mod-10 بأوزان معكوسة عن EAN-13.
 * وزن ٣ للمواضع الفردية من اليسار (١، ٣، ٥…)، ١ للزوجية. نحسب على كلّ الأرقام إلا الأخير.
 * لاحظ: UPC-A ١٢ رقماً، EAN-8 ٨، ITF-14 ١٤ — نفس الخوارزمية، طول مختلف.
 */
function mod10Weighted31(digits: string): number {
  let sum = 0;
  const body = digits.slice(0, -1);
  for (let i = 0; i < body.length; i++) sum += (+body[i]) * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10;
}

/** هل باركود EAN-13 صحيح شكلاً وخانة تحقّق؟ */
export function isValidEan13(code: string): boolean {
  if (!/^\d{13}$/.test(code || "")) return false;
  return +code[12] === ean13CheckDigit(code);
}

/** هل UPC-A ١٢ رقماً صحيح؟ */
export function isValidUpcA(code: string): boolean {
  if (!/^\d{12}$/.test(code || "")) return false;
  return +code[11] === mod10Weighted31(code);
}

/** هل EAN-8 ٨ أرقام صحيح؟ */
export function isValidEan8(code: string): boolean {
  if (!/^\d{8}$/.test(code || "")) return false;
  return +code[7] === mod10Weighted31(code);
}

/** هل ITF-14 ١٤ رقماً صحيح؟ */
export function isValidItf14(code: string): boolean {
  if (!/^\d{14}$/.test(code || "")) return false;
  return +code[13] === mod10Weighted31(code);
}

/* ============================ الكاشف الرئيسي ============================ */

/** بادئة الرمز الداخلي المطبوع على ملصق الرفّ (رمزيّ، للتصنيف السريع). */
const INTERNAL_PREFIX = /^ALR/i;

/** Code39: مجموعة محارف صغيرة محدّدة معياريّاً. */
const CODE39_RE = /^[A-Z0-9\-. $/+%]+$/;

/** GS1-128: رأس FNC1 (]C1) أو Application Identifier بأقواس مثل (01). */
const GS1_128_RE = /^(\]C1|\(\d{2,4}\))/;

/** أيّ ASCII قابل للطباعة (0x20-0x7E) — بما فيه المسافة. */
const PRINTABLE_ASCII_RE = /^[\x20-\x7E]+$/;

/**
 * يكشف نوع ترميز أيّ سلسلة باركود بترتيب أولوية حتميّ:
 * ١. فارغ ⇐ empty
 * ٢. أرقام فقط:
 *    ١٣ رقماً ⇐ EAN-13 (فرعية: ISBN-13 لبادئة 978/979، INTERNAL لنطاق 20-29)
 *    ١٤ رقماً ⇐ ITF-14
 *    ١٢ رقماً ⇐ UPC-A
 *    ٨  أرقام ⇐ EAN-8
 * ٣. بادئة داخلية `ALR*` ⇐ INTERNAL
 * ٤. بادئة GS1-128 (]C1 أو (01)) ⇐ GS1-128
 * ٥. Code39 (مجموعة محارف محدَّدة) ⇐ Code39
 * ٦. ASCII قابل للطباعة ⇐ Code128
 * ٧. غير ذلك ⇐ unknown
 */
export function detectSymbology(raw: string): SymbologyResult {
  const s = String(raw ?? "").trim();
  if (!s) return { kind: "empty", valid: false, normalized: "", label: "" };

  // (٣) بادئة داخليّة مخصَّصة — قبل فحص الأرقام لأنها قد تبدأ برقم بعد ALR.
  if (INTERNAL_PREFIX.test(s)) {
    return { kind: "INTERNAL", valid: true, normalized: s, label: "داخلي" };
  }

  // (٢) أرقام فقط — الأطوال المعياريّة الأكثر شيوعاً.
  if (/^\d+$/.test(s)) {
    if (s.length === 13) {
      if (isValidEan13(s)) {
        const prefix3 = s.slice(0, 3);
        // ISBN-13 (كتب): 978 و 979.
        if (prefix3 === "978" || prefix3 === "979") {
          return { kind: "ISBN-13", valid: true, normalized: s, label: "ISBN" };
        }
        // النطاق الداخلي المعياريّ GS1: 20-29 (أوّل رقمين).
        const p2 = +s.slice(0, 2);
        if (p2 >= 20 && p2 <= 29) {
          return { kind: "EAN-13-INTERNAL", valid: true, normalized: s, label: "داخلي (EAN-13)" };
        }
        return { kind: "EAN-13", valid: true, normalized: s, label: "EAN-13" };
      }
      return { kind: "EAN-13", valid: false, normalized: s, label: "EAN-13", reason: "خانة التحقّق لا تطابق" };
    }
    if (s.length === 14) {
      const ok = isValidItf14(s);
      return {
        kind: "ITF-14",
        valid: ok,
        normalized: s,
        label: "ITF-14",
        reason: ok ? undefined : "خانة التحقّق لا تطابق",
      };
    }
    if (s.length === 12) {
      const ok = isValidUpcA(s);
      return {
        kind: "UPC-A",
        valid: ok,
        normalized: s,
        label: "UPC-A",
        reason: ok ? undefined : "خانة التحقّق لا تطابق",
      };
    }
    if (s.length === 8) {
      const ok = isValidEan8(s);
      return {
        kind: ok ? "EAN-8" : "EAN-8",
        valid: ok,
        normalized: s,
        label: "EAN-8",
        reason: ok ? undefined : "خانة التحقّق لا تطابق",
      };
    }
    // أرقام بطول غير معياريّ (أقلّ من ٨، أو ٩-١١، أو ١٥+) — لا يوجد ترميز معياري ⇒ يُقبل كـCode128.
    return {
      kind: "Code128",
      valid: true,
      normalized: s,
      label: "Code128",
      reason: "طول غير معياريّ — يُطبع كـCode128",
    };
  }

  // (٤) GS1-128.
  if (GS1_128_RE.test(s)) {
    return { kind: "GS1-128", valid: true, normalized: s, label: "GS1-128" };
  }

  // (٥) Code39 — مجموعة محارف مغلقة معياريّاً.
  if (CODE39_RE.test(s)) {
    return { kind: "Code39", valid: true, normalized: s, label: "Code39" };
  }

  // (٦) Code128 — أوسع تغطية لـASCII القابل للطباعة.
  if (PRINTABLE_ASCII_RE.test(s)) {
    return { kind: "Code128", valid: true, normalized: s, label: "Code128" };
  }

  // (٧) غير معروف — يحتوي محارف غير قابلة للطباعة.
  return { kind: "unknown", valid: false, normalized: s, label: "غير معروف", reason: "محارف غير قابلة للطباعة" };
}

/* ============================ توليد داخلي (النطاق المعياريّ 20-29) ============================ */

/**
 * يولّد EAN-13 داخلياً صحيحاً — قرار المالك: البادئة في النطاق المعياريّ GS1 (20-29).
 * الافتراضي "200" (٢٠٠-٢٩٩ = نطاق GS1 المخصَّص للاستخدام الداخلي داخل المؤسّسة، صفر تصادم عالمياً).
 */
export function genInternalEan13(prefix = "200"): string {
  let body = (prefix || "").replace(/\D/g, "");
  // اجبر البادئة على نطاق 20-29 إن كانت خارجه (حماية من الاستخدام الخاطئ).
  if (!/^2\d/.test(body.slice(0, 2))) body = "20" + body.slice(2);
  while (body.length < 12) body += Math.floor(Math.random() * 10);
  body = body.slice(0, 12);
  return body + ean13CheckDigit(body);
}
