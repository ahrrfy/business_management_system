import { describe, expect, it } from "vitest";
import {
  autoMapColumns,
  buildRows,
  coerceValue,
  normHeader,
  normalizeDigits,
  type ImportField,
  type ImportParseResult,
} from "./import";

type Row = {
  name: string;
  phone?: string;
  creditLimit?: string;
  qty?: number;
  tier?: string;
  active?: boolean;
};

const FIELDS: ImportField<Row>[] = [
  { key: "name", label: "اسم العميل", type: "string", required: true, aliases: ["الاسم", "name"] },
  { key: "phone", label: "الهاتف", type: "phone" },
  { key: "creditLimit", label: "سقف الائتمان", type: "money" },
  { key: "qty", label: "الكمية", type: "integer" },
  {
    key: "tier",
    label: "فئة السعر",
    type: "enum",
    enumValues: ["RETAIL", "WHOLESALE", "GOVERNMENT"],
    enumMap: { مفرد: "RETAIL", جملة: "WHOLESALE", حكومي: "GOVERNMENT" },
  },
  { key: "active", label: "نشط", type: "boolean" },
];

describe("normalizeDigits", () => {
  it("يحوّل الأرقام العربية إلى ASCII", () => {
    expect(normalizeDigits("٠١٢٣٤٥٦٧٨٩")).toBe("0123456789");
  });
  it("يحوّل الأرقام الفارسية", () => {
    expect(normalizeDigits("۰۱۲")).toBe("012");
  });
  it("يترك النصّ غير الرقمي كما هو", () => {
    expect(normalizeDigits("أحمد-07٧")).toBe("أحمد-077");
  });
});

describe("normHeader", () => {
  it("يحذف علامة المطلوب والتطويل ويوحّد الحالة", () => {
    expect(normHeader("اسم العميل*")).toBe("اسم العميل");
    expect(normHeader("  Name  ")).toBe("name");
  });
});

describe("coerceValue", () => {
  it("string: يقتطع المسافات", () => {
    expect(coerceValue(FIELDS[0], "  أحمد ")).toEqual({ value: "أحمد", error: null });
  });
  it("required فارغ ⇒ خطأ", () => {
    expect(coerceValue(FIELDS[0], "").error).toBe("حقل مطلوب");
  });
  it("اختياري فارغ ⇒ بلا خطأ وبلا قيمة", () => {
    expect(coerceValue(FIELDS[1], "")).toEqual({ value: undefined, error: null });
  });
  it("money: يطبّع الأرقام العربية والفواصل", () => {
    expect(coerceValue(FIELDS[2], "١٬٥٠٠٫٥٠")).toEqual({ value: "1500.50", error: null });
  });
  it("money: يرفض أكثر من منزلتين", () => {
    expect(coerceValue(FIELDS[2], "1.555").value).toBeUndefined();
    expect(coerceValue(FIELDS[2], "1.555").error).toBeTruthy();
  });
  it("money: يرفض النصّ", () => {
    expect(coerceValue(FIELDS[2], "abc").error).toBeTruthy();
  });
  it("integer: يقبل الصحيح ويرفض الكسر", () => {
    expect(coerceValue(FIELDS[3], "١٢")).toEqual({ value: 12, error: null });
    expect(coerceValue(FIELDS[3], "1.5").error).toBeTruthy();
  });
  it("enum: يطابق المرادف العربي للقيمة القانونية", () => {
    expect(coerceValue(FIELDS[4], "جملة")).toEqual({ value: "WHOLESALE", error: null });
  });
  it("enum: يقبل القيمة القانونية مباشرة", () => {
    expect(coerceValue(FIELDS[4], "RETAIL")).toEqual({ value: "RETAIL", error: null });
  });
  it("enum: يرفض غير المعروف", () => {
    expect(coerceValue(FIELDS[4], "VIP").error).toBeTruthy();
  });
  it("boolean: نعم/لا", () => {
    expect(coerceValue(FIELDS[5], "نعم")).toEqual({ value: true, error: null });
    expect(coerceValue(FIELDS[5], "لا")).toEqual({ value: false, error: null });
    expect(coerceValue(FIELDS[5], "ربما").error).toBeTruthy();
  });
});

describe("autoMapColumns", () => {
  it("يطابق عبر label و alias و key", () => {
    const map = autoMapColumns(["اسم العميل", "الهاتف", "tier", "غير معروف"], FIELDS);
    expect(map["اسم العميل"]).toBe("name");
    expect(map["الهاتف"]).toBe("phone");
    expect(map["tier"]).toBe("tier");
    expect(map["غير معروف"]).toBeNull();
  });
  it("يطابق الـ alias", () => {
    const map = autoMapColumns(["الاسم"], FIELDS);
    expect(map["الاسم"]).toBe("name");
  });
});

describe("buildRows", () => {
  const parse: ImportParseResult = {
    headers: ["اسم العميل", "الهاتف", "سقف الائتمان"],
    rows: [
      { "اسم العميل": "أحمد", الهاتف: "٠٧٧٠١٢٣٤٥٦٧", "سقف الائتمان": "٥٠٠" },
      { "اسم العميل": "", الهاتف: "0780", "سقف الائتمان": "abc" },
    ],
    totalRows: 2,
  };
  const mapping = autoMapColumns(parse.headers, FIELDS);

  it("يبني صفّاً صحيحاً بلا أخطاء + يطبّع الأرقام", () => {
    const built = buildRows(parse, mapping, FIELDS);
    expect(built[0].errors).toHaveLength(0);
    expect(built[0].values.name).toBe("أحمد");
    expect(built[0].values.phone).toBe("07701234567");
    expect(built[0].values.creditLimit).toBe("500");
    expect(built[0].rowNumber).toBe(1);
  });

  it("يجمع أخطاء الصفّ (اسم مطلوب + مال غير صالح)", () => {
    const built = buildRows(parse, mapping, FIELDS);
    expect(built[1].errors.length).toBeGreaterThanOrEqual(2);
  });
});
