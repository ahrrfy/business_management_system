import { describe, it, expect } from "vitest";
import {
  AUTOMATION_REGISTRY,
  AUTOMATION_ENTITIES,
  ENTITY_STATUSES,
  MIN_JUSTIFICATION_LENGTH,
  STATES_WITHOUT_TRANSITIONS,
  type AutomationMode,
  type TransitionKey,
  automationOf,
  autoTransitionsWithoutEvidence,
  manualTransitionsWithoutJustification,
  parseTransitionKey,
  statesWithoutCoverage,
} from "./automationRegistry";
import { WO_NEXT_STATUS, WORK_ORDER_STATUSES } from "./workOrderStatus";
import { DEAD_INVOICE_STATUSES, INVOICE_STATUSES } from "./invoiceStatus";

const entries = Object.entries(AUTOMATION_REGISTRY) as [TransitionKey, AutomationMode][];

describe("automationRegistry — الحالاتُ تُقرأ من القواميس ولا تُخترَع", () => {
  it("كلُّ مفتاحٍ على شكل «كيان:من->إلى» وطرفاه من قاموس الكيان", () => {
    expect(entries.length).toBeGreaterThan(0);
    for (const [key] of entries) {
      const parsed = parseTransitionKey(key);
      expect(parsed, `مفتاحٌ لا يُفكَّك: ${key}`).not.toBeNull();
      const { entity, from, to } = parsed!;
      expect(AUTOMATION_ENTITIES as readonly string[], `كيانٌ غير مُغطّى: ${key}`).toContain(
        entity,
      );
      const known = ENTITY_STATUSES[entity as (typeof AUTOMATION_ENTITIES)[number]];
      expect(known, `«${from}» ليست في قاموس ${entity} (${key})`).toContain(from);
      expect(known, `«${to}» ليست في قاموس ${entity} (${key})`).toContain(to);
    }
  });

  it("لا انتقالَ إلى الحالة نفسها — الطرفان المتطابقان ليسا انتقالاً", () => {
    for (const [key] of entries) {
      const { from, to } = parseTransitionKey(key)!;
      expect(from, `طرفان متطابقان: ${key}`).not.toBe(to);
    }
  });

  it("قاموسا الحالة هما المصدر — لا نسخةَ محلّيةَ منهما هنا", () => {
    expect(ENTITY_STATUSES.workOrder).toBe(WORK_ORDER_STATUSES);
    expect(ENTITY_STATUSES.invoice).toBe(INVOICE_STATUSES);
  });
});

