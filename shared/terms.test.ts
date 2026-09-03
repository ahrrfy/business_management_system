import { describe, it, expect } from "vitest";
import {
  CHANNEL_SOURCE_ENUMS,
  CHANNEL_TERMS,
  PAYMENT_METHOD_SOURCE_ENUMS,
  PAYMENT_METHOD_TERMS,
  UNIFIED_CHANNELS,
  UNIFIED_PAYMENT_METHODS,
  channelCompact,
  channelProse,
  channelTerm,
  channelTermOptions,
  channelTooltip,
  isUnifiedChannel,
  isUnifiedPaymentMethod,
  paymentMethodCompact,
  paymentMethodProse,
  paymentMethodTerm,
  paymentMethodTermOptions,
  paymentMethodTooltip,
  type Term,
} from "./terms";
import { RECEPTION_CHANNELS, WORK_ORDER_CHANNELS } from "./receptionChannel";
import { INVOICE_CHANNELS } from "./invoiceChannel";
import { SALES_LEAD_SOURCES } from "./salesPipeline";

/** U+064B..U+0652 (فتحة/ضمّة/كسرة/شدّة/سكون/تنوين) + U+0653..U+065F + U+0670.
 * بالهروب السداسيّ لا بالحروف: نطاقٌ عربيّ داخل [...] يُقلَب بصرياً في المحرّر (bidi)
 * فيُقرأ خطأً ويُعدَّل خطأً — نفسُ نطاق scripts/check-tashkeel-in-small-text.mjs.
 */
const TASHKEEL_RE = /[\u064B-\u0652\u0653-\u065F\u0670]/;

/** كلُّ القواميس في هذا الملفّ تُفحَص بنفس المعايير — لا قاموسَ يُفلت من الحارس. */
const DICTS: { name: string; keys: readonly string[]; terms: Record<string, Term> }[] = [
  { name: "القناة", keys: UNIFIED_CHANNELS, terms: CHANNEL_TERMS },
  { name: "طريقة الدفع", keys: UNIFIED_PAYMENT_METHODS, terms: PAYMENT_METHOD_TERMS },
];

describe("القاموس الموحَّد — البنية", () => {
  it.each(DICTS)("$name: كل مصطلح يحوي compact + prose + tooltip بلا فراغ", ({ terms }) => {
    for (const [key, val] of Object.entries(terms)) {
      expect(val.compact.trim(), `compact لـ${key}`).not.toBe("");
      expect(val.prose.trim(), `prose لـ${key}`).not.toBe("");
      expect(val.tooltip.trim(), `tooltip لـ${key}`).not.toBe("");
      // شرحٌ أقصرُ من ٢٠ محرفاً يعيد كتابةَ الاسم بدل تفسيره — وهو ما يجعل الـtooltip زينةً.
      expect(val.tooltip.length, `tooltip لـ${key} ≥ 20 محرفاً`).toBeGreaterThanOrEqual(20);
    }
  });

  it.each(DICTS)("$name: لا قيمةَ بلا تسمية (مفتاحُ الاتّحاد ⇒ مصطلحٌ موجود)", ({ keys, terms }) => {
    for (const key of keys) {
      expect(terms[key], `القيمة ${key} بلا مصطلح`).toBeDefined();
    }
    // والعكسُ أيضاً: لا مصطلحَ يتيمٌ لا تقابله قيمةٌ في الاتّحاد.
    expect(Object.keys(terms).sort()).toEqual([...keys].sort());
  });

  it.each(DICTS)("$name: لا تكرارَ في المفاتيح", ({ keys }) => {
    expect(new Set(keys).size, `مفاتيحُ ${keys.length} فيها تكرار`).toBe(keys.length);
  });

  it.each(DICTS)("$name: لا تكرارَ في نصّ compact (اسمان متطابقان ⇒ شارتان لا تُميَّزان)", ({ keys, terms }) => {
    const compacts = keys.map((k) => terms[k].compact);
    expect(new Set(compacts).size, `compact مكرَّر: ${compacts.join(" · ")}`).toBe(compacts.length);
  });
});

