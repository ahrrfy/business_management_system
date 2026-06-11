// اختبارات وحدات نقية لمحرّك الاستيراد — شريحة import-integration:
// قسر moneySigned (أقواس/سوالب/نقطة زائدة/تقريب HALF_UP)، تطبيع الترويسات (توحيد الألف)،
// الهاتف العراقي E.164، التاريخ، ومطابقة autoMapColumns لترويسات ملفات النظام القديم الحرفية
// (مراجعة العملاء/الموردين/الأصناف — كما في excel-analysis.json).
import { describe, expect, it } from "vitest";
import {
  autoMapColumns,
  buildRows,
  coerceValue,
  parseSheet,
  duplicateKeyOf,
  findBarcodeConflicts,
  findFileDuplicates,
  findSkuConflicts,
  mergeSummaries,
  normHeader,
  normalizeIraqPhone,
  splitIntoBatches,
  type ImportField,
  type ImportParseResult,
  type ImportSummary,
  type ParsedRow,
} from "../import";
import {
  CUSTOMER_FIELDS,
  PRODUCT_FIELDS,
  SUPPLIER_FIELDS,
} from "../importFields";
import type {
  CustomerImportRow,
  ProductImportRow,
  SupplierImportRow,
} from "../importTypes";

const cf = (key: keyof CustomerImportRow) => CUSTOMER_FIELDS.find((f) => f.key === key)!;
const pf = (key: keyof ProductImportRow) => PRODUCT_FIELDS.find((f) => f.key === key)!;

/** صفّ مُقسَر مصغّر لاختبار فحوص الملف الكامل. */
function row<TRow>(rowNumber: number, values: Partial<TRow>): ParsedRow<TRow> {
  return { rowNumber, raw: {}, values, errors: [], warnings: [] };
}

/* ───────────────────────── قسر moneySigned (أرصدة النظام القديم) ───────────────────────── */

describe("moneySigned — صيغ ملفات النظام القديم", () => {
  const balance = cf("openingBalance");

  it("أقواس مربعة = سالب: [123] → -123", () => {
    expect(coerceValue(balance, "[123]").value).toBe("-123");
  });
  it("أقواس مربعة مع فواصل آلاف ونقطة زائدة: [27,749,996.] → -27749996", () => {
    expect(coerceValue(balance, "[27,749,996.]").value).toBe("-27749996");
  });
  it("أقواس محاسبية = سالب: (123.45) → -123.45", () => {
    expect(coerceValue(balance, "(123.45)").value).toBe("-123.45");
  });
  it("سالب صريح يبقى: -28920682.01", () => {
    expect(coerceValue(balance, "-28920682.01").value).toBe("-28920682.01");
  });
  it("نقطة زائدة في النهاية: 2,988,100. → 2988100", () => {
    expect(coerceValue(balance, "2,988,100.").value).toBe("2988100");
  });
  it("تقريب نصّي HALF_UP لمنزلتين: 2291.678 → 2291.68", () => {
    expect(coerceValue(balance, "2291.678").value).toBe("2291.68");
  });
  it("تقريب سالب HALF_UP (بعيداً عن الصفر): [2291.675] → -2291.68", () => {
    expect(coerceValue(balance, "[2291.675]").value).toBe("-2291.68");
  });
  it("أرقام عربية: ٩٧٧٨٩٩٫٥ → 977899.5", () => {
    expect(coerceValue(balance, "٩٧٧٨٩٩٫٥").value).toBe("977899.5");
  });
  it("صفر سالب يُطبَّع موجباً: [0] → 0", () => {
    expect(coerceValue(balance, "[0]").value).toBe("0");
  });
  it("صيغة علمية (عَطَب فاصلة عائمة من النظام القديم): -2.6E-11 → 0.00 — رفضُها كان يُضيع سجلّ المورد كاملاً", () => {
    expect(coerceValue(balance, "-2.6E-11")).toEqual({ value: "0.00", error: null });
  });
  it("صيغة علمية موجبة تُطبَّع منزلتين: 1.5E2 → 150.00", () => {
    expect(coerceValue(balance, "1.5E2").value).toBe("150.00");
  });
  it("نصّ غير رقمي يُرفض", () => {
    expect(coerceValue(balance, "abc").error).toBeTruthy();
  });
  it("إشارة مزدوجة خردة تُرفض: --4 و[-4]", () => {
    expect(coerceValue(balance, "--4").error).toBeTruthy();
    expect(coerceValue(balance, "[-4]").error).toBeTruthy();
  });
});

