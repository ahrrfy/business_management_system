import { describe, it, expect } from "vitest";
import {
  ean13CheckDigit,
  isValidEan13,
  genEan13,
  incEan13,
  deriveSku,
  barcodeState,
  barcodeInfo,
  marginPercent,
  toArabicDigits,
  onlyDigits,
  variantStockTotal,
  parseVariantPaste,
  syncColorChipsOnRename,
} from "./variants";

describe("EAN-13", () => {
  it("يحسب خانة التحقّق القياسية", () => {
    // 6291041500213 — باركود مرجعي شائع، خانة تحقّقه 3.
    expect(ean13CheckDigit("629104150021")).toBe(3);
    // مثال GS1 القياسي 400638133393 ⇒ 1.
    expect(ean13CheckDigit("400638133393")).toBe(1);
  });

  it("يقبل الصالح ويرفض غير الصالح", () => {
    expect(isValidEan13("6291041500213")).toBe(true);
    expect(isValidEan13("6291041500214")).toBe(false); // خانة تحقّق خاطئة
    expect(isValidEan13("62910415002")).toBe(false); // أقصر من ١٣
    expect(isValidEan13("629104150021A")).toBe(false); // حرف غير رقمي
    expect(isValidEan13("")).toBe(false);
  });

  it("genEan13 ينتج باركوداً صالحاً بالبادئة المطلوبة", () => {
    for (let i = 0; i < 50; i++) {
      const code = genEan13("621");
      expect(code).toMatch(/^\d{13}$/);
      expect(code.startsWith("621")).toBe(true);
      expect(isValidEan13(code)).toBe(true);
    }
  });

  it("incEan13 يزيد بمقدار واحد ويبقى صالحاً", () => {
    const start = genEan13("621");
    const next = incEan13(start);
    expect(isValidEan13(next)).toBe(true);
    // الجسم (أول ١٢ رقماً) يزيد بمقدار ١.
    expect(Number(next.slice(0, 12)) - Number(start.slice(0, 12))).toBe(1);
  });

  it("incEan13 يبدأ من مجال افتراضي حين يكون المدخل غير صالح", () => {
    expect(isValidEan13(incEan13(""))).toBe(true);
    expect(isValidEan13(incEan13("abc"))).toBe(true);
  });
});

