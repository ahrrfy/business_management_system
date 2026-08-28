import { describe, it, expect } from "vitest";
import {
  ONLINE_ORDER_STATUSES,
  ONLINE_ORDER_STATUS_AR,
  ONLINE_ORDER_STATUS_AR_CUSTOMER,
  TERMINAL_ONLINE_ORDER_STATUSES,
  ORDER_NEXT_STEP,
  isTerminalOnlineOrderStatus,
  orderStatusLabel,
  orderStatusLabelForCustomer,
  orderStatusChipClass,
  orderStatusChartColor,
  orderStatusBadgeVariant,
  type OnlineOrderStatus,
} from "./onlineOrderStatus";

/**
 * ⚠️ **قائمة مرآة enum** — تُنسخ حرفياً من `mysqlEnum('orderStatus', […])` في
 * [drizzle/schema.ts:4444]. أيّ تعديلٍ لـenum يلزمه تعديلٌ هنا **بنفس الهجرة** — الاختبار
 * يفشل مغلقاً وإلا لتذكيرك.
 */
const SCHEMA_ENUM_VALUES = [
  "PENDING",
  "CONFIRMED",
  "PROCESSING",
  "SHIPPED",
  "DELIVERED",
  "CANCELLED",
] as const;

describe("قاموس حالة طلب المتجر — مصدر الحقيقة", () => {
  it("ONLINE_ORDER_STATUSES يطابق enum خادمياً (schema.ts:4444)", () => {
    expect([...ONLINE_ORDER_STATUSES].sort()).toEqual([...SCHEMA_ENUM_VALUES].sort());
  });

  it("كلّ قيمة enum لها تعريب إداريّ عربيّ", () => {
    for (const s of SCHEMA_ENUM_VALUES) {
      const label = ONLINE_ORDER_STATUS_AR[s];
      expect(label, `الحالة ${s} بلا تعريب إداريّ`).toBeTruthy();
      expect(label, `الحالة ${s} تعريبها فارغ`).not.toBe("");
      // على الأقلّ حرف عربيّ واحد
      expect(label, `الحالة ${s} تعريبها ليس عربياً`).toMatch(/[؀-ۿ]/);
    }
  });

  it("كلّ قيمة enum لها تعريب موجَّهٌ للعميل", () => {
    for (const s of SCHEMA_ENUM_VALUES) {
      const label = ONLINE_ORDER_STATUS_AR_CUSTOMER[s];
      expect(label, `الحالة ${s} بلا تعريب للعميل`).toBeTruthy();
      expect(label).toMatch(/[؀-ۿ]/);
    }
  });

  it("orderStatusLabel: فارغ/null/undefined ⇒ «—»", () => {
    expect(orderStatusLabel(null)).toBe("—");
    expect(orderStatusLabel(undefined)).toBe("—");
    expect(orderStatusLabel("")).toBe("—");
  });

  it("orderStatusLabel: رمز مجهول يعود كما هو (لا throw ولا رسم مكسور)", () => {
    expect(orderStatusLabel("MYSTERY_STATUS")).toBe("MYSTERY_STATUS");
  });

  it("orderStatusLabelForCustomer: فارغ ⇒ «—» ورمز مجهول يعود كما هو", () => {
    expect(orderStatusLabelForCustomer(null)).toBe("—");
    expect(orderStatusLabelForCustomer("MYSTERY")).toBe("MYSTERY");
  });
});