describe("money — تقريب وتطبيع", () => {
  const credit = cf("creditLimit");

  it("نقطة زائدة: 2,621. → 2621", () => {
    expect(coerceValue(credit, "2,621.").value).toBe("2621");
  });
  it("تقريب HALF_UP: 2291.678 → 2291.68", () => {
    expect(coerceValue(credit, "2291.678").value).toBe("2291.68");
  });
  it("منزلتان أو أقل تبقى كما هي: 1500.50", () => {
    expect(coerceValue(credit, "1500.50").value).toBe("1500.50");
  });
  it("السالب مرفوض للنوع money (غير الموقَّع)", () => {
    expect(coerceValue(credit, "-5").error).toBeTruthy();
  });
});

/* ───────────────────────── integer / boolean / date / phone ───────────────────────── */

describe("integer — نقطة زائدة وسياسة المخزون السالب", () => {
  const stock = pf("openingStock");

  it("نقطة زائدة تُبتلَع: «4.» → 4", () => {
    expect(coerceValue(stock, "4.")).toEqual({ value: 4, error: null });
  });
  it("السالب = خطأ صفّي (قرار المالك ١١/٦: لا يُستورَد ويُتجاوَز الصف)", () => {
    const r = coerceValue(stock, "-7");
    expect(r.value).toBeUndefined();
    expect(r.error).toContain("لم يُستورَد");
  });
  it("السالب بأقواس مربعة («[1.]» — ١٤٤١ صفاً مقيسة في ملف الأصناف) خطأ صفّي بالرسالة الواضحة لا «قيمة رقمية غير صالحة»", () => {
    for (const v of ["[1.]", "[2.]", "[402.]"]) {
      const r = coerceValue(stock, v);
      expect(r.value, v).toBeUndefined();
      expect(r.error, v).toContain("لم يُستورَد");
    }
  });
  it("السالب بأقواس محاسبية (7.) خطأ صفّي أيضاً، و[0.] يبقى صفراً موجباً مقبولاً", () => {
    const r = coerceValue(stock, "(7.)");
    expect(r.value).toBeUndefined();
    expect(r.error).toContain("لم يُستورَد");
    const zero = coerceValue(stock, "[0.]");
    expect(zero).toEqual({ value: 0, error: null });
  });
  it("الكسري الحقيقي يفشل: 4.5", () => {
    expect(coerceValue(stock, "4.5").error).toBe("يجب أن يكون عدداً صحيحاً");
  });
  it("الكسري السالب يأخذ رسالة السالب الواضحة ([4.5] و-4.5 — فحص السالب قبل فحص الصحيح)", () => {
    expect(coerceValue(stock, "[4.5]").error).toContain("لم يُستورَد");
    expect(coerceValue(stock, "-4.5").error).toContain("لم يُستورَد");
  });
  it("إشارة مزدوجة خردة تُرفض: [-4]", () => {
    expect(coerceValue(stock, "[-4]").error).toBe("قيمة رقمية غير صالحة");
  });
});

describe("boolean — صيغة TRUE/FALSE في ملفات النظام القديم", () => {
  const active = cf("isActive");

  it("TRUE → نعم", () => {
    expect(coerceValue(active, "TRUE")).toEqual({ value: true, error: null });
  });
  it("FALSE → لا", () => {
    expect(coerceValue(active, "FALSE")).toEqual({ value: false, error: null });
  });
});