describe("deriveSku", () => {
  it("يشتقّ رمزاً من البادئة + كود اللون + القياس", () => {
    expect(deriveSku("PG-G2", "أزرق")).toBe("PG-G2-BLU");
    expect(deriveSku("PG-G2", "أحمر", "M")).toBe("PG-G2-RED-M");
    expect(deriveSku("PG-G2", "أزرق", "0.7")).toBe("PG-G2-BLU-0.7");
  });

  it("يتعامل مع لون غير معروف وبادئة فارغة", () => {
    // لون عربي معروف في بنك الألوان (تركوازي) ⇒ كود من مرادفه الإنكليزيّ (turquoise).
    expect(deriveSku("BASE", "تركواز")).toBe("BASE-TUR");
    // بادئة فارغة ⇒ "PR" الافتراضية.
    expect(deriveSku("", "أزرق")).toBe("PR-BLU");
    // لون لاتيني غير معروف: أوّل ٣ محارف بحروف كبيرة.
    expect(deriveSku("X", "Teal")).toBe("X-TEA");
  });

  it("يضمن كوداً لاتينيّاً غير فارغ ومميّزاً لكلّ لون عربيّ خارج الخريطة القصيرة (منع تكرار SKU)", () => {
    // كان أيّ اسم عربيّ غير مُخرَّط يسقط لكودٍ فارغ ⇒ عدّة ألوان تشترك في نفس الـSKU الأساس
    // ⇒ «SKU مكرّر بين المتغيّرات» يمنع الحفظ (العلّة الفعلية: برونزي/الوان كلاهما «PR»).
    const bronze = deriveSku("PR", "برونزي");
    const assorted = deriveSku("PR", "الوان");
    const gold = deriveSku("PR", "ذهبي");
    expect(bronze).toBe("PR-BRO"); // من مرادف bronze في بنك الألوان
    expect(gold).toBe("PR-GLD"); // من الخريطة القصيرة المنسّقة
    expect(assorted).not.toBe("PR"); // لم يعُد يسقط لكودٍ فارغ
    expect(new Set([bronze, assorted, gold]).size).toBe(3); // كلّها مميّزة ⇒ لا تكرار

    // ألوان عربية شائعة أخرى كانت تتصادم كلّها على «PR» — الآن أكواد مميّزة.
    const rich = ["بترولي", "زيتي", "خمري", "نحاسي", "فيروزي"].map((c) => deriveSku("PR", c));
    expect(rich.every((s) => s !== "PR")).toBe(true);
    expect(new Set(rich).size).toBe(rich.length);

    // اتّساق: الاسم العربيّ ومرادفه الإنكليزيّ يعطيان نفس الكود.
    expect(deriveSku("PR", "bronze")).toBe(deriveSku("PR", "برونزي"));
  });

  it("يميّز ألواناً تتشارك بادئة إنكليزية (خوخي/طاووسي) في نفس المنتج", () => {
    // كلاهما peach/peacock ⇒ كانا يعطيان PR-PEA ⇒ «SKU مكرّر» يمنع الحفظ.
    const peach = deriveSku("PR", "خوخي");
    const peacock = deriveSku("PR", "طاووسي");
    expect(peach).not.toBe(peacock);
  });

  it("يميّز قياسات غير لاتينية للون واحد (صغير/كبير/٣٨) — منع تكرار SKU في بُعد القياس", () => {
    // القياس العربيّ كان يُفرَّغ (replace غير اللاتيني) ⇒ صغير وكبير كلاهما PR-RED ⇒ يُمنع الحفظ.
    const sizes = ["صغير", "كبير", "٣٨"];
    const skus = sizes.map((s) => deriveSku("PR", "أحمر", s));
    expect(skus.every((s) => s !== "PR-RED")).toBe(true); // لم يعُد القياس يسقط لفراغ
    expect(new Set(skus).size).toBe(sizes.length); // كلّها مميّزة
    // القياس اللاتينيّ يبقى كما هو (لا انحدار).
    expect(deriveSku("PR", "أحمر", "M")).toBe("PR-RED-M");
  });
});

describe("barcodeState", () => {
  it("يصنّف الحالات بالأولوية الصحيحة", () => {
    expect(barcodeState("", { countInForm: 0, takenInDb: false })).toBe("empty");
    expect(barcodeState("6291041500213", { countInForm: 1, takenInDb: true })).toBe("takenInDb");
    expect(barcodeState("6291041500213", { countInForm: 2, takenInDb: false })).toBe("dupInForm");
    expect(barcodeState("6291041500214", { countInForm: 1, takenInDb: false })).toBe("invalid");
    expect(barcodeState("6291041500213", { countInForm: 1, takenInDb: false })).toBe("valid");
  });

  it("المحجوز في القاعدة يسبق فحص خانة التحقّق", () => {
    // باركود غير صالح لكنه محجوز ⇒ نُظهر «محجوز» (الأهمّ للحفظ).
    expect(barcodeState("0000000000000", { countInForm: 1, takenInDb: true })).toBe("takenInDb");
  });
});

