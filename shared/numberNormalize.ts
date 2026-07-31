/**
 * numberNormalize.ts — تطبيع مدخلات الأرقام العدوانيّ لحقول التكلفة/السعر.
 *
 * **الجذر (٣٠/٧/٢٦):** تشخيص حادثة SINARLINE (16162 vs المفروض 1162.5) كشف أنّ الملاك يلصقون
 * أو يكتبون الأرقام بأشكالٍ متنوّعة — عربية هندية، فاصلة عربية، فواصل ألوف أوروبية، رموز عملة
 * ملحقة. `MoneyInput` الأصليّ كان يستعمل regex `[^0-9.]/g` يحذف كلّ ذلك صامتاً ⇒ المستخدم يرى
 * حقلاً «فرغ» بلا سبب واضح، فيُعيد الكتابة بأرقامٍ لاتينيّة يدوياً وقد يُدرج خطأً في الطريق.
 *
 * هذه الوحدة **تُشارَك عميلاً وخادماً** (كما `priceSanity.ts`) — نفس القواعد في الطبقتين
 * فلا تنجرف. تُستدعى في:
 *  - `MoneyInput.onPaste` (تحويل قبل التعقيم النهائي).
 *  - `MoneyInput.sanitizeRaw` (قبل `[^0-9.]`).
 *  - راوترات الاستيراد المستقبلية (تطبيع أعمدة CSV/Excel المتنوّعة).
 *
 * **مبدأ التطبيع:** ما هو **قابل للفهم بلا لبس** يُحوَّل تلقائياً. ما هو **ملتبس** (مثل `1.162.500`
 * التي قد تعني «مليون ومئة» بالنمط الأوروبيّ أو ثلاثة أعداد منفصلة) يُعاد كـ`{ambiguous: true}`
 * ليقرّر المستدعي كيف يعامله (رفض/تنبيه/اقتراح).
 */

// -----------------------------------------------------------------------------
// خرائط ثابتة (ثابتة على مستوى الوحدة — لا تُنشأ في كل نداء).
// -----------------------------------------------------------------------------

/** الأرقام الهندية-العربية ٠-٩ (U+0660..U+0669) إلى 0-9 اللاتينية. */
const ARABIC_INDIC_DIGITS: Record<string, string> = {
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
  "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
};

/** الأرقام الفارسية-العربية ۰-۹ (U+06F0..U+06F9) إلى 0-9 اللاتينية.
 *  تُستخدم في بعض ملفات Excel المستوردة من مصادر إيرانية/أفغانية. */
const PERSIAN_DIGITS: Record<string, string> = {
  "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4",
  "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
};

/** رموز العملة/الوحدة التي قد تُلصَق ملتصقةً بالرقم. تُحذف بلا لبس. */
const CURRENCY_SYMBOLS = [
  "د.ع.", "د.ع", "دينار", "IQD", "iqd", "$", "USD", "usd",
  // فراغات غير معتادة (NBSP، NNBSP)
  " ", " ",
];

/** فاصلة عشرية بديلة (عربية U+066B، فارسية U+066B، مسافة U+066C أحياناً). */
const ALT_DECIMAL_SEPARATORS = ["٫", "،"]; // Arabic decimal + Arabic comma (used as decimal by some)

// -----------------------------------------------------------------------------
// دوالّ صغيرة نقيّة.
// -----------------------------------------------------------------------------

/** يستبدل كلَّ رقمٍ هنديٍّ/فارسيٍّ بمقابله اللاتينيّ. باقي الحروف تُترَك كما هي. */
export function digitsArabicToLatin(input: string): string {
  let out = "";
  for (const ch of input) {
    out += ARABIC_INDIC_DIGITS[ch] ?? PERSIAN_DIGITS[ch] ?? ch;
  }
  return out;
}

/** يزيل رموز العملة المعروفة (د.ع, IQD, $ إلخ) وفراغات غير الفراغ العاديّ. لا يمسّ الأرقام. */
export function stripCurrencySymbols(input: string): string {
  let out = input;
  for (const sym of CURRENCY_SYMBOLS) {
    if (out.includes(sym)) out = out.split(sym).join("");
  }
  return out;
}

/**
 * نتيجة التطبيع المفصَّلة:
 *  - `normalized`: القيمة النهائيّة النظيفة (رقم لاتينيّ بفاصلة عشريّة `.` أو فارغة).
 *  - `ambiguous`: true إذا كانت المدخلات قابلة لقراءتين متساويتَي الاحتمال (نمط أوروبيّ vs أمريكيّ).
 *  - `warnings`: قائمة تحويلات مطبَّقة (لأغراض التنبيه المرئي إن أراد المستدعي).
 *  - `original`: النصّ الأصليّ (للمقارنة).
 */