describe("date — صيغة YYYY-MM-DD فقط", () => {
  const last = cf("lastDealtAt");

  it("تاريخ صالح يمرّ: 2026-01-07", () => {
    expect(coerceValue(last, "2026-01-07")).toEqual({ value: "2026-01-07", error: null });
  });
  it("صيغة أخرى تُرفض برسالة واضحة: 07/01/2026", () => {
    expect(coerceValue(last, "07/01/2026").error).toContain("YYYY-MM-DD");
  });
  it("شهر مستحيل يُرفض: 2026-13-07", () => {
    expect(coerceValue(last, "2026-13-07").error).toBeTruthy();
  });
});

describe("normalizeIraqPhone — تطبيع E.164", () => {
  it("07XXXXXXXXX (١١ رقماً) → +9647XXXXXXXXX", () => {
    expect(normalizeIraqPhone("07901199308")).toBe("+9647901199308");
  });
  it("009647… → +9647…", () => {
    expect(normalizeIraqPhone("009647901199308")).toBe("+9647901199308");
  });
  it("9647… → +9647…", () => {
    expect(normalizeIraqPhone("9647901199308")).toBe("+9647901199308");
  });
  it("+9647… يبقى كما هو", () => {
    expect(normalizeIraqPhone("+9647901199308")).toBe("+9647901199308");
  });
  it("أرقام عربية تُطبَّع ثم تُحوَّل", () => {
    expect(normalizeIraqPhone("٠٧٩٠١١٩٩٣٠٨")).toBe("+9647901199308");
  });
  it("ما لا يطابق الأنماط يُمرَّر كما هو (لا رفض)", () => {
    expect(normalizeIraqPhone("12345")).toBe("12345");
  });
  it("قسر النوع phone يطبّق التطبيع", () => {
    expect(coerceValue(cf("phone"), "07701234567").value).toBe("+9647701234567");
  });
});

/* ───────────────── حدود الأطوال (مرآة zod الخادم) — خطأ صفّي لا رفض دفعة كاملة ───────────────── */

describe("maxLen — إنفاذ حدود الخادم في العميل", () => {
  it("هاتف أطول من ٢٠ محرفاً (أرقام محشورة في خلية واحدة) ⇒ خطأ صفّي", () => {
    // نمط حقيقي من ملف المبيعات القديم: عدة هواتف في خلية واحدة (قيست حتى ١٢٨ محرفاً).
    const crammed = "07901111111 - 07902222222 - 07903333333";
    const r = coerceValue(cf("phone"), crammed);
    expect(r.value).toBeUndefined();
    expect(r.error).toContain("أطول من المسموح");
    expect(r.error).toContain("هاتف واحد");
  });
  it("هاتف صالح بعد التطبيع (+9647… = ١٤ محرفاً) يمرّ", () => {
    expect(coerceValue(cf("phone"), "07901199308").error).toBeNull();
  });
  it("الرقم القديم أطول من ٤٠ محرفاً ⇒ خطأ صفّي (حدّ legacyCode.max(40) في الخادم)", () => {
    const r = coerceValue(cf("legacyCode"), "x".repeat(41));
    expect(r.error).toContain("أطول من المسموح");
    expect(coerceValue(cf("legacyCode"), "x".repeat(40)).error).toBeNull();
  });
  it("الاسم أطول من ٢٥٥ محرفاً ⇒ خطأ صفّي (حدّ name.max(255) في الخادم)", () => {
    expect(coerceValue(cf("name"), "ا".repeat(256)).error).toContain("أطول من المسموح");
    expect(coerceValue(cf("name"), "ا".repeat(255)).error).toBeNull();
  });
});

/* ───────────────────────── normHeader — توحيد الألف ───────────────────────── */

describe("normHeader — توحيد الألف (أ/إ/آ → ا)", () => {
  it("«حد الإئتمان» تطابق «حد الائتمان»", () => {
    expect(normHeader("حد الإئتمان")).toBe(normHeader("حد الائتمان"));
  });
  it("«آخر تعامل» تطابق «اخر تعامل»", () => {
    expect(normHeader("آخر تعامل")).toBe(normHeader("اخر تعامل"));
  });
});

/* ───────────────────────── autoMapColumns — ترويسات الملفات الحرفية ───────────────────────── */

