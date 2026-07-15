// اختبارات المفكّك التشخيصي للأخطاء (ترقية ١٥/٧/٢٦) — «أين الخطأ + ما هو + لماذا + الإجراء»:
//   • تفكيك ER_DUP_ENTRY عبر سجلّ UNIQUE_AR (الحقل/الشاشة/القيمة/السبب).
//   • تسمية الحقل في ER_BAD_NULL_ERROR وأخطاء المفاتيح الأجنبية.
//   • ترجمة ملاحظات zod بأسماء الحقول وأرقام السطور.
//   • حارس مزامنة: كل قيد UNIQUE حيّ في هجرات drizzle له مدخل في UNIQUE_AR (والعكس).
// كلها اختبارات نقية (بلا قاعدة بيانات).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { toArabicMessage, UNIQUE_AR } from "./errorMap.ar";

/** يحاكي DrizzleQueryError: رسالة خام «Failed query: …» تلفّ خطأ mysql2 في cause. */
function dbErr(code: string, sqlMessage: string) {
  const inner = Object.assign(new Error(sqlMessage), { code, sqlMessage });
  return Object.assign(new Error("Failed query: insert into `x` (`a`) values (?)"), { cause: inner });
}

function msgOf(cause: Error, trpcCode = "INTERNAL_SERVER_ERROR") {
  return toArabicMessage({ trpcCode, originalMessage: cause.message, cause });
}

describe("تفكيك ER_DUP_ENTRY (قيمة مكرّرة تشخيصية)", () => {
  it("قيد معروف بحقل: يسمّي الحقل والشاشة والقيمة والسبب والإجراء", () => {
    const m = msgOf(dbErr("ER_DUP_ENTRY", "Duplicate entry '6212005134732' for key 'productUnits.productUnits_barcode_unique'"));
    expect(m).toContain("«الباركود»");
    expect(m).toContain("وحدات المنتج");
    expect(m).toContain("«6212005134732»");
    expect(m).toContain("موجود مسبقاً"); // السبب
    expect(m).toContain("الإجراء:");
  });

  it("الباركود البديل يُميَّز عن الأساسي", () => {
    const m = msgOf(dbErr("ER_DUP_ENTRY", "Duplicate entry '123' for key 'productUnitBarcodes.uq_unit_barcode_alias'"));
    expect(m).toContain("الباركود البديل");
  });

  it("قيد رسالة أعمال كاملة (uq_wo_invoice): رسالة جاهزة بلا «حقل»", () => {
    const m = msgOf(dbErr("ER_DUP_ENTRY", "Duplicate entry '55' for key 'workOrders.uq_wo_invoice'"));
    expect(m).toContain("فاتورة صادرة مسبقاً");
  });

  it("قيد غير معروف: يعرض القيمة واسم القيد مع إجراء عام", () => {
    const m = msgOf(dbErr("ER_DUP_ENTRY", "Duplicate entry 'abc' for key 'someTable.uq_future_constraint'"));
    expect(m).toContain("«abc»");
    expect(m).toContain("uq_future_constraint");
    expect(m).toContain("موجود مسبقاً");
  });

  it("PRIMARY: تعارض معرّف داخلي بصياغة تحوي «موجود مسبقاً» (توافق اختبارات الاستيراد)", () => {
    const m = msgOf(dbErr("ER_DUP_ENTRY", "Duplicate entry 'x' for key 'customers.PRIMARY'"));
    expect(m).toContain("المعرّف الداخلي");
    expect(m).toContain("موجود مسبقاً");
  });

  it("قيمة طويلة تُقصّ (باركود/نص طويل لا يُغرق الرسالة)", () => {
    const long = "9".repeat(80);
    const m = msgOf(dbErr("ER_DUP_ENTRY", `Duplicate entry '${long}' for key 'productUnits.productUnits_barcode_unique'`));
    expect(m).toContain("…");
    expect(m).not.toContain(long);
  });

  it("صيغة MySQL بلا بادئ جدول في اسم المفتاح تُفكّ أيضاً", () => {
    const m = msgOf(dbErr("ER_DUP_ENTRY", "Duplicate entry 'a@b.c' for key 'users_email_unique'"));
    expect(m).toContain("البريد الإلكتروني");
  });
});