describe("شارات ولون — لا فراغ ولا تعارض", () => {
  it("chip class موحّد لكلّ حالة معروفة (لا رمي على الاحتياط الرماديّ)", () => {
    for (const s of ONLINE_ORDER_STATUSES) {
      const chip = orderStatusChipClass(s);
      expect(chip.length, `الحالة ${s} chip فارغ`).toBeGreaterThan(0);
      expect(chip, `الحالة ${s} تعود للاحتياط الرماديّ`).not.toBe("bg-muted text-muted-foreground");
    }
  });

  it("chip class للفارغ/المجهول ⇒ الاحتياط الرماديّ (لا خطأ)", () => {
    expect(orderStatusChipClass(null)).toBe("bg-muted text-muted-foreground");
    expect(orderStatusChipClass("MYSTERY")).toBe("bg-muted text-muted-foreground");
  });

  it("chart color موحّد لكلّ حالة معروفة (Tailwind bg-*)", () => {
    for (const s of ONLINE_ORDER_STATUSES) {
      expect(orderStatusChartColor(s)).toMatch(/^bg-/);
    }
    expect(orderStatusChartColor(null)).toBe("bg-slate-300");
  });

  it("badge variant من المجموعة الآمنة عالمياً (success/warning/secondary/outline)", () => {
    const allowed = new Set(["success", "warning", "secondary", "outline"]);
    for (const s of ONLINE_ORDER_STATUSES) {
      expect(allowed.has(orderStatusBadgeVariant(s))).toBe(true);
    }
    expect(orderStatusBadgeVariant(null)).toBe("outline");
  });
});

describe("انتقالات الحالة — بلا حلقة، بلا نهاية مفتوحة", () => {
  it("ORDER_NEXT_STEP لا يُدخل حالةً في نفسها ولا يشير لحالةٍ غير موجودة", () => {
    for (const [from, next] of Object.entries(ORDER_NEXT_STEP)) {
      expect(next, `الانتقال من ${from} لا `.concat(from, ` غير معرّف`)).toBeDefined();
      expect(next!.to, `${from} ينتقل إلى نفسه — حلقة`).not.toBe(from);
      expect(
        (ONLINE_ORDER_STATUSES as readonly string[]).includes(next!.to),
        `${from} → ${next!.to} حيث ${next!.to} غير معروف`,
      ).toBe(true);
      // لكلّ انتقالٍ تسميةٌ إجرائيّةٌ عربيّة (زرّ الشاشة)
      expect(next!.label).toMatch(/[؀-ۿ]/);
    }
  });

  it("الحالات النهائيّة (DELIVERED/CANCELLED) لا خطوة تالية لها", () => {
    expect(ORDER_NEXT_STEP.DELIVERED).toBeUndefined();
    expect(ORDER_NEXT_STEP.CANCELLED).toBeUndefined();
  });

  it("TERMINAL_ONLINE_ORDER_STATUSES يطابق ما لا خطوةَ له في ORDER_NEXT_STEP", () => {
    const derivedTerminals = (ONLINE_ORDER_STATUSES as readonly OnlineOrderStatus[]).filter(
      (s) => ORDER_NEXT_STEP[s] === undefined,
    );
    // ملاحظة: PROCESSING بلا next لأنّ SHIPPED مسارٌ ماليّ (orders.dispatch) لا خطوة UI بحتة.
    // فلا نُطالب بمطابقةٍ صارمة — نتحقّق فقط أنّ TERMINAL يقع ضمن المشتقّ (لا شيءَ مفقود).
    for (const t of TERMINAL_ONLINE_ORDER_STATUSES) {
      expect(derivedTerminals, `${t} خطوةُ التالي معرَّفة له لكنّه مُعلَنٌ نهائيّاً`).toContain(t);
    }
  });

  it("isTerminalOnlineOrderStatus يميّز النهائيّ صحيحاً", () => {
    expect(isTerminalOnlineOrderStatus("DELIVERED")).toBe(true);
    expect(isTerminalOnlineOrderStatus("CANCELLED")).toBe(true);
    expect(isTerminalOnlineOrderStatus("PENDING")).toBe(false);
    expect(isTerminalOnlineOrderStatus("SHIPPED")).toBe(false);
    expect(isTerminalOnlineOrderStatus(null)).toBe(false);
    expect(isTerminalOnlineOrderStatus(undefined)).toBe(false);
    expect(isTerminalOnlineOrderStatus("")).toBe(false);
  });
});