describe("barcodeInfo — تشخيص متعدّد الترميزات (يحلّ رسالة «invalid» الكاذبة على غير EAN-13)", () => {
  const opts = { countInForm: 1, takenInDb: false };

  it("EAN-13 معياريّ ⇒ ok مع بادج «EAN-13»", () => {
    const r = barcodeInfo("4006381333931", opts);
    expect(r.severity).toBe("ok");
    expect(r.symbology.kind).toBe("EAN-13");
    expect(r.symbology.label).toBe("EAN-13");
  });

  it("UPC-A ١٢ رقماً ⇒ info مع بادج «UPC-A» — لا يُوسَم «غير صالح» كما في السلوك القديم", () => {
    const r = barcodeInfo("036000291452", opts);
    expect(r.severity).toBe("info");
    expect(r.symbology.kind).toBe("UPC-A");
    expect(r.state).toBe("valid"); // النموذج يحفظه (ليس حاصراً)
  });

  it("EAN-8 صحيح ⇒ info لا invalid", () => {
    const r = barcodeInfo("96385074", opts);
    expect(r.severity).toBe("info");
    expect(r.symbology.kind).toBe("EAN-8");
    expect(r.state).toBe("valid");
  });

  it("ITF-14 كرتون شحن ⇒ info", () => {
    const r = barcodeInfo("10012345678902", opts);
    expect(r.severity).toBe("info");
    expect(r.symbology.kind).toBe("ITF-14");
  });

  it("ISBN-13 (978-*) ⇒ ok — يُميَّز كنشرٍ", () => {
    const r = barcodeInfo("9780134685991", opts);
    expect(r.symbology.kind).toBe("ISBN-13");
    expect(r.symbology.label).toBe("ISBN");
  });

  it("EAN-13-INTERNAL نطاق 20-29 ⇒ ok مع بادج «داخلي (EAN-13)»", () => {
    const code = genEan13("200");
    const r = barcodeInfo(code, opts);
    expect(r.severity).toBe("ok");
    expect(r.symbology.kind).toBe("EAN-13-INTERNAL");
  });

  it("Code128 نصّ (اسم دفعة) ⇒ info بلا تخويف", () => {
    const r = barcodeInfo("Item#42_batch-b", opts);
    expect(r.severity).toBe("info");
    expect(r.symbology.kind).toBe("Code128");
    expect(r.state).toBe("valid");
  });

  it("EAN-13 بخانة تحقّق فاسدة ⇒ warn (يُقبل مع بادج) — قرار المالك", () => {
    const r = barcodeInfo("4006381333930", opts);
    expect(r.severity).toBe("warn");
    expect(r.symbology.kind).toBe("EAN-13");
    expect(r.symbology.valid).toBe(false);
  });

  it("المكرّر في النموذج ⇒ blocker يسبق نوع الترميز", () => {
    const r = barcodeInfo("4006381333931", { countInForm: 2, takenInDb: false });
    expect(r.severity).toBe("blocker");
    expect(r.state).toBe("dupInForm");
  });

  it("المحجوز في القاعدة ⇒ blocker يسبق نوع الترميز", () => {
    const r = barcodeInfo("4006381333931", { countInForm: 1, takenInDb: true });
    expect(r.severity).toBe("blocker");
    expect(r.state).toBe("takenInDb");
  });

  it("الفارغ ⇒ info بلا رسالة", () => {
    const r = barcodeInfo("", { countInForm: 0, takenInDb: false });
    expect(r.state).toBe("empty");
    expect(r.message).toBe("");
  });
});

describe("marginPercent", () => {
  it("يحسب الربح الموجب", () => {
    expect(marginPercent(150, 250)).toEqual({ pct: 40, loss: false });
  });
  it("يكشف الخسارة حين السعر دون التكلفة", () => {
    const m = marginPercent(300, 250);
    expect(m?.loss).toBe(true);
  });
  it("يعيد null لسعر بيع غير موجب أو غير رقمي", () => {
    expect(marginPercent(150, 0)).toBeNull();
    expect(marginPercent(150, "")).toBeNull();
    expect(marginPercent("abc", "def")).toBeNull();
  });
  it("يقبل سلاسل بفواصل/نصوص ويستخرج الرقم", () => {
    expect(marginPercent("150", "250 د.ع")).toEqual({ pct: 40, loss: false });
  });
});

