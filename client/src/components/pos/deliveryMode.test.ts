import { describe, expect, it } from "vitest";
import {
  applyCustomerIdentity,
  applyGovernorateSelection,
  applyZoneSuggestion,
  applyPartySelection,
  buildDeliveryPayload,
  deliveryModeUnavailableReason,
  deliveryReceiptAmounts,
  deliverySendsPayment,
  emptyDeliveryDraft,
  governorateOptions,
  normalizeFee,
  saleReceiptAmounts,
  toE164Iraq,
  validateDeliveryDraft,
  withRecipientDefaults,
  type DeliveryDraft,
} from "./deliveryMode";
import { GOVERNORATES } from "@shared/governorates";
import Decimal from "decimal.js";

const parties = [
  { id: 3, name: "مندوب الكرادة", defaultFee: "4000.00" },
  { id: 9, name: "شركة النقل السريع", defaultFee: "7500.00" },
];

const filled = (over: Partial<DeliveryDraft> = {}): DeliveryDraft => ({
  ...emptyDeliveryDraft(),
  governorate: "baghdad",
  address: "الكرادة — شارع ٦٢",
  partyId: 3,
  partyName: "مندوب الكرادة",
  fee: "4000",
  recipientName: "سارة",
  recipientPhone: "07701234567",
  ...over,
});

