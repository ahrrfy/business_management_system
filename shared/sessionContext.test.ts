/**
 * حارسُ عقد سياق الجلسة (`shared/sessionContext.ts`).
 *
 * أربعةُ ثوابت يحرسها هذا الملفّ، وكلٌّ منها عطبٌ حقيقيّ لا تجميلُ نوع:
 *  ١) **التعارض يُرفَض برسالةٍ تذكر القيمتين** — «لا يطابق» وحدها رسالةٌ عمياء يُعالجها الموظّف
 *     بالتخمين (نفس درس مطابقة فاتورة المورّد: الرسالةُ العمياء عطّلت الضابط كلّه).
 *  ٢) **لا مسارَ يُنتج فرعاً بلا مصدرٍ خادميّ** — الفرعُ الافتراضيّ الصامت بابُ IDOR تاريخيّ
 *     (`?? 1`). يُفحَص سلوكياً (كلّ مدخلٍ ناقصٍ ينتهي بـ`null` أو رمي) **ونصّياً** على الملفّ
 *     نفسه (لا `?? 1`، ولا رقمَ فرعٍ حرفيّ، ولا قراءةَ ساعةٍ داخلية) — فحارسٌ يقرأ من مصدرٍ
 *     غير الذي ينفّذ عليه ليس حارساً، ولذا نقرأ الشيفرة الحيّة لا قائمةً مكتوبةً بيد.
 *  ٣) **`canCrossBranches` مفتاحُ إطفاءٍ متحقَّقٌ منه** — يُقارَن **سلوكياً** بالدالّة الخادميّة
 *     الحيّة `canCrossBranches` (server/lib/branchAuthority.ts) على مصفوفة أدوار، لا بنصٍّ
 *     منسوخ. مفتاحٌ يُطفئ فحصاً وهو غيرُ متحقَّقٍ منه = لا فحصَ أصلاً.
 *  ٤) **القوائمُ المنسوخة مربوطةٌ بمصدرها** — الفئاتُ السعرية تُقابَل بـ`drizzle/schema.ts`
 *     الحيّ. (وقائمةُ أنواع الورديات أُسقطت مع رايل النقد — انظر اختبار «لا رايلَ نقدٍ».)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// الدالّةُ الخادميّةُ الحيّة نفسها — لا نسخةَ نصّها. سابقةٌ قائمة: shared/priceWaveRule.test.ts
// يستورد server/services/money. (اختبارٌ فقط ⇒ لا يبلغ حزمةَ المتصفّح.)
import { canCrossBranches as serverCanCrossBranches } from "../server/lib/branchAuthority";
import * as sessionContextModule from "./sessionContext";
import {
  assertMatchesDerived,
  composeSessionContext,
  findSessionContextConflicts,
  formatSessionContextConflicts,
  isBusinessDayYmd,
  isSessionPaymentMethodAllowed,
  readSessionContext,
  requireSessionBranchId,
  SESSION_CONTEXT_CONFLICT_CODE,
  SessionContextConflictError,
  type SessionContext,
  type SessionContextSource,
} from "./sessionContext";

const ROOT = join(__dirname, "..");

/** الشيفرة الحيّة **بلا تعليقات**: التوثيق يذكر `?? 1` ليحذّر منه، والحارسُ يفحص ما يُنفَّذ. */
const SOURCE = readFileSync(join(__dirname, "sessionContext.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|\s)\/\/[^\n]*/g, "$1");

/** سياقٌ مُشتَقٌّ خادمياً نموذجيّ: كاشير في الفرع 3 (لا يعبُر الفروع، ويرى ما أنشأه). */
function mkCtx(over: Partial<SessionContext> = {}): SessionContext {
  return {
    actor: { userId: 42, role: "cashier", isOwner: false },
    branch: { id: 3, name: "الفرع الرئيسي" },
    businessDay: "2026-09-02",
    allowedPaymentMethods: ["CASH", "CARD", "TRANSFER", "WALLET"],
    defaultPriceTier: "RETAIL",
    canCrossBranches: false,
    scope: { scopedBranchId: 3, scopedOwnerId: 42 },
    derivedAt: "2026-09-02T08:00:00.000Z",
    ...over,
  };
}

/** سياقُ أدمنٍ عابرِ الفروع — بصمةٌ متّسقة (نطاقٌ فارغ في الاتّجاهين). */
function mkAdminCtx(over: Partial<SessionContext> = {}): SessionContext {
  return mkCtx({
    actor: { userId: 1, role: "admin", isOwner: true },
    branch: null,
    canCrossBranches: true,
    scope: { scopedBranchId: null, scopedOwnerId: null },
    ...over,
  });
}

/** حمولةٌ خام صالحة (نفس القيم) — لاختبار القارئ الفاشل مغلقاً. */
const validPayload = (): Record<string, unknown> =>
  JSON.parse(JSON.stringify(mkCtx()));

/** مدخلُ تركيبٍ صالح — بلا `canCrossBranches` (تُشتقّ من الفاعل داخل الدالّة). */
function mkSource(
  over: Partial<SessionContextSource> = {},
): SessionContextSource {
  return {
    actor: { userId: 42, role: "cashier", isOwner: false },
    branch: { id: 5, name: "فرع المبيعات" },
    businessDay: "2026-09-02",
    allowedPaymentMethods: ["CASH"],
    defaultPriceTier: "RETAIL",
    scopedOwnerId: 42,
    ...over,
  };
}

const NOW = new Date("2026-09-02T08:00:00.000Z");

// ─────────────────────────────────────────────────────────────────────────────
describe("findSessionContextConflicts — التعارض يُرصَد بقيمتَيه", () => {
  it("ادّعاءٌ فارغ = لا تعارض (الحقلُ غير المُرسَل لا يُملأ باشتقاق)", () => {
    expect(findSessionContextConflicts({}, mkCtx())).toEqual([]);
  });

  it("ادّعاءٌ مطابقٌ للمُشتَقّ = لا تعارض", () => {
    const conflicts = findSessionContextConflicts(
      {
        userId: 42,
        branchId: 3,
        businessDay: "2026-09-02",
        paymentMethod: "CASH",
      },
      mkCtx(),
    );
    expect(conflicts).toEqual([]);
  });

  it("فرعٌ مخالفٌ لغير عابر الفروع ⇒ تعارضٌ يحمل القيمتين لاتينيّتين", () => {
    const [conflict, ...rest] = findSessionContextConflicts(
      { branchId: 7 },
      mkCtx(),
    );
    expect(rest).toEqual([]);
    expect(conflict.field).toBe("branchId");
    expect(conflict.sent).toBe("7");
    expect(conflict.derived).toBe("3");
    expect(conflict.label).toBe("الفرع");
  });

  it("عابرُ الفروع يختار فرعاً آخر بقصدٍ مشروع ⇒ لا تعارض (مرآةُ عودة الراوتر المبكرة)", () => {
    expect(findSessionContextConflicts({ branchId: 7 }, mkAdminCtx())).toEqual(
      [],
    );
  });

  it("فرعٌ مُرسَلٌ بلا فرعٍ نشط ⇒ تعارض (دفاعٌ في العمق على سياقٍ مبنيٍّ يدوياً)", () => {
    // ⚠️ بصمةٌ **لا يُنتجها** `composeSessionContext` ولا يقبلها `readSessionContext`
    // (كلاهما يرفض «غيرُ عابرٍ بلا فرع» كما يرفضه الراوتر بـFORBIDDEN) — يحرسها الاختباران
    // أدناه. تُبنى هنا يدوياً لأنّ الدالّة نقيّةٌ ومُصدَّرة: موقعُ نداءٍ يبني سياقاً بيده يجب
    // ألّا يمرّ صامتاً.
    const handBuilt = mkCtx({
      actor: { userId: 1, role: "admin", isOwner: true },
      branch: null,
      canCrossBranches: false,
      scope: { scopedBranchId: null, scopedOwnerId: null },
    });
    const [conflict] = findSessionContextConflicts({ branchId: 1 }, handBuilt);
    expect(conflict.field).toBe("branchId");
    expect(conflict.sent).toBe("1");
    expect(conflict.derived).toBe("بلا");
  });

  it("اليومُ التشغيليّ لا يُتجاوَز — تاريخُ المستند قرارٌ خادميّ", () => {
    const [conflict] = findSessionContextConflicts(
      { businessDay: "2026-09-01" },
      mkCtx(),
    );
    expect(conflict.field).toBe("businessDay");
    expect(conflict.sent).toBe("2026-09-01");
    expect(conflict.derived).toBe("2026-09-02");
  });

  it("طريقةُ دفعٍ خارج المسموح ⇒ تعارضٌ يعرض القائمة المسموحة كاملةً", () => {
    const [conflict] = findSessionContextConflicts(
      { paymentMethod: "CHECK" },
      mkCtx(),
    );
    expect(conflict.field).toBe("paymentMethod");
    expect(conflict.sent).toBe("CHECK");
    expect(conflict.derived).toContain("CASH");
    expect(conflict.derived).toContain("WALLET");
  });

  it("طريقةٌ مجهولة تُرفَض أيضاً (fail-closed)", () => {
    expect(
      findSessionContextConflicts({ paymentMethod: "CRYPTO" }, mkCtx()),
    ).toHaveLength(1);
  });

  it("انتحالُ مستخدمٍ آخر ⇒ تعارض (النسبةُ لغيره حقلٌ صريحٌ آخر لا ادّعاءُ هويّة)", () => {
    const [conflict] = findSessionContextConflicts({ userId: 9 }, mkCtx());
    expect(conflict.field).toBe("userId");
    expect(conflict.sent).toBe("9");
    expect(conflict.derived).toBe("42");
  });

  it("يجمع كلّ التعارضات دفعةً واحدة لا أوّلَها فقط", () => {
    const conflicts = findSessionContextConflicts(
      { branchId: 7, businessDay: "2026-01-01", paymentMethod: "CHECK" },
      mkCtx(),
    );
    expect(conflicts.map((c) => c.field).sort()).toEqual([
      "branchId",
      "businessDay",
      "paymentMethod",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("ما هو خارج فحص التعارض عمداً — وسببُه", () => {
  it("الفئةُ السعرية ليست حقلاً في الادّعاء — رفعُها لعميل الجملة قرارٌ مشروع", () => {
    // حارسٌ يُنذر كذباً يُتجاوَز فيصير مسرحياً: الفئةُ افتراضٌ لا قيد.
    const fields = Object.keys(sessionContextModule.SESSION_CLAIM_LABEL_AR);
    expect(fields).not.toContain("priceTier");
    expect(fields).not.toContain("defaultPriceTier");
  });

  it("⛔ لا رايلَ نقدٍ في العقد: الوردية والوعاء يُحلّان لكلّ عملية لا لكلّ جلسة", () => {
    // ثلاثةُ أسبابٍ من قراءة `shiftIdForCashTx` (server/services/shiftService.ts:1265-1290):
    //  ١) `openShiftIdTx` تحلّ لكلّ (userId, branchId, preferredType)، والموظّف قد يملك
    //     ورديتَين مفتوحتَين (تجزئة + استقبال) ⇒ قيمةٌ جلسيّةٌ واحدة تُنذر كذباً على إحداهما.
    //  ٢) `shiftType` غيرُ مُرجَعٍ أصلاً — `preferredType` معاملُ **دخل** لموقع النداء.
    //  ٣) الفرعُ الثالث (غيرُ إداريٍّ بلا وردية) **رميٌ** `PRECONDITION_FAILED` لا قيمة.
    // إعادةُ الحقل تُعيد حارساً مسرحياً؛ فإن لزم فعلاً، احذف هذا الاختبار بقرارٍ واعٍ مكتوب.
    expect(SOURCE).not.toMatch(/\bshiftId\b/);
    expect(SOURCE).not.toMatch(/\bcashBucket\b/);
    expect(SOURCE).not.toMatch(/\bshiftType\b/);
    expect(SOURCE).not.toMatch(/\bcashRail\b/);
    const fields = Object.keys(sessionContextModule.SESSION_CLAIM_LABEL_AR);
    expect(fields).not.toContain("shiftId");
    expect(fields).not.toContain("cashBucket");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("assertMatchesDerived — الرمي برسالةٍ تذكر القيمتين", () => {
  it("لا ترمي على ادّعاءٍ مطابق", () => {
    expect(() => assertMatchesDerived({ branchId: 3 }, mkCtx())).not.toThrow();
  });

  it("ترمي SessionContextConflictError برمزٍ ثابت وقائمةِ تعارضات", () => {
    let caught: unknown;
    try {
      assertMatchesDerived({ branchId: 7 }, mkCtx());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SessionContextConflictError);
    const err = caught as SessionContextConflictError;
    expect(err.code).toBe(SESSION_CONTEXT_CONFLICT_CODE);
    expect(err.conflicts).toHaveLength(1);
  });

  it("الرسالة تحمل القيمتين معاً — لا «لا يطابق» عمياء", () => {
    let message = "";
    try {
      assertMatchesDerived({ branchId: 7 }, mkCtx());
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("7");
    expect(message).toContain("3");
    expect(message).toContain("الفرع");
    expect(message).toContain("أُرسل");
    expect(message).toContain("المُشتَقّ");
  });

  it("الأرقام في الرسالة لاتينية لا هندية (قاعدة المالك)", () => {
    const message = formatSessionContextConflicts(
      findSessionContextConflicts({ branchId: 7, userId: 12 }, mkCtx()),
    );
    expect(message).toMatch(/[0-9]/);
    expect(message).not.toMatch(/[٠-٩]/);
  });

  it("رسالةُ تعارضاتٍ متعدّدة تذكرها كلَّها", () => {
    const message = formatSessionContextConflicts(
      findSessionContextConflicts(
        { branchId: 7, businessDay: "2026-01-01" },
        mkCtx(),
      ),
    );
    expect(message).toContain("الفرع");
    expect(message).toContain("اليوم التشغيليّ");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("لا مسارَ يُنتج فرعاً بلا مصدرٍ خادميّ", () => {
  it("requireSessionBranchId ترمي حين لا فرعَ نشط — ولا تُرجع 1", () => {
    expect(() => requireSessionBranchId(mkAdminCtx())).toThrow(
      "لا فرعَ نشطٌ في هذه الجلسة",
    );
  });

  it("requireSessionBranchId ترمي على سياقٍ غائب (null/undefined)", () => {
    expect(() => requireSessionBranchId(null)).toThrow();
    expect(() => requireSessionBranchId(undefined)).toThrow();
  });

  it("requireSessionBranchId تُرجع فرع الخادم حين يوجد", () => {
    expect(requireSessionBranchId(mkCtx())).toBe(3);
  });

  it("readSessionContext تفشل مغلقةً على كلّ حمولةٍ ناقصة", () => {
    expect(readSessionContext(undefined)).toBeNull();
    expect(readSessionContext(null)).toBeNull();
    expect(readSessionContext({})).toBeNull();
    expect(readSessionContext("branchId=1")).toBeNull();
    const noBranchKey = validPayload();
    delete noBranchKey.branch; // غيابُ المفتاح ≠ «لا فرع» الصريحة ⇒ رفض
    expect(readSessionContext(noBranchKey)).toBeNull();
  });

  it("composeSessionContext ترمي على «غيرُ عابرٍ بلا فرع» — نفس FORBIDDEN الراوتر", () => {
    expect(() =>
      composeSessionContext(mkSource({ branch: null }), NOW),
    ).toThrow("لا فرع مُسنَد لهذا المستخدم");
  });

  it("composeSessionContext تشتقّ scopedBranchId من الفرع لا من مُدخَلٍ خارجيّ", () => {
    const ctx = composeSessionContext(mkSource(), NOW);
    expect(ctx.scope.scopedBranchId).toBe(5);
    expect(ctx.derivedAt).toBe("2026-09-02T08:00:00.000Z");
  });

  it("عابرُ الفروع ⇒ scopedBranchId=null (كلّ الفروع) لا فرعٌ مُلفَّق", () => {
    const ctx = composeSessionContext(
      mkSource({
        actor: { userId: 1, role: "admin", isOwner: true },
        branch: null,
        scopedOwnerId: null,
      }),
      NOW,
    );
    expect(ctx.branch).toBeNull();
    expect(ctx.scope.scopedBranchId).toBeNull();
  });

  it("composeSessionContext ترفض نطاقَ موظّفٍ لا يطابق الفاعل", () => {
    expect(() =>
      composeSessionContext(mkSource({ scopedOwnerId: 99 }), NOW),
    ).toThrow("نطاقُ الموظّف");
  });

  it("composeSessionContext تُبلغ بالعربية على لحظةٍ غير صالحة بدل RangeError عمياء", () => {
    expect(() =>
      composeSessionContext(mkSource(), new Date("لا-تاريخ")),
    ).toThrow("لحظةُ اشتقاق السياق غير صالحة");
  });

  it("⭐ كلُّ ما تُنتجه compose يقبله read (الطبقتان لا تتفارقان)", () => {
    // ثابتٌ تكامليّ: خادمٌ يُركّب سياقاً يرفضه عميلُه = جلسةٌ ميتة بلا رسالة. يُفحَص عبر
    // JSON (نفس رحلة الشبكة) لا بمرجعٍ في الذاكرة.
    const cases: SessionContextSource[] = [
      mkSource(),
      mkSource({
        actor: { userId: 7, role: "manager", isOwner: false },
        scopedOwnerId: null,
      }),
      mkSource({
        actor: { userId: 1, role: "admin", isOwner: true },
        branch: null,
        scopedOwnerId: null,
      }),
      mkSource({
        actor: { userId: 2, role: "manager", isOwner: true }, // مالكٌ بدورِ مدير ⇒ يعبُر
        branch: null,
        scopedOwnerId: null,
      }),
      mkSource({
        defaultPriceTier: "GOVERNMENT",
        allowedPaymentMethods: ["CASH", "CARD"],
      }),
    ];
    for (const source of cases) {
      const composed = composeSessionContext(source, NOW);
      expect(readSessionContext(JSON.parse(JSON.stringify(composed)))).toEqual(
        composed,
      );
    }
  });

  it("الملفّ نفسه بلا فرعٍ افتراضيّ ولا قراءةِ ساعةٍ داخلية (فحصٌ نصّيّ على الشيفرة الحيّة)", () => {
    expect(SOURCE).not.toMatch(/\?\?\s*1\b/); // بابُ IDOR التاريخيّ
    expect(SOURCE).not.toMatch(/\|\|\s*1\b/);
    expect(SOURCE).not.toMatch(/branchId\s*[:=]\s*\d/); // لا رقمَ فرعٍ حرفيّ في العقد
    expect(SOURCE).not.toMatch(/new Date\(\s*\)/); // اليومُ يأتي مُشتَقّاً لا من ساعة الجهاز
  });

  it("جردُ الصادرات مُجمَّد — أيّ منفذٍ جديد يجب أن يمرّ بمراجعةٍ واعية", () => {
    // مثلاً `sessionBranchIdOrDefault` كان سيعيد `?? 1` من بابٍ آخر بلا أن يمسّ الحارس النصّيّ.
    expect(Object.keys(sessionContextModule).sort()).toEqual(
      [
        "SESSION_BUSINESS_DAY_TIMEZONE",
        "SESSION_CLAIM_LABEL_AR",
        "SESSION_CONTEXT_CONFLICT_CODE",
        "SessionContextConflictError",
        "assertMatchesDerived",
        "composeSessionContext",
        "findSessionContextConflicts",
        "formatSessionContextConflicts",
        "isBusinessDayYmd",
        "isSessionPaymentMethodAllowed",
        "readSessionContext",
        "requireSessionBranchId",
      ].sort(),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("canCrossBranches — مفتاحُ إطفاءٍ متحقَّقٌ منه لا ادّعاءٌ حرّ", () => {
  /** بصمةٌ متّسقةٌ مع سلطة الفاعل — لعزل الفشل في `canCrossBranches` وحدها. */
  const payloadFor = (
    actor: { userId: number; role: string; isOwner: boolean },
    claimedCross: boolean,
  ): Record<string, unknown> => {
    const p = validPayload();
    p.actor = actor;
    p.canCrossBranches = claimedCross;
    // نجعل بقيّةَ الحمولة موافقةً للادّعاء كي لا يكون الرفضُ من ثابت العزل بدلاً منه.
    p.branch = claimedCross ? null : { id: 3, name: "الفرع الرئيسي" };
    p.scope = { scopedBranchId: claimedCross ? null : 3, scopedOwnerId: null };
    return p;
  };

  const ROLES: ReadonlyArray<{ role: string; isOwner: boolean }> = [
    { role: "admin", isOwner: false },
    { role: "admin", isOwner: true },
    { role: "manager", isOwner: false },
    { role: "manager", isOwner: true },
    { role: "cashier", isOwner: false },
    { role: "cashier", isOwner: true },
    { role: "print_operator", isOwner: false },
    { role: "warehouse", isOwner: false },
  ];

  it("يُقبَل الادّعاء ⇔ طابق الدالّةَ الخادميّة الحيّة (لا نصّاً منسوخاً)", () => {
    for (const { role, isOwner } of ROLES) {
      const actor = { userId: 42, role, isOwner };
      const truth = serverCanCrossBranches(actor);
      for (const claimed of [true, false]) {
        const accepted =
          readSessionContext(payloadFor(actor, claimed)) !== null;
        expect(
          accepted,
          `${role}/isOwner=${isOwner} يدّعي canCrossBranches=${claimed}`,
        ).toBe(claimed === truth);
      }
    }
  });

  it("كاشيرٌ يدّعي عبورَ الفروع يُرفَض — وإلّا أطفأ فحصَ الفرع عن نفسه", () => {
    const forged = validPayload();
    forged.canCrossBranches = true;
    forged.scope = { scopedBranchId: null, scopedOwnerId: 42 };
    forged.branch = null;
    expect(readSessionContext(forged)).toBeNull();
  });

  it("أدمنٌ يدّعي **عدم** العبور يُرفَض أيضاً — الكذبةُ المعاكسة تُشعل إنذاراً كاذباً", () => {
    const understated = validPayload();
    understated.actor = { userId: 1, role: "admin", isOwner: true };
    understated.canCrossBranches = false;
    understated.scope = { scopedBranchId: 3, scopedOwnerId: null };
    expect(readSessionContext(understated)).toBeNull();
  });

  it("composeSessionContext تشتقّ السلطة ولا تقبلها مُدخَلاً", () => {
    const cashier = composeSessionContext(mkSource(), NOW);
    expect(cashier.canCrossBranches).toBe(false);
    const owner = composeSessionContext(
      mkSource({
        actor: { userId: 9, role: "manager", isOwner: true },
        branch: null,
        scopedOwnerId: null,
      }),
      NOW,
    );
    expect(owner.canCrossBranches).toBe(true);
    // مُدخَلٌ إضافيّ مُدَّعىً يُتجاهَل: العقدُ لا يحمل الحقل أصلاً (يمنعه tsc)، والاشتقاقُ يفوز.
    const forgedSource = {
      ...mkSource(),
      canCrossBranches: true,
    } as SessionContextSource;
    expect(composeSessionContext(forgedSource, NOW).canCrossBranches).toBe(
      false,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("readSessionContext — ثوابتُ العزل والنطاق", () => {
  it("يقبل الحمولة الصالحة كما هي", () => {
    expect(readSessionContext(validPayload())).toEqual(mkCtx());
  });

  it("يرفض «غيرُ عابرٍ ونطاقُه فرعٌ آخر» (سياقٌ ملفَّقٌ يُسكِت العزل)", () => {
    const p = validPayload();
    p.scope = { scopedBranchId: 9, scopedOwnerId: 42 };
    expect(readSessionContext(p)).toBeNull();
  });

  it("يرفض «عابرُ الفروع بنطاقِ فرعٍ مفرد» (مخالفٌ لسطر branchScopedProcedure)", () => {
    const p = JSON.parse(JSON.stringify(mkAdminCtx()));
    p.scope = { scopedBranchId: 3, scopedOwnerId: null };
    expect(readSessionContext(p)).toBeNull();
  });

  it("يرفض نطاقَ موظّفٍ لا يطابق الفاعل (scopedOwnerId = معرّفُ الفاعل أو فارغ)", () => {
    const p = validPayload();
    p.scope = { scopedBranchId: 3, scopedOwnerId: 99 };
    expect(readSessionContext(p)).toBeNull();
  });

  it("يقبل scopedOwnerId=null لغير المشرف كذلك — «فارغةٌ ⇔ مشرف» غيرُ مفروضة عمداً", () => {
    // «المشرف» = عابرُ الفروع **أو المدير**، ولا مصدرَ مشتركاً لتلك القاعدة يُستورَد هنا؛
    // ونسخُها بيد هو الانجرافُ الذي يوجد هذا الملفّ لمنعه. نفرض النصفَ المؤكَّد وحده.
    const p = validPayload();
    p.scope = { scopedBranchId: 3, scopedOwnerId: null };
    expect(readSessionContext(p)?.scope.scopedOwnerId).toBeNull();
  });

  it("يرفض يوماً غير موجود (2026-02-31) لا الصيغةَ وحدها", () => {
    const p = validPayload();
    p.businessDay = "2026-02-31";
    expect(readSessionContext(p)).toBeNull();
  });

  it("يرفض حمولةً فيها طريقةٌ خارج سياسة القبض بدل تصفيتها صامتاً", () => {
    const p = validPayload();
    p.allowedPaymentMethods = ["CASH", "CHECK"];
    expect(readSessionContext(p)).toBeNull();
  });

  it("يرفض فئةً سعريّة مجهولة", () => {
    const p = validPayload();
    p.defaultPriceTier = "VIP";
    expect(readSessionContext(p)).toBeNull();
  });

  it("يرفض فرعاً بلا اسمٍ أو بمعرّفٍ غير موجب", () => {
    const noName = validPayload();
    noName.branch = { id: 3 };
    expect(readSessionContext(noName)).toBeNull();

    const badId = validPayload();
    badId.branch = { id: 0, name: "فرع" };
    expect(readSessionContext(badId)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("derivedAt — طابعٌ يُتحقَّق منه وإلّا لم يشتعل كشفُ التقادم أبداً", () => {
  const withDerivedAt = (value: unknown) => {
    const p = validPayload();
    p.derivedAt = value;
    return readSessionContext(p);
  };

  it("يقبل صيغةَ toISOString والإزاحةَ الصريحة معاً", () => {
    expect(withDerivedAt("2026-09-02T08:00:00.000Z")?.derivedAt).toBe(
      "2026-09-02T08:00:00.000Z",
    );
    expect(withDerivedAt("2026-09-02T08:00:00Z")).not.toBeNull();
    expect(withDerivedAt("2026-09-02T11:00:00+03:00")).not.toBeNull();
  });

  it("يرفض ما ينتهي بـ Invalid Date — وهذا كان الكشفَ الميّت بصمت", () => {
    // نصٌّ «غير فارغ» كان يمرّ، فيصير `new Date(derivedAt)` = Invalid Date وكلُّ مقارنةِ
    // تقادمٍ عليه `false` ⇒ سياقٌ عمرُه ساعات يبدو طازجاً أبداً.
    for (const bad of [
      "قبل قليل",
      "لم يُشتقّ بعد",
      "2026-09-02", // تاريخٌ بلا وقت: ليس طابعاً زمنياً
      "2026-09-02 08:00:00", // بلا T وبلا منطقة
      "2026-09-02T08:00:00", // بلا منطقة ⇒ يُفسَّر محلياً فينزاح
      "2026-02-31T00:00:00.000Z", // يومٌ لا وجود له (Date.parse يتدحرج إلى ٣ مارس)
      "2026-09-02T25:00:00Z",
      "2026-13-01T00:00:00Z",
      "",
      "   ",
      1788336000000,
      null,
    ]) {
      expect(withDerivedAt(bad), `derivedAt=${String(bad)}`).toBeNull();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("القوائمُ مربوطةٌ بمصدرها لا منسوخةٌ بيد", () => {
  /** الفئاتُ كما يعرّفها المخطّط الحيّ — مصدرُ الحقيقة النهائيّ للعمود. */
  const schemaPriceTiers = (): string[] => {
    const src = readFileSync(join(ROOT, "drizzle/schema.ts"), "utf8");
    const matches = [
      ...src.matchAll(/mysqlEnum\(\s*"priceTier"\s*,\s*\[([^\]]*)\]/g),
    ].map((m) => [...m[1].matchAll(/"([A-Z_]+)"/g)].map((x) => x[1]));
    expect(
      matches.length,
      "لا عمودَ priceTier في المخطّط — تغيّر الاسمُ فعمي الحارس",
    ).toBeGreaterThan(0);
    for (const list of matches) expect(list).toEqual(matches[0]); // أعمدةٌ متعدّدة ⇒ نفس القائمة
    return matches[0];
  };

  it("كلُّ فئةٍ في المخطّط يقبلها القارئ، وما ليس فيه يُرفَض", () => {
    const tiers = schemaPriceTiers();
    for (const tier of tiers) {
      const p = validPayload();
      p.defaultPriceTier = tier;
      expect(readSessionContext(p), `الفئة ${tier} من المخطّط`).not.toBeNull();
    }
    for (const notATier of ["VIP", "RETAILX", "retail", ""]) {
      const p = validPayload();
      p.defaultPriceTier = notATier;
      expect(readSessionContext(p), `ليست فئةً: ${notATier}`).toBeNull();
    }
  });

  it("عددُ الفئات المقبولة = عددُها في المخطّط (فئةٌ رابعة تكسر الحارس لا تمرّ صامتة)", () => {
    const tiers = schemaPriceTiers();
    const accepted = [
      "RETAIL",
      "WHOLESALE",
      "GOVERNMENT",
      "VIP",
      "COST",
      "STAFF",
    ].filter((t) => {
      const p = validPayload();
      p.defaultPriceTier = t;
      return readSessionContext(p) !== null;
    });
    expect(accepted.sort()).toEqual([...tiers].sort());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("مساعداتٌ نقيّة", () => {
  it("isSessionPaymentMethodAllowed يتبع قائمة الجلسة لا نصّاً ثابتاً في شاشة", () => {
    const ctx = mkCtx({ allowedPaymentMethods: ["CASH"] });
    expect(isSessionPaymentMethodAllowed(ctx, "CASH")).toBe(true);
    expect(isSessionPaymentMethodAllowed(ctx, "CARD")).toBe(false);
    expect(isSessionPaymentMethodAllowed(ctx, null)).toBe(false);
    expect(isSessionPaymentMethodAllowed(ctx, undefined)).toBe(false);
  });

  it("isBusinessDayYmd يقبل الصحيح ويرفض المزيّف", () => {
    expect(isBusinessDayYmd("2026-09-02")).toBe(true);
    expect(isBusinessDayYmd("2026-02-29")).toBe(false);
    expect(isBusinessDayYmd("2026-9-2")).toBe(false);
    expect(isBusinessDayYmd(20260902)).toBe(false);
    expect(isBusinessDayYmd(undefined)).toBe(false);
  });
});
