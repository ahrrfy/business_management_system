import { describe, it, expect } from "vitest";
import { resolveColorHex, normalizeColorName, normalizeHex, COLOR_BANK } from "./colorBank";

describe("normalizeColorName", () => {
  it("يوحّد الهمزة والألف", () => {
    expect(normalizeColorName("أزرق")).toBe(normalizeColorName("ازرق"));
    expect(normalizeColorName("إخضر")).toBe(normalizeColorName("اخضر"));
    expect(normalizeColorName("آجري")).toBe(normalizeColorName("اجري"));
  });
  it("يزيل التشكيل والتطويل", () => {
    expect(normalizeColorName("أَزْرَق")).toBe(normalizeColorName("أزرق"));
    expect(normalizeColorName("أزـرق")).toBe(normalizeColorName("أزرق"));
  });
  it("يوحّد التاء المربوطة والألف المقصورة", () => {
    expect(normalizeColorName("خزامى")).toBe(normalizeColorName("خزامي"));
    expect(normalizeColorName("قرمزية")).toBe("قرمزيه");
  });
  it("يصغّر اللاتيني ويجمع الفواصل إلى مسافة", () => {
    expect(normalizeColorName("Royal  Blue")).toBe("royal blue");
    expect(normalizeColorName("off-white")).toBe("off white");
  });
  it("لا يبتلع الأرقام العربية-الهندية", () => {
    expect(normalizeColorName("٢٠٢٦")).toBe("٢٠٢٦");
  });
});

describe("resolveColorHex — مطابقة مباشرة", () => {
  it("أسماء أساسية", () => {
    expect(resolveColorHex("أزرق")).toBe("#0000FF");
    expect(resolveColorHex("أحمر")).toBe("#FF0000");
    expect(resolveColorHex("أخضر")).toBe("#008000");
    expect(resolveColorHex("كحلي")).toBe("#000080");
    expect(resolveColorHex("زيتي")).toBe("#808000");
    expect(resolveColorHex("تركوازي")).toBe("#40E0D0");
    expect(resolveColorHex("بترولي")).toBe("#0E5A6B");
  });
  it("تهجئة بلا همزة", () => {
    expect(resolveColorHex("ازرق")).toBe("#0000FF");
    expect(resolveColorHex("اخضر")).toBe("#008000");
  });
  it("مرادفات عربية/إنكليزية (غير حسّاسة للحالة)", () => {
    expect(resolveColorHex("blue")).toBe("#0000FF");
    expect(resolveColorHex("Navy")).toBe("#000080");
    expect(resolveColorHex("OLIVE")).toBe("#808000");
    expect(resolveColorHex("تركواز")).toBe("#40E0D0");
    expect(resolveColorHex("روز غولد")).toBe("#B76E79");
  });
  it("أسماء السوق العراقي", () => {
    expect(resolveColorHex("طابوقي")).toBe("#AB4E3D"); // طوبي
    expect(resolveColorHex("آجري")).toBe("#AB4E3D");
    expect(resolveColorHex("نبيتي")).toBe("#722F37"); // خمري
  });
});

describe("resolveColorHex — التطبيع في الاستنتاج", () => {
  it("«ال» التعريف", () => {
    expect(resolveColorHex("الأزرق")).toBe("#0000FF");
    expect(resolveColorHex("الاخضر")).toBe("#008000");
  });
  it("بادئة «لون»", () => {
    expect(resolveColorHex("لون أزرق")).toBe("#0000FF");
    expect(resolveColorHex("اللون الأزرق")).toBe("#0000FF");
  });
  it("صيغة التأنيث (ة/ه نهائية)", () => {
    expect(resolveColorHex("زيتية")).toBe("#808000");
    expect(resolveColorHex("كحلية")).toBe("#000080");
  });
});

describe("resolveColorHex — المعدِّلات (فاتح/غامق)", () => {
  it("فاتح يمزج نحو الأبيض", () => {
    expect(resolveColorHex("أزرق فاتح")).toBe("#5959FF");
  });
  it("غامق يمزج نحو الأسود", () => {
    expect(resolveColorHex("أصفر غامق")).toBe("#999900");
  });
  it("ترتيب «مُعدِّل ثم أساس» يعمل أيضاً", () => {
    expect(resolveColorHex("فاتح أزرق")).toBe(resolveColorHex("أزرق فاتح"));
  });
  it("المرادف الصريح يسبق حساب المعدِّل", () => {
    // «احمر غامق» مرادف صريح لـدموي — يفوز على تغميق الأحمر.
    expect(resolveColorHex("أحمر غامق")).toBe("#8B0000");
  });
});

describe("resolveColorHex — صيغ التأنيث (فعلاء)", () => {
  it("الألوان الأساسية بصيغة المؤنّث", () => {
    expect(resolveColorHex("حمراء")).toBe("#FF0000");
    expect(resolveColorHex("زرقاء")).toBe("#0000FF");
    expect(resolveColorHex("خضراء")).toBe("#008000");
    expect(resolveColorHex("صفراء")).toBe("#FFFF00");
    expect(resolveColorHex("بيضاء")).toBe("#FFFFFF");
    expect(resolveColorHex("سوداء")).toBe("#000000");
  });
  it("مركّب يحوي لوناً مؤنّثاً يلتقط اللون", () => {
    expect(resolveColorHex("حقيبة حمراء")).toBe("#FF0000");
  });
});

describe("resolveColorHex — معدِّل في أيّ موضع + «ال» على المعدِّل", () => {
  it("معدِّل في الوسط لا يُهمَل (لا يعود اللون الأساس عارياً)", () => {
    expect(resolveColorHex("أزرق غامق جداً")).toBe("#000099");
  });
  it("«ال» التعريف على رمز المعدِّل تُجرَّد", () => {
    expect(resolveColorHex("الأزرق الفاتح")).toBe("#5959FF");
  });
});

describe("resolveColorHex — مركّبات وحدود", () => {
  it("مركّب لونين يأخذ الأخصّ (الأخير)", () => {
    expect(resolveColorHex("أخضر زيتي")).toBe("#808000");
  });
  it("hex صالح يُمرَّر مُطبّعاً", () => {
    expect(resolveColorHex("#1e90ff")).toBe("#1E90FF");
    expect(resolveColorHex("1e90ff")).toBe("#1E90FF");
  });
  it("غير المعروف/الفارغ ⇒ null", () => {
    expect(resolveColorHex("بلابل")).toBeNull();
    expect(resolveColorHex("")).toBeNull();
    expect(resolveColorHex("   ")).toBeNull();
    expect(resolveColorHex(null)).toBeNull();
    expect(resolveColorHex(undefined)).toBeNull();
  });
});

describe("سلامة القاموس", () => {
  it("كل قيمة hex بصيغة #RRGGBB صالحة", () => {
    for (const c of COLOR_BANK) {
      expect(c.hex, c.name).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
  it("لا تكرار لأسماء معياريّة", () => {
    const names = COLOR_BANK.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
  it("عدد ألوان معتبَر (≥ 140)", () => {
    expect(COLOR_BANK.length).toBeGreaterThanOrEqual(140);
  });
});

describe("normalizeHex", () => {
  it("يقبل الصالح ويرفض غيره", () => {
    expect(normalizeHex("#abcdef")).toBe("#ABCDEF");
    expect(normalizeHex("abcdef")).toBe("#ABCDEF");
    expect(normalizeHex("#xyz")).toBeNull();
    expect(normalizeHex("blue")).toBeNull();
    expect(normalizeHex(null)).toBeNull();
  });
});
