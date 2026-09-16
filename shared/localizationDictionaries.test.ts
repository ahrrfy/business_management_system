import { describe, expect, it } from "vitest";

import {
  deliveryLedgerEntries,
  digitalSaleIntents,
  orderPayments,
} from "../drizzle/schema";
import {
  CUSTOMER_FOLLOW_UP_KIND_LABEL,
  CUSTOMER_FOLLOW_UP_KINDS,
  CUSTOMER_FOLLOW_UP_OUTCOME_LABEL,
  CUSTOMER_FOLLOW_UP_OUTCOMES,
} from "./customerFollowUp";
import {
  DELIVERY_EVENT_LABEL,
  DELIVERY_EVENT_SOURCE_LABEL,
  DELIVERY_EVENT_SOURCES,
  DELIVERY_EVENT_TYPES,
  deliveryEventLabel,
  deliveryEventSourceLabel,
} from "./deliveryEventType";
import {
  DELIVERY_LEDGER_ENTRY_LABEL,
  DELIVERY_LEDGER_ENTRY_SIGN,
  DELIVERY_LEDGER_ENTRY_TYPES,
  deliveryLedgerEntryLabel,
  deliveryLedgerEntrySign,
} from "./deliveryLedgerEntryType";
import {
  DIGITAL_SALE_INTENT_PENDING_STATUSES,
  DIGITAL_SALE_INTENT_STATUS_LABEL,
  DIGITAL_SALE_INTENT_STATUSES,
  digitalSaleIntentStatusLabel,
} from "./digitalSaleIntentStatus";
import {
  ORDER_DEPOSIT_KIND_LABEL,
  ORDER_DEPOSIT_KINDS,
  ORDER_DEPOSIT_STATUS_LABEL,
  ORDER_DEPOSIT_STATUSES,
  orderDepositKindLabel,
  orderDepositStatusLabel,
} from "./orderDeposit";
import { paymentMethodCompact } from "./terms";

/**
 * حارسُ قواميس التسميات المستخرَجة من داخل المكوّنات (موجة D6، ٢/٩/٢٦).
 *
 * القاموسُ داخل مكوّنٍ لا يحرسه شيء: يشيخ عن عموده بصمت، فيُعرَض للموظّف رمزٌ إنجليزيّ خامّ
 * على شاشةٍ عربيّة، أو يُقرأ المفهومُ الواحد باسمين بحسب الشاشة. هذا الملفّ يثبّت ثلاثة عقود
 * على كلّ قاموسٍ نُقل إلى `shared/`:
 *   ١) **لا قيمةَ enum بلا تسمية** — بمطابقةٍ حرفيّة مع عمود القاعدة حيث يوجد عمود.
 *   ٢) **لا تشكيل** في التسمية (نفس علّة `check:tashkeel`: خطّ الواجهة تحت 14px يرسم
 *      «سُلِّم» كأنّها «شلَم»).
 *   ٣) **لا تكرارَ مفاتيحَ ولا تسمياتٍ** داخل القاموس الواحد — اسمان لقيمةٍ واحدة يخفيان
 *      قيمةً، واسمٌ واحد لقيمتين يجعل الشاشة تكذب.
 */

/** U+064B..U+0652 (الحركات والتنوين والشدّة والسكون) + U+0670 + U+0653..U+065F. */
const TASHKEEL_RE = /[\u064B-\u0652\u0653-\u065F\u0670]/;

/** كلُّ قاموسٍ خاضعٍ للعقود الثلاثة: اسمُه · قائمةُ قيمه · خريطةُ تسمياته. */
const DICTIONARIES: readonly {
  name: string;
  values: readonly string[];
  labels: Readonly<Record<string, string>>;
}[] = [
  { name: "نوع حدث التوصيل", values: DELIVERY_EVENT_TYPES, labels: DELIVERY_EVENT_LABEL },
  { name: "سلطة حدث التوصيل", values: DELIVERY_EVENT_SOURCES, labels: DELIVERY_EVENT_SOURCE_LABEL },
  {
    name: "نوع قيد دفتر التوصيل",
    values: DELIVERY_LEDGER_ENTRY_TYPES,
    labels: DELIVERY_LEDGER_ENTRY_LABEL,
  },
  { name: "نوع صف العربون", values: ORDER_DEPOSIT_KINDS, labels: ORDER_DEPOSIT_KIND_LABEL },
  { name: "حالة احتجاز العربون", values: ORDER_DEPOSIT_STATUSES, labels: ORDER_DEPOSIT_STATUS_LABEL },
  {
    name: "حالة نية البيع الرقمي",
    values: DIGITAL_SALE_INTENT_STATUSES,
    labels: DIGITAL_SALE_INTENT_STATUS_LABEL,
  },
  {
    name: "وسيلة متابعة العميل",
    values: CUSTOMER_FOLLOW_UP_KINDS,
    labels: CUSTOMER_FOLLOW_UP_KIND_LABEL,
  },
  {
    name: "نتيجة متابعة العميل",
    values: CUSTOMER_FOLLOW_UP_OUTCOMES,
    labels: CUSTOMER_FOLLOW_UP_OUTCOME_LABEL,
  },
];

