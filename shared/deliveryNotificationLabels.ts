/**
 * صياغة عناوين ونصوص إشعارات الطرود والتوصيل باللغة العربية الواضحة والمفهومة.
 *
 * يستبدل العنوان الموحّد («تحديث طرد توصيل») والأكواد الإنكليزية الخام (مثل ASSIGNED أو MONEY_SETTLED)
 * بعناوين وأوصاف دقيقة تعكس الحركة الحقيقية للطرد:
 * - «إسناد طرد للمندوب»
 * - «تم تسليم طرد»
 * - «طرد مرتجع»
 * - «تعذر توصيل طرد»
 * - «تسوية نقدية لطرد»
 * ... إلخ.
 */

import { actorSuffix } from "./notificationActorLabel";

export interface DeliveryNoticeDetails {
  title: string;
  body: string;
}

export interface FormatDeliveryNoticeParams {
  eventType: string;
  topic?: string | null;
  consignmentNumber: string;
  recipientName?: string | null;
  partyName?: string | null;
  payload?: Record<string, unknown> | null;
  actorName?: string | null;
}

/**
 * يُنسّق عنوان الإشعار ونصّه لحركات وأحداث الطرود والتوصيل باللغة العربية.
 */
export function formatDeliveryNotificationText(
  params: FormatDeliveryNoticeParams,
): DeliveryNoticeDetails {
  const {
    eventType,
    topic,
    consignmentNumber,
    recipientName,
    partyName,
    payload,
    actorName,
  } = params;

  const actor = actorSuffix(actorName);
  const recipientPart = recipientName?.trim() ? ` (${recipientName.trim()})` : "";
  const partyPart = partyName?.trim() ? ` مع ${partyName.trim()}` : "";
  const reason =
    payload &&
    typeof payload === "object" &&
    typeof (payload as Record<string, unknown>).reason === "string" &&
    ((payload as Record<string, unknown>).reason as string).trim()
      ? ((payload as Record<string, unknown>).reason as string).trim()
      : null;

  switch (eventType) {
    case "ASSIGNED":
      return {
        title: "إسناد طرد للمندوب",
        body: `طرد ${consignmentNumber}${recipientPart} · أُسند للتوصيل${partyPart}${actor}`,
      };

    case "REASSIGNED":
      return {
        title: "إعادة إسناد طرد",
        body: `طرد ${consignmentNumber}${recipientPart} · أُعيد إسناده${partyPart ? ` إلى ${partyName?.trim()}` : ""}${actor}`,
      };

    case "ASSIGNMENT_CANCELLED":
      return {
        title: "إلغاء إسناد طرد",
        body: `طرد ${consignmentNumber}${recipientPart} · أُلغي إسناده للتوصيل${actor}`,
      };

    case "ASSIGNMENT_REACTIVATED":
      return {
        title: "إعادة تفعيل إسناد طرد",
        body: `طرد ${consignmentNumber}${recipientPart} · أُعيد تفعيل إسناده للتوصيل${partyPart}${actor}`,
      };

    case "ACCEPTED":
      return {
        title: "قبول طرد من المندوب",
        body: `طرد ${consignmentNumber}${recipientPart} · قَبِل المندوب التوصيل${actor}`,
      };

    case "PICKED_UP":
      return {
        title: "استلام طرد من المندوب",
        body: `طرد ${consignmentNumber}${recipientPart} · استلم المندوب الطرد من الفرع${actor}`,
      };

    case "OUT_FOR_DELIVERY":
      return {
        title: "طرد خرج للتوصيل",
        body: `طرد ${consignmentNumber}${recipientPart} · في الطريق إلى العميل${actor}`,
      };

    case "DELIVERED":
      return {
        title: "تم تسليم طرد",
        body: `طرد ${consignmentNumber}${recipientPart} · تم تسليمه بنجاح للعميل${actor}`,
      };

    case "STAFF_CONFIRMED":
      return {
        title: "تأكيد تسليم طرد",
        body: `طرد ${consignmentNumber}${recipientPart} · أُكّد تسليمه من موظف الفرع${actor}`,
      };

    case "FAILED":
    case "PARCEL_FAILED":
      return {
        title: "تعذر توصيل طرد",
        body: `طرد ${consignmentNumber}${recipientPart} · تعذر تسليمه للعميل${reason ? ` (${reason})` : ""}${actor}`,
      };

    case "STAFF_FAILED":
      return {
        title: "تعذر تسليم طرد (موظف)",
        body: `طرد ${consignmentNumber}${recipientPart} · وُسم بتعذر التسليم من الفرع${actor}`,
      };

    case "AUTO_FAILED_SLA":
      return {
        title: "تعذر توصيل لتجاوز المهلة",
        body: `طرد ${consignmentNumber}${recipientPart} · تجاوز مهلة التوصيل المحددة (SLA)${actor}`,
      };

    case "STALE_ESCALATED":
      return {
        title: "طرد توصيل جامد يحتاج متابعة",
        body: `طرد ${consignmentNumber}${recipientPart} · معلّق بلا تحديث ويحتاج متابعة إدارية${actor}`,
      };

    case "RETURN_DECLARED":
      return {
        title: "إعلان طرد مرتجع",
        body: `طرد ${consignmentNumber}${recipientPart} · أُعلن عنه كمرتجع وفي انتظار الاستلام${actor}`,
      };

    case "RETURNED":
      return {
        title: "طرد مرتجع",
        body: `طرد ${consignmentNumber}${recipientPart} · تم إرجاعه واكتملت إعادته${actor}`,
      };

    case "RETURN_RESTOCKED":
      return {
        title: "إعادة طرد للمخزن",
        body: `طرد ${consignmentNumber}${recipientPart} · أُعيدت بضاعته بنجاح إلى المخزن${actor}`,
      };

    case "MONEY_SETTLED":
      return {
        title: "تسوية نقدية لطرد",
        body: `طرد ${consignmentNumber}${recipientPart} · تمت تسوية مبلغه بالكامل${actor}`,
      };

    case "MONEY_PARTIAL":
      return {
        title: "تسوية نقدية جزئية",
        body: `طرد ${consignmentNumber}${recipientPart} · تمت تسوية جزء من مبلغه${actor}`,
      };

    case "MONEY_WRITTEN_OFF":
      return {
        title: "شطب مستحقات طرد",
        body: `طرد ${consignmentNumber}${recipientPart} · تم شطب مستحقاته${actor}`,
      };

    case "COUNTER_SETTLED":
      return {
        title: "تسوية استلام كاونتر",
        body: `طرد ${consignmentNumber}${recipientPart} · تم استلام مبلغه وتسويته بالكاونتر${actor}`,
      };

    case "SUPPLEMENTARY_COLLECTION":
      return {
        title: "تحصيل إضافي لطرد",
        body: `طرد ${consignmentNumber}${recipientPart} · تم تحصيل مبلغ إضافي له${actor}`,
      };

    default:
      if (topic === "delivery.delivered") {
        return {
          title: "تم تسليم طرد",
          body: `طرد ${consignmentNumber}${recipientPart} · تم تسليمه للعميل${actor}`,
        };
      }
      if (topic === "delivery.failed") {
        return {
          title: "تعذر توصيل طرد",
          body: `طرد ${consignmentNumber}${recipientPart} · تعذر تسليمه${actor}`,
        };
      }
      if (topic === "delivery.returned") {
        return {
          title: "طرد مرتجع",
          body: `طرد ${consignmentNumber}${recipientPart} · تم إرجاعه${actor}`,
        };
      }
      if (topic === "delivery.assigned" || topic === "delivery.reassigned") {
        return {
          title: "إسناد طرد للمندوب",
          body: `طرد ${consignmentNumber}${recipientPart} · أُسند للتوصيل${partyPart}${actor}`,
        };
      }
      if (topic === "delivery.money_settled") {
        return {
          title: "تسوية نقدية لطرد",
          body: `طرد ${consignmentNumber}${recipientPart} · تمت تسوية مبلغه بالكامل${actor}`,
        };
      }
      return {
        title: "تحديث طرد توصيل",
        body: `طرد ${consignmentNumber}${recipientPart} · ${eventType}${actor}`,
      };
  }
}

const LEGACY_DELIVERY_BODY_REGEX =
  /^([A-Z0-9-]+)\s*—\s*([A-Za-z0-9_]+)(?:\s*·\s*بواسطة\s*(.+))?$/;

/**
 * يُحوّل الإشعارات القديمة المحفوظة بصيغة «CN-x-xxx — ASSIGNED · بواسطة فلان» إلى الصيغة العربية المفهومة.
 */
export function normalizeLegacyDeliveryNotificationText(notice: {
  title: string;
  body: string;
}): DeliveryNoticeDetails {
  if (notice.title !== "تحديث طرد توصيل") {
    return notice;
  }

  const match = LEGACY_DELIVERY_BODY_REGEX.exec(notice.body.trim());
  if (!match) {
    return notice;
  }

  const consignmentNumber = match[1];
  const eventType = match[2];
  const actorName = match[3] ?? null;

  return formatDeliveryNotificationText({
    eventType,
    consignmentNumber,
    actorName,
  });
}
