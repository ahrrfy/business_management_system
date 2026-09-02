import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
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

  it("⭐ trigger = null ⇒ لا بوّابةَ إطلاقاً — يمرّ الموظّف بلا اعتماد", () => {
    const legacy = vi.fn();
    expect(() =>
      assertApprover({ actor: STAFF, trigger: null, subject: "ترحيل فاتورة مورّد", legacy }),
    ).not.toThrow();
    // ولا يُستدعى الفحص القديم: البوّابة **حُذفت** لا استُبدلت.
    expect(legacy).not.toHaveBeenCalled();
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

describe("الضابطُ المُستبقى بقرار مالك — retainLegacy", () => {
  beforeEach(() => {
    process.env[FLAG] = "ON";
  });

  it("⭐ يُنفَّذ الضابطُ القائم رغم أنّ التصنيف null والسياسةُ الجديدة تعمل", () => {
    // سندُ القبض العاديّ: لا مالَ يخرج ولا أثرَ يُمحى ⇒ تصنيفُه null. وبلا الاستبقاء كان
    // تشغيلُ السياسة يُسقط **الضابط الوحيد** على نقدٍ مجهول المصدر يدخل الخزينة.
    const legacy = vi.fn();
    assertApprover({ actor: STAFF, trigger: null, subject: "سند V-1", legacy, retainLegacy: true });
    expect(legacy).toHaveBeenCalledTimes(1);
  });

  it("ورميُ الضابط المُستبقى يمرّ كما هو — الاستبقاء ليس تخفيفاً", () => {
    const legacy = () => {
      throw new Error("لا يجوز اعتماد سند أنشأته بنفسك");
    };
    expect(() =>
      assertApprover({ actor: STAFF, trigger: null, subject: "سند V-1", legacy, retainLegacy: true }),
    ).toThrow(/أنشأته بنفسك/);
  });

  it("ولا يُستثنى منه المالك — الضابطُ القائم يقيس ما كان يقيسه", () => {
    // المالكُ يتجاوز **البوّابة الجديدة** لا الضابطَ الذي قرّر إبقاءه؛ وإلّا صار الاستبقاء
    // اسماً بلا أثرٍ على الفاعل الوحيد الذي يعتمد.
    const legacy = vi.fn();
    assertApprover({ actor: OWNER, trigger: null, subject: "سند V-1", legacy, retainLegacy: true });
    expect(legacy).toHaveBeenCalledTimes(1);
  });

  it("وبلا العلَم لا فرق — الضابطُ يعمل في الوضعين", () => {
    delete process.env[FLAG];
    const legacy = vi.fn();
    assertApprover({ actor: STAFF, trigger: null, subject: "سند V-1", legacy, retainLegacy: true });
    expect(legacy).toHaveBeenCalledTimes(1);
  });

  it("ولا يُزدوج على فعلٍ له مُطلِقٌ أصلاً: الضابطُ ثمّ البوّابة معاً", () => {
    // صرفٌ (MONEY_OUT) مع استبقاء: يُنفَّذ الضابط القديم **ثمّ** تُطبَّق البوّابة الجديدة —
    // فلا يُفلت غيرُ المالك بحجّة أنّ الضابط القديم مرّ.
    const legacy = vi.fn();
    expect(() =>
      assertApprover({ actor: STAFF, trigger: "MONEY_OUT", subject: "سند V-2", legacy, retainLegacy: true }),
    ).toThrow(/المالك/);
    expect(legacy).toHaveBeenCalledTimes(1);
  });

  it("والسلوك بلا retainLegacy لم يتغيّر — null يمرّ بلا استدعاء الضابط", () => {
    const legacy = vi.fn();
    assertApprover({ actor: STAFF, trigger: null, subject: "س", legacy });
    expect(legacy).not.toHaveBeenCalled();
  });
});

describe("عقدُ الوصل — لا يبلغ البوّابةَ فاعلٌ لم تُحسَم ملكيّتُه من القاعدة", () => {
  /**
   * ⭐ هذا الاختبار يُغلق **النصف الذي لا يمسكه النوع**.
   *
   * جعلُ `isOwner` إلزاميةً في `ResolvedApprovalActor` يمنع تمريرَ `Actor` خامّاً (يُحمِّر
   * `tsc` — وهو ما كشف ثمانيةَ عشرَ موضعاً معطوباً صامتاً). لكنّه **لا يمنع إسكاتَه كذباً**:
   * `actor: { ...actor, isOwner: actor.isOwner === true }` يُرضي النوعَ ويُعيد العطبَ نفسَه،
   * لأنّ `undefined` تصير `false` فيُرفَض المالكُ الحقيقيّ.
   *
   * الجذرُ المقيس: **٥٥ من ٦٤ راوتراً** تبني الفاعل بلا `isOwner`. ولذلك المصدرُ المقبول
   * واحدٌ لا غير: `resolveApprovalActor(tx, actor)` — تقرأ `users.isOwner` و`isActive` داخل
   * المعاملة نفسها، فلا راوترَ ينسى ولا حمولةَ طلبٍ تدّعي.
   */
  const CALL = "assertApprover({";

  function serviceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "__tests__") continue;
        out.push(...serviceFiles(full));
      } else if (entry.isFile() && full.endsWith(".ts") && !full.endsWith(".test.ts")) {
        out.push(full);
      }
    }
    return out;
  }

  const ROOT = join(__dirname, "..");
  const sites: Array<{ file: string; snippet: string }> = [];
  for (const file of serviceFiles(ROOT)) {
    const src = readFileSync(file, "utf8");
    // ⚠️ قيدٌ ضروريّ: `inventory/adjustmentApproval.ts` فيه دالّةٌ **محلّية** بالاسم نفسه
    // وتوقيعٍ مختلف تماماً. بلا هذا الشرط يُنذر الاختبارُ كذباً على شيفرةٍ لا علاقة لها.
    if (!/from "[^"]*approval\/ownerGate"/.test(src) && !/from "\.\/ownerGate"/.test(src)) continue;
    let at = src.indexOf(CALL);
    while (at !== -1) {
      sites.push({ file: file.slice(ROOT.length + 1).split("\\").join("/"), snippet: src.slice(at, at + 260) });
      at = src.indexOf(CALL, at + 1);
    }
  }

  it("تُوجد مواضعُ وصلٍ فعلاً — وإلّا كان الاختبار أخضرَ على الفراغ", () => {
    expect(sites.length).toBeGreaterThanOrEqual(15);
  });

  it("⭐ كلُّ موضعٍ يمرّ بـresolveApprovalActor — لا فاعلَ خامّ ولا حسمٌ يدويّ", () => {
    const offenders = sites.filter((s) => !s.snippet.includes("resolveApprovalActor("));
    expect(offenders.map((o) => `${o.file}: ${o.snippet.slice(0, 90)}`)).toEqual([]);
  });

  it("ولا يُحسَم بـ`=== true` يدوياً — يُرضي النوعَ ويُعيد العطب", () => {
    const faked = sites.filter((s) => /isOwner:\s*[^,\n]*===\s*true/.test(s.snippet));
    expect(faked.map((o) => o.file)).toEqual([]);
  });
});