describe("قواميس التسميات المشتركة", () => {
  for (const dict of DICTIONARIES) {
    describe(dict.name, () => {
      it("لكل قيمة تسميةٌ عربية غير فارغة", () => {
        for (const value of dict.values) {
          expect(dict.labels[value]?.trim(), `${dict.name}: ${value}`).toBeTruthy();
        }
      });

      // خريطةُ التسميات لا تحمل مفتاحاً خارج القائمة: المفتاحُ الميت يوهم بتغطيةٍ لا وجود لها
      // (كان قاموس أحداث التوصيل يحمل ستّةً منها، أربعةٌ مسروقةٌ من قاموس قيود الدفتر).
      it("لا مفتاحَ في خريطة التسميات خارج قائمة القيم", () => {
        expect(Object.keys(dict.labels).sort()).toEqual([...dict.values].sort());
      });

      it("لا تكرار في المفاتيح", () => {
        expect(new Set(dict.values).size).toBe(dict.values.length);
      });

      // قيمتان بتسميةٍ واحدة = شاشةٌ تُظهر سطرين متطابقين لمفهومين مختلفين، ولا سبيل للموظّف
      // للتمييز. هذا بالضبط ما كان قائماً: `DISPATCHED` و`ASSIGNED` كلاهما «أُسنِد».
      it("لا تكرار في التسميات", () => {
        const labels = dict.values.map((v) => dict.labels[v]);
        expect(new Set(labels).size, `${dict.name}: تسميةٌ مكرَّرة`).toBe(labels.length);
      });

      it("لا تشكيل في أي تسمية", () => {
        for (const value of dict.values) {
          expect(TASHKEEL_RE.test(dict.labels[value]), `${dict.name}: ${value}`).toBe(false);
        }
      });
    });
  }
});

describe("مطابقة القواميس لأعمدة القاعدة", () => {
  // الحارس الأهمّ: القيم مخزَّنة حرفياً في MySQL. توسيعُ العمود بلا تسميةٍ هنا يمرّ في CI
  // (قاعدةُ الاختبار تُبنى من المخطط) ثم يظهر رمزاً إنجليزياً خامّاً على شاشةٍ عربيّة —
  // وهو ما وقع فعلاً لـ`SHORTFALL_ASSIGNED` (هجرة 0295) حتى هذه الموجة.
  it("قيود دفتر التوصيل تطابق عمود entryType", () => {
    expect(deliveryLedgerEntries.entryType.enumValues).toEqual([
      ...DELIVERY_LEDGER_ENTRY_TYPES,
    ]);
  });

  it("نوع صف العربون وحالته يطابقان عمودَيهما", () => {
    expect(orderPayments.kind.enumValues).toEqual([...ORDER_DEPOSIT_KINDS]);
    expect(orderPayments.status.enumValues).toEqual([...ORDER_DEPOSIT_STATUSES]);
  });

  it("حالة نية البيع الرقمي تطابق عمود status", () => {
    expect(digitalSaleIntents.status.enumValues).toEqual([...DIGITAL_SALE_INTENT_STATUSES]);
  });

  // حالاتُ «لم تكتمل» مرآةُ `inArray` في dashboardService#pendingExecutions — تُرصَد هنا
  // كي لا تتباعد القائمتان فيظهر صفٌّ بلا تسمية أو تسميةٌ بلا صفّ.
  it("حالات العمليات المعلقة جزءٌ من التعداد", () => {
    expect(DIGITAL_SALE_INTENT_PENDING_STATUSES).toEqual([
      "PREPARED",
      "EXECUTING",
      "EXECUTED",
      "NEEDS_REVIEW",
    ]);
    for (const status of DIGITAL_SALE_INTENT_PENDING_STATUSES) {
      expect(DIGITAL_SALE_INTENT_STATUSES).toContain(status);
    }
  });
});

