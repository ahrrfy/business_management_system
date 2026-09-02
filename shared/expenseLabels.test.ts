/**
 * حارس قواميس المصروفات — على نمط `invoiceStatus` و`workOrderStatus`.
 *
 * الثابتُ المحروس ليس التسميةَ بل **المطابقةَ مع مصدرها الحيّ**: التعدادات تُقرأ من
 * `drizzle/schema.ts` نفسه، ورموزُ التدقيق ومصادرُ التمويل من `server/services/expenseService.ts`
 * نفسه. حارسٌ يقرأ من مصدرٍ غير الذي ينفّذ عليه ليس حارساً — فلا قائمةَ مكتوبةً بيدٍ هنا:
 * إضافةُ حالةٍ أو رمزِ تحذيرٍ في الشيفرة **تُحمِّر هذا الملف** حتى يُسمَّى عربياً.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EXPENSE_APPROVAL_AR,
  EXPENSE_APPROVAL_STATUSES,
  EXPENSE_AUDIT_WARNINGS,
  EXPENSE_AUDIT_WARNING_AR,
  EXPENSE_FUNDING_META,
  EXPENSE_FUNDING_VIEWS,
  EXPENSE_STATUSES,
  EXPENSE_STATUS_AR,
  EXPENSE_STATUS_BADGE_CLASS,
  EXPENSE_STOCK_REASONS,
  EXPENSE_STOCK_REASON_AR,
  SERVER_EXPENSE_FUNDING_KINDS,
  expenseAuditWarningLabel,
  expenseStatusBadgeClass,
  expenseStatusLabel,
  expenseStockReasonLabel,
  fundingViewOfServerKind,
  isExpenseApprovalStatus,
  isExpenseAuditWarning,
  isExpenseStatus,
  isExpenseStockReason,
} from "./expenseLabels";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** قيمُ enum الحيّة من المخطّط — لا نسخةَ يدويّة تشيخ بصمت. */
function enumFromSchema(name: string): string[] {
  const src = read("drizzle/schema.ts");
  const m = new RegExp(`mysqlEnum\\("${name}",\\s*\\[([^\\]]*)\\]`).exec(src);
  if (!m)
    throw new Error(`تعذّر إيجاد mysqlEnum("${name}") في drizzle/schema.ts`);
  return [...m[1].matchAll(/"([A-Z_]+)"/g)].map((x) => x[1]);
}

/** رموزُ التحذير التي يدفعها الخادم فعلاً — مصدرُ الحقيقة الوحيد لما سيصل الشاشة. */
function warningCodesFromService(): string[] {
  const src = read("server/services/expenseService.ts");
  const found = new Set<string>();
  for (const m of src.matchAll(/warnings\.push\("([A-Z_]+)"\)/g))
    found.add(m[1]);
  return [...found];
}

/** قيمُ `ExpenseFundingKind` الخادميّة من إعلان النوع نفسه. */
function fundingKindsFromService(): string[] {
  const src = read("server/services/expenseService.ts");
  const m = /export type ExpenseFundingKind =([\s\S]*?);/.exec(src);
  if (!m)
    throw new Error("تعذّر إيجاد ExpenseFundingKind في expenseService.ts");
  return [...m[1].matchAll(/"([A-Z_]+)"/g)].map((x) => x[1]);
}

/** U+064B..U+0652 + U+0653..U+065F + U+0670 — بالهروب السداسيّ لا بالحروف:
 *  نطاقٌ عربيّ داخل [...] يُقلَب بصرياً في المحرّر (bidi) فيُقرأ ويُعدَّل خطأً.
 *  نفسُ نطاق `scripts/check-tashkeel-in-small-text.mjs`. */
const TASHKEEL_RE = /[\u064B-\u0652\u0653-\u065F\u0670]/;

/** حرفٌ عربيّ واحدٌ على الأقلّ — يمسك التسميةَ التي بقيت رمزاً إنجليزياً. */
const ARABIC_RE = /[\u0621-\u064A]/;

describe("حالة المصروف — مطابقة المخطّط", () => {
  it("مفاتيحُ القاموس = enum expenseStatus حرفياً (لا قيمةَ بلا تسمية ولا تسميةٌ يتيمة)", () => {
    expect([...EXPENSE_STATUSES]).toEqual(enumFromSchema("expenseStatus"));
    expect(Object.keys(EXPENSE_STATUS_AR)).toEqual([...EXPENSE_STATUSES]);
    expect(Object.keys(EXPENSE_STATUS_BADGE_CLASS)).toEqual([
      ...EXPENSE_STATUSES,
    ]);
  });

  it("كلُّ صنفِ شارةٍ توكنٌ دلاليّ لا لونٌ خامّ (حارس check:colors)", () => {
    for (const cls of Object.values(EXPENSE_STATUS_BADGE_CLASS)) {
      expect(cls, `الصنف ${cls}`).toMatch(/^badge-/);
    }
  });

  it("الفارغُ «—» والمجهولُ يعود بالرمز نفسه، وشارتُه محايدة", () => {
    expect(expenseStatusLabel("ACTIVE")).toBe("نافذ");
    expect(expenseStatusLabel(null)).toBe("—");
    expect(expenseStatusLabel("")).toBe("—");
    expect(expenseStatusLabel("ARCHIVED")).toBe("ARCHIVED");
    expect(expenseStatusBadgeClass("ARCHIVED")).toBe("bg-muted");
    expect(isExpenseStatus("ACTIVE")).toBe(true);
    expect(isExpenseStatus("ARCHIVED")).toBe(false);
  });
});