describe("وضع «توصيل» في الكاشير — المنطق النقيّ", () => {
  it("الأوفلاين يُعطّل الوضع بسببٍ ظاهر — لا إسناد بلا حرّاس حيّة", () => {
    expect(deliveryModeUnavailableReason(false)).toBeNull();
    expect(deliveryModeUnavailableReason(true)).toBe("التوصيل يحتاج اتصالاً بالخادم — لا إسناد بلا حرّاس حيّة");
  });

  it("الحمولة الخادميّة تُبنى من مسوّدةٍ مكتملة بأجرةٍ مطبَّعة ومحافظةٍ ومستلم", () => {
    expect(buildDeliveryPayload(filled())).toEqual({
      partyId: 3,
      fee: "4000.00",
      feeCollection: "COURIER",
      recipientName: "سارة",
      recipientPhone: "07701234567",
      address: "الكرادة — شارع ٦٢",
      governorate: "baghdad",
    });
    // المستلم اختياريّ — يُسقَط من الحمولة إن فرغ (الخادم يعود إلى بيانات العميل).
    const noRecipient = buildDeliveryPayload(filled({ recipientName: " ", recipientPhone: "" }));
    expect(noRecipient).not.toHaveProperty("recipientName");
    expect(noRecipient).not.toHaveProperty("recipientPhone");
    // بلا محافظة ⇒ لا مفتاح governorate.
    expect(buildDeliveryPayload(filled({ governorate: "" }))).not.toHaveProperty("governorate");
  });

  it("المسوّدة الناقصة تُرفض بأسبابٍ مسمّاة لا بصمت", () => {
    expect(validateDeliveryDraft(emptyDeliveryDraft())).toEqual(["NO_PARTY", "NO_ADDRESS"]);
    expect(buildDeliveryPayload(emptyDeliveryDraft())).toBeNull();
    expect(validateDeliveryDraft(filled({ fee: "abc" }))).toEqual(["BAD_FEE"]);
    // «مقبوضة في الاستقبال» بأجرةٍ صفر = أمانةٌ بلا مال ⇒ مرفوضة (مرآة OrderDeliveryDialog).
    expect(validateDeliveryDraft(filled({ feeCollection: "COUNTER", fee: "0" }))).toEqual(["COUNTER_FEE_REQUIRED"]);
    expect(validateDeliveryDraft(filled({ feeCollection: "COUNTER", fee: "" }))).toEqual(["COUNTER_FEE_REQUIRED"]);
    expect(validateDeliveryDraft(filled({ feeCollection: "SHOP", fee: "" }))).toEqual([]);
  });

  it("تطبيع الأجرة: فارغ ⇒ 0.00، منزلتان، ورفض غير الرقميّ والسالب", () => {
    expect(normalizeFee("")).toBe("0.00");
    expect(normalizeFee("4000")).toBe("4000.00");
    expect(normalizeFee("4000.5")).toBe("4000.50");
    expect(normalizeFee("4,000")).toBeNull();
    expect(normalizeFee("-5")).toBeNull();
  });

  it("اختيار الجهة يملأ الأجرة من defaultFee فقط حين تكون فارغة — ما كتبه الكاشير لا يُطمس", () => {
    const d = applyPartySelection(emptyDeliveryDraft(), parties[0]);
    expect(d.partyId).toBe(3);
    expect(d.partyName).toBe("مندوب الكرادة");
    expect(d.fee).toBe("4000.00");
    const kept = applyPartySelection(filled({ fee: "2500" }), parties[1]);
    expect(kept.partyId).toBe(9);
    expect(kept.partyName).toBe("شركة النقل السريع");
    expect(kept.fee).toBe("2500");
    const cleared = applyPartySelection(filled(), null);
    expect(cleared.partyId).toBeNull();
    expect(cleared.partyName).toBe("");
  });

  it("اختيار المحافظة يقترح الجهة تلقائياً (المستخدم يعدّل لا يبتدئ) ويقدّر الأجرة عند غياب الاقتراح", () => {
    const suggested = applyGovernorateSelection(emptyDeliveryDraft(), "baghdad", { suggestedPartyId: 9, parties });
    expect(suggested.governorate).toBe("baghdad");
    expect(suggested.partyId).toBe(9);
    expect(suggested.fee).toBe("7500.00");

    // جهةٌ مختارة يدوياً لا يطمسها الاقتراح.
    const manual = applyGovernorateSelection(filled({ partyId: 3, fee: "4000" }), "basra", { suggestedPartyId: 9, parties });
    expect(manual.partyId).toBe(3);
    expect(manual.fee).toBe("4000");

    // بلا اقتراحٍ ولا أجرة ⇒ تقدير المصدر المشترك.
    const estimate = applyGovernorateSelection(emptyDeliveryDraft(), "basra", { suggestedPartyId: null, parties });
    expect(estimate.partyId).toBeNull();
    expect(estimate.fee).toBe(String(GOVERNORATES.find((g) => g.id === "basra")!.deliveryFee));
  });

  it("قائمة المحافظات من المصدر المشترك حرفياً — لا قاموس محلّيّ", () => {
    const options = governorateOptions();
    expect(options).toHaveLength(GOVERNORATES.length);
    expect(options[0]).toEqual({ value: GOVERNORATES[0].id, label: GOVERNORATES[0].name });
  });

  it("الهاتف المحلّي يتحوّل إلى E.164 (صيغة IntlPhoneInput والخادم)، والدوليّ يبقى", () => {
    expect(toE164Iraq("07701234567")).toBe("+9647701234567");
    expect(toE164Iraq("9647701234567")).toBe("+9647701234567");
    expect(toE164Iraq("+9647701234567")).toBe("+9647701234567");
    expect(toE164Iraq("")).toBe("");
    expect(toE164Iraq("0770")).toBe("0770");
  });

  it("هويّة العميل بالهاتف: تُحفظ للاستئناف، وتبدّلُ العميل يستبدل المستلم، وثباتُه يملأ الفارغ فقط", () => {
    // أثناء الكتابة (بلا عميل بعد): الهاتف يُحفظ فقط.
    const typing = applyCustomerIdentity(emptyDeliveryDraft(), { customerId: null, name: "", phone: "0770" }, null);
    expect(typing.customerPhone).toBe("0770");
    expect(typing.recipientName).toBe("");

    // أوّل ربط: يملأ المستلم الفارغ.
    const linked = applyCustomerIdentity(typing, { customerId: 5, name: "سارة", phone: "07701234567" }, null);
    expect(linked.recipientName).toBe("سارة");
    expect(linked.recipientPhone).toBe("+9647701234567");

    // نفس العميل + مستلمٌ كتبه الكاشير ⇒ لا يُطمس.
    const edited = { ...linked, recipientName: "أخوها" };
    expect(applyCustomerIdentity(edited, { customerId: 5, name: "سارة", phone: "07701234567" }, 5).recipientName).toBe("أخوها");

    // عميلٌ آخر ⇒ المستلم يُستبدل بالجديد (السابق كان لعميلٍ غيره).
    const switched = applyCustomerIdentity(edited, { customerId: 9, name: "أحمد", phone: "07809999999" }, 5);
    expect(switched.recipientName).toBe("أحمد");
    expect(switched.recipientPhone).toBe("+9647809999999");
    expect(switched.customerPhone).toBe("07809999999");
  });

  it("المستلم يُملأ من العميل المربوط ما لم يكتبه الكاشير", () => {
    const d = withRecipientDefaults(emptyDeliveryDraft(), { name: "أحمد", phone: "07701234567" });
    expect(d.recipientName).toBe("أحمد");
    expect(d.recipientPhone).toBe("+9647701234567");
    const kept = withRecipientDefaults(filled({ recipientName: "الجار", recipientPhone: "07809999999" }), { name: "أحمد", phone: "07701234567" });
    expect(kept.recipientName).toBe("الجار");
    expect(kept.recipientPhone).toBe("07809999999");
  });

  it("اقتراح الخادم للمنطقة: يختار الجهة حين لا جهة، ويستبدل تقدير الأجرة الثابت لا ما كتبه الكاشير", () => {
    const base = { ...emptyDeliveryDraft(), governorate: "baghdad" };
    const s = { partyId: 7, partyName: "مندوب الكرادة", fee: "2500.00" };
    // لا جهة ولا أجرة ⇒ الاثنتان من الاقتراح.
    const fresh = applyZoneSuggestion(base, s);
    expect(fresh.partyId).toBe(7);
    expect(fresh.partyName).toBe("مندوب الكرادة");
    expect(fresh.fee).toBe("2500.00");
    // تقدير المحافظة الثابت (وضعه applyGovernorateSelection) ليس من يد الكاشير ⇒ يُستبدل بأجرة المنطقة.
    const estimated = applyGovernorateSelection(emptyDeliveryDraft(), "baghdad", { suggestedPartyId: null, parties: [] });
    expect(applyZoneSuggestion(estimated, s).fee).toBe("2500.00");
    // أجرةٌ كتبها الكاشير وجهةٌ اختارها ⇒ لا تُطمس، والكائن يُعاد كما هو.
    const typed = { ...base, partyId: 3, partyName: "شركة", fee: "1750" };
    expect(applyZoneSuggestion(typed, s)).toBe(typed);
    // بلا اقتراحٍ أو بلا محافظة ⇒ لا تغيير.
    expect(applyZoneSuggestion(base, null)).toBe(base);
    expect(applyZoneSuggestion(emptyDeliveryDraft(), s)).toEqual(emptyDeliveryDraft());
  });

  const D = (n: number | string) => new Decimal(n);

  it("قرارُ إرسال الدفع في التوصيل: يُحجَب فقط للنقد بلا قبضٍ الآن؛ غيرُ النقد يُرسَل دائماً (Codex #1012 P1)", () => {
    expect(deliverySendsPayment("CASH", D(0))).toBe(false);   // COD كامل: لا دفع
    expect(deliverySendsPayment("CASH", D(2500))).toBe(true);  // قبضٌ جزئيّ نقديّ
    expect(deliverySendsPayment("CARD", D(0))).toBe(true);     // بطاقةٌ مؤكَّدة سلفاً ⇒ تُرسَل ولو كان الحقل صفراً
    expect(deliverySendsPayment("TRANSFER", D(0))).toBe(true);
  });

  it("مبالغُ إيصال التوصيل: الفكّةُ تُحفَظ عند دفعٍ نقديٍّ زائد ولا آجلَ على العميل (Codex #1012 P2)", () => {
    // COD كامل: لا مقبوض، لا فكّة.
    expect(deliveryReceiptAmounts({ method: "CASH", paidNow: D(0), total: D(10000), isCredit: false }))
      .toEqual({ received: D(0), change: D(0) });
    // دفعٌ نقديٌّ زائد (12000 على 10000): المقبوض الإجماليّ والفكّة 2000 — لا تُبتلَع.
    expect(deliveryReceiptAmounts({ method: "CASH", paidNow: D(12000), total: D(10000), isCredit: false }))
      .toEqual({ received: D(10000), change: D(2000) });
    // بطاقةٌ كاملة: المقبوض الإجماليّ بلا فكّة.
    expect(deliveryReceiptAmounts({ method: "CARD", paidNow: D(0), total: D(10000), isCredit: false }))
      .toEqual({ received: D(10000), change: D(0) });
  });

  it("مبالغُ إيصال البيع: عهدةُ COD ليست ذمّةً على العميل (credit=0)، والبيعُ العاديّ الآجلُ يُظهر الباقي ذمّةً", () => {
    expect(saleReceiptAmounts({ codMode: true, method: "CASH", paidNow: D(0), total: D(10000), isCredit: false }))
      .toEqual({ received: D(0), change: D(0), credit: D(0) });
    expect(saleReceiptAmounts({ codMode: true, method: "CASH", paidNow: D(12000), total: D(10000), isCredit: false }).change).toEqual(D(2000));
    // بيعٌ عاديٌّ آجلٌ جزئيّ: مدفوعٌ 4000 من 10000 ⇒ المقبوض 4000، لا فكّة، وذمّةٌ 6000.
    expect(saleReceiptAmounts({ codMode: false, method: "CASH", paidNow: D(4000), total: D(10000), isCredit: true }))
      .toEqual({ received: D(4000), change: D(0), credit: D(6000) });
  });
});
