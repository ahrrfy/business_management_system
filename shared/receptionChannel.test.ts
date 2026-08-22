/**
 * حارس قاموس قناة الوصول (١٩/٨) — على نسق `invoiceStatus`.
 *
 * الثابت المحروس: **قاموسٌ واحد**، و`WALK_IN` **ليست «عميل نقدي»** أبداً. كان ثلاثةٌ من سبعة
 * قواميس محلّية يسمّونها كذلك، فيقرأ الموظّف قناةَ وصولٍ في خانةٍ تصف حالة الدفع.
 */
import { describe, expect, it } from "vitest";
import {
  RECEPTION_CHANNELS,
  isReceptionChannel,
  receptionChannelHandleHint,
  receptionChannelIcon,
  receptionChannelLabel,
  receptionChannelOptions,
} from "./receptionChannel";

describe("قاموس قناة الوصول", () => {
  it("يغطّي كل قيم المخطّط ولا يترك واحدةً بلا اسم", () => {
    // القيم الستّ في `drizzle/schema.ts` + STORE لطلبات المتجر في Inbox.
    for (const v of ["WALK_IN", "WHATSAPP", "INSTAGRAM", "TIKTOK", "PHONE", "OTHER"]) {
      expect(isReceptionChannel(v)).toBe(true);
      expect(receptionChannelLabel(v).length).toBeGreaterThan(1);
    }
    expect(new Set(RECEPTION_CHANNELS).size).toBe(RECEPTION_CHANNELS.length);
  });

  it("⭐ WALK_IN حضورٌ لا «عميل نقدي» — القناة ليست حالة الدفع", () => {
    expect(receptionChannelLabel("WALK_IN")).toBe("حضوري");
    for (const v of RECEPTION_CHANNELS) {
      expect(receptionChannelLabel(v)).not.toContain("نقدي");
    }
  });

  it("الأسماء فريدة — لا اسمان لقناتين ولا قناةٌ باسمين", () => {
    const labels = RECEPTION_CHANNELS.map(receptionChannelLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("NULL ⇒ الافتراضي WALK_IN (مطابق لـ.default في المخطّط)، والغريب يُعرض كما هو", () => {
    expect(receptionChannelLabel(null)).toBe("حضوري");
    expect(receptionChannelLabel(undefined)).toBe("حضوري");
    expect(receptionChannelLabel("XYZ")).toBe("XYZ");
    expect(receptionChannelIcon("XYZ")).toBe("Circle");
  });

  it("الأيقونات أسماء lucide لا إيموجي (حارس check:emoji)", () => {
    for (const v of RECEPTION_CHANNELS) {
      const icon = receptionChannelIcon(v);
      expect(icon).toMatch(/^[A-Z][A-Za-z0-9]*$/);
    }
  });

  it("حقل المعرّف: الحضوريّ بلا حقل، وغيره بتلميحٍ صريح", () => {
    expect(receptionChannelHandleHint("WALK_IN")).toBe("");
    expect(receptionChannelHandleHint("WHATSAPP")).toBe("رقم الواتساب");
  });

  it("الخيارات مرتّبةٌ ترتيباً واحداً، وتقبل حصراً بمجموعةٍ فرعية", () => {
    expect(receptionChannelOptions().map((o) => o.value)).toEqual([...RECEPTION_CHANNELS]);
    expect(receptionChannelOptions(["PHONE", "WALK_IN"]).map((o) => o.label)).toEqual(["هاتف", "حضوري"]);
  });
});