describe("سبب الصرف المخزنيّ — مطابقة المخطّط", () => {
  it("مفاتيحُ القاموس = enum expenseStockReason حرفياً", () => {
    expect([...EXPENSE_STOCK_REASONS]).toEqual(
      enumFromSchema("expenseStockReason"),
    );
    expect(Object.keys(EXPENSE_STOCK_REASON_AR)).toEqual([
      ...EXPENSE_STOCK_REASONS,
    ]);
  });

  it("الاحتياطيُّ مُمرَّرٌ لا مفترَض — نصّان مقصودا الاختلاف عند غياب السبب", () => {
    expect(expenseStockReasonLabel("WASTAGE", "مخزون")).toBe("تلف (مخزون)");
    expect(expenseStockReasonLabel(null, "مخزون")).toBe("مخزون");
    expect(expenseStockReasonLabel("", "صرف مخزون")).toBe("صرف مخزون");
    expect(isExpenseStockReason("INTERNAL_USE")).toBe(true);
  });
});

describe("حالة اعتماد سند الصرف — مطابقة المخطّط", () => {
  it("مفاتيحُ القاموس = enum receiptApprovalStatus حرفياً", () => {
    expect([...EXPENSE_APPROVAL_STATUSES].sort()).toEqual(
      enumFromSchema("receiptApprovalStatus").sort(),
    );
    expect(Object.keys(EXPENSE_APPROVAL_AR)).toEqual([
      ...EXPENSE_APPROVAL_STATUSES,
    ]);
    expect(isExpenseApprovalStatus("APPROVED")).toBe(true);
    expect(isExpenseApprovalStatus("EXPIRED")).toBe(false);
  });
});

describe("مصدر التمويل — كلُّ قيمةٍ خادميّة لها مقابلُ عرض", () => {
  it("SERVER_EXPENSE_FUNDING_KINDS = ExpenseFundingKind الحيّة", () => {
    expect([...SERVER_EXPENSE_FUNDING_KINDS].sort()).toEqual(
      fundingKindsFromService().sort(),
    );
  });

  it("لا قيمةَ خادميّة بلا مصطلحِ عرض — وUNKNOWN تُترجَم إلى UNATTRIBUTED", () => {
    for (const kind of SERVER_EXPENSE_FUNDING_KINDS) {
      const view = fundingViewOfServerKind(kind);
      expect(view, `القيمة الخادميّة ${kind} بلا مقابلِ عرض`).not.toBeNull();
      expect(EXPENSE_FUNDING_META[view!], `${kind} بلا وصف`).toBeDefined();
    }
    expect(fundingViewOfServerKind("UNKNOWN")).toBe("UNATTRIBUTED");
    expect(fundingViewOfServerKind("BITCOIN")).toBeNull();
  });

  it("PENDING إضافةُ عرضٍ مقصودة لا قيمةٌ خادميّة", () => {
    expect(EXPENSE_FUNDING_VIEWS).toContain("PENDING");
    expect(SERVER_EXPENSE_FUNDING_KINDS as readonly string[]).not.toContain(
      "PENDING",
    );
  });

  it("كلُّ مصدرٍ يحمل label + short + badge بلا فراغ", () => {
    expect(Object.keys(EXPENSE_FUNDING_META)).toEqual([
      ...EXPENSE_FUNDING_VIEWS,
    ]);
    for (const [key, meta] of Object.entries(EXPENSE_FUNDING_META)) {
      expect(meta.label.trim(), `label لـ${key}`).not.toBe("");
      expect(meta.short.trim(), `short لـ${key}`).not.toBe("");
      expect(meta.badge.trim(), `badge لـ${key}`).not.toBe("");
      // النصُّ المختصر أقصرُ من العنوان دائماً — وإلّا فقد الاختصارُ سببَ وجوده.
      expect(meta.short.length, `short لـ${key} ليس أقصر`).toBeLessThan(
        meta.label.length,
      );
    }
  });
});