// الترويسات كما قيست فعلياً في excel-analysis.json (مراجعة  العملاء/الموردين/الأصناف).
const LEGACY_PARTY_HEADERS = [
  "الاسم",
  "الرقم",
  "تليفون 1",
  "الرصيد",
  "العملة",
  "حد الإئتمان",
  "اخر تعامل",
  "نشط",
  "Whatsapp",
];

describe("autoMapColumns — ملف العملاء القديم (٣٢٦ صفاً)", () => {
  const map = autoMapColumns(LEGACY_PARTY_HEADERS, CUSTOMER_FIELDS);

  it("كل عمود يجد حقله باسمه الحقيقي", () => {
    expect(map["الاسم"]).toBe("name");
    expect(map["الرقم"]).toBe("legacyCode");
    expect(map["تليفون 1"]).toBe("phone");
    expect(map["الرصيد"]).toBe("openingBalance");
    expect(map["العملة"]).toBe("currency");
    expect(map["حد الإئتمان"]).toBe("creditLimit");
    expect(map["اخر تعامل"]).toBe("lastDealtAt");
    expect(map["نشط"]).toBe("isActive");
    expect(map["Whatsapp"]).toBe("whatsapp");
  });
});

describe("autoMapColumns — ملف الموردين القديم (١٨٦ صفاً)", () => {
  const map = autoMapColumns(LEGACY_PARTY_HEADERS, SUPPLIER_FIELDS);

  it("نفس أعمدة العملاء مع تجاهل «حد الإئتمان» عمداً (كل قيمه 0 ولا حقل مقابلاً)", () => {
    expect(map["الاسم"]).toBe("name");
    expect(map["الرقم"]).toBe("legacyCode");
    expect(map["تليفون 1"]).toBe("phone");
    expect(map["الرصيد"]).toBe("openingBalance");
    expect(map["العملة"]).toBe("currency");
    expect(map["حد الإئتمان"]).toBeNull();
    expect(map["اخر تعامل"]).toBe("lastDealtAt");
    expect(map["نشط"]).toBe("isActive");
    expect(map["Whatsapp"]).toBe("whatsapp");
  });
});

describe("autoMapColumns — ملف الأصناف القديم (٩٤١٥ صفاً)", () => {
  const headers = [
    "الاسم",
    "الكود",
    "الوحدة",
    "المجموعة",
    "سعر الشراء",
    "سعر الجملة",
    "سعر البيع",
    "الرصيد",
    "اجمالي التكلفة",
  ];
  const map = autoMapColumns(headers, PRODUCT_FIELDS);

  it("«الاسم» → productName (وإلا حُظر زر الاستيراد بحقل مطلوب غير مربوط)", () => {
    expect(map["الاسم"]).toBe("productName");
  });
  it("«الكود» → barcode حصراً (و«code» الإنجليزية تبقى لـsku)", () => {
    expect(map["الكود"]).toBe("barcode");
    const skuMap = autoMapColumns(["code"], PRODUCT_FIELDS);
    expect(skuMap["code"]).toBe("sku");
  });
  it("«سعر البيع» → retailPrice حصراً (حُذفت من aliases الحقل القديم price)", () => {
    expect(map["سعر البيع"]).toBe("retailPrice");
    expect(pf("price").aliases).not.toContain("سعر البيع");
  });
  it("بقية الأعمدة: وحدة/مجموعة/شراء/جملة/رصيد=مخزون", () => {
    expect(map["الوحدة"]).toBe("unitName");
    expect(map["المجموعة"]).toBe("categoryName");
    expect(map["سعر الشراء"]).toBe("costPrice");
    expect(map["سعر الجملة"]).toBe("wholesalePrice");
    expect(map["الرصيد"]).toBe("openingStock");
  });
  it("«اجمالي التكلفة» عمود محسوب — يُتجاهَل", () => {
    expect(map["اجمالي التكلفة"]).toBeNull();
  });
});

describe("«الرصيد» ترويسة واحدة بمعنيين — الـalias في كلا التعريفين", () => {
  it("عند العملاء/الموردين = رصيد افتتاحي، وعند الأصناف = مخزون افتتاحي", () => {
    expect(autoMapColumns(["الرصيد"], CUSTOMER_FIELDS)["الرصيد"]).toBe("openingBalance");
    expect(autoMapColumns(["الرصيد"], SUPPLIER_FIELDS)["الرصيد"]).toBe("openingBalance");
    expect(autoMapColumns(["الرصيد"], PRODUCT_FIELDS)["الرصيد"]).toBe("openingStock");
  });
});