describe("parseVariantPaste", () => {
  it("يحلّل صفوفاً مفصولة بـTab بترتيب التصدير (لون، قياس، SKU، باركود/وحدة…، مخزون)", () => {
    // وحدتان ⇒ ٦ أعمدة: لون، قياس، SKU، باركود١، باركود٢، مخزون.
    const text = "أزرق\tM\t\t6291041500244\t6291041511244\t24\nأخضر\tL\tGR-L\t6291041500268\t\t30";
    const rows = parseVariantPaste(text, 2);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ color: "أزرق", size: "M", sku: "", barcodes: ["6291041500244", "6291041511244"], stock: "24" });
    expect(rows[1]).toEqual({ color: "أخضر", size: "L", sku: "GR-L", barcodes: ["6291041500268", ""], stock: "30" });
  });

  it("يتجاهل الأسطر الفارغة وما لا لون له", () => {
    expect(parseVariantPaste("\n\n  \n", 1)).toEqual([]);
    // صفّ بعمود لون فارغ (الفاصلة لا تُقتطع بـtrim) ⇒ يُسقَط.
    expect(parseVariantPaste(",M,123", 1)).toEqual([]);
  });

  it("يقبل الفاصلة كفاصل أعمدة", () => {
    const rows = parseVariantPaste("أحمر,S,RED-S,629,50", 1);
    expect(rows[0]).toEqual({ color: "أحمر", size: "S", sku: "RED-S", barcodes: ["629"], stock: "50" });
  });
});

describe("أدوات العرض", () => {
  it("toArabicDigits يحوّل الأرقام", () => {
    expect(toArabicDigits(2026)).toBe("٢٠٢٦");
    expect(toArabicDigits("12 صنف")).toBe("١٢ صنف");
  });
  it("onlyDigits يُبقي الأرقام فقط", () => {
    expect(onlyDigits("12a3 ب4")).toBe("1234");
    expect(onlyDigits("--")).toBe("");
  });
  it("variantStockTotal يجمع كل الفروع", () => {
    expect(variantStockTotal({ 1: "48", 2: "12" })).toBe(60);
    expect(variantStockTotal({ 1: "", 2: "5" })).toBe(5);
    expect(variantStockTotal({})).toBe(0);
  });
});

describe("syncColorChipsOnRename — مزامنة رقائق المصفوفة عند إعادة تسمية اللون بالصفّ", () => {
  it("لون واحد (بلا قياسات): يستبدل القديم بالجديد فيبقى «ولّد» متّسقاً", () => {
    // أزرق ⇐ كحلي؛ لا متغيّر آخر يستعمل أزرق بعد التسمية ⇒ يُحذف من الرقائق ويُضاف كحلي.
    expect(syncColorChipsOnRename(["أزرق", "أحمر"], "أزرق", "كحلي", ["كحلي", "أحمر"])).toEqual(["أحمر", "كحلي"]);
  });

  it("لون بعدّة قياسات: يُبقي القديم إن كان متغيّرٌ آخر ما زال يستعمله", () => {
    // أزرق-S ⇐ كحلي، لكن أزرق-M باقٍ ⇒ يبقى أزرق في الرقائق ويُضاف كحلي.
    expect(syncColorChipsOnRename(["أزرق"], "أزرق", "كحلي", ["كحلي", "أزرق"])).toEqual(["أزرق", "كحلي"]);
  });

  it("لا يمسّ ألوان المصفوفة التي لم تُولَّد بعد", () => {
    // «بترولي» رقاقةٌ بلا متغيّر (لم تُولَّد) — إعادة تسمية أحمر⇐عنّابي لا تحذفها.
    expect(syncColorChipsOnRename(["أحمر", "بترولي"], "أحمر", "عنّابي", ["عنّابي"])).toEqual(["بترولي", "عنّابي"]);
  });

  it("اسمٌ جديد موجودٌ مسبقاً في الرقائق ⇒ لا تكرار", () => {
    expect(syncColorChipsOnRename(["أحمر", "أزرق"], "أحمر", "أزرق", ["أزرق", "أزرق"])).toEqual(["أزرق"]);
  });

  it("اسمٌ جديد فارغ ⇒ يحذف القديم (إن أُيتِم) بلا إضافة", () => {
    expect(syncColorChipsOnRename(["أحمر", "أزرق"], "أحمر", "  ", ["أزرق"])).toEqual(["أزرق"]);
  });

  it("لا قديم (لون جديد كُتب في صفٍّ كان فارغاً) ⇒ إضافةٌ فقط", () => {
    expect(syncColorChipsOnRename(["أحمر"], "", "أخضر", ["أحمر", "أخضر"])).toEqual(["أحمر", "أخضر"]);
  });
});
