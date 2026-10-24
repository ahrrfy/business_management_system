import { canPrintFixedCoupon, type DossierCoupon } from "../customerCoupon";
import { useCatalogPeopleOperationAccess } from "@/lib/catalogPeopleOperationAccess";
import { useState, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { fmtDate } from "@/lib/date";
import { notify } from "@/lib/notify";
import {
  openWhatsApp,
  preferredWhatsAppPhone,
  buildGoogleReviewInviteWhatsAppMessage,
  buildInstantGiftWhatsAppMessage,
} from "@/lib/whatsapp";
import { printGiftVoucherDoc } from "@/lib/printing/giftVoucherPrint";
import {
  hasModuleAccess,
  type PermissionMap,
  type RoleKey,
} from "@shared/permissions";
import type { CustomerDossierDrawerProps } from "../CustomerDossierDrawer";
export function useCustomerDossier({
  customerId,
  open,
}: CustomerDossierDrawerProps) {
  const { can } = useCatalogPeopleOperationAccess();
  const [giftModalOpen, setGiftModalOpen] = useState(false);
  const [feedbackModalOpen, setFeedbackOpen] = useState(false);
  const feedbackSessionRef = useRef(0);
  const feedbackSession = feedbackSessionRef.current;
  const setFeedbackModalOpen = (value: boolean) => {
    if (value) feedbackSessionRef.current += 1;
    setFeedbackOpen(value);
  };
  const isFeedbackSessionCurrent = () =>
    feedbackSessionRef.current === feedbackSession;
  const [pendingInvite, setPendingInvite] = useState<{
    feedbackId?: number;
  } | null>(null);
  const [targetFeedbackId, setTargetFeedbackId] = useState<number | undefined>(
    undefined,
  );
  const [targetWorkOrderId, setTargetWorkOrderId] = useState<
    number | undefined
  >(undefined);
  const [targetWorkOrderNumber, setTargetWorkOrderNumber] = useState<
    string | undefined
  >(undefined);

  const utils = trpc.useUtils();

  const dossierQuery = trpc.customers.dossier360.useQuery(
    { customerId: customerId! },
    {
      enabled:
        can("customers.dossier360") &&
        open &&
        customerId != null &&
        customerId > 0,
    },
  );

  const updateStatusMutation = trpc.customers.updateFeedbackStatus.useMutation({
    onSuccess: () => {
      notify.ok("تم تحديث حالة الشكوى بنجاح");
      utils.customers.dossier360.invalidate({ customerId: customerId! });
      utils.customers.feedbackList.invalidate();
    },
    onError: (err) => {
      notify.err(err.message || "فشل تحديث حالة الشكوى");
    },
  });

  const markGoogleReviewMutation =
    trpc.customers.markGoogleReviewInviteSent.useMutation({
      onError: (error) => notify.err(error),
      onSuccess: () => {
        notify.ok("تم تسجيل إرسال دعوة التقييم عبر واتساب");
        utils.customers.dossier360.invalidate({ customerId: customerId! });
      },
    });

  const me = trpc.auth.me.useQuery();
  const role = me.data?.role as RoleKey | undefined;
  const override = (me.data?.permissionsOverride ??
    null) as PermissionMap | null;
  const canReadReports = can(
    "reports.customerStatement",
    !!role &&
      (role === "admin" || hasModuleAccess(role, override, "reports", "READ")),
  );

  const dossier = can("customers.dossier360") ? dossierQuery.data : undefined;
  const customer = dossier?.customer;
  const metrics = dossier?.metrics;

  const latestFiveStarFeedback =
    dossier?.recentFeedback?.find(
      (f) => f.rating === 5 && !f.googleReviewInviteSent,
    ) || dossier?.recentFeedback?.find((f) => f.rating === 5);

  const handleSendGoogleReviewInvite = (feedbackId?: number) => {
    if (markGoogleReviewMutation.isPending) return;
    if (!customer || !can("customers.markGoogleReviewInviteSent")) return;
    const phone = preferredWhatsAppPhone(customer.whatsapp, customer.phone);
    if (!phone) {
      notify.err("لا يوجد رقم هاتف أو واتساب مسجل لهذا الزبون");
      return;
    }

    const message = buildGoogleReviewInviteWhatsAppMessage({
      customerName: customer.name,
    });

    openWhatsApp(phone, message);

    setPendingInvite({ feedbackId });
  };

  const handlePrintCoupon = async (coupon: DossierCoupon) => {
    if (!customer || !canPrintFixedCoupon(coupon)) return;
    try {
      const res = await printGiftVoucherDoc({
        couponCode: coupon.code,
        amount: String(coupon.discountAmount),
        customerName: customer.name,
        customerPhone:
          preferredWhatsAppPhone(customer.whatsapp, customer.phone) ||
          customer.phone ||
          customer.whatsapp,
        reason: coupon.programName || undefined,
        validUntil: coupon.validTo ?? undefined,
        terms: "تُخصم لمرة واحدة على أي فاتورة مبيعات أو أمر شغل داخل فروعنا.",
      });
      if (res && !res.ok) {
        if (res.reason === "popup-blocked") {
          notify.err(
            "تم حظر نافذة الطباعة من قبل المتصفح، يرجى السماح بالنوافذ المنبثقة للموقع",
          );
        } else {
          notify.err("تعذر إرسال القسيمة إلى الطابعة");
        }
        return;
      }
      notify.ok("تم إرسال قسيمة الهدية للطباعة");
    } catch {
      notify.err("تعذر إرسال القسيمة إلى الطابعة");
    }
  };

  const handleSendCouponWhatsApp = (coupon: DossierCoupon) => {
    if (!customer || !canPrintFixedCoupon(coupon)) return;
    const phone = preferredWhatsAppPhone(customer.whatsapp, customer.phone);
    if (!phone) {
      notify.err("لا يوجد رقم هاتف أو واتساب مسجل لهذا الزبون");
      return;
    }
    const message = buildInstantGiftWhatsAppMessage({
      customerName: customer.name,
      code: coupon.code,
      amount: String(coupon.discountAmount),
      reason: coupon.programName || undefined,
      validUntil: coupon.validTo ? fmtDate(coupon.validTo) : undefined,
    });
    openWhatsApp(phone, message);
  };

  const confirmInviteSent = () => {
    if (
      !customer ||
      !pendingInvite ||
      !can("customers.markGoogleReviewInviteSent") ||
      markGoogleReviewMutation.isPending
    )
      return;
    markGoogleReviewMutation.mutate(
      { customerId: customer.id, feedbackId: pendingInvite.feedbackId },
      {
        onSuccess: () =>
          setPendingInvite((current) =>
            current === pendingInvite ? null : current,
          ),
      },
    );
  };

  return {
    can,
    giftModalOpen,
    setGiftModalOpen,
    feedbackModalOpen,
    setFeedbackModalOpen,
    targetFeedbackId,
    setTargetFeedbackId,
    targetWorkOrderId,
    setTargetWorkOrderId,
    targetWorkOrderNumber,
    setTargetWorkOrderNumber,
    utils,
    dossierQuery,
    updateStatusMutation,
    markGoogleReviewMutation,
    canReadReports,
    dossier,
    customer,
    metrics,
    latestFiveStarFeedback,
    handleSendGoogleReviewInvite,
    handlePrintCoupon,
    handleSendCouponWhatsApp,
    pendingInvite,
    setPendingInvite,
    confirmInviteSent,
    isFeedbackSessionCurrent,
  };
}
export type CustomerDossierModel = ReturnType<typeof useCustomerDossier>;
