import { describe, expect, it } from "vitest";
import {
  formatDeliveryNotificationText,
  normalizeLegacyDeliveryNotificationText,
} from "../deliveryNotificationLabels";

describe("deliveryNotificationLabels — تنسيق إشعارات حركات التوصيل", () => {
  it("يُنسق إشعار إسناد الطرد للمندوب بصيغة عربية واضحة", () => {
    const res = formatDeliveryNotificationText({
      eventType: "ASSIGNED",
      consignmentNumber: "CN-1-20260921-00009",
      recipientName: "حيدر صباح",
      partyName: "شركة البراق",
      actorName: "نور محمد",
    });

    expect(res.title).toBe("إسناد طرد للمندوب");
    expect(res.body).toBe(
      "طرد CN-1-20260921-00009 (حيدر صباح) · أُسند للتوصيل مع شركة البراق · بواسطة نور محمد",
    );
  });

  it("يُنسق إشعار تم تسليم الطرد بنجاح", () => {
    const res = formatDeliveryNotificationText({
      eventType: "DELIVERED",
      consignmentNumber: "CN-1-20260921-00008",
      actorName: "علي المندوب",
    });

    expect(res.title).toBe("تم تسليم طرد");
    expect(res.body).toBe(
      "طرد CN-1-20260921-00008 · تم تسليمه بنجاح للعميل · بواسطة علي المندوب",
    );
  });

  it("يُنسق إشعار الطرد المرتجع", () => {
    const res = formatDeliveryNotificationText({
      eventType: "RETURNED",
      consignmentNumber: "CN-1-20260921-00007",
      actorName: "أحمد",
    });

    expect(res.title).toBe("طرد مرتجع");
    expect(res.body).toBe(
      "طرد CN-1-20260921-00007 · تم إرجاعه واكتملت إعادته · بواسطة أحمد",
    );
  });

  it("يُنسق إشعار تعذر التسليم مع السبب إن وجد", () => {
    const res = formatDeliveryNotificationText({
      eventType: "FAILED",
      consignmentNumber: "CN-1-20260921-00006",
      payload: { reason: "العميل لم يرد على الهاتف" },
      actorName: "سعد",
    });

    expect(res.title).toBe("تعذر توصيل طرد");
    expect(res.body).toBe(
      "طرد CN-1-20260921-00006 · تعذر تسليمه للعميل (العميل لم يرد على الهاتف) · بواسطة سعد",
    );
  });

  it("يُنسق إشعار التسوية النقدية للطرد", () => {
    const res = formatDeliveryNotificationText({
      eventType: "MONEY_SETTLED",
      consignmentNumber: "CN-1-20260920-00023",
      actorName: "نور محمد احمد",
    });

    expect(res.title).toBe("تسوية نقدية لطرد");
    expect(res.body).toBe(
      "طرد CN-1-20260920-00023 · تمت تسوية مبلغه بالكامل · بواسطة نور محمد احمد",
    );
  });

  it("يُنسق إشعار خرج للتوصيل واستلام الطرد", () => {
    const outRes = formatDeliveryNotificationText({
      eventType: "OUT_FOR_DELIVERY",
      consignmentNumber: "CN-1-20260921-00005",
    });
    expect(outRes.title).toBe("طرد خرج للتوصيل");
    expect(outRes.body).toBe("طرد CN-1-20260921-00005 · في الطريق إلى العميل");

    const pickedRes = formatDeliveryNotificationText({
      eventType: "PICKED_UP",
      consignmentNumber: "CN-1-20260921-00005",
    });
    expect(pickedRes.title).toBe("استلام طرد من المندوب");
  });

  it("يُحوّل الإشعارات القديمة من لقطة الشاشة إلى صيغة واضحة", () => {
    // 1. الإشعار الأول في لقطة الشاشة:
    const legacy1 = normalizeLegacyDeliveryNotificationText({
      title: "تحديث طرد توصيل",
      body: "CN-1-20260920-00023 — MONEY_SETTLED · بواسطة نور محمد احمد",
    });
    expect(legacy1.title).toBe("تسوية نقدية لطرد");
    expect(legacy1.body).toBe(
      "طرد CN-1-20260920-00023 · تمت تسوية مبلغه بالكامل · بواسطة نور محمد احمد",
    );

    // 2. الإشعار الثاني في لقطة الشاشة:
    const legacy2 = normalizeLegacyDeliveryNotificationText({
      title: "تحديث طرد توصيل",
      body: "CN-1-20260921-00009 — ASSIGNED",
    });
    expect(legacy2.title).toBe("إسناد طرد للمندوب");
    expect(legacy2.body).toBe("طرد CN-1-20260921-00009 · أُسند للتوصيل");
  });

  it("لا يمس الإشعارات غير التابعة للنمط القديم", () => {
    const customNotice = {
      title: "تسوية مخزون بانتظار قرار",
      body: "طلب #5 · الفرع 1",
    };
    expect(normalizeLegacyDeliveryNotificationText(customNotice)).toEqual(
      customNotice,
    );
  });
});
