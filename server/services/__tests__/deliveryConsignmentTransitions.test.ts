/**
 * م١ (PR-4) — **جدولُ انتقالات إغلاق الإرسالية** (`CONSIGNMENT_STATUS_TRANSITIONS`) ≡ **سجلّ الأتمتة**.
 *
 * ما تحرسه:
 *  ① كلُّ انتقالٍ يصرّح به الجدول (من ≠ إلى) له مدخلٌ في `AUTOMATION_REGISTRY` — لا انتقالَ حقيقيّ
 *     بلا تصريح AUTO/MANUAL.
 *  ② كلُّ مفتاح `deliveryConsignment:*` في السجلّ يقع في الجدول — لا أتمتةَ وهميّة لانتقالٍ لا تنفّذه الشيفرة.
 *  ③ `assertConsignmentStatusTransition`: يمرّر المشروع، ويرفض غيره برسالةٍ تسمّي الطرفين، ويعدّ
 *     الانتقالَ إلى الحالة نفسها لا انتقالاً (توريدٌ ناقصٌ ثانٍ PARTIAL → PARTIAL).
 *  ④ الجدولُ يغطّي القاموس كلَّه (`DELIVERY_CONSIGNMENT_STATUSES`) — حالةٌ جديدة في المخطّط تكسر
 *     الاختبار لا الشاشة.
 */
import { describe, expect, it } from "vitest";
import { AUTOMATION_REGISTRY, parseTransitionKey } from "@shared/automationRegistry";
import { DELIVERY_CONSIGNMENT_STATUSES } from "@shared/deliveryStatuses";
import {
  CONSIGNMENT_STATUS_TRANSITIONS,
  assertConsignmentStatusTransition,
  type ConsignmentStatus,
} from "../delivery/lifecycle";

const tablePairs = new Set<string>();
for (const from of DELIVERY_CONSIGNMENT_STATUSES) {
  for (const to of CONSIGNMENT_STATUS_TRANSITIONS[from]) tablePairs.add(`${from}->${to}`);
}
const registryPairs = new Set(
  Object.keys(AUTOMATION_REGISTRY)
    .map((k) => parseTransitionKey(k))
    .filter((p): p is NonNullable<typeof p> => p != null && p.entity === "deliveryConsignment")
    .map((p) => `${p.from}->${p.to}`),
);

describe("CONSIGNMENT_STATUS_TRANSITIONS ≡ automationRegistry (deliveryConsignment)", () => {
  it("① كلُّ انتقالٍ في الجدول مُصرَّحٌ به في السجلّ", () => {
    const missing = Array.from(tablePairs).filter((p) => !registryPairs.has(p));
    expect(missing, `انتقالاتٌ يصرّح بها الجدول بلا مدخلٍ في السجلّ: ${missing.join(", ")}`).toEqual([]);
  });

  it("② كلُّ مفتاحٍ في السجلّ ينفّذه الجدول فعلاً — لا أتمتةَ وهميّة", () => {
    const phantom = Array.from(registryPairs).filter((p) => !tablePairs.has(p));
    expect(phantom, `مفاتيحُ سجلٍّ لا يعرفها الجدول: ${phantom.join(", ")}`).toEqual([]);
  });

  it("④ الجدول يغطّي قاموس الحالات كلَّه ولا يذكر حالةً خارجه", () => {
    expect(Object.keys(CONSIGNMENT_STATUS_TRANSITIONS).sort()).toEqual([...DELIVERY_CONSIGNMENT_STATUSES].sort());
    for (const from of DELIVERY_CONSIGNMENT_STATUSES) {
      for (const to of CONSIGNMENT_STATUS_TRANSITIONS[from]) {
        expect(DELIVERY_CONSIGNMENT_STATUSES as readonly string[]).toContain(to);
        expect(to, `انتقالٌ إلى الحالة نفسها لا يُدرَج (${from})`).not.toBe(from);
      }
    }
    // الحالتان النهائيّتان بلا مخرج — أيُّ مخرجٍ جديد منهما قرارُ تصميمٍ يُسجَّل هنا وفي السجلّ معاً.
    expect(CONSIGNMENT_STATUS_TRANSITIONS.DELIVERED).toEqual([]);
    expect(CONSIGNMENT_STATUS_TRANSITIONS.WRITTEN_OFF).toEqual([]);
  });

  it("③ assertConsignmentStatusTransition: يمرّر المشروع ويرفض غيره ويعدّ الثبات لا انتقالاً", () => {
    for (const p of Array.from(tablePairs)) {
      const [from, to] = p.split("->") as [ConsignmentStatus, ConsignmentStatus];
      expect(() => assertConsignmentStatusTransition(from, to)).not.toThrow();
    }
    for (const st of DELIVERY_CONSIGNMENT_STATUSES) {
      expect(() => assertConsignmentStatusTransition(st, st)).not.toThrow();
    }
    const forbidden: Array<[ConsignmentStatus, ConsignmentStatus]> = [
      ["DELIVERED", "DISPATCHED"],
      ["WRITTEN_OFF", "DISPATCHED"],
      ["PARTIAL", "CANCELLED"],
      ["PARTIAL", "RETURNED"],
      ["CANCELLED", "DELIVERED"],
      ["RETURNED", "DELIVERED"],
    ];
    for (const [from, to] of forbidden) {
      expect(() => assertConsignmentStatusTransition(from, to)).toThrow(
        new RegExp(`انتقال حالة إغلاق الإرسالية غير مسموح: ${from} → ${to}`),
      );
    }
  });
});
