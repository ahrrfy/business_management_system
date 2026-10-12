// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildOnlineOrderFollowupMessage,
  toIraqiIntl,
} from "../whatsapp";
import {
  AUDIO_FEEDBACK_STORAGE_KEY,
  isAudioFeedbackEnabled,
  playAudioFeedback,
  setAudioFeedbackEnabled,
} from "../audioFeedback";

// مساعد فحص خلو النص تماماً من أي إيموجي (سواء في نطاق BMP أو Astral Plane أو محددات العرض)
const ASTRAL_EMOJI_REGEX = /[\uD800-\uDBFF][\uDC00-\uDFFF]/;
const EXTENDED_PICTOGRAPHIC_REGEX = /\p{Extended_Pictographic}/u;
const BMP_SYMBOLS_REGEX =
  /[\u2300-\u23FF\u2600-\u27BF\u2B00-\u2BFF\u2122\u2139\u24C2\u203C\u2049\u00A9\u00AE\u3030\u303D\u3297\u3299\uFE00-\uFE0F\u200D\u20E3]/;

function assertZeroEmojis(message: string): void {
  expect(ASTRAL_EMOJI_REGEX.test(message)).toBe(false);
  expect(EXTENDED_PICTOGRAPHIC_REGEX.test(message)).toBe(false);
  expect(BMP_SYMBOLS_REGEX.test(message)).toBe(false);
}

describe("whatsappStoreOrder — متابعة طلبات المتجر وتطبيع الهواتف", () => {
  describe("buildOnlineOrderFollowupMessage", () => {
    it("يصيغ رسالة تأكيد الطلب لحالتي CONFIRMED و PROCESSING بنص واضح ودون أي إيموجي", () => {
      const msgConfirmed = buildOnlineOrderFollowupMessage({
        orderNumber: "SO-101",
        customerName: "حيدر الكرخي",
        total: 35000,
        status: "CONFIRMED",
      });

      expect(msgConfirmed).toContain("*بخصوص طلبك #SO-101*");
      expect(msgConfirmed).toContain("المكتبة العربية للطباعة والقرطاسية");
      expect(msgConfirmed).toContain("مرحباً حيدر الكرخي،");
      expect(msgConfirmed).toContain("لتأكيد طلبك وإتمام التوصيل، يرجى الردّ على هذه الرسالة.");
      expect(msgConfirmed).toContain("الإجمالي (الدفع عند الاستلام): 35,000 د.ع.");
      expect(msgConfirmed).toContain("للاستفسار تواصلوا معنا.");
      assertZeroEmojis(msgConfirmed);

      const msgProcessing = buildOnlineOrderFollowupMessage({
        orderNumber: "SO-102",
        customerName: "سارة الزيدي",
        total: "12500",
        status: "PROCESSING",
      });

      expect(msgProcessing).toContain("لتأكيد طلبك وإتمام التوصيل، يرجى الردّ على هذه الرسالة.");
      expect(msgProcessing).toContain("12,500 د.ع.");
      assertZeroEmojis(msgProcessing);
    });

    it("يصيغ رسالة الشحن مع المندوب لحالة SHIPPED", () => {
      const msgShipped = buildOnlineOrderFollowupMessage({
        orderNumber: "SO-201",
        customerName: "علي الرافدين",
        total: 50000,
        status: "SHIPPED",
      });

      expect(msgShipped).toContain("*بخصوص طلبك #SO-201*");
      expect(msgShipped).toContain("طلبك الآن *مع المندوب* في طريقه إليك.");
      expect(msgShipped).toContain("50,000 د.ع.");
      assertZeroEmojis(msgShipped);
    });

    it("يصيغ رسالة الإلغاء لحالة CANCELLED", () => {
      const msgCancelled = buildOnlineOrderFollowupMessage({
        orderNumber: "SO-301",
        customerName: "سيف عباس",
        total: 20000,
        status: "CANCELLED",
      });

      expect(msgCancelled).toContain("*بخصوص طلبك #SO-301*");
      expect(msgCancelled).toContain("نأسف، تمّ *إلغاء* طلبك. لمزيد من التفاصيل تواصل معنا.");
      assertZeroEmojis(msgCancelled);
    });

    it("يصيغ رسالة التسليم لحالة DELIVERED", () => {
      const msgDelivered = buildOnlineOrderFollowupMessage({
        orderNumber: "SO-401",
        customerName: "نور الهدى",
        total: 45000,
        status: "DELIVERED",
      });

      expect(msgDelivered).toContain("*بخصوص طلبك #SO-401*");
      expect(msgDelivered).toContain("تمّ *تسليم* طلبك بنجاح. شكراً لتعاملك معنا.");
      assertZeroEmojis(msgDelivered);
    });

    it("يتعامل بنجاح مع عدم وجود اسم عميل", () => {
      const msgAnonymous = buildOnlineOrderFollowupMessage({
        orderNumber: "SO-501",
        customerName: null,
        total: 15000,
        status: "CONFIRMED",
      });

      expect(msgAnonymous).toContain("*بخصوص طلبك #SO-501*");
      expect(msgAnonymous).not.toContain("مرحباً");
      expect(msgAnonymous).toContain("15,000 د.ع.");
      assertZeroEmojis(msgAnonymous);
    });
  });

  describe("toIraqiIntl — تطبيع أرقام الهواتف", () => {
    it("يطبّع الأرقام العراقية المحلية البادئة بـ 07 إلى صيغة +964", () => {
      expect(toIraqiIntl("07701234567")).toBe("+9647701234567");
      expect(toIraqiIntl("07801234567")).toBe("+9647801234567");
      expect(toIraqiIntl("07501234567")).toBe("+9647501234567");
      expect(toIraqiIntl("07901234567")).toBe("+9647901234567");
    });

    it("يتعامل مع الفواصل والمسافات والرموز غير الرقمية", () => {
      expect(toIraqiIntl("0770 123 4567")).toBe("+9647701234567");
      expect(toIraqiIntl("0780-123-4567")).toBe("+9647801234567");
      expect(toIraqiIntl(" (0750) 123 4567 ")).toBe("+9647501234567");
    });

    it("يطبّع الأرقام المكتوبة بدون الصفر المبتدئ (10 خانات تبدأ بـ 7)", () => {
      expect(toIraqiIntl("7701234567")).toBe("+9647701234567");
      expect(toIraqiIntl("7801234567")).toBe("+9647801234567");
    });

    it("يتعامل مع بادئة الاتصال الدولي 00 وبادئة 964 الصريحة", () => {
      expect(toIraqiIntl("009647701234567")).toBe("+9647701234567");
      expect(toIraqiIntl("9647701234567")).toBe("+9647701234567");
      expect(toIraqiIntl("+9647701234567")).toBe("+9647701234567");
      // أرقام دولية أخرى ببادئة 00 أو +
      expect(toIraqiIntl("00966501234567")).toBe("+966501234567");
      expect(toIraqiIntl("+971501234567")).toBe("+971501234567");
    });

    it("يرجع null للمدخلات غير الصالحة أو الفارغة", () => {
      expect(toIraqiIntl(null)).toBeNull();
      expect(toIraqiIntl(undefined)).toBeNull();
      expect(toIraqiIntl("")).toBeNull();
      expect(toIraqiIntl("   ")).toBeNull();
      expect(toIraqiIntl("12345")).toBeNull();
    });
  });
});

