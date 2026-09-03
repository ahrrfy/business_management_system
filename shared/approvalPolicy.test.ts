import { describe, expect, it } from "vitest";
import {
  APPROVAL_TRIGGERS,
  APPROVAL_TRIGGER_LABEL_AR,
  executesNow,
  ownerApprovalRequiredMessage,
  resolveApproval,
  type ApprovalTrigger,
} from "./approvalPolicy";

/**
 * هذه الاختبارات تحرس **قرار المالك** لا صياغةَ دالّة. كلُّ حالةٍ هنا كانت إمّا تعطيلاً
 * يوميّاً في المحلّ، أو ثغرةً رقابية — فتغييرُ أيٍّ منها قرارُ مالكٍ لا قرارُ مبرمج.
 */
describe("سياسة الاعتماد — شخصان لا أكثر", () => {
  it("عمليةٌ لا تُخرج مالاً ولا تمحو أثراً ⇒ تُنفَّذ فوراً بلا اعتماد", () => {
    const d = resolveApproval({ trigger: null, actorIsOwner: false });
    expect(d.outcome).toBe("NOT_REQUIRED");
    expect(executesNow(d)).toBe(true);
    // الغالبية العظمى من العمليات تقع هنا: إنشاء · إرسال · استلام · مطابقة · ترحيل.
    expect(d.soloExecution).toBe(true);
  });

  it.each(APPROVAL_TRIGGERS)("موظّفٌ ينفّذ «%s» ⇒ يلزم اعتماد المالك", (trigger) => {
    const d = resolveApproval({ trigger, actorIsOwner: false });
    expect(d.outcome).toBe("NEEDS_OWNER");
    expect(executesNow(d)).toBe(false);
    expect(d.soloExecution).toBe(false);
    expect(d.reason).toContain(APPROVAL_TRIGGER_LABEL_AR[trigger]);
  });

  it.each(APPROVAL_TRIGGERS)("المالك ينفّذ «%s» ⇒ اعتمادٌ تلقائيّ بلا شخصٍ ثانٍ", (trigger) => {
    const d = resolveApproval({ trigger, actorIsOwner: true });
    expect(d.outcome).toBe("AUTO_SELF_APPROVED");
    expect(executesNow(d)).toBe(true);
    // ⚠️ يبقى مُدرَجاً في تقرير «نُفِّذ بشخصٍ واحد» — التقريرُ يحلّ محلّ الفصل.
    expect(d.soloExecution).toBe(true);
  });

  it("لا اعتمادَ بعد المالك — لا يوجد مخرجٌ ثالثٌ يطلب مُعتمِداً إضافياً", () => {
    const outcomes = new Set(
      [true, false].flatMap((isOwner) =>
        [null, ...APPROVAL_TRIGGERS].map(
          (t) => resolveApproval({ trigger: t as ApprovalTrigger | null, actorIsOwner: isOwner }).outcome,
        ),
      ),
    );
    expect([...outcomes].sort()).toEqual(["AUTO_SELF_APPROVED", "NEEDS_OWNER", "NOT_REQUIRED"]);
  });

  it("كلُّ قرارٍ يحمل سبباً عربياً مقروءاً — لا حجبَ صامت", () => {
    for (const isOwner of [true, false]) {
      for (const trigger of [null, ...APPROVAL_TRIGGERS]) {
        const d = resolveApproval({ trigger: trigger as ApprovalTrigger | null, actorIsOwner: isOwner });
        expect(d.reason.length).toBeGreaterThan(15);
        expect(d.reason).toMatch(/[؀-ۿ]/);
      }
    }
  });
});

describe("رسالةُ الحجب — تقول ماذا حدث ولماذا وماذا تفعل", () => {
  it("تذكر المستند ولحظة الخطر والخطوة التالية", () => {
    const msg = ownerApprovalRequiredMessage({
      trigger: "MONEY_OUT",
      subject: "أمر شراء PO-1024",
    });
    expect(msg).toContain("أمر شراء PO-1024");
    expect(msg).toContain("خروج مال");
    expect(msg).toContain("اعتماد المالك");
    // «ماذا تفعل الآن» — بلا هذا الجزء تصير رسالةَ حجبٍ يقف عندها الموظّف.
    expect(msg).toContain("مطلوب مني الآن");
  });

  it("لحظتان اثنتان لا ثالثَ لهما", () => {
    expect(APPROVAL_TRIGGERS).toHaveLength(2);
    expect([...APPROVAL_TRIGGERS]).toEqual(["MONEY_OUT", "ERASE_EFFECT"]);
  });
});
