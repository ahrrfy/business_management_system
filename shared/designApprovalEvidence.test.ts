/**
 * قاموسُ دليل اعتماد التصميم — مصدرٌ واحدٌ يقرأه `TaskDetail` وبطاقةُ أمر الشغل معاً،
 * ومرجعٌ افتراضيٌّ يجعل الموافقةَ **بلا مرفق** سجلّاً يُعيد بناءَ الواقعة لا حشواً.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DESIGN_APPROVAL_EVIDENCE_LABELS,
  DESIGN_APPROVAL_EVIDENCE_TYPES,
  DESIGN_APPROVAL_REASONS,
  DESIGN_REJECTION_REASONS,
  DESIGN_APPROVAL_REFERENCE_MIN,
  defaultDesignApprovalEvidenceReference,
  designApprovalEvidenceLabel,
} from "./designApprovalEvidence";

describe("قاموس دليل اعتماد التصميم", () => {
  it("يطابق enum قاعدة البيانات قيمةً بقيمة", () => {
    const schema = readFileSync(new URL("../drizzle/schema.ts", import.meta.url), "utf8");
    // ⚠️ عشرةُ جداولٍ تحمل عموداً اسمُه `evidenceType` (أوّلُها IMAGE/PDF) — المطابقةُ بالاسم
    // وحده كانت تقرأ enum جدولٍ آخر وتُنذر كذباً. نُثبّت النطاق على كتلة الجدول المقصود.
    const table = schema.slice(schema.indexOf("export const workOrderDesignApprovals = mysqlTable("));
    expect(table).not.toBe("");
    const declared = table.match(/mysqlEnum\("evidenceType", \[([^\]]+)\]\)/);
    expect(declared).not.toBeNull();
    const dbValues = Array.from(declared![1].matchAll(/"([A-Z_]+)"/g)).map((m) => m[1]);
    expect(dbValues).toEqual([...DESIGN_APPROVAL_EVIDENCE_TYPES]);
  });

  it("لكل قيمة تسميةٌ عربية — ولا تسقط الدالّة على المفتاح الخام بلا سبب", () => {
    for (const key of DESIGN_APPROVAL_EVIDENCE_TYPES) {
      expect(DESIGN_APPROVAL_EVIDENCE_LABELS[key]).toBeTruthy();
      expect(designApprovalEvidenceLabel(key)).toBe(DESIGN_APPROVAL_EVIDENCE_LABELS[key]);
    }
    expect(designApprovalEvidenceLabel(null)).toBe("—");
  });

  it("⭐ المرجعُ الافتراضيّ يحمل الأمرَ والنسخة فيتجاوز حدَّ الخادم بلا رفعِ ملفّ", () => {
    const ref = defaultDesignApprovalEvidenceReference({ orderNumber: "WO-1024", revision: 2 });
    expect(ref).toContain("WO-1024");
    expect(ref).toContain("2");
    expect(ref.trim().length).toBeGreaterThanOrEqual(DESIGN_APPROVAL_REFERENCE_MIN);
  });

  it("يضمّ العميلَ والتوقيتَ حين يتوفّران، ويتجاهل الفراغ بلا فاصلٍ يتيم", () => {
    const full = defaultDesignApprovalEvidenceReference({
      orderNumber: "WO-7",
      revision: 1,
      customerName: "أحمد",
      stampedAt: "2026-09-01",
    });
    expect(full).toContain("أحمد");
    expect(full).toContain("2026-09-01");

    const blank = defaultDesignApprovalEvidenceReference({
      orderNumber: "WO-7",
      revision: 1,
      customerName: "   ",
      stampedAt: "",
    });
    expect(blank.endsWith("—")).toBe(false);
    expect(blank).not.toContain("——");
  });

  it("كل سببٍ جاهزٍ يتجاوز حدَّ الخادم (٣ محارف) فلا يُقدَّم خيارٌ يُرفض", () => {
    for (const reason of [...DESIGN_APPROVAL_REASONS, ...DESIGN_REJECTION_REASONS]) {
      expect(reason.trim().length).toBeGreaterThanOrEqual(3);
    }
  });
});