describe("تحذيرات التدقيق — مطابقة ما يدفعه الخادم", () => {
  it("لا رمزَ يدفعه الخادم بلا تسميةٍ عربيّة، ولا تسميةٌ يتيمة", () => {
    const emitted = warningCodesFromService();
    expect([...EXPENSE_AUDIT_WARNINGS].sort()).toEqual(emitted.sort());
    expect(Object.keys(EXPENSE_AUDIT_WARNING_AR).sort()).toEqual(
      [...EXPENSE_AUDIT_WARNINGS].sort(),
    );
  });

  it("الرمزُ المجهول يظهر كما هو — بلاغُ نقصٍ لا ابتلاعٌ صامت لتحذيرٍ ماليّ", () => {
    expect(expenseAuditWarningLabel("PAYEE_MISSING")).toBe("المستفيد غير محدد");
    expect(expenseAuditWarningLabel("BRAND_NEW_CODE")).toBe("BRAND_NEW_CODE");
    expect(isExpenseAuditWarning("PAYEE_MISSING")).toBe(true);
    expect(isExpenseAuditWarning("BRAND_NEW_CODE")).toBe(false);
  });
});

/**
 * الفحوصُ العابرةُ لكلّ القواميس. `EXPENSE_FUNDING_META.label` **مستثنًى صراحةً**: عنوانُ
 * مجموعةٍ بحجمٍ نظاميّ (و`aria-label` حيث لا رسمَ أصلاً)، والتشكيلُ فيه مأمونٌ ومفيد.
 */
const SHORT_TEXT_DICTS: { name: string; values: Record<string, string> }[] = [
  { name: "حالة المصروف", values: EXPENSE_STATUS_AR },
  { name: "سبب الصرف المخزنيّ", values: EXPENSE_STOCK_REASON_AR },
  { name: "حالة الاعتماد", values: EXPENSE_APPROVAL_AR },
  { name: "تحذيرات التدقيق", values: EXPENSE_AUDIT_WARNING_AR },
  {
    name: "مصدر التمويل (المختصر)",
    values: Object.fromEntries(
      Object.entries(EXPENSE_FUNDING_META).map(([k, v]) => [k, v.short]),
    ),
  },
];

describe("قواعدٌ عابرةٌ لكلّ قواميس المصروفات", () => {
  it.each(SHORT_TEXT_DICTS)(
    "$name: بلا تشكيلٍ في النصّ القصير (يُرسَم 11-12px)",
    ({ values }) => {
      for (const [key, label] of Object.entries(values)) {
        expect(TASHKEEL_RE.test(label), `تشكيلٌ في ${key}: «${label}»`).toBe(
          false,
        );
      }
    },
  );

  it.each(SHORT_TEXT_DICTS)(
    "$name: لا تسميةَ فارغةً ولا رمزٌ إنجليزيّ",
    ({ values }) => {
      for (const [key, label] of Object.entries(values)) {
        expect(label.trim(), `التسمية ${key} فارغة`).not.toBe("");
        expect(ARABIC_RE.test(label), `التسمية ${key} بلا حرفٍ عربيّ`).toBe(
          true,
        );
      }
    },
  );

  it("لا تكرارَ في المفاتيح ولا في التسميات المتمايزة", () => {
    const keyLists: [string, readonly string[]][] = [
      ["EXPENSE_STATUSES", EXPENSE_STATUSES],
      ["EXPENSE_STOCK_REASONS", EXPENSE_STOCK_REASONS],
      ["EXPENSE_APPROVAL_STATUSES", EXPENSE_APPROVAL_STATUSES],
      ["EXPENSE_FUNDING_VIEWS", EXPENSE_FUNDING_VIEWS],
      ["EXPENSE_AUDIT_WARNINGS", EXPENSE_AUDIT_WARNINGS],
      ["SERVER_EXPENSE_FUNDING_KINDS", SERVER_EXPENSE_FUNDING_KINDS],
    ];
    for (const [name, keys] of keyLists) {
      expect(new Set(keys).size, `${name} فيها مفتاحٌ مكرّر`).toBe(keys.length);
    }
    // تسميتان متطابقتان لمفهومين مختلفين تجعلان الشاشةَ تكذب — يُستثنى صنفُ الشارة
    // (اللونُ يُشارَك عمداً: REJECTED وCANCELLED كلاهما مسارٌ ميت).
    const auditLabels = Object.values(EXPENSE_AUDIT_WARNING_AR);
    expect(new Set(auditLabels).size, "تحذيرانِ بنفس النصّ").toBe(
      auditLabels.length,
    );
    const fundingShorts = Object.values(EXPENSE_FUNDING_META).map(
      (m) => m.short,
    );
    expect(new Set(fundingShorts).size, "مصدرانِ بنفس النصّ المختصر").toBe(
      fundingShorts.length,
    );
  });
});
