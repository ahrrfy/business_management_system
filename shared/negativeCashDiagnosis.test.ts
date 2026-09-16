import { describe, expect, it } from "vitest";
import {
  NEGATIVE_CASH_CLASSIFICATIONS,
  NEGATIVE_CASH_CLASSIFICATION_LABEL_AR,
  NEGATIVE_CASH_CONFIDENCE_LABEL_AR,
  NEGATIVE_CASH_CONFIDENCE_LEVELS,
  NEGATIVE_CASH_EVIDENCE_KINDS,
  NEGATIVE_CASH_EVIDENCE_LABEL_AR,
} from "./negativeCashDiagnosis";
import { REMEDIATION_CLASSIFICATIONS } from "../server/services/cashRemediation/types";

describe("negativeCashDiagnosis — مفردات تشخيص الرصيد النقديّ السالب", () => {
  it("يسمّي كلَّ تصنيفٍ قابلٍ للمحاكاة في الخادم", () => {
    // التعدادُ الوحيدُ ذو وجودٍ تشغيليّ في الخادم؛ بقيّةُ التصنيفات أنواعٌ يحرسها إسنادُ
    // الشاشة المُنمَّط (`Record<SuggestedClassification, string>`) عند `pnpm check`.
    for (const key of REMEDIATION_CLASSIFICATIONS) {
      expect(NEGATIVE_CASH_CLASSIFICATION_LABEL_AR[key]).toBeTruthy();
    }
  });

  it("لكلّ مفتاحٍ في المحاور الثلاثة تسميةٌ غير فارغة", () => {
    for (const [keys, labels] of [
      [NEGATIVE_CASH_CLASSIFICATIONS, NEGATIVE_CASH_CLASSIFICATION_LABEL_AR],
      [NEGATIVE_CASH_CONFIDENCE_LEVELS, NEGATIVE_CASH_CONFIDENCE_LABEL_AR],
      [NEGATIVE_CASH_EVIDENCE_KINDS, NEGATIVE_CASH_EVIDENCE_LABEL_AR],
    ] as const) {
      expect(Object.keys(labels).sort()).toEqual([...keys].sort());
      for (const key of keys) {
        expect((labels as Record<string, string>)[key]?.trim().length ?? 0).toBeGreaterThan(0);
      }
    }
  });

  it("لا لفظَ يتكرّر داخل محورٍ واحد", () => {
    for (const labels of [
      NEGATIVE_CASH_CLASSIFICATION_LABEL_AR,
      NEGATIVE_CASH_CONFIDENCE_LABEL_AR,
      NEGATIVE_CASH_EVIDENCE_LABEL_AR,
    ]) {
      const values = Object.values(labels);
      expect(new Set(values).size).toBe(values.length);
    }
  });

  it("«الثقة» سلّمٌ ثلاثيّ، وليست سلّمَ «الخطورة» في لوحة سلامة المشتريات", () => {
    // `PurchaseIntegrityPanel` يستعمل CRITICAL/HIGH/MEDIUM/INFO لقياس **أثر ملاحظةٍ مؤكَّدة**،
    // وهذا يقيس **قوّة الدليل خلف اقتراح**. تصادفَ مفتاحان نصّاً فبَدَيا قاموساً واحداً.
    // دمجُهما يجعل «متوسط» تعني شيئين في شاشتَي مال — وهو العطبُ الذي يُغلقه هذا الفصل.
    expect([...NEGATIVE_CASH_CONFIDENCE_LEVELS]).toEqual(["HIGH", "MEDIUM", "LOW"]);
    expect(Object.keys(NEGATIVE_CASH_CONFIDENCE_LABEL_AR)).not.toContain("CRITICAL");
    expect(Object.keys(NEGATIVE_CASH_CONFIDENCE_LABEL_AR)).not.toContain("INFO");
  });

  it("يُثبّت الألفاظ كما كانت في الشاشة — التوحيد نقلٌ لا إعادةُ صياغة", () => {
    expect(NEGATIVE_CASH_CLASSIFICATION_LABEL_AR.TREASURY_PAID).toBe("دفع فعلي من الخزينة");
    expect(NEGATIVE_CASH_CLASSIFICATION_LABEL_AR.UNRESOLVED).toBe("غير محسوم");
    expect(NEGATIVE_CASH_CONFIDENCE_LABEL_AR.MEDIUM).toBe("متوسط");
    expect(NEGATIVE_CASH_EVIDENCE_LABEL_AR.MANAGER_DECISION).toBe("اعتماد المدير");
  });
});