describe("تمايز مفهومَي التوصيل", () => {
  // فخُّ «تشابُهِ المفاتيح ليس وحدةَ المفهوم»: سلسلةُ الحيازة (`deliveryEvents`) وحركةُ المال
  // (`deliveryLedgerEntries`) جدولان مختلفان. أربعةُ أسماءٍ من الثاني كانت مُقحَمةً في قاموس
  // الأول حيث لا يكتبها أيُّ مسار — فبدا القاموسُ أشملَ ممّا هو، وغطّى ما لا يقع.
  it("لا تقاطع بين مفاتيح أحداث التوصيل ومفاتيح قيود دفتره", () => {
    const overlap = DELIVERY_EVENT_TYPES.filter((t) =>
      (DELIVERY_LEDGER_ENTRY_TYPES as readonly string[]).includes(t),
    );
    expect(overlap).toEqual([]);
  });

  it("المفاتيح الميتة الستة أُزيلت من قاموس الأحداث", () => {
    for (const dead of ["DISPATCHED", "CANCELLED", "REMITTED", "WRITTEN_OFF", "RECOVERED", "FEE_PAID"]) {
      expect(DELIVERY_EVENT_TYPES as readonly string[]).not.toContain(dead);
    }
  });

  // الأنواع التي كانت تُعرَض رمزاً إنجليزياً خامّاً قبل هذه الموجة — تثبيتُها يمنع تراجعاً صامتاً.
  it("الأنواع الحية التي كانت بلا تسمية صارت مغطّاة", () => {
    for (const live of [
      "ASSIGNMENT_REACTIVATED",
      "ASSIGNMENT_CANCELLED",
      "REASSIGNED",
      "PARCEL_FAILED",
      "SUPPLEMENTARY_COLLECTION",
      "MONEY_PARTIAL",
      "MONEY_SETTLED",
      "MONEY_WRITTEN_OFF",
    ]) {
      expect(DELIVERY_EVENT_TYPES as readonly string[]).toContain(live);
    }
  });

  it("لكل قيد دفترٍ إشارةٌ صريحة", () => {
    for (const entryType of DELIVERY_LEDGER_ENTRY_TYPES) {
      expect([1, -1]).toContain(DELIVERY_LEDGER_ENTRY_SIGN[entryType]);
    }
  });
});

describe("سلوك دوال العرض على الفارغ والمجهول", () => {
  // العقدُ محفوظٌ كما كان في المكوّنات قبل النقل: «—» للفارغ، والرمزُ نفسُه للمجهول.
  // إخفاءُ المجهول تحت «أخرى» يدفن الفجوة، وإظهارُه يقود المطوّر إليها.
  it("التسمية المجهولة تُعرَض خامّةً والفارغة شرطة", () => {
    expect(deliveryEventLabel("NOPE")).toBe("NOPE");
    expect(deliveryEventLabel(null)).toBe("—");
    expect(deliveryLedgerEntryLabel("NOPE")).toBe("NOPE");
    expect(deliveryLedgerEntryLabel("")).toBe("—");
    expect(orderDepositKindLabel("NOPE")).toBe("NOPE");
    expect(orderDepositStatusLabel(undefined)).toBe("—");
    expect(digitalSaleIntentStatusLabel("NOPE")).toBe("NOPE");
  });

  // شارةُ السلطة ثانويّة: تختفي على المجهول بدل مزاحمة الفعل برمزٍ خامّ (السلوك السابق حرفياً).
  it("شارة السلطة تختفي على المجهول", () => {
    expect(deliveryEventSourceLabel("NOPE")).toBe("");
    expect(deliveryEventSourceLabel(null)).toBe("");
    expect(deliveryEventSourceLabel("COUNTER")).toBe("قبض كاونتري");
  });

  it("إشارة القيد المجهول موجبة كما كان", () => {
    expect(deliveryLedgerEntrySign("NOPE")).toBe(1);
    expect(deliveryLedgerEntrySign(null)).toBe(1);
  });
});

describe("طريقة الدفع تُستهلك من المصدر الموحد لا من قاموسٍ محلي", () => {
  // حوار عرابين الطلب كان يحمل نسخته الخاصّة من طرق الدفع. الاستهلاك من `terms.ts` يجب أن
  // يُنتج **النصوص نفسها حرفياً** لكل قيمة يحملها عمود `orderPayMethod` — وإلّا كان النقل
  // تغييراً في نصٍّ يراه الموظّف لا توحيداً للمصدر.
  it("تسميات عمود orderPayMethod مطابقة لما كان معروضاً", () => {
    const previous: Record<string, string> = {
      CASH: "نقدي",
      CARD: "بطاقة",
      TRANSFER: "تحويل",
      WALLET: "محفظة",
      TELECOM: "رصيد زين",
    };
    for (const method of orderPayments.method.enumValues) {
      expect(paymentMethodCompact(method), method).toBe(previous[method]);
    }
  });
});