describe("تسمية الحقل/الجدول في أخطاء NULL والمفاتيح الأجنبية", () => {
  it("ER_BAD_NULL_ERROR يسمّي الحقل الفارغ بالعربية", () => {
    const m = msgOf(dbErr("ER_BAD_NULL_ERROR", "Column 'quantity' cannot be null"));
    expect(m).toContain("«الكمية»");
    expect(m).toContain("فارغاً");
  });

  it("ER_NO_REFERENCED_ROW_2 يسمّي الحقل والجدول المرجعي", () => {
    const m = msgOf(dbErr(
      "ER_NO_REFERENCED_ROW_2",
      "Cannot add or update a child row: a foreign key constraint fails (`erp`.`invoiceItems`, CONSTRAINT `invoiceItems_ibfk_2` FOREIGN KEY (`variantId`) REFERENCES `productVariants` (`id`))",
    ));
    expect(m).toContain("«متغيّر المنتج»");
    expect(m).toContain("متغيّرات المنتج");
    expect(m).toContain("حدّث الصفحة");
  });

  it("ER_ROW_IS_REFERENCED_2 يسمّي الجدول المستعمِل للسجلّ", () => {
    const m = msgOf(dbErr(
      "ER_ROW_IS_REFERENCED_2",
      "Cannot delete or update a parent row: a foreign key constraint fails (`erp`.`invoiceItems`, CONSTRAINT `invoiceItems_ibfk_1` FOREIGN KEY (`productId`) REFERENCES `products` (`id`))",
    ));
    expect(m).toContain("لا يمكن الحذف");
    expect(m).toContain("بنود الفواتير");
  });
});

describe("ترجمة ملاحظات zod بأسماء الحقول", () => {
  function zodErr(issues: unknown[]) {
    return Object.assign(new Error('[{"code":"invalid_type"}]'), {
      cause: { name: "ZodError", issues },
    });
  }

  it("يسمّي الحقل المفقود ورقم السطر داخل المصفوفات", () => {
    const m = msgOf(
      zodErr([
        { code: "invalid_type", expected: "string", received: "undefined", path: ["name"] },
        { code: "too_small", type: "number", minimum: 1, path: ["items", 2, "quantity"] },
      ]) as Error,
      "BAD_REQUEST",
    );
    expect(m).toContain("«الاسم»");
    expect(m).toContain("حقل مطلوب");
    expect(m).toContain("«الكمية»");
    expect(m).toContain("السطر 3");
    expect(m).toContain("أصغر من الحدّ المسموح (1)");
  });

  it("رسالة عربية مخصّصة من المخطط تمرّ كما هي", () => {
    const m = msgOf(zodErr([{ code: "custom", message: "معامل التحويل يجب أن يكون أكبر من ١", path: ["conversionFactor"] }]) as Error, "BAD_REQUEST");
    expect(m).toContain("معامل التحويل يجب أن يكون أكبر من ١");
  });

  it("أكثر من ٣ ملاحظات تُلخَّص", () => {
    const issues = [1, 2, 3, 4, 5].map((i) => ({ code: "invalid_type", received: "undefined", path: [`f${i}`] }));
    const m = msgOf(zodErr(issues) as Error, "BAD_REQUEST");
    expect(m).toContain("ملاحظات أخرى");
  });

  it("بريد إلكتروني غير صالح يُسمّى", () => {
    const m = msgOf(zodErr([{ code: "invalid_string", validation: "email", path: ["email"] }]) as Error, "BAD_REQUEST");
    expect(m).toContain("«البريد الإلكتروني»");
    expect(m).toContain("بريد إلكتروني غير صالح");
  });

  // إعادة إنتاج P1 من المراجعة العدائية (١٥/٧): في zod v4 رسالة ZodError نفسها =
  // JSON.stringify(issues, null, 2)، وtRPC يجعلها error.message. حين يحمل المخطط رسالة
  // عربية مخصّصة يحوي الـJSON عربيةً فكان يخدع ممرّ «الرسالة العربية» ويتسرّب خاماً.
  it("zod v4 واقعي: JSON الملاحظات يحمل رسالة عربية مخصّصة — يُفكّ ولا يتسرّب JSON خاماً", () => {
    const issues = [{ origin: "string", code: "too_small", minimum: 1, inclusive: true, path: ["firstName"], message: "الاسم الأول مطلوب" }];
    const zodError = Object.assign(new Error(JSON.stringify(issues, null, 2)), { name: "ZodError", issues });
    // TRPCError يسقط لرسالة الـcause نفسها (originalMessage === cause.message).
    const m = toArabicMessage({ trpcCode: "BAD_REQUEST", originalMessage: zodError.message, cause: zodError });
    expect(m).not.toContain('"code"');
    expect(m).not.toContain("origin");
    expect(m).toContain("«الاسم الأول»");
    expect(m).toContain("الاسم الأول مطلوب");
  });

  it("رسالة أعمال عربية متعمَّدة مغايرة تمرّ كما هي ولو حمل cause ملاحظات zod", () => {
    const zodError = Object.assign(new Error('[{"code":"custom"}]'), { name: "ZodError", issues: [{ code: "custom", path: [] }] });
    const m = toArabicMessage({ trpcCode: "BAD_REQUEST", originalMessage: "رسالة أعمال مقصودة من الخدمة", cause: zodError });
    expect(m).toBe("رسالة أعمال مقصودة من الخدمة");
  });

  // zod v4 (المستعمل فعلياً في المشروع): لا received في invalid_type، وorigin بدل type،
  // وinvalid_format بدل invalid_string، وinvalid_value بدل invalid_enum_value.
  it("أشكال zod v4: حقل مفقود + حدّ أدنى + بريد + قيمة خارج الخيارات", () => {
    const missing = msgOf(zodErr([{ code: "invalid_type", expected: "string", message: "Invalid input: expected string, received undefined", path: ["lastName"] }]) as Error, "BAD_REQUEST");
    expect(missing).toContain("«اللقب»");
    expect(missing).toContain("حقل مطلوب");

    const tooSmall = msgOf(zodErr([{ code: "too_small", origin: "string", minimum: 3, message: "Too small", path: ["name"] }]) as Error, "BAD_REQUEST");
    expect(tooSmall).toContain("أقصر من الحدّ الأدنى (3)");

    const badEmail = msgOf(zodErr([{ code: "invalid_format", format: "email", message: "Invalid email address", path: ["email"] }]) as Error, "BAD_REQUEST");
    expect(badEmail).toContain("بريد إلكتروني غير صالح");

    const badEnum = msgOf(zodErr([{ code: "invalid_value", message: 'Invalid option: expected one of "A"|"B"', path: ["status"] }]) as Error, "BAD_REQUEST");
    expect(badEnum).toContain("خارج الخيارات المسموحة");
  });
});