describe("القاموس الموحَّد — قاعدة التشكيل", () => {
  it.each(DICTS)("$name: لا تشكيلَ في compact (الخطّ تحت 14px يرسم «مُ» كأنّها «ف»)", ({ terms }) => {
    for (const [key, val] of Object.entries(terms)) {
      expect(
        TASHKEEL_RE.test(val.compact),
        `compact لـ${key} فيه تشكيل: "${val.compact}"`,
      ).toBe(false);
    }
  });

  it("prose يحمل التشكيلَ فعلاً (وإلّا فلا معنى لوجود نسختين)", () => {
    const withTashkeel = [...Object.values(CHANNEL_TERMS), ...Object.values(PAYMENT_METHOD_TERMS)]
      .filter((v) => TASHKEEL_RE.test(v.prose));
    expect(withTashkeel.length).toBeGreaterThan(5);
  });
});

describe("الاتّحادُ يغطّي كلَّ تعدادٍ مصدريّ", () => {
  it("كلُّ قيمةٍ في كلّ تعدادٍ مصدريّ للقناة لها مصطلح", () => {
    for (const [enumName, values] of Object.entries(CHANNEL_SOURCE_ENUMS)) {
      for (const v of values) {
        expect(CHANNEL_TERMS[v], `${enumName}.${v} بلا مصطلح`).toBeDefined();
      }
    }
  });

  it("كلُّ قيمةٍ في كلّ تعدادٍ مصدريّ لطريقة الدفع لها مصطلح", () => {
    for (const [enumName, values] of Object.entries(PAYMENT_METHOD_SOURCE_ENUMS)) {
      for (const v of values) {
        expect(PAYMENT_METHOD_TERMS[v], `${enumName}.${v} بلا مصطلح`).toBeDefined();
      }
    }
  });

  it("لا قيمةَ في الاتّحاد بلا مصدرٍ يُبرّرها (الاتّحادُ اتّحادٌ لا توسيع)", () => {
    const fromSources = new Set(Object.values(CHANNEL_SOURCE_ENUMS).flat());
    for (const v of UNIFIED_CHANNELS) {
      expect(fromSources.has(v), `${v} في الاتّحاد بلا تعدادٍ مصدريّ`).toBe(true);
    }
    const payFromSources = new Set(Object.values(PAYMENT_METHOD_SOURCE_ENUMS).flat());
    for (const v of UNIFIED_PAYMENT_METHODS) {
      expect(payFromSources.has(v), `${v} في الاتّحاد بلا تعدادٍ مصدريّ`).toBe(true);
    }
  });
});

describe("الاتّحادُ يغطّي القواميسَ المشترَكة القائمة (كاشفُ انجرافٍ مستقبليّ)", () => {
  it("RECEPTION_CHANNELS ⊆ الاتّحاد", () => {
    for (const v of RECEPTION_CHANNELS) {
      expect(isUnifiedChannel(v), `receptionChannel.${v} خارج الاتّحاد`).toBe(true);
    }
  });

  it("INVOICE_CHANNELS ⊆ الاتّحاد", () => {
    for (const v of INVOICE_CHANNELS) {
      expect(isUnifiedChannel(v), `invoiceChannel.${v} خارج الاتّحاد`).toBe(true);
    }
  });

  it("SALES_LEAD_SOURCES ⊆ الاتّحاد", () => {
    for (const v of SALES_LEAD_SOURCES) {
      expect(isUnifiedChannel(v), `salesLeads.source.${v} خارج الاتّحاد`).toBe(true);
    }
  });

  it("سجلُّ `receptionChannel` هنا يطابق WORK_ORDER_CHANNELS (لا نسخةَ ثالثة تنجرف)", () => {
    expect([...CHANNEL_SOURCE_ENUMS.receptionChannel].sort()).toEqual([...WORK_ORDER_CHANNELS].sort());
  });

  it("`sourceChannel` نسخةٌ حرفية من `convChannel` — يُثبتها الاختبار كما يقول تعليقُ المخطّط", () => {
    expect([...CHANNEL_SOURCE_ENUMS.sourceChannel]).toEqual([...CHANNEL_SOURCE_ENUMS.convChannel]);
  });
});

