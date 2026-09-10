import { describe, expect, it } from "vitest";
import {
  applyCustomerIdentity,
  applyGovernorateSelection,
  applyPartySelection,
  buildDeliveryPayload,
  deliveryBlocksOfflineCapture,
  deliveryModeUnavailableReason,
  deliveryReceiptAmounts,
  deliverySendsPayment,
  emptyDeliveryDraft,
  governorateOptions,
  normalizeFee,
  OFFLINE_DELIVERY_BLOCK,
  saleReceiptAmounts,
  toE164Iraq,
  validateDeliveryDraft,
  withRecipientDefaults,
  type DeliveryDraft,
} from "./deliveryMode";
import { GOVERNORATES } from "@shared/governorates";
import { D } from "@/lib/money";

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

  it("سلّةُ توصيلٍ لا تُلتقَط أوفلاين — قاعدةٌ واحدةٌ لحارس الالتقاط وشرط الأهليّة (٥٠٣ · submitSale · quickPay)", () => {
    // بلا توصيل ⇒ لا يُحجَب: البيعُ النقديُّ الصرف يُلتقَط أوفلاين كالمعتاد.
    expect(deliveryBlocksOfflineCapture(null)).toBe(false);
    expect(deliveryBlocksOfflineCapture(undefined)).toBe(false);
    // مسوّدةُ توصيلٍ حاضرة ⇒ يُحجَب مهما بلغ اكتمالها (حتى مسوّدةٌ فارغة = نيّةُ توصيلٍ لم تكتمل بعد).
    expect(deliveryBlocksOfflineCapture(emptyDeliveryDraft())).toBe(true);
    expect(deliveryBlocksOfflineCapture(filled())).toBe(true);

    // مرآةُ شرط أهليّة الالتقاط في POS.tsx (offlineCapturable): التوصيل وحده يُسقط أهليّةَ سلّةٍ
    // نقديّةٍ كاملةٍ لولاه ⇒ لا تُلتقَط بيعاً نقدياً صرفاً بلا إسنادِ جهةٍ ولا تحصيلِ COD.
    const eligibleGivenDelivery = (delivery: DeliveryDraft | null) => !deliveryBlocksOfflineCapture(delivery);
    expect(eligibleGivenDelivery(null)).toBe(true);
    expect(eligibleGivenDelivery(filled())).toBe(false);

    // الرسالةُ تقول ماذا حدث · لماذا · ماذا تفعل الآن (لا رسالةً صمّاء)، ومجمَّدةٌ كمصدرٍ واحد.
    expect(OFFLINE_DELIVERY_BLOCK.title).toContain("توصيل");
    expect(OFFLINE_DELIVERY_BLOCK.body).toMatch(/الخادم|أزِل التوصيل/);
    expect(Object.isFrozen(OFFLINE_DELIVERY_BLOCK)).toBe(true);
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

  it("اختيار الجهة: الأجرة التلقائيّة تتبع الجهة الجديدة، واليدويّة (feeManual) لا تُطمَس", () => {
    const first = applyPartySelection(emptyDeliveryDraft(), parties[0]);
    expect(first.partyId).toBe(3);
    expect(first.partyName).toBe("مندوب الكرادة");
    expect(first.fee).toBe("4000.00");
    // أجرةٌ تلقائيّة (feeManual=false) تُستبدَل بافتراض الجهة الجديدة عند التبديل — لا تعلَق على القديمة.
    const swapped = applyPartySelection(first, parties[1]);
    expect(swapped.partyId).toBe(9);
    expect(swapped.fee).toBe("7500.00");
    // أجرةٌ كتبها الكاشير بيده (feeManual=true) لا تُطمَس عند تبديل الجهة.
    const kept = applyPartySelection(filled({ fee: "2500", feeManual: true }), parties[1]);
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

  it("تقديرُ المحافظة التلقائيّ يُستبدَل عند تغيّرها، واليدويّ لا يُمَسّ", () => {
    const basra = applyGovernorateSelection(emptyDeliveryDraft(), "basra", { suggestedPartyId: null, parties });
    expect(basra.fee).toBe(String(GOVERNORATES.find((g) => g.id === "basra")!.deliveryFee));
    // تغيير المحافظة يُعيد التقدير (لا يتجمّد على القديم) ما دامت الأجرة تلقائيّةً وبلا جهة.
    const baghdad = applyGovernorateSelection(basra, "baghdad", { suggestedPartyId: null, parties });
    expect(baghdad.fee).toBe(String(GOVERNORATES.find((g) => g.id === "baghdad")!.deliveryFee));
    // أجرةٌ يدويّة (feeManual=true) لا يطمسها تغيّرُ المحافظة.
    const manual = applyGovernorateSelection(filled({ partyId: null, fee: "3333", feeManual: true }), "basra", { suggestedPartyId: null, parties });
    expect(manual.fee).toBe("3333");
  });

  it("قرارُ إرسال الدفع في التوصيل: يُحجَب فقط لنقدٍ بلا قبضٍ الآن (COD كامل)، وغيرُ النقد يُرسَل دائماً", () => {
    expect(deliverySendsPayment("CASH", D(0))).toBe(false);
    expect(deliverySendsPayment("CASH", D(5000))).toBe(true);
    // بطاقة/تحويل/محفظة بلا قبضٍ نقديٍّ الآن: دفعٌ كامل مؤكَّد ⇒ يُرسَل (لا يُهمَل قبضٌ وقع).
    expect(deliverySendsPayment("CARD", D(0))).toBe(true);
    expect(deliverySendsPayment("TRANSFER", D(0))).toBe(true);
    expect(deliverySendsPayment("WALLET", D(0))).toBe(true);
  });

  it("مبالغُ إيصال التوصيل: المقبوضُ الآن والفكّة بحسب الطريقة والقبض", () => {
    const amt = (r: ReturnType<typeof deliveryReceiptAmounts>) => ({
      received: r.received.toString(),
      change: r.change.toString(),
    });
    const total = D(10000);
    // نقدٌ بلا قبض ⇒ COD كامل: صفرٌ ولا فكّة.
    expect(amt(deliveryReceiptAmounts({ method: "CASH", paidNow: D(0), total, isCredit: false })))
      .toEqual({ received: "0", change: "0" });
    // نقدٌ جزئيّ (COD جزئيّ): المقبوض = المدفوع، ولا فكّة.
    expect(amt(deliveryReceiptAmounts({ method: "CASH", paidNow: D(4000), total, isCredit: true })))
      .toEqual({ received: "4000", change: "0" });
    // نقدٌ ≥ الإجماليّ: مدفوعٌ كاملاً + فكّةٌ كبيعٍ عاديّ (فائضٌ يُردّ).
    expect(amt(deliveryReceiptAmounts({ method: "CASH", paidNow: D(12000), total, isCredit: false })))
      .toEqual({ received: "10000", change: "2000" });
    // بطاقةٌ بلا قبضٍ نقديٍّ الآن: دفعٌ كامل مؤكَّد ⇒ المقبوض = الإجماليّ ولا فكّة نقديّة.
    expect(amt(deliveryReceiptAmounts({ method: "CARD", paidNow: D(0), total, isCredit: false })))
      .toEqual({ received: "10000", change: "0" });
    // بطاقةٌ جزئيّة + COD: المقبوض = المدفوع ولا فكّة.
    expect(amt(deliveryReceiptAmounts({ method: "CARD", paidNow: D(4000), total, isCredit: true })))
      .toEqual({ received: "4000", change: "0" });
  });

  it("مبالغُ إيصال البيع الموحّدة: التوصيل يشتقّ من deliveryReceiptAmounts بعهدةٍ لا ذمّة (credit=0)، والعاديّ يُبقي الذمّة", () => {
    const amt = (r: ReturnType<typeof saleReceiptAmounts>) => ({
      received: r.received.toString(),
      change: r.change.toString(),
      credit: r.credit.toString(),
    });
    const total = D(10000);
    // توصيل COD كامل نقداً: عهدةٌ على المندوب لا ذمّةٌ على العميل ⇒ credit=0.
    expect(amt(saleReceiptAmounts({ codMode: true, method: "CASH", paidNow: D(0), total, isCredit: false })))
      .toEqual({ received: "0", change: "0", credit: "0" });
    // بيعٌ عاديٌّ آجلٌ جزئيّ: المقبوض = المدفوع، لا فكّة، وذمّةٌ بالباقي.
    expect(amt(saleReceiptAmounts({ codMode: false, method: "CASH", paidNow: D(4000), total, isCredit: true })))
      .toEqual({ received: "4000", change: "0", credit: "6000" });
    // بيعٌ عاديٌّ نقديٌّ كامل بفائض: المقبوض = الإجماليّ، فكّةٌ بالفائض، بلا ذمّة.
    expect(amt(saleReceiptAmounts({ codMode: false, method: "CASH", paidNow: D(12000), total, isCredit: false })))
      .toEqual({ received: "10000", change: "2000", credit: "0" });
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
});