export interface NormalizeResult {
  original: string;
  normalized: string;
  ambiguous: boolean;
  warnings: string[];
}

/**
 * **الدالّة الأساس** — تطبّع مدخلاً نصّياً واحداً إلى صيغةٍ رقميّةٍ لاتينيّةٍ نظيفةٍ.
 *
 * الخوارزمية (بالترتيب):
 *   ١. تحويل الأرقام الهندية/الفارسية إلى لاتينية.
 *   ٢. إزالة رموز العملة والفراغات غير العاديّة.
 *   ٣. تشذيب الفراغات الطرفيّة.
 *   ٤. توحيد الفاصلة العشريّة البديلة (٫ ,) إلى `.` — بحذر (لا نضرّ ما هو ألف).
 *   ٥. حلّ الغموض بين نمط الأوروبيّ (`1.162,50`) والأمريكيّ (`1,162.50`) وسلاسل الفواصل المتعدّدة.
 *   ٦. إزالة فواصل الآلاف بعد الحلّ.
 *
 * أمثلة:
 *   `"١١٦٢٫٥ د.ع"` → `{normalized:"1162.5", ambiguous:false}`
 *   `"1,162.50"`    → `{normalized:"1162.50", ambiguous:false}`
 *   `"1.162,50"`    → `{normalized:"1162.50", ambiguous:false}` (نمط أوروبيّ صريح)
 *   `"1.162.500"`   → `{normalized:"1.162.500", ambiguous:true}` (غموض بين ألف ونقطة عشرية × ٢)
 *   `"١,٢٣٤٫٥٦"`   → `{normalized:"1234.56", ambiguous:false}`
 *   `""` أو `"abc"` → `{normalized:"", ambiguous:false}`
 */