describe("دوالُّ الوصول — القناة", () => {
  it("تُرجع المصطلحَ الصحيح للقيمة المعروفة", () => {
    expect(channelCompact("WALK_IN")).toBe("حضوري");
    expect(channelProse("STORE")).toBe(CHANNEL_TERMS.STORE.prose);
    expect(channelTooltip("PHONE")).toBe(CHANNEL_TERMS.PHONE.tooltip);
    expect(channelTerm("WHATSAPP")).toEqual(CHANNEL_TERMS.WHATSAPP);
  });

  it("NULL لا يُفترَض WALK_IN — الافتراضُ ملكُ العمود لا ملكُ المفهوم", () => {
    expect(channelTerm(null)).toBeNull();
    expect(channelTerm(undefined)).toBeNull();
    expect(channelTerm("")).toBeNull();
    expect(channelCompact(null)).toBe("—");
    expect(channelProse(undefined)).toBe("—");
    expect(channelTooltip(null)).toBe("");
  });

  it("القيمةُ المجهولة تُطوى إلى OTHER بدل عرض رمزٍ إنجليزيّ خامّ", () => {
    expect(channelCompact("SNAPCHAT")).toBe(CHANNEL_TERMS.OTHER.compact);
    expect(channelTerm("SNAPCHAT")).toEqual(CHANNEL_TERMS.OTHER);
  });

  it("channelTermOptions تحترم التضييقَ بتعداد العمود", () => {
    const opts = channelTermOptions(CHANNEL_SOURCE_ENUMS.reservationChannel);
    expect(opts.map((o) => o.value)).toEqual(["PHONE", "WALK_IN", "WHATSAPP", "STORE"]);
    expect(opts[0].compact).toBe(CHANNEL_TERMS.PHONE.compact);
    // بلا تضييقٍ تُرجع الاتّحادَ كاملاً بترتيبه المقصود.
    expect(channelTermOptions().map((o) => o.value)).toEqual([...UNIFIED_CHANNELS]);
  });
});

describe("دوالُّ الوصول — طريقة الدفع", () => {
  it("تُرجع المصطلحَ الصحيح للقيمة المعروفة", () => {
    expect(paymentMethodCompact("CASH")).toBe("نقدي");
    expect(paymentMethodCompact("CHECK")).toBe("صك");
    expect(paymentMethodProse("TRANSFER")).toBe(PAYMENT_METHOD_TERMS.TRANSFER.prose);
    expect(paymentMethodTooltip("TELECOM")).toBe(PAYMENT_METHOD_TERMS.TELECOM.tooltip);
  });

  it("الفارغُ «—» والمجهولُ يعود بالرمز نفسه (سلوكُ paymentMethodLabel القائم محفوظ)", () => {
    expect(paymentMethodCompact(null)).toBe("—");
    expect(paymentMethodCompact("")).toBe("—");
    expect(paymentMethodCompact("CRYPTO")).toBe("CRYPTO");
    expect(paymentMethodProse("CRYPTO")).toBe("CRYPTO");
    expect(paymentMethodTerm("CRYPTO")).toBeNull();
    expect(paymentMethodTooltip("CRYPTO")).toBe("");
  });

  it("ACCRUAL و MIXED حاضرتان — الأولى أسقطها قاموسُ Expenses والثانية أسقطتها قواميسُ عدّة", () => {
    expect(isUnifiedPaymentMethod("ACCRUAL")).toBe(true);
    expect(isUnifiedPaymentMethod("MIXED")).toBe(true);
    expect(paymentMethodCompact("ACCRUAL")).toBe("استحقاق");
    expect(paymentMethodCompact("MIXED")).toBe("مختلطة");
  });

  it("paymentMethodTermOptions تحترم التضييقَ بتعداد العمود", () => {
    const opts = paymentMethodTermOptions(PAYMENT_METHOD_SOURCE_ENUMS.woPaymentMethod);
    expect(opts.map((o) => o.value)).toEqual(["CASH", "CARD", "TRANSFER", "WALLET", "TELECOM"]);
    expect(paymentMethodTermOptions().map((o) => o.value)).toEqual([...UNIFIED_PAYMENT_METHODS]);
  });
});