/* ───────────────────────── الحقول الجديدة عبر buildRows ───────────────────────── */

describe("buildRows — صفّ عملاء واقعي من الملف القديم", () => {
  const parse: ImportParseResult = {
    headers: LEGACY_PARTY_HEADERS,
    rows: [
      {
        "الاسم": "paper max   احمد مصطفى",
        "الرقم": "11442",
        "تليفون 1": "07901199308",
        "الرصيد": "2,988,100.",
        "العملة": "IQD",
        "حد الإئتمان": "0",
        "اخر تعامل": "2026-01-07",
        "نشط": "TRUE",
        "Whatsapp": "",
      },
    ],
    rowNumbers: [2],
    totalRows: 1,
  };
  const mapping = autoMapColumns(parse.headers, CUSTOMER_FIELDS);
  const built = buildRows(parse, mapping, CUSTOMER_FIELDS);

  it("يقسر كل الحقول الجديدة بلا أخطاء", () => {
    expect(built[0].errors).toHaveLength(0);
    expect(built[0].values.name).toBe("paper max   احمد مصطفى");
    expect(built[0].values.legacyCode).toBe("11442");
    expect(built[0].values.phone).toBe("+9647901199308");
    expect(built[0].values.openingBalance).toBe("2988100");
    expect(built[0].values.currency).toBe("IQD");
    expect(built[0].values.creditLimit).toBe("0");
    expect(built[0].values.lastDealtAt).toBe("2026-01-07");
    expect(built[0].values.isActive).toBe(true);
  });

  it("enum العملة يقبل المرادف العربي: دولار → USD", () => {
    expect(coerceValue(cf("currency"), "دولار").value).toBe("USD");
    expect(coerceValue(cf("currency"), "دينار").value).toBe("IQD");
  });
});

describe("buildRows — منتجات: تطبيع الوحدة وفحص sku/باركود", () => {
  it('"each" بأي حالة أحرف تُطبَّع «قطعة»', () => {
    expect(coerceValue(pf("unitName"), "each").value).toBe("قطعة");
    expect(coerceValue(pf("unitName"), "EACH").value).toBe("قطعة");
    expect(coerceValue(pf("unitName"), "كارتون").value).toBe("كارتون");
  });

  it("غياب SKU والباركود معاً = خطأ صف؛ الباركود وحده يكفي", () => {
    const parse: ImportParseResult = {
      headers: ["الاسم", "الكود"],
      rows: [
        { "الاسم": "كتر CUTTER KNIFE", "الكود": "6935403104236" },
        { "الاسم": "صنف بلا كود", "الكود": "" },
      ],
      rowNumbers: [2, 3],
      totalRows: 2,
    };
    const mapping = autoMapColumns(parse.headers, PRODUCT_FIELDS);
    const built = buildRows(parse, mapping, PRODUCT_FIELDS);
    expect(built[0].errors).toHaveLength(0);
    expect(built[0].values.barcode).toBe("6935403104236");
    expect(built[1].errors.some((e) => e.message.includes("SKU أو الباركود"))).toBe(true);
  });

  it("المخزون السالب = خطأ على الصف (لا يُستورَد ويُتجاوَز — قرار المالك ١١/٦)", () => {
    const parse: ImportParseResult = {
      headers: ["الاسم", "الكود", "الرصيد"],
      rows: [{ "الاسم": "صنف", "الكود": "123", "الرصيد": "-25" }],
      rowNumbers: [2],
      totalRows: 1,
    };
    const built = buildRows(parse, autoMapColumns(parse.headers, PRODUCT_FIELDS), PRODUCT_FIELDS);
    expect(built[0].errors.some((e) => e.field === "openingStock" && e.message.includes("لم يُستورَد"))).toBe(true);
    expect(built[0].values.openingStock).toBeUndefined();
  });
});

