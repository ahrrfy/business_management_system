/**
 * **عقدُ منتقي رافد الردّ عند الاعتماد** — يحرس ثلاثَ ملاحظاتٍ من مراجعة Codex على #943،
 * أخطرُها ماليّة.
 *
 * ⚠️ لا مكتبةَ تصيير في هذا المستودع (`@testing-library/react` غير مثبّتة)، فالحراسةُ نصّيّة
 * على المصدر — وهو نمطُ عقود الواجهة المتّبع هنا. تُثبت أنّ الشروط قائمةٌ في الشيفرة، لا أنّ
 * البكسل صحيح؛ والعينُ تبقى مسؤوليةَ الجولة البصرية.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const picker = readFileSync(new URL("./ApprovalRefundRailPicker.tsx", import.meta.url), "utf8");
const dialog = readFileSync(new URL("./WorkOrderControlApprovals.tsx", import.meta.url), "utf8");
// م٢ ق١٠ب: العرضُ صار المنتقي الموحَّد نفسَه — الضماناتُ الثلاث تُحرَس حيث انتقلت.
const unified = readFileSync(new URL("../ui/RefundRailPicker.tsx", import.meta.url), "utf8");

describe("منتقي رافد الردّ عند الاعتماد", () => {
  it("⭐⛔ P1: درجُ الطالب يُصان ولا يُستبدَل بدرج المعتمِد", () => {
    // `pickDefaultRefundDrawer` يُفضّل درجَ المستخدم الحاليّ — أي درجَ المعتمِد. فيخرج النقدُ من
    // درجٍ لم يُقصَد وتنكسر تسويةُ درجَين. درجُ الطلب يُبذَر في المنتقي الموحَّد ويُطبَّق **ما دام مؤهَّلاً**.
    expect(picker).toContain("refundShiftId: choice.requested.shiftId");
    expect(unified).toContain("initialSelection?.refundShiftId != null && preflight.drawers.some((d) => d.shiftId === initialSelection.refundShiftId)");
    expect(unified).toContain("drawer.setRefundShiftId(initialSelection.refundShiftId)");
    // مرّةً لكلّ مستند (لا تُطمَس نقرةُ المدير اليدويّة بعدها).
    expect(unified).toContain("seededRef");
  });

  it("⭐ P2: مرجعُ البطاقة يُبذَر من الطلب ويُقارَن به", () => {
    // طلبٌ يقترح CARD يحمل مرجعاً متحقَّقاً منه؛ تفريغُه كان يحجب الاعتماد ويَعُدّ ما يُكتب
    // تجاوزاً — فيستحيل اعتمادُ الطلب كما قُدِّم رغم أنّ الخادم يقبله.
    expect(picker).toContain("cardReference: choice.requested.reference");
    expect(unified).toContain("if (initialSelection?.cardReference) setCardReference(initialSelection.cardReference)");
    expect(picker).toContain('reference.trim() !== (requestedReference ?? "").trim()');
    expect(dialog).toContain("requestedReference: requestedPayload?.refundReference ?? null");
  });

  it("⭐ الرافدُ المقترح الذي لا يكفي والخزينةُ تكفي ⇒ يبدأ على الخزينة (بلاغ المالك ١/٩) — في المنتقي الموحَّد", () => {
    expect(unified).toContain("if (!anyDrawerFits && rails.TREASURY.available && preflight.treasurySufficient) next = \"TREASURY\"");
  });

  it("⭐ P2: إعادةُ الجلب في الخلفية تحجب الاعتماد كما يحجبه التحميل الأوّل", () => {
    // مع بياناتٍ مخبّأة و`staleTime: 0` يكون `isLoading === false` و`isFetching === true`،
    // فيبقى الزرُّ مفعَّلاً على أرصدةٍ قديمة — عينُ ما بُني الحوار ليمنعه.
    expect(dialog).toContain("refundPreflight.isLoading || refundPreflight.isFetching");
    expect(dialog).not.toContain("(refundPreflight.isLoading || refundPreflight.isError)");
  });

  it("التجاوزُ يُرسَل حين يختلف عن اقتراح الطالب وحده", () => {
    expect(dialog).toContain("refundChoice.changed");
    // ولا يُرسَل تجاوزٌ صوريٌّ يطابق ما طُلب أصلاً فيمتلئ السجلّ بضوضاء.
    expect(dialog).toContain("refundOverride ?? {}");
  });
});