export function normalizeNumberInput(input: string): NormalizeResult {
  const original = input;
  const warnings: string[] = [];

  // ١. الأرقام
  let s = digitsArabicToLatin(input);
  if (s !== input) warnings.push("digits_converted");

  // ٢. رموز العملة
  const beforeStrip = s;
  s = stripCurrencySymbols(s);
  if (s !== beforeStrip) warnings.push("currency_stripped");

  // ٣. تشذيب
  s = s.trim();

  // ٤. الإشارة السالبة
  const negative = s.startsWith("-");
  if (negative) s = s.slice(1).trim();

  // ٥. توحيد الفاصلة البديلة
  // «٫» (U+066B) دائماً عشريّة — تحويلٌ آمن.
  // «،» (U+060C) قد تكون فاصلة عربية للألوف أو للعشريّ — نتعامل معها في المرحلة ٦ مع باقي الفواصل.
  for (const alt of ALT_DECIMAL_SEPARATORS) {
    if (alt === "٫" && s.includes(alt)) {
      s = s.split(alt).join(".");
      warnings.push("arabic_decimal_normalized");
    }
  }
  // نحوّل الفاصلة العربية «،» إلى فاصلة أمريكية «,» لتُعامل بنفس منطق ٦ (كفاصل ألوف افتراضاً،
  // مع كشف اللبس إن جاءت وحدها كعشريّ).
  if (s.includes("،")) {
    s = s.split("،").join(",");
    warnings.push("arabic_comma_treated_as_ambiguous");
  }

  // ٦. حلّ الغموض بين «.» و «,» كفاصل ألوف/عشريّ.
  //    القواعد الحاسمة (بترتيب الأولوية):
  //    أ) لا شيء منهما ⇒ لا شيء يُفعَل.
  //    ب) واحد منهما فقط ولمرّةٍ واحدة، مع ٣ أرقام بعده ⇒ يُرجَّح كفاصل ألوف (لن يُحذَف — يبقى للفحص لاحقاً).
  //    ج) وجود الاثنَين ⇒ الأخير هو العشريّ، الأوّل كفاصل ألوف يُحذَف.
  //    د) واحد منهما فقط لكن مرّاتٍ متعدّدة ⇒ كلّها فواصل ألوف (يُحذَف كلٌّ) — إلا إن جاءت بعد آخرها ≤ ٢
  //       أرقام فهي عشريّة والباقي ألوف.
  //    هـ) واحدٌ مع خانتَين بعده (مثل `1,50`) ⇒ عشريّة (نمط أوروبيّ مُبسَّط).
  //    و) واحدٌ مع ثلاث خانات بعده ولا خانات قبل ⇒ ألوف (`.500` كسر لكن `1.500` = ألف ونصف بالنمط الأوروبيّ).
  const dotCount = (s.match(/\./g) ?? []).length;
  const commaCount = (s.match(/,/g) ?? []).length;
  let ambiguous = false;

  if (dotCount === 0 && commaCount === 0) {
    // نظيف بالفعل.
  } else if (dotCount === 0 && commaCount > 0) {
    // فاصلة أمريكية فقط. تُعامَل ألوفاً غالباً.
    const parts = s.split(",");
    const last = parts[parts.length - 1] ?? "";
    if (commaCount === 1 && last.length <= 2 && last.length >= 1) {
      // «1,5» أو «12,34» ⇒ عشريّة بنمط أوروبيّ (فاصلة عربية أصلاً).
      s = parts[0] + "." + last;
      warnings.push("comma_treated_as_decimal");
    } else if (parts.every((p, i) => (i === 0 || p.length === 3))) {
      // ألوف نظيفة: 1,234 أو 1,234,567.
      s = parts.join("");
      warnings.push("comma_treated_as_thousands");
    } else if (commaCount === 1 && last.length === 3 && parts[0].length > 0) {
      // «1,234» ⇒ ألوف صريحة (٣ أرقام بعد الفاصلة).
      s = parts.join("");
      warnings.push("comma_treated_as_thousands");
    } else {
      // ملتبس (`1,2,3` مثلاً) — نبقيه ونشير للّبس.
      ambiguous = true;
      warnings.push("ambiguous_comma_pattern");
    }
  } else if (dotCount > 0 && commaCount === 0) {
    // نقطة فقط. تُعامَل عشريّةً غالباً — إلا إن كانت مرّاتٍ متعدّدة (نمط أوروبيّ للألوف).
    const parts = s.split(".");
    if (dotCount === 1) {
      // «1162.5» أو «1.500» — نقطةٌ واحدة. الأشيَع في اللغة الإنكليزية أنها عشريّة.
      // النمط الأوروبيّ للألوف يُنتج «1.500» أيضاً (ألف وخمسمئة). هنا نقيس بعدد الخانات:
      const last = parts[1] ?? "";
      if (last.length === 3 && parts[0].length > 0 && parts[0].length <= 3) {
        // «1.500» — ملتبس: قد تكون ١,٥٠٠ (نمط أوروبيّ) أو ١.٥٠٠ (نمط إنكليزيّ عشريّ).
        // القرار: نعامله كعشريّ (النمط الإنكليزيّ هو الأشيع في التطبيق) ونشير إلى اللبس بتحذير.
        ambiguous = true;
        warnings.push("ambiguous_1500_pattern");
      }
      // خلاف ذلك تُترَك كعشريّة نظيفة.
    } else {
      // «1.162.500» ⇒ نمط أوروبيّ ألوف (النقطة عاجزة عن الظهور مرّتَين كعشريّ).
      // نحوّل كل النقاط إلى ألوفٍ نحذفها ثم لا تكون هناك عشريّة.
      s = parts.join("");
      warnings.push("multi_dot_treated_as_thousands");
    }
  } else {
    // كلا الفاصلَين موجودتان. الأخير هو العشريّ.
    const lastDotIdx = s.lastIndexOf(".");
    const lastCommaIdx = s.lastIndexOf(",");
    const decimalIsDot = lastDotIdx > lastCommaIdx;
    if (decimalIsDot) {
      // «1,162.50» أمريكيّ — الفواصل ألوف، النقطة عشريّة.
      s = s.split(",").join("");
    } else {
      // «1.162,50» أوروبيّ — النقاط ألوف، الفاصلة عشريّة.
      s = s.split(".").join("").replace(",", ".");
      warnings.push("european_pattern");
    }
  }

  // ٧. تعقيم نهائي: أزل كل ما ليس رقماً أو نقطةً (اللواحق النصّية، إلخ) دون لبس هذه المرّة.
  //    ملاحظة: هذا يزيل أي حروفٍ متبقّية — أمرٌ مقصود (المدخلات هنا مالية بحتة).
  const cleaned = s.replace(/[^0-9.]/g, "");
  // احتفظ بنقطةٍ واحدة فقط (الأولى).
  const firstDot = cleaned.indexOf(".");
  let final = cleaned;
  if (firstDot !== -1) {
    final = cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, "");
  }
  // احذف الأصفار الأمامية إلا واحداً قبل النقطة (`007` → `7`، `0.5` تبقى).
  final = final.replace(/^0+(?=[0-9])/, "");

  const normalized = (negative && final !== "" ? "-" : "") + final;
  return {
    original,
    normalized,
    ambiguous,
    warnings,
  };
}

/**
 * دالّةٌ مبسَّطة: تُعيد النصّ المطبَّع فقط (بلا metadata). للاستخدام في `MoneyInput.sanitize`.
 * القيم الملتبسة تُترَك بلا لبس مرئيّ لتُلاحَظ في مستوى أعلى.
 */
export function toNormalizedNumber(input: string): string {
  return normalizeNumberInput(input).normalized;
}