/* ───────────────────────── فحوص الملف الكامل ───────────────────────── */

describe("duplicateKeyOf + findFileDuplicates — مفتاح التكرار الداخلي", () => {
  const keys = { legacy: "legacyCode", phone: "phone", name: "name" };

  it("legacyCode أولاً، وإلا (الهاتف+الاسم)، وإلا الاسم", () => {
    expect(duplicateKeyOf({ legacyCode: "118", phone: "+964770", name: "أحمد" }, keys)).toBe("L:118");
    expect(duplicateKeyOf({ phone: "+964770", name: "أحمد" }, keys)).toBe("PN:+964770|أحمد");
    expect(duplicateKeyOf({ name: "أحمد" }, keys)).toBe("N:أحمد");
  });

  it("الهاتف المشترك بأسماء مختلفة ليس تكراراً (عائلة/محل واحد — مقيس في الملفات الفعلية)", () => {
    const rows = [
      row<CustomerImportRow>(2, { name: "أحمد", phone: "+9647701112233" }),
      row<CustomerImportRow>(3, { name: "محمد", phone: "+9647701112233" }),
    ];
    expect(findFileDuplicates(rows, keys).size).toBe(0);
  });

  it("نفس legacyCode = تكرار برسالة تذكر الرقم المزدوج والصف الأول", () => {
    const rows = [
      row<SupplierImportRow>(2, { name: "مورد أ", legacyCode: "73" }),
      row<SupplierImportRow>(5, { name: "مورد ب", legacyCode: "73" }),
    ];
    const issues = findFileDuplicates(rows, keys);
    expect(issues.size).toBe(1);
    expect(issues.get(5)).toContain("«73»");
    expect(issues.get(5)).toContain("الصف الأول رقم 2");
  });

  it("المفتاح موحَّد الحالة (مرآة dupKeyOf الخادم وقيد UNIQUE غير الحسّاس للحالة)", () => {
    expect(duplicateKeyOf({ legacyCode: "A1", name: "x" }, keys)).toBe(
      duplicateKeyOf({ legacyCode: "a1", name: "y" }, keys),
    );
    expect(duplicateKeyOf({ name: "Paper Max أحمد", phone: "+964770" }, keys)).toBe(
      duplicateKeyOf({ name: "paper max أحمد", phone: "+964770" }, keys),
    );
    // اسمان لاتينيان متمايزا الحالة بنفس الهاتف: كانا يجتازان فحص العميل ثم يفشلان في الخادم.
    const rows = [
      row<CustomerImportRow>(2, { name: "Paper Max أحمد", phone: "+9647700000009" }),
      row<CustomerImportRow>(3, { name: "paper max أحمد", phone: "+9647700000009" }),
    ];
    expect(findFileDuplicates(rows, keys).size).toBe(1);
  });
});

describe("findSkuConflicts — تعارض ملكية sku للملف كاملاً", () => {
  const keys = { sku: "sku", fallback: "barcode", owner: "productName" };

  it("sku واحد تحت منتجَين مختلفَين ⇒ خطأ على كل صفوفه", () => {
    const rows = [
      row<ProductImportRow>(2, { productName: "قلم أزرق", sku: "PEN-1" }),
      row<ProductImportRow>(3, { productName: "قلم أحمر", sku: "PEN-1" }),
    ];
    const issues = findSkuConflicts(rows, keys);
    expect(issues.size).toBe(2);
    expect(issues.get(2)).toContain("PEN-1");
  });

  it("نفس sku لنفس المنتج (متغيّرات) لا تعارض، والباركود fallback عند غياب sku", () => {
    const rows = [
      row<ProductImportRow>(2, { productName: "قلم", sku: "PEN-1" }),
      row<ProductImportRow>(3, { productName: "قلم", sku: "PEN-1" }),
      row<ProductImportRow>(4, { productName: "دفتر", barcode: "B-9" }),
      row<ProductImportRow>(5, { productName: "مسطرة", barcode: "B-9" }),
    ];
    const issues = findSkuConflicts(rows, keys);
    expect(issues.has(2)).toBe(false);
    expect(issues.has(3)).toBe(false);
    expect(issues.has(4)).toBe(true);
    expect(issues.has(5)).toBe(true);
  });
});

