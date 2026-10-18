import { describe, expect, it } from "vitest";
import { deriveOnlineOrderLifecycle } from "./onlineOrderLifecycle";

const delivered = {
  parcelStatus: "DELIVERED",
  moneyStatus: "UNSETTLED",
  status: "DISPATCHED",
  codAmount: "10000.00",
  collectedAmount: "0.00",
  customerCollectedAmount: "10000.00",
  counterSettledAmount: "0.00",
  remittanceId: null,
};

describe("online order delivery facts", () => {
  it("distinguishes customer collection from remittance to the shop", () => {
    expect(deriveOnlineOrderLifecycle(delivered)).toMatchObject({
      label: "تم التسليم والتحصيل",
      remittanceLabel: "بانتظار التوريد",
    });
    expect(
      deriveOnlineOrderLifecycle({
        ...delivered,
        moneyStatus: "PARTIAL",
        collectedAmount: "4000.00",
      }).remittanceLabel,
    ).toBe("توريد جزئي");
    expect(
      deriveOnlineOrderLifecycle({
        ...delivered,
        moneyStatus: "SETTLED",
        collectedAmount: "10000.00",
        remittanceId: 7,
      }).remittanceLabel,
    ).toBe("تم التوريد");
  });
  it("does not invent full collection from a paid invoice with assigned shortfall", () => {
    expect(
      deriveOnlineOrderLifecycle({
        ...delivered,
        customerCollectedAmount: "7000.00",
      }),
    ).toMatchObject({
      label: "تم التسليم",
      collectionLabel: "تحصيل جزئي",
    });
    expect(
      deriveOnlineOrderLifecycle({
        ...delivered,
        customerCollectedAmount: "40000",
        shortfallAssignedAmount: "3000",
      }).collectionLabel,
    ).toBe("تحصيل جزئي");
  });
  it("does not call prepaid delivery a new collection or remittance", () => {
    expect(
      deriveOnlineOrderLifecycle({
        ...delivered,
        codAmount: "0",
        customerCollectedAmount: "0",
        moneyStatus: "NOT_APPLICABLE",
      }),
    ).toMatchObject({
      label: "تم التسليم",
      collectionLabel: "مدفوع مسبقا",
      remittanceLabel: null,
    });
  });
  it("shows physical movement, failure and return instead of frozen shipped text", () => {
    for (const [parcelStatus, label] of [
      ["ASSIGNED", "مسند لجهة التوصيل"],
      ["PICKED_UP", "استلمته جهة التوصيل"],
      ["OUT_FOR_DELIVERY", "بالطريق إلى العميل"],
      ["FAILED", "تعذر التسليم"],
      ["RETURNED", "أعيد للمكتبة"],
      ["CANCELLED", "ألغي الإسناد"],
    ]) {
      expect(
        deriveOnlineOrderLifecycle({ ...delivered, parcelStatus }).label,
      ).toBe(label);
    }
    expect(
      deriveOnlineOrderLifecycle({
        ...delivered,
        parcelStatus: "OUT_FOR_DELIVERY",
        returnDeclaredAt: new Date(),
      }).label,
    ).toBe("بانتظار استلام المرتجع");
    expect(
      deriveOnlineOrderLifecycle({
        ...delivered,
        parcelStatus: "RETURNED",
        returnDeclaredAt: new Date(),
      }).label,
    ).toBe("أعيد للمكتبة");
  });
  it("never calls a write-off or counter settlement a cash remittance", () => {
    expect(
      deriveOnlineOrderLifecycle({ ...delivered, moneyStatus: "WRITTEN_OFF" })
        .remittanceLabel,
    ).toBe("شطب المتبقي");
    expect(
      deriveOnlineOrderLifecycle({
        ...delivered,
        moneyStatus: "SETTLED",
        counterSettledAmount: "10000",
      }).remittanceLabel,
    ).toBe("تمت التسوية");
  });
  it("counts receipt-backed counter payments, while excluding obligation release after returns", () => {
    const counterPaid = {
      ...delivered,
      customerCollectedAmount: "0",
      counterSettledAmount: "10000",
      moneyStatus: "SETTLED",
    };
    expect(deriveOnlineOrderLifecycle(counterPaid).collectionLabel).toBe(
      "لم يثبت التحصيل",
    );
    expect(
      deriveOnlineOrderLifecycle({
        ...counterPaid,
        customerCounterCollectedAmount: "10000",
      }),
    ).toMatchObject({
      label: "تم التسليم والتحصيل",
      remittanceLabel: "تمت التسوية",
    });
  });
});