describe("Web Audio Tone Synthesis (audioFeedback.ts)", () => {
  type ScheduledToneRecord = {
    frequency: number;
    startsAt: number;
    waveform: OscillatorType;
    gain: number;
  };

  const createdOscillators: Array<{
    type: OscillatorType;
    frequencyValue: number;
    startsAt: number;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    listeners: Record<string, () => void>;
    triggerEnded: () => void;
  }> = [];

  const createdGains: Array<{
    gainPeak: number;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }> = [];

  const contextInstances: FakeAudioContext[] = [];

  class FakeAudioParam {
    current = 0;
    setValueAtTime = vi.fn((val: number) => {
      this.current = val;
    });
    exponentialRampToValueAtTime = vi.fn((val: number) => {
      this.current = val;
    });
  }

  class FakeAudioContext {
    state: AudioContextState = "running";
    currentTime = 0;
    destination = { id: "audio-dest" };
    resume = vi.fn(async () => {});

    constructor() {
      contextInstances.push(this);
    }

    createOscillator() {
      const freqParam = new FakeAudioParam();
      const listeners: Record<string, () => void> = {};
      const osc = {
        type: "sine" as OscillatorType,
        frequency: freqParam,
        get frequencyValue() {
          return freqParam.current;
        },
        startsAt: 0,
        start: vi.fn((time: number) => {
          osc.startsAt = time;
        }),
        stop: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
        listeners,
        addEventListener: vi.fn((evt: string, cb: () => void) => {
          listeners[evt] = cb;
        }),
        triggerEnded: () => {
          listeners["ended"]?.();
        },
      };
      createdOscillators.push(osc);
      return osc;
    }

    createGain() {
      const gainParam = new FakeAudioParam();
      const gn = {
        gain: gainParam,
        get gainPeak() {
          return gainParam.current;
        },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      createdGains.push(gn);
      return gn;
    }
  }

  beforeEach(() => {
    // إغلاق السياقات السابقة لإعادة تعيين كائن الـ singleton في audioFeedback.ts
    contextInstances.forEach((ctx) => {
      ctx.state = "closed";
    });
    contextInstances.length = 0;
    createdOscillators.length = 0;
    createdGains.length = 0;
    setAudioFeedbackEnabled(true, null);
    localStorage.clear();
    vi.restoreAllMocks();

    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: FakeAudioContext,
    });
  });

  it("يولّد نغمة order_alert بنمط Doorbell ثلاثي المراحل بترددات 587.33Hz و 880Hz و 1174.66Hz", () => {
    vi.spyOn(performance, "now").mockReturnValue(10000);

    const played = playAudioFeedback("order_alert");
    expect(played).toBe(true);

    // التحقق من إنشاء 3 نغمات متسلسلة لنغمة جرس الباب للطلبات
    expect(createdOscillators.length).toBe(3);
    expect(createdGains.length).toBe(3);

    const freqs = createdOscillators.map((o) => o.frequency.setValueAtTime.mock.calls[0]?.[0]);
    expect(freqs).toEqual([587.33, 880, 1174.66]);

    // التأكد من شكل الموجة الجيبية (sine)
    createdOscillators.forEach((osc) => {
      expect(osc.type).toBe("sine");
      expect(osc.connect).toHaveBeenCalled();
      expect(osc.start).toHaveBeenCalled();
      expect(osc.stop).toHaveBeenCalled();
    });
  });

  it("يحترم مهلة التهدئة (Debounce) لـ order_alert المحددة بـ 1000ms", () => {
    const timeSpy = vi.spyOn(performance, "now");

    // النداء الأول عند النقطة الزمنية 20000ms: ينجح
    timeSpy.mockReturnValue(20000);
    expect(playAudioFeedback("order_alert")).toBe(true);
    expect(createdOscillators.length).toBe(3);

    // النداء الثاني بعد 400ms (20400ms): يُكبح لعدم مرور 1000ms
    timeSpy.mockReturnValue(20400);
    expect(playAudioFeedback("order_alert")).toBe(false);
    expect(createdOscillators.length).toBe(3); // لا يتم إنشاء نغمات جديدة

    // النداء الثالث عند 20999ms (قبل تمام الثانية): يُكبح
    timeSpy.mockReturnValue(20999);
    expect(playAudioFeedback("order_alert")).toBe(false);
    expect(createdOscillators.length).toBe(3);

    // النداء الرابع عند 21001ms (بعد مرور أكثر من 1000ms): ينجح
    timeSpy.mockReturnValue(21001);
    expect(playAudioFeedback("order_alert")).toBe(true);
    expect(createdOscillators.length).toBe(6); // أُضيفت 3 نغمات جديدة
  });

  it("يعيد استخدام نفس كائن AudioContext (Singleton) ولا ينشئ كائنات جديدة إلا عند الإغلاق", () => {
    const timeSpy = vi.spyOn(performance, "now");

    timeSpy.mockReturnValue(30000);
    const initialCount = contextInstances.length;

    expect(playAudioFeedback("order_alert")).toBe(true);
    expect(contextInstances.length).toBe(initialCount + 1);
    const firstInstance = contextInstances[contextInstances.length - 1];

    timeSpy.mockReturnValue(32000);
    expect(playAudioFeedback("order_alert")).toBe(true);
    // يجب ألا يتغير عدد السياقات لأن الـ singleton قيد العمل
    expect(contextInstances.length).toBe(initialCount + 1);
    expect(contextInstances[contextInstances.length - 1]).toBe(firstInstance);

    // إذا أُغلق سياق الصوت (closed):
    firstInstance.state = "closed";

    timeSpy.mockReturnValue(35000);
    expect(playAudioFeedback("order_alert")).toBe(true);
    expect(contextInstances.length).toBe(initialCount + 2);
  });

  it("يفصل العقد الصوتية (Oscillator و Gain) عند انتهاء النغمة عبر حدث ended", () => {
    vi.spyOn(performance, "now").mockReturnValue(40000);

    expect(playAudioFeedback("order_alert")).toBe(true);
    expect(createdOscillators.length).toBe(3);

    const firstOsc = createdOscillators[0];
    const firstGain = createdGains[0];

    expect(firstOsc.disconnect).not.toHaveBeenCalled();
    expect(firstGain.disconnect).not.toHaveBeenCalled();

    // تشغيل حدث انتهاء النغمة
    firstOsc.triggerEnded();

    expect(firstOsc.disconnect).toHaveBeenCalledOnce();
    expect(firstGain.disconnect).toHaveBeenCalledOnce();
  });
});
