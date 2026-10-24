import type { RouterInputs, RouterOutputs } from "@/lib/trpc";
import type { ManagerApprovalInput } from "@/components/reception/ManagerApprovalDialog";
import { notify } from "@/lib/notify";
import { buildDraftPayload } from "@/components/reception/draftPayloadBuilder";
import { trpc } from "@/lib/trpc";
import {
  createReceptionDraftPointer,
  prepareReceptionLocalWorkspaceRestore,
  resolveReceptionRestoredPricingContext,
  type ReceptionLocalWorkspaceSnapshot,
  type ReceptionServerDraftPointer,
} from "@/lib/receptionWorkspaceState";
import {
  type CartLine,
  type PayMethod,
  type PosRow,
  type Tier,
} from "@/components/reception/cartMath";
export interface ReceptionRestoreWorkspaceInput {
  branchId: number;
  setDraftPromotionPending: React.Dispatch<React.SetStateAction<boolean>>;
  setDraftPromotionShiftId: React.Dispatch<React.SetStateAction<number | null>>;
  resolvePromotionM: {
    mutateAsync: (
      input: RouterInputs["reception"]["draftResolvePromotion"],
    ) => Promise<RouterOutputs["reception"]["draftResolvePromotion"]>;
  };
  attachResolvedPromotion: (result: {
    draftId: number;
    version: number;
    draftNumber: string;
  }) => Promise<boolean>;
  setDraftRestoreRecovery: React.Dispatch<
    React.SetStateAction<{
      snapshot: import("@/lib/receptionWorkspaceState").ReceptionServerDraftPointer;
      serverAvailable: boolean;
    } | null>
  >;
  restoreCustomerM: {
    mutateAsync: (
      input: RouterInputs["customers"]["receptionResolveByPhone"],
    ) => Promise<RouterOutputs["customers"]["receptionResolveByPhone"]>;
  };
  utils: ReturnType<typeof trpc.useUtils>;
  restoreCouponPreviewM: {
    mutateAsync: (
      input: RouterInputs["crm"]["coupons"]["preview"],
    ) => Promise<RouterOutputs["crm"]["coupons"]["preview"]>;
  };
  isElevatedRole: boolean;
  prevCustomerIdRef: React.RefObject<number | null>;
  pendingDeferredRestoreRef: React.RefObject<boolean>;
  suppressHydratedPhoneResetRef: React.RefObject<boolean>;
  receptionPhone: string;
  setCheckoutCharges: React.Dispatch<React.SetStateAction<import("@shared/checkoutCharges").CheckoutChargesInput>>;
  setCart: React.Dispatch<
    React.SetStateAction<import("@/components/reception/cartMath").CartLine[]>
  >;
  setSelKey: React.Dispatch<React.SetStateAction<string | null>>;
  setReceptionPhone: (digits: string) => void;
  setCustomer: (
    customer: import("@/components/customer/customerByPhoneMachine").PhoneCustomer,
  ) => void;
  setCustomerCreditLimit: (raw: string) => void;
  setTierOverride: React.Dispatch<
    React.SetStateAction<import("@/components/reception/cartMath").Tier | null>
  >;
  setHydratedAutomaticTier: React.Dispatch<
    React.SetStateAction<import("@/components/reception/cartMath").Tier | null>
  >;
  setInvoiceDiscountPct: React.Dispatch<React.SetStateAction<string>>;
  setPayInput: React.Dispatch<React.SetStateAction<string>>;
  setMethod: React.Dispatch<
    React.SetStateAction<import("@/components/reception/cartMath").PayMethod>
  >;
  setPaymentReference: React.Dispatch<React.SetStateAction<string>>;
  setDeferred: React.Dispatch<React.SetStateAction<boolean>>;
  setCouponInput: React.Dispatch<React.SetStateAction<string>>;
  setCouponCode: React.Dispatch<React.SetStateAction<string | null>>;
  setCouponLabel: React.Dispatch<React.SetStateAction<string | null>>;
  setChannel: React.Dispatch<
    React.SetStateAction<
      "OTHER" | "WALK_IN" | "WHATSAPP" | "INSTAGRAM" | "TIKTOK" | "PHONE"
    >
  >;
  setChannelHandle: React.Dispatch<React.SetStateAction<string>>;
  setLinkedConversationId: React.Dispatch<React.SetStateAction<number | null>>;
  setDetachedRecoveryPending: React.Dispatch<React.SetStateAction<boolean>>;
  activeDraftRef: React.RefObject<{ id: number; version: number } | null>;
  setActiveDraft: React.Dispatch<
    React.SetStateAction<{ id: number; version: number } | null>
  >;
  setDraftHeld: React.Dispatch<React.SetStateAction<string>>;
  setDraftInfo: React.Dispatch<
    React.SetStateAction<{ draftNumber: string } | null>
  >;
  mgrCredsRef: React.RefObject<ManagerApprovalInput | null>;
}
export async function ReceptionRestoreWorkspace(
  {
    branchId,
    setDraftPromotionPending,
    setDraftPromotionShiftId,
    resolvePromotionM,
    attachResolvedPromotion,
    setDraftRestoreRecovery,
    restoreCustomerM,
    utils,
    restoreCouponPreviewM,
    isElevatedRole,
    prevCustomerIdRef,
    pendingDeferredRestoreRef,
    suppressHydratedPhoneResetRef,
    receptionPhone,
    setCheckoutCharges,
    setCart,
    setSelKey,
    setReceptionPhone,
    setCustomer,
    setCustomerCreditLimit,
    setTierOverride,
    setHydratedAutomaticTier,
    setInvoiceDiscountPct,
    setPayInput,
    setMethod,
    setPaymentReference,
    setDeferred,
    setCouponInput,
    setCouponCode,
    setCouponLabel,
    setChannel,
    setChannelHandle,
    setLinkedConversationId,
    setDetachedRecoveryPending,
    activeDraftRef,
    setActiveDraft,
    setDraftHeld,
    setDraftInfo,
    mgrCredsRef,
  }: ReceptionRestoreWorkspaceInput,
  snapshot: ReceptionLocalWorkspaceSnapshot,
  isCurrent: () => boolean,
  preserveStoredPrices = false,
): Promise<boolean> {
  try {
    if (snapshot.draftPromotionPending) {
      setDraftPromotionPending(true);
      setDraftPromotionShiftId(snapshot.draftPromotionShiftId);
      const payload = buildDraftPayload({
        customer: snapshot.customer,
        effectiveTier: snapshot.effectiveTier,
        channel: snapshot.channel.kind,
        channelHandle: snapshot.channel.handle,
        linkedConversationId: snapshot.channel.linkedConversationId,
        cart: snapshot.cart,
        checkoutCharges:snapshot.checkoutCharges,
      });
      const resolved = await resolvePromotionM.mutateAsync({
        branchId,
        shiftId: snapshot.draftPromotionShiftId,
        clientRequestId: snapshot.clientRequestId,
        ...payload,
      });
      if (!isCurrent()) return false;
      if (resolved?.payloadMatches) return attachResolvedPromotion(resolved);
      if (resolved) {
        setDraftPromotionPending(false);
        setDraftRestoreRecovery({
          snapshot: createReceptionDraftPointer({
            activeDraftId: resolved.draftId,
            draftVersion: resolved.version,
            pendingLocal: {
              ...snapshot,
              draftPromotionPending: false,
              detachedRecoveryPending: true,
            },
          }),
          serverAvailable: true,
        });
        return false;
      }
    }
    const restored = await prepareReceptionLocalWorkspaceRestore(snapshot, {
      isCurrent,
      resolveAutomaticPricingContext: (input) =>
        resolveReceptionRestoredPricingContext(
          input,
          (phone) => restoreCustomerM.mutateAsync({ phone }),
          (customerId) =>
            utils.customers.receptionResolveById.fetch(
              { customerId },
              { staleTime: 0 },
            ),
        ),
      loadCatalog: async ({ productUnitIds, tier, customerId }) =>
        utils.catalog.byUnitIds.fetch({
          branchId,
          tier,
          productUnitIds,
          customerId: customerId ?? undefined,
        }) as Promise<PosRow[]>,
      previewCoupon: async ({ code, tier, customerId, lines }) =>
        restoreCouponPreviewM.mutateAsync({
          code,
          branchId,
          customerId: customerId ?? undefined,
          customerTier: tier,
          lines,
        }),
      preserveStoredPrices:
        preserveStoredPrices || snapshot.draftPromotionPending,
    });
    if (!isCurrent()) return false;
    if (!restored.ok) {
      if (restored.reason === "MISSING_CATALOG")
        notify.warn(
          "تعذّر استعادة السلة بأمان",
          `وحدة أو صنف لم يعد متاحاً (${restored.missingUnitIds?.join("، ")})؛ لم نستخدم أسعاراً أو معاملات قديمة.`,
        );
      else if (restored.reason === "NO_COUPON_LINES")
        notify.warn(
          "تعذّر استعادة الكوبون بأمان",
          "لم تعد في السلة بنود صالحة للكوبون؛ فرّغ الحالة وابدأ طلباً جديداً.",
        );
      return false;
    }
    const droppedPrivilegedDiscount =
      !isElevatedRole &&
      (restored.cart.some((line) => (line.disc ?? 0) > 10) ||
        Number(snapshot.invoiceDiscountPct || 0) > 15);
    const restoredCart = droppedPrivilegedDiscount
      ? restored.cart.map((line) =>
          (line.disc ?? 0) > 10 ? { ...line, disc: undefined } : line,
        )
      : restored.cart;
    if (droppedPrivilegedDiscount)
      notify.warn(
        "أُزيل خصم يحتاج اعتماداً جديداً",
        "بيانات اعتماد المدير لا تُخزّن؛ أعد تطبيق الخصم ليُطلب الاعتماد بأمان.",
      );
    prevCustomerIdRef.current = restored.customer.customerId;
    pendingDeferredRestoreRef.current = snapshot.payment.deferred;
    suppressHydratedPhoneResetRef.current =
      snapshot.phoneInput !== receptionPhone;
    setCart(restoredCart);
    setCheckoutCharges(snapshot.checkoutCharges??{});
    setSelKey(null);
    setReceptionPhone(snapshot.phoneInput);
    setCustomer(restored.customer);
    setCustomerCreditLimit(snapshot.customerCreditLimit);
    setTierOverride(snapshot.tierOverride);
    setHydratedAutomaticTier(
      snapshot.tierOverride == null ? restored.tier : null,
    );
    setInvoiceDiscountPct(
      droppedPrivilegedDiscount && Number(snapshot.invoiceDiscountPct || 0) > 15
        ? ""
        : snapshot.invoiceDiscountPct,
    );
    setPayInput(snapshot.payment.amount);
    setMethod(snapshot.payment.method);
    setPaymentReference("");
    setDeferred(false);
    setCouponInput(snapshot.coupon.input);
    setCouponCode(restored.couponCode);
    setCouponLabel(restored.couponLabel);
    setChannel(snapshot.channel.kind);
    setChannelHandle(snapshot.channel.handle);
    setLinkedConversationId(snapshot.channel.linkedConversationId);
    setDraftPromotionPending(snapshot.draftPromotionPending);
    setDraftPromotionShiftId(snapshot.draftPromotionShiftId);
    setDetachedRecoveryPending(snapshot.detachedRecoveryPending);
    activeDraftRef.current = null;
    setActiveDraft(null);
    setDraftHeld("0.00");
    setDraftInfo(null);
    mgrCredsRef.current = null;
    return true;
  } catch (error) {
    if (isCurrent())
      notify.warn(
        "تعذّر التحقق من السلة المحفوظة",
        error instanceof Error
          ? error.message
          : "تحقّق من الاتصال ثم أعد تحميل الصفحة",
      );
    return false;
  }
}