describe("findBarcodeConflicts — تكرار الباركود للملف كاملاً (مرآة كشف الخادم عبر الدفعات)", () => {
  const keys = { sku: "sku", fallback: "barcode", owner: "productName", barcode: "barcode", unit: "unitName" };

  it("باركود واحد تحت متغيّرَين (sku) مختلفَين ⇒ خطأ على كل صفوفه — كان يفلت من فحص sku ويُفشل دفعة لاحقة", () => {
    const rows = [
      row<ProductImportRow>(2, { productName: "قلم", sku: "A1", barcode: "X-9" }),
      row<ProductImportRow>(3, { productName: "دفتر", sku: "B1", barcode: "X-9" }),
    ];
    const issues = findBarcodeConflicts(rows, keys);
    expect(issues.size).toBe(2);
    expect(issues.get(2)).toContain("«X-9»");
    expect(issues.get(2)).toContain("مكرّر داخل الملف");
  });

  it("باركود واحد لوحدتَين مختلفتَين داخل نفس الـsku ⇒ تعارض (هوية الوحدة في الخادم sku+اسم الوحدة)", () => {
    const rows = [
      row<ProductImportRow>(2, { productName: "قلم", sku: "A1", barcode: "X-9", unitName: "قطعة" }),
      row<ProductImportRow>(3, { productName: "قلم", sku: "A1", barcode: "X-9", unitName: "درزن" }),
    ];
    expect(findBarcodeConflicts(rows, keys).size).toBe(2);
  });

  it("الصف المكرَّر حرفياً (نفس sku ونفس الوحدة) ليس تعارضاً — الخادم يدمجه بصمت", () => {
    const rows = [
      row<ProductImportRow>(2, { productName: "قلم", sku: "A1", barcode: "X-9", unitName: "قطعة" }),
      row<ProductImportRow>(3, { productName: "قلم", sku: "A1", barcode: "X-9", unitName: "قطعة" }),
    ];
    expect(findBarcodeConflicts(rows, keys).size).toBe(0);
  });

  it("غياب sku (الـfallback = الباركود — نمط ملف المالك): لا تعارض زائفاً لباركودات فريدة", () => {
    const rows = [
      row<ProductImportRow>(2, { productName: "قلم", barcode: "B-1" }),
      row<ProductImportRow>(3, { productName: "دفتر", barcode: "B-2" }),
    ];
    expect(findBarcodeConflicts(rows, keys).size).toBe(0);
  });
});

/* ───────────────────────── تقسيم الدفعات ودمج الملخّصات ───────────────────────── */

describe("splitIntoBatches — دون فصم مجموعة عبر دفعتين", () => {
  type R = { productName: string; n: number };
  const keyOf = (r: R) => r.productName;

  it("مجموعة المنتج الواحد تبقى في دفعة واحدة ولو تجاوز العدّ حدّ الدفعة", () => {
    const rows: R[] = [
      { productName: "أ", n: 1 },
      { productName: "ب", n: 2 },
      { productName: "أ", n: 3 }, // متغيّر ثانٍ لنفس المنتج — متباعد في الملف
      { productName: "ج", n: 4 },
      { productName: "ب", n: 5 },
    ];
    const batches = splitIntoBatches(rows, 3, keyOf);
    // كل مجموعة كاملة في دفعة واحدة:
    for (const name of ["أ", "ب", "ج"]) {
      const containing = batches.filter((b) => b.some((r) => r.productName === name));
      expect(containing).toHaveLength(1);
    }
    expect(batches.flat()).toHaveLength(rows.length);
    for (const b of batches) expect(b.length).toBeLessThanOrEqual(3);
  });

  it("بلا مفتاح تجميع: قصّ بسيط بحجم الدفعة", () => {
    const rows = Array.from({ length: 2500 }, (_, i) => ({ productName: String(i), n: i }));
    const batches = splitIntoBatches(rows, 1000);
    expect(batches.map((b) => b.length)).toEqual([1000, 1000, 500]);
  });
});