describe("automationRegistry — عقدُ الطبيعة: دليلٌ مُسمّى أو مبرّرٌ بشريّ", () => {
  it("لا مفتاحَ يدويٌّ بلا مبرّرٍ كافٍ", () => {
    expect(manualTransitionsWithoutJustification()).toEqual([]);
  });

  it("لا مفتاحَ آليٌّ بلا دليلٍ كافٍ", () => {
    expect(autoTransitionsWithoutEvidence()).toEqual([]);
  });

  it("⭐ كلُّ `evidence` يُسمّي مصدراً (رمزٌ بين علامتَي اقتباسٍ مائلة أو ملفُّ خدمة) لا «واضح»", () => {
    const NAMES_A_SOURCE = /`[^`]+`|\.ts\b/;
    for (const [key, mode] of entries) {
      if (mode.kind !== "AUTO") continue;
      expect(NAMES_A_SOURCE.test(mode.evidence), `دليلٌ مبهمٌ بلا مصدرٍ مُسمّى: ${key}`).toBe(true);
    }
  });

  it("⛔ لا مبرّرَ مكرَّرٌ ولا دليلَ مكرَّر — النسخُ واللصقُ صورةٌ من «يدويّ لأنّه يدويّ»", () => {
    const texts = entries.map(([, m]) => (m.kind === "AUTO" ? m.evidence : m.because).trim());
    expect(new Set(texts).size, "نصٌّ مكرَّرٌ بين مدخلَين").toBe(texts.length);
  });

  it("النوعُ والحقلُ لا يختلطان: AUTO يحمل evidence وحده، وMANUAL يحمل because وحده", () => {
    for (const [key, mode] of entries) {
      if (mode.kind === "AUTO") {
        expect("because" in mode, `AUTO يحمل because: ${key}`).toBe(false);
      } else {
        expect("evidence" in mode, `MANUAL يحمل evidence: ${key}`).toBe(false);
      }
    }
  });

  it("الحدُّ الأدنى مقياسُ وجودٍ لا جودة — وقيمتُه ٢٠ محرفاً", () => {
    expect(MIN_JUSTIFICATION_LENGTH).toBe(20);
  });
});

describe("automationRegistry — التغطية مقابل القواميس", () => {
  it("كلُّ انتقالٍ أماميٍّ في WO_NEXT_STATUS مُسجَّل", () => {
    for (const [from, to] of Object.entries(WO_NEXT_STATUS)) {
      const key = `workOrder:${from}->${to}` as TransitionKey;
      expect(automationOf(key), `انتقالٌ مُصرَّحٌ به بلا مدخل: ${key}`).toBeDefined();
    }
  });

  it("كلُّ حالةٍ نهائيّةٍ في DEAD_INVOICE_STATUSES يبلغها انتقالٌ مُسجَّل", () => {
    for (const dead of DEAD_INVOICE_STATUSES) {
      const reached = entries.some(([key]) => {
        const p = parseTransitionKey(key)!;
        return p.entity === "invoice" && p.to === dead;
      });
      expect(reached, `حالةٌ نهائيّة لا يبلغها انتقال: invoice:${dead}`).toBe(true);
    }
  });

  it("لا حالةَ في قاموسٍ بلا تغطيةٍ ولا تبرير", () => {
    expect(statesWithoutCoverage()).toEqual([]);
  });

  it("كلُّ تبريرِ غيابٍ يحمل نصّاً كافياً كتبرير MANUAL", () => {
    for (const [id, text] of Object.entries(STATES_WITHOUT_TRANSITIONS)) {
      expect(text, `تبريرُ غيابٍ فارغ: ${id}`).toBeTruthy();
      expect(
        (text as string).trim().length,
        `تبريرُ غيابٍ أقصرُ من الحدّ: ${id}`,
      ).toBeGreaterThanOrEqual(MIN_JUSTIFICATION_LENGTH);
    }
  });
});

describe("automationRegistry — سلوكُ القراءة", () => {
  it("automationOf يُرجع الطبيعةَ المُسجَّلة", () => {
    const auto = automationOf("workOrder:READY->IN_PROGRESS");
    expect(auto?.kind).toBe("AUTO");
    const manual = automationOf("workOrder:READY->DELIVERED");
    expect(manual?.kind).toBe("MANUAL");
  });

  it("⭐ الغيابُ يعني «لم يُسأل بعد» لا «يدويّ بقرار» ⇒ undefined لا سقوطٌ إلى MANUAL", () => {
    expect(automationOf("purchase:DRAFT->SENT")).toBeUndefined();
    expect(automationOf("workOrder:CANCELLED->RECEIVED")).toBeUndefined();
  });

  it("parseTransitionKey يرفض ما ليس مفتاحاً", () => {
    expect(parseTransitionKey("workOrder:READY")).toBeNull();
    expect(parseTransitionKey("READY->DELIVERED")).toBeNull();
    expect(parseTransitionKey("")).toBeNull();
    expect(parseTransitionKey("workOrder:READY->DELIVERED")).toEqual({
      entity: "workOrder",
      from: "READY",
      to: "DELIVERED",
    });
  });

  it("محورُ المال في الفاتورة آليٌّ بالكامل — لا زرَّ «حدّث الحالة»", () => {
    const money = ["PENDING", "PARTIALLY_PAID", "PAID"];
    for (const [key, mode] of entries) {
      const p = parseTransitionKey(key)!;
      if (p.entity !== "invoice") continue;
      if (!money.includes(p.from) || !money.includes(p.to)) continue;
      expect(mode.kind, `انتقالٌ ماليٌّ مشتقٌّ سُجّل يدوياً: ${key}`).toBe("AUTO");
    }
  });
});
