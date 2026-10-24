import { toWorkOrderChannel } from "@shared/receptionChannel";
import { toLocalIqMobileDigits } from "@/components/form/PhoneDigitsInput";
import { useCustomerByPhone } from "@/components/customer/useCustomerByPhone";
import { fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import {
  prepareReceptionDraftCart,
  prepareReceptionDraftSwitch,
  type ReceptionDraftSyncQueue,
  type ReceptionLocalWorkspaceSnapshot,
  type ReceptionServerDraftPointer,
} from "@/lib/receptionWorkspaceState";
import {
  type CartLine,
  type PayMethod,
  type PosRow,
  type Tier,
} from "@/components/reception/cartMath";
export interface ReceptionResumeDraftInput {
  onCommittedRecovery?:(draftId:number)=>Promise<boolean>;
  onPaymentScopeChanged?: () => void;
  branchId: number;
  offline: boolean;
  activeDraftRef: React.RefObject<{ id: number; version: number } | null>;
  phoneResolution: import("@/components/customer/customerByPhoneMachine").PhoneResolution;
  phoneCustomer: ReturnType<typeof useCustomerByPhone>;
  couponPreview: { isPending: boolean };
  draftResumeEpochRef: React.RefObject<number>;
  setDraftTransitionPending: React.Dispatch<React.SetStateAction<boolean>>;
  draftSyncTimer: React.RefObject<NodeJS.Timeout | null>;
  draftSyncQueueRef: React.RefObject<ReceptionDraftSyncQueue<ReturnType<typeof import("./draftPayloadBuilder").buildDraftPayload>>|null>;
  workspaceDirty: boolean;
  flushActiveDraft: (
    customerIdOverride?: number | null | undefined,
    handleFailure?: boolean,
  ) => Promise<
    import("@/lib/receptionWorkspaceState").ReceptionDraftSyncOutcome
  >;
  utils: ReturnType<typeof trpc.useUtils>;
  handleDraftSyncFailure: (outcome: {
    ok: false;
    draftId: number | null;
    reason: "SUPERSEDED" | "FAILED" | "NO_ACTIVE";
    error: unknown;
  }) => void;
  setActiveDraft: React.Dispatch<
    React.SetStateAction<{ id: number; version: number } | null>
  >;
  setDraftRestoreRecovery: React.Dispatch<
    React.SetStateAction<{
      snapshot: import("@/lib/receptionWorkspaceState").ReceptionServerDraftPointer;
      serverAvailable: boolean;
    } | null>
  >;
  restoreLocalWorkspace: (
    snapshot: import("@/lib/receptionWorkspaceState").ReceptionLocalWorkspaceSnapshot,
    isCurrent: () => boolean,
    preserveStoredPrices?: boolean,
  ) => Promise<boolean>;
  setDraftHeld: React.Dispatch<React.SetStateAction<string>>;
  setDraftInfo: React.Dispatch<
    React.SetStateAction<{ draftNumber: string } | null>
  >;
  setDetachedRecoveryPending: React.Dispatch<React.SetStateAction<boolean>>;
  clearCouponIfApplied: () => void;
  setCheckoutCharges: React.Dispatch<React.SetStateAction<import("@shared/checkoutCharges").CheckoutChargesInput>>;
  setCart: React.Dispatch<
    React.SetStateAction<import("@/components/reception/cartMath").CartLine[]>
  >;
  setReceptionPhone: (digits: string) => void;
  prevCustomerIdRef: React.RefObject<number | null>;
  setCustomer: (
    customer: import("@/components/customer/customerByPhoneMachine").PhoneCustomer,
  ) => void;
  setTierOverride: React.Dispatch<
    React.SetStateAction<import("@/components/reception/cartMath").Tier | null>
  >;
  setChannel: React.Dispatch<
    React.SetStateAction<
      "OTHER" | "WALK_IN" | "WHATSAPP" | "INSTAGRAM" | "TIKTOK" | "PHONE"
    >
  >;
  setChannelHandle: React.Dispatch<React.SetStateAction<string>>;
  setLinkedConversationId: React.Dispatch<React.SetStateAction<number | null>>;
  setPayInput: React.Dispatch<React.SetStateAction<string>>;
  setMethod: React.Dispatch<
    React.SetStateAction<import("@/components/reception/cartMath").PayMethod>
  >;
  setPaymentReference: React.Dispatch<React.SetStateAction<string>>;
  setDeferred: React.Dispatch<React.SetStateAction<boolean>>;
  setCustomerCreditLimit: (raw: string) => void;
  setInvoiceDiscountPct: React.Dispatch<React.SetStateAction<string>>;
  setCouponInput: React.Dispatch<React.SetStateAction<string>>;
}
export async function ReceptionResumeDraft(
  {
    branchId,
    offline,
    activeDraftRef,
    phoneResolution,
    phoneCustomer,
    couponPreview,
    draftResumeEpochRef,
    setDraftTransitionPending,
    draftSyncTimer,
    draftSyncQueueRef,
    workspaceDirty,
    flushActiveDraft,
    utils,
    handleDraftSyncFailure,
    setActiveDraft,
    setDraftRestoreRecovery,
    restoreLocalWorkspace,
    setDraftHeld,
    setDraftInfo,
    setDetachedRecoveryPending,
    clearCouponIfApplied,
    setCheckoutCharges,
    setCart,
    setReceptionPhone,
    prevCustomerIdRef,
    setCustomer,
    setTierOverride,
    setChannel,
    setChannelHandle,
    setLinkedConversationId,
    setPayInput,
    setMethod,
    setPaymentReference,
    setDeferred,
    setCustomerCreditLimit,
    setInvoiceDiscountPct,
    setCouponInput,
    onPaymentScopeChanged,onCommittedRecovery,
  }: ReceptionResumeDraftInput,
  draftId: number,
  isHydrationCurrent: () => boolean = () => true,
  forceReload = false,
  shadow?: ReceptionServerDraftPointer,
): Promise<boolean> {
  if (!forceReload && !shadow && activeDraftRef.current?.id === draftId)
    return true;
  if (
    !forceReload &&
    (phoneResolution === "CHECKING" ||
      phoneCustomer.isPending ||
      couponPreview.isPending)
  ) {
    notify.warn(
      "لم يُفتح الطلب الآخر",
      "انتظر اكتمال التحقق من العميل أو الكوبون أولاً.",
    );
    return false;
  }
  const resumeEpoch = ++draftResumeEpochRef.current;
  setDraftTransitionPending(true);
  const isCurrent = () =>
    resumeEpoch === draftResumeEpochRef.current && isHydrationCurrent();
  try {
    if (forceReload) {
      if (draftSyncTimer.current) clearTimeout(draftSyncTimer.current);
      draftSyncTimer.current = null;
      await draftSyncQueueRef.current?.supersedeAndDrain();
      if (!isCurrent()) return false;
    }
    // staleTime:0 إلزاميّ (مراجعة ش٤): الافتراض العام ٦٠ث كان يعيد نسخة الكاش بعد CONFLICT/
    // حارس I3 — heldTotal وversion وبنوداً متقادمة دقيقةً كاملة ⇒ حلقة CONFLICT وتحصيلٌ زائد.
    const switched = await prepareReceptionDraftSwitch({
      active: activeDraftRef.current,
      targetDraftId: draftId,
      forceReload,
      localDirty: shadow == null && workspaceDirty,
      offline,
      isCurrent,
      flush: () => flushActiveDraft(undefined, false),
      load: () => utils.reception.draftGet.fetch({ draftId }, { staleTime: 0 }),
    });
    if (!switched.ok) {
      if (switched.reason === "OFFLINE")
        notify.warn(
          "لم يُفتح الطلب الآخر",
          "الطلب الحالي يحمل تعديلات؛ أعد الاتصال ليُحفظ أولاً.",
        );
      else if (switched.reason === "LOCAL_DIRTY")
        notify.warn(
          "السلة الحالية لم تُحفظ",
          "احفظها كطلب محفوظ أو فرّغها صراحةً قبل فتح طلب آخر.",
        );
      else if (switched.reason === "SYNC") {
        const failed = switched.syncOutcome!;
        const code = (failed.error as { data?: { code?: string } })?.data?.code;
        if (code === "PRECONDITION_FAILED" || code === "CONFLICT")
          handleDraftSyncFailure(failed);
        notify.warn(
          "لم يُفتح الطلب الآخر",
          "تعذّر حفظ تعديلات الطلب الحالي؛ بقي مفتوحاً ولم تُستبدل سلته.",
        );
      }
      return false;
    }
    if (switched.kind === "NOOP") return true;
    const d = switched.draft;
    if(d.status==="COMMITTED"&&shadow&&d.checkoutCharges&&onCommittedRecovery)return await onCommittedRecovery(draftId);
    if (d.status !== "OPEN") {
      const closedMessage =
        d.status === "COMMITTED"
          ? "ثُبّت الطلب من جهاز آخر؛ افتح الفواتير أو أوامر الشغل لمراجعة النتيجة."
          : "أُلغي الطلب أو انتهت صلاحيته؛ اختر طلباً مفتوحاً من الشريط.";
      if (activeDraftRef.current?.id === draftId) {
        activeDraftRef.current = null;
        setActiveDraft(null);
      }
      if (shadow)
        setDraftRestoreRecovery({ snapshot: shadow, serverAvailable: false });
      notify.warn("الطلب المحفوظ لم يعد مفتوحاً", closedMessage);
      return false;
    }
    if (shadow) {
      if (Number(d.version) !== shadow.draftVersion) {
        setDraftRestoreRecovery({ snapshot: shadow, serverAvailable: true });
        notify.warn(
          "توجد نسخة أحدث للطلب المحفوظ",
          "احتفظنا بالنسخة المحلية؛ اختر تحميل الخادم أو استعادتها منفصلةً للمراجعة.",
        );
        return false;
      }
      if (
        !(await restoreLocalWorkspace(shadow.pendingLocal, isCurrent, true)) ||
        !isCurrent()
      )
        return false;
      const restoredDraft = { id: draftId, version: Number(d.version) };
      activeDraftRef.current = restoredDraft;
      setActiveDraft(restoredDraft);
      setDraftHeld(String((d as { heldTotal?: string }).heldTotal ?? "0.00"));
      setDraftInfo({ draftNumber: d.draftNumber });
      setDraftRestoreRecovery(null);
      setDetachedRecoveryPending(false);
      notify.ok(
        `استُعيدت تعديلات ${d.draftNumber}`,
        "ستُزامَن تلقائياً مع نسخة الخادم الحالية",
      );
      return true;
    }
    const unitIds = Array.from(
      new Set(d.lines.map((l) => Number(l.productUnitId)).filter((n) => n > 0)),
    );
    const live = unitIds.length
      ? await utils.catalog.byUnitIds.fetch({
          branchId,
          tier: (d.priceTier as Tier) ?? "RETAIL",
          productUnitIds: unitIds,
          customerId: d.customerId != null ? Number(d.customerId) : undefined,
        })
      : [];
    if (!isCurrent()) return false;
    const prepared = prepareReceptionDraftCart(d.lines, live as PosRow[]);
    if (!prepared.ok) {
      if (activeDraftRef.current?.id === draftId) {
        activeDraftRef.current = null;
        setActiveDraft(null);
      }
      notify.warn(
        "تعذّر فتح الطلب المحفوظ بأمان",
        `${prepared.missingCount} بند غير متاح في الكتالوج؛ لم نغيّر المسوّدة كي لا تُحذف بنودها.`,
      );
      return false;
    }
    if (!shadow && activeDraftRef.current?.id !== draftId && (!forceReload || activeDraftRef.current != null)) onPaymentScopeChanged?.();
    clearCouponIfApplied();
    setCart(prepared.cart);
    setCheckoutCharges(d.checkoutCharges??{});
    setReceptionPhone(toLocalIqMobileDigits(d.contactPhone ?? ""));
    const restoredCustomerId =
      d.customerId != null ? Number(d.customerId) : null;
    prevCustomerIdRef.current = restoredCustomerId;
    setCustomer({
      customerId: restoredCustomerId,
      name: d.contactName ?? "",
      phone: d.contactPhone ?? null,
      isNew: false,
    });
    setTierOverride((d.priceTier as Tier) ?? null);
    setChannel(toWorkOrderChannel(d.channel));
    setChannelHandle(d.channelHandle ?? "");
    setLinkedConversationId(
      d.conversationId != null ? Number(d.conversationId) : null,
    );
    setPayInput("");
    setMethod("CASH");
    setPaymentReference("");
    setDeferred(false);
    setCustomerCreditLimit("");
    setInvoiceDiscountPct("");
    setCouponInput("");
    const restoredDraft = { id: draftId, version: Number(d.version) };
    activeDraftRef.current = restoredDraft;
    setActiveDraft(restoredDraft);
    // ش٤: صافي المقبوض سلفاً يرافق الاستئناف — «المتوقّع الآن» يهبط به فوراً.
    setDraftHeld(String((d as { heldTotal?: string }).heldTotal ?? "0.00"));
    setDraftInfo({ draftNumber: d.draftNumber });
    setDraftRestoreRecovery(null);
    setDetachedRecoveryPending(false);
    const heldNote =
      Number((d as { heldTotal?: string }).heldTotal ?? 0) > 0
        ? ` — عليها عربون مقبوض ${fmt(Number((d as { heldTotal?: string }).heldTotal))} د.ع`
        : "";
    notify.ok(
      `فُتحت المسوّدة ${d.draftNumber}${heldNote}`,
      "تعديلاتك تُزامَن وتُسجَّل باسمك",
    );
    return true;
  } catch (e) {
    if (!isCurrent()) return false;
    if (shadow)
      setDraftRestoreRecovery({ snapshot: shadow, serverAvailable: true });
    notify.err(e, "تعذّر فتح المسوّدة");
    return false;
  } finally {
    if (isCurrent()) setDraftTransitionPending(false);
  }
}