describe("mergeSummaries", () => {
  it("يجمع العدّادات وcommitted = كل الدفعات التزمت", () => {
    const a: ImportSummary = { total: 2, created: 2, updated: 0, skipped: 0, failed: 0, committed: true, rows: [] };
    const b: ImportSummary = { total: 3, created: 1, updated: 1, skipped: 1, failed: 0, committed: true, rows: [] };
    expect(mergeSummaries([a, b])).toMatchObject({ total: 5, created: 3, updated: 1, skipped: 1, committed: true });
    expect(mergeSummaries([a, { ...b, committed: false }]).committed).toBe(false);
  });

  it("دفعة كلها «متجاوَز» (لا كتابة ولا فشل — إعادة استيراد) لا تُحسَب فشلاً", () => {
    // الخادم يعيد committed=false لكل دفعة لم تكتب شيئاً، حتى المتجاوَزة كلياً —
    // عدّها فاشلة كان يجعل إعادة التشغيل الآمنة تعرض رسائل فشل حمراء كاذبة.
    const wrote: ImportSummary = { total: 2, created: 2, updated: 0, skipped: 0, failed: 0, committed: true, rows: [] };
    const allSkipped: ImportSummary = { total: 3, created: 0, updated: 0, skipped: 3, failed: 0, committed: false, rows: [] };
    const failedPart: ImportSummary = { total: 1, created: 0, updated: 0, skipped: 0, failed: 1, committed: false, rows: [] };
    expect(mergeSummaries([wrote, allSkipped]).committed).toBe(true);
    expect(mergeSummaries([allSkipped]).committed).toBe(true);
    expect(mergeSummaries([wrote, failedPart]).committed).toBe(false);
  });
});

/* ───────────────────────── سلامة التعريفات (حارس انجراف) ───────────────────────── */

describe("سلامة aliases — لا تصادم داخل مجموعة الحقول الواحدة", () => {
  function assertNoCollisions<TRow>(fields: ImportField<TRow>[], label: string) {
    const seen = new Map<string, string>();
    for (const f of fields) {
      for (const name of [f.label, f.key, ...(f.aliases ?? [])]) {
        const norm = normHeader(name);
        const owner = seen.get(norm);
        // نفس الحقل يكرّر اسمه بصيغ ألف مختلفة — مقبول؛ حقلان مختلفان = تصادم.
        expect(owner == null || owner === f.key, `${label}: «${name}» متنازَع بين ${owner} و${f.key}`).toBe(true);
        seen.set(norm, f.key);
      }
    }
  }

  it("عملاء/موردون/منتجات بلا تصادم", () => {
    assertNoCollisions(CUSTOMER_FIELDS, "عملاء");
    assertNoCollisions(SUPPLIER_FIELDS, "موردون");
    assertNoCollisions(PRODUCT_FIELDS, "منتجات");
  });
});

/* ───────────────────────── parseSheet — تواريخ CSV تبقى ISO ───────────────────────── */

describe("parseSheet — تاريخ CSV يبقى ISO (dateNF)", () => {
  // بلا dateNF يعيد SheetJS خلية تاريخ CSV بصيغة أميركية «1/7/26» فيرفضها قسر date —
  // كشفته الجولة البصرية (ملفات xlsx تمرّ لأن نصّها المنسّق محفوظ مسبقاً).
  it("«2026-01-07» في CSV لا يتحوّل إلى «1/7/26»", async () => {
    // BOM كما يصدّره Excel «CSV UTF-8» — بدونه يفكّ SheetJS الترميز cp1252 فتتشوّه الترويسات العربية.
    const csv = "﻿اخر تعامل,الاسم\n2026-01-07,عميل تجربة\n";
    const file = new File([csv], "عملاء.csv", { type: "text/csv" });
    const parsed = await parseSheet(file);
    expect(parsed.rows[0]?.["اخر تعامل"]).toBe("2026-01-07");
    const dateField = cf("lastDealtAt");
    expect(coerceValue(dateField, parsed.rows[0]?.["اخر تعامل"]).error).toBeNull();
  });
});