describe("السلوك القائم محفوظ (انحدار)", () => {
  it("رسالة أعمال عربية صريحة تمرّ كما هي", () => {
    expect(toArabicMessage({ trpcCode: "BAD_REQUEST", originalMessage: "اسم المنتج مطلوب" })).toBe("اسم المنتج مطلوب");
  });

  it("«Failed query» بمعاملات عربية لا يتسرّب — يُحال للتفكيك", () => {
    const err = dbErr("ER_DUP_ENTRY", "Duplicate entry '500' for key 'productUnits.productUnits_barcode_unique'");
    const m = toArabicMessage({ trpcCode: "INTERNAL_SERVER_ERROR", originalMessage: err.message, cause: err });
    expect(m).not.toContain("Failed query");
    expect(m).toContain("موجود مسبقاً");
  });

  it("ER_DATA_TOO_LONG ما زال يسمّي الحقل", () => {
    const m = msgOf(dbErr("ER_DATA_TOO_LONG", "Data too long for column 'phone' at row 1"));
    expect(m).toContain("«الهاتف»");
  });

  it("كود بلا تفكيك يسقط لخريطة MySQL ثم كود tRPC ثم العام", () => {
    expect(msgOf(dbErr("ER_LOCK_DEADLOCK", "Deadlock found"))).toContain("أعد المحاولة");
    expect(toArabicMessage({ trpcCode: "FORBIDDEN", originalMessage: "forbidden" })).toContain("صلاحية");
    expect(toArabicMessage({ originalMessage: "boom" })).toContain("غير متوقّع");
  });
});

describe("حارس المزامنة: سجلّ UNIQUE_AR يطابق قيود الهجرات الحيّة", () => {
  // قيود خارج هجرات الشركة (قاعدة التحكّم erp_control تُنشأ من scripts/control-bootstrap).
  const CONTROL_ONLY = new Set(["uq_provision_active_code"]);

  function liveUniqueKeys(): Set<string> {
    const dir = path.resolve(process.cwd(), "drizzle", "migrations");
    const files = (readdirSync(dir, { recursive: true }) as string[])
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const live = new Set<string>();
    // backticks اختيارية: هجرات يدوية تكتب «UNIQUE KEY uq_vchcat_name (name)» بلا backticks
    // (0036/0041 فعلاً)، وDROP CONSTRAINT صيغة حذف صالحة على MySQL 8.0.19+ (مراجعة عدائية ١٥/٧).
    const token =
      /CONSTRAINT `?([A-Za-z0-9_]+)`? UNIQUE|UNIQUE (?:KEY|INDEX) `?([A-Za-z0-9_]+)`?|DROP (?:INDEX|KEY|CONSTRAINT) `?([A-Za-z0-9_]+)`?/g;
    for (const f of files) {
      const sql = readFileSync(path.join(dir, f), "utf8");
      for (const m of sql.matchAll(token)) {
        const added = m[1] ?? m[2];
        if (added) live.add(added);
        else if (m[3]) live.delete(m[3]);
      }
    }
    live.delete("PRIMARY");
    return live;
  }

  it("كل قيد UNIQUE حيّ له مدخل تشخيصي — وكل مدخل يقابل قيداً حيّاً", () => {
    const live = liveUniqueKeys();
    expect(live.size).toBeGreaterThan(40); // عاقل: المخطط يحوي عشرات القيود الفريدة

    const missing = [...live].filter((k) => !(k in UNIQUE_AR));
    expect(missing, `قيود UNIQUE بلا مدخل في UNIQUE_AR (أضِفها في shared/errorMap.ar.ts): ${missing.join(", ")}`).toEqual([]);

    const stale = Object.keys(UNIQUE_AR).filter((k) => !live.has(k) && !CONTROL_ONLY.has(k));
    expect(stale, `مدخلات UNIQUE_AR لقيود غير موجودة/محذوفة: ${stale.join(", ")}`).toEqual([]);
  });
});
