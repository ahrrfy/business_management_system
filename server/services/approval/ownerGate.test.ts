import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertApprover, planApproval, soloExecutionRecord } from "./ownerGate";

/**
 * الثابت المحروس هنا هو **أمانُ الانتقال**: إطفاءُ العلَم يجب أن يُعيد السلوك القائم
 * حرفياً — بلا فرقٍ واحد. اختبارٌ يفحص السياسة الجديدة وحدها يترك أخطر نصفٍ بلا حراسة.
 */
const FLAG = "ROLLOUT_OWNER_ONLY_APPROVAL";
const OWNER = { userId: 1, branchId: 1, isOwner: true } as const;
const STAFF = { userId: 7, branchId: 1, isOwner: false } as const;

let saved: string | undefined;
beforeEach(() => {
  saved = process.env[FLAG];
});
afterEach(() => {
  if (saved === undefined) delete process.env[FLAG];
  else process.env[FLAG] = saved;
});

describe("العلَم مطفأ — السلوك القائم يُعاد حرفياً", () => {
  beforeEach(() => {
    delete process.env[FLAG];
  });

  it("planApproval لا تُنفّذ شيئاً فوراً — أي «أنشئ الطلب كما اليوم»", () => {
    for (const actor of [OWNER, STAFF]) {
      for (const trigger of [null, "MONEY_OUT", "ERASE_EFFECT"] as const) {
        const plan = planApproval({ actor, trigger });
        expect(plan.executeNow, `${actor.userId}/${trigger}`).toBe(false);
        expect(plan.underNewPolicy).toBe(false);
      }
    }
  });

  it("assertApprover تُنفّذ الفحص القديم ولا تستبدله — حتى للمالك", () => {
    const legacy = vi.fn();
    assertApprover({ actor: OWNER, trigger: "MONEY_OUT", subject: "س", legacy });
    assertApprover({ actor: STAFF, trigger: "MONEY_OUT", subject: "س", legacy });
    expect(legacy).toHaveBeenCalledTimes(2);
  });

  it("ورميُ الفحص القديم يمرّ كما هو — لا تبتلعه البوّابة", () => {
    const boom = () => {
      throw new Error("فصل المهام القديم");
    };
    expect(() =>
      assertApprover({ actor: OWNER, trigger: "MONEY_OUT", subject: "س", legacy: boom }),
    ).toThrow("فصل المهام القديم");
  });
});

describe("العلَم مفتوح — شخصان لا أكثر", () => {
  beforeEach(() => {
    process.env[FLAG] = "ON";
  });

  it("لا خروجَ مالٍ ولا محوَ أثر ⇒ يُنفَّذ فوراً بلا طلبٍ ولا اعتماد", () => {
    const plan = planApproval({ actor: STAFF, trigger: null });
    expect(plan.outcome).toBe("NOT_REQUIRED");
    expect(plan.executeNow).toBe(true);
  });

  it("موظّفٌ + لحظةُ خطر ⇒ طلبٌ ينتظر المالك", () => {
    const plan = planApproval({ actor: STAFF, trigger: "MONEY_OUT" });
    expect(plan.outcome).toBe("NEEDS_OWNER");
    expect(plan.executeNow).toBe(false);
  });

  it("المالك + لحظةُ خطر ⇒ اعتمادٌ تلقائيّ ينفَّذ فوراً", () => {
    const plan = planApproval({ actor: OWNER, trigger: "ERASE_EFFECT" });
    expect(plan.outcome).toBe("AUTO_SELF_APPROVED");
    expect(plan.executeNow).toBe(true);
  });

  it("المالك يعتمد ولو كان هو المنشئ — ولا يُستدعى الفحص القديم إطلاقاً", () => {
    const legacy = vi.fn(() => {
      throw new Error("ما كان يجب أن يُستدعى");
    });
    expect(() =>
      assertApprover({ actor: OWNER, trigger: "MONEY_OUT", subject: "طلب دفع SP-42", legacy }),
    ).not.toThrow();
    expect(legacy).not.toHaveBeenCalled();
  });

  it("غيرُ المالك لا يعتمد — ورسالتُه تقول ماذا يفعل وأين يجده", () => {
    let msg = "";
    try {
      assertApprover({ actor: STAFF, trigger: "MONEY_OUT", subject: "طلب دفع SP-42", legacy: () => {} });
    } catch (e) {
      msg = (e as { message: string }).message;
    }
    expect(msg).toContain("طلب دفع SP-42");
    expect(msg).toContain("اعتماد المالك");
    expect(msg).toContain("مطلوب مني الآن");
  });

  it("قيمةٌ غير مفهومة في العلَم ⇒ يُعامَل مطفأً (يفشل مغلقاً)", () => {
    process.env[FLAG] = "نعم";
    const legacy = vi.fn();
    assertApprover({ actor: STAFF, trigger: "MONEY_OUT", subject: "س", legacy });
    expect(legacy).toHaveBeenCalledOnce();
  });
});

describe("سجلّ «نُفِّذ بشخصٍ واحد» — التقريرُ يحلّ محلّ الفصل", () => {
  beforeEach(() => {
    process.env[FLAG] = "ON";
  });

  it("يُسجَّل ما اعتمده المالك على نفسه", () => {
    const plan = planApproval({ actor: OWNER, trigger: "MONEY_OUT" });
    const rec = soloExecutionRecord({
      actor: { userId: 1, branchId: 1, isOwner: true },
      plan,
      trigger: "MONEY_OUT",
      subject: "صرف ٢٥٠٬٠٠٠",
    });
    expect(rec).not.toBeNull();
    expect(rec?.outcome).toBe("AUTO_SELF_APPROVED");
    expect(rec?.actorUserId).toBe(1);
  });

  it("ويُسجَّل ما نفّذه موظّفٌ وحده بلا بوّابة", () => {
    const plan = planApproval({ actor: STAFF, trigger: null });
    const rec = soloExecutionRecord({
      actor: { userId: 7, branchId: 1, isOwner: false },
      plan,
      trigger: null,
      subject: "استلام بضاعة GRN-9",
    });
    expect(rec?.outcome).toBe("NOT_REQUIRED");
  });

  it("ولا يُسجَّل ما ينتظر المالك — لأنّه لم يُنفَّذ بعد", () => {
    const plan = planApproval({ actor: STAFF, trigger: "MONEY_OUT" });
    expect(
      soloExecutionRecord({
        actor: { userId: 7, branchId: 1, isOwner: false },
        plan,
        trigger: "MONEY_OUT",
        subject: "س",
      }),
    ).toBeNull();
  });
});
