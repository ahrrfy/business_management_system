import { useCallback, useEffect, useRef, useState } from "react";
import type { POSTab } from "@/components/pos/posShared";
import { newClientRequestId } from "@/lib/countQueue";
import { notify } from "@/lib/notify";
import { offlineDb } from "@/lib/offline/db";
import {
  type PreflightSaleIntentV4,
  clearPreflightSaleIntent,
  listRecoverablePreflightSaleIntents,
  markPreflightIntentLiveInMemory,
  markPreflightSaleIntentUnconfirmed,
  recordPreflightSaleIntent,
  unmarkPreflightIntentLiveInMemory,
} from "@/lib/offline/outbox";
import { trpc } from "@/lib/trpc";

interface UsePOSPreflightReconciliationOptions {
  branchId: number;
  offline: boolean;
  viewerUserId: number | null;
  hasAuthenticatedUser: boolean;
  viewerCanAdminReconcile: boolean;
  isSalePending: boolean;
  utils: ReturnType<typeof trpc.useUtils>;
  setLastInv: (v: { num: string; total: number } | null) => void;
  patchTab: (tabId: number, patch: Partial<POSTab>) => void;
  setCreditPrompt: (msg: string | null | ((prev: string | null) => string | null)) => void;
  setSaleError: (msg: string | null) => void;
  releaseReservedPrintWindow: () => void;
  onTriggerSameKeyReplay: (intent: PreflightSaleIntentV4) => void;
}

/** Manages preflight v4 intent persistence, multi-tab fencing, and automatic recovery upon reconnect. */
export function usePOSPreflightReconciliation(options: UsePOSPreflightReconciliationOptions) {
  const {
    branchId,
    offline,
    viewerUserId,
    hasAuthenticatedUser,
    viewerCanAdminReconcile,
    isSalePending,
    utils,
    setLastInv,
    patchTab,
    setCreditPrompt,
    setSaleError,
    releaseReservedPrintWindow,
    onTriggerSameKeyReplay,
  } = options;

  const [unconfirmedSaleIntents, setUnconfirmedSaleIntents] = useState<PreflightSaleIntentV4[]>([]);
  const unconfirmedSaleIntent = unconfirmedSaleIntents[0] ?? null;
  const [foreignOwnerPendingCount, setForeignOwnerPendingCount] = useState(0);
  const [activeInOtherTabCount, setActiveInOtherTabCount] = useState(0);
  const [earliestOtherTabLeaseExpiryMs, setEarliestOtherTabLeaseExpiryMs] = useState<number | null>(null);
  const [preflightRecheckTick, setPreflightRecheckTick] = useState(0);
  const reconcilingPreflightRef = useRef(false);
  const lastPreflightAttemptMsRef = useRef(0);
  const attemptedSameKeyReplayIdsRef = useRef<Set<string>>(new Set());

  const hasBlockingConflict =
    unconfirmedSaleIntents.length > 0 || foreignOwnerPendingCount > 0 || activeInOtherTabCount > 0;

  const getBlockingMessage = useCallback(() => {
    if (activeInOtherTabCount > 0) {
      return "توجد عملية بيع قيد الإرسال حالياً في تبويب آخر على هذا المتصفح — انتظر اكتمالها أولاً.";
    }
    if (foreignOwnerPendingCount > 0) {
      return "توجد فاتورة معلّقة لموظف آخر على هذا الجهاز — سجّل دخول الموظف الأصلي أو المدير لمصالحتها أولاً.";
    }
    return "توجد فاتورة بحالة غير مؤكدة على الخادم — انتظر المصالحة التلقائية أو سيّج الإلغاء خادمياً قبل بدء بيع جديد.";
  }, [activeInOtherTabCount, foreignOwnerPendingCount]);

  const refreshRecoverablePreflightQueue = useCallback(async () => {
    if (viewerUserId == null) {
      setUnconfirmedSaleIntents([]);
      setForeignOwnerPendingCount(0);
      setActiveInOtherTabCount(0);
      setEarliestOtherTabLeaseExpiryMs(null);
      return;
    }
    const res = await listRecoverablePreflightSaleIntents({
      branchId,
      viewerUserId,
      viewerCanAdminReconcile,
    });
    setUnconfirmedSaleIntents(res.intents);
    setForeignOwnerPendingCount(res.foreignOwnerPendingCount);
    setActiveInOtherTabCount(res.activeInOtherTabCount);
    setEarliestOtherTabLeaseExpiryMs(res.earliestOtherTabLeaseExpiryMs ?? null);
  }, [branchId, viewerUserId, viewerCanAdminReconcile]);

  useEffect(() => {
    void refreshRecoverablePreflightQueue();
  }, [refreshRecoverablePreflightQueue]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (ev: StorageEvent) => {
      if (!ev.key || ev.key.startsWith("alroya.preflightIntent.v4:")) {
        void refreshRecoverablePreflightQueue();
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [refreshRecoverablePreflightQueue]);

  useEffect(() => {
    if (typeof window === "undefined" || activeInOtherTabCount <= 0) return;
    const waitMs =
      earliestOtherTabLeaseExpiryMs != null
        ? Math.min(15_000, Math.max(250, earliestOtherTabLeaseExpiryMs - Date.now() + 250))
        : 12_500;
    const timer = window.setTimeout(() => {
      void refreshRecoverablePreflightQueue();
    }, waitMs);
    return () => window.clearTimeout(timer);
  }, [activeInOtherTabCount, earliestOtherTabLeaseExpiryMs, refreshRecoverablePreflightQueue]);

  const handleMutationSuccess = useCallback(
    async (doneReqId: string) => {
      reconcilingPreflightRef.current = false;
      attemptedSameKeyReplayIdsRef.current.delete(doneReqId);
      unmarkPreflightIntentLiveInMemory(doneReqId);
      await clearPreflightSaleIntent(doneReqId);
      await refreshRecoverablePreflightQueue();
    },
    [refreshRecoverablePreflightQueue],
  );

  const handleMutationError = useCallback(
    (params: {
      err: { data?: unknown; message: string };
      reqId: string;
      offlineCapturable: boolean;
      captureOfflineSale: () => Promise<boolean>;
      clearPendingSaleCtx: () => void;
    }) => {
      const { err, reqId, offlineCapturable, captureOfflineSale, clearPendingSaleCtx } = params;
      reconcilingPreflightRef.current = false;
      const errData = err.data as unknown as { code?: string; httpStatus?: number } | null | undefined;
      const code = errData?.code;
      if (!code || (errData?.httpStatus != null && errData.httpStatus >= 500)) {
        clearPendingSaleCtx();
        if (offlineCapturable) {
          void captureOfflineSale()
            .then(async (capturedOk) => {
              if (capturedOk) {
                await clearPreflightSaleIntent(reqId);
              } else {
                releaseReservedPrintWindow();
                await markPreflightSaleIntentUnconfirmed(
                  reqId,
                  "انقطع الرد من الخادم وتعذّر الحفظ المحلي دون اتصال",
                );
              }
              await refreshRecoverablePreflightQueue();
            })
            .finally(() => {
              unmarkPreflightIntentLiveInMemory(reqId);
            });
          return;
        }
        unmarkPreflightIntentLiveInMemory(reqId);
        releaseReservedPrintWindow();
        void markPreflightSaleIntentUnconfirmed(
          reqId,
          "انقطع الرد من الخادم ولا تقبل هذه العملية الالتقاط دون اتصال",
        ).then(() => refreshRecoverablePreflightQueue());
        return;
      }

      unmarkPreflightIntentLiveInMemory(reqId);
      releaseReservedPrintWindow();
      const isManagerPromptError = Boolean(
        code === "PRECONDITION_FAILED" ||
          (err.message &&
            (err.message.includes("حدّ الائتمان") ||
              err.message.includes("بأقل من التكلفة") ||
              err.message.includes("موافقة مدير"))),
      );
      if (isManagerPromptError) {
        attemptedSameKeyReplayIdsRef.current.add(reqId);
      }
      void utils.offline.lookupPreflightSaleOutcome
        .fetch({ branchId, clientRequestId: reqId, mode: "OBSERVE" })
        .then(async (lookup) => {
          if (lookup.outcome === "COMMITTED") {
            attemptedSameKeyReplayIdsRef.current.delete(reqId);
            await clearPreflightSaleIntent(reqId);
            await refreshRecoverablePreflightQueue();
            notify.ok(
              `الفاتورة ${lookup.invoiceNumber} ملتزمة مسبقاً`,
              "تأكّد الخادم من التزام الفاتورة مسبقاً ولا حاجة لإعادة الإرسال",
            );
            return;
          }
          if (lookup.outcome === "FENCED_NOT_COMMITTED") {
            attemptedSameKeyReplayIdsRef.current.delete(reqId);
            await clearPreflightSaleIntent(reqId);
            await refreshRecoverablePreflightQueue();
            return;
          }
          await markPreflightSaleIntentUnconfirmed(
            reqId,
            lookup.outcome === "UNKNOWN_IN_FLIGHT"
              ? "العملية لا تزال قيد التنفيذ على الخادم؛ انتظر التحقق التلقائي"
              : "لم يتأكد التزام العملية على الخادم؛ أكمل بنفس المعرّف أو سيّج الإلغاء خادمياً",
          );
          await refreshRecoverablePreflightQueue();
        })
        .catch(async () => {
          await markPreflightSaleIntentUnconfirmed(
            reqId,
            "تعذّر إثبات نتيجة الطلب الأصلي على الخادم بعد رد غير حاسم",
          );
          await refreshRecoverablePreflightQueue();
        });

      if (isManagerPromptError) {
        setCreditPrompt(err.message);
      } else {
        notify.errBig(err);
        setSaleError(err.message);
      }
    },
    [branchId, releaseReservedPrintWindow, refreshRecoverablePreflightQueue, setCreditPrompt, setSaleError, utils],
  );

  const fenceAndCancelUnconfirmedIntent = useCallback(
    async (intent: PreflightSaleIntentV4) => {
      try {
        const existingOutbox = await offlineDb.outbox?.get?.(intent.clientRequestId);
        if (existingOutbox) {
          attemptedSameKeyReplayIdsRef.current.delete(intent.clientRequestId);
          await clearPreflightSaleIntent(intent.clientRequestId);
          await refreshRecoverablePreflightQueue();
          if (existingOutbox.status === "SENT") {
            notify.ok(
              `العملية مرحّلة مسبقاً — ${existingOutbox.resultInvoiceNumber ?? existingOutbox.offlineReceiptNumber}`,
              "وُجدت العملية في سجل المزامنة ولا حاجة لتسييجها.",
            );
          } else {
            notify.warn(
              `العملية محفوظة في طابور الأوفلاين (${existingOutbox.offlineReceiptNumber})`,
              "لا يجوز تسييج معرّف محفوظ أوفلاينياً؛ ستُزامَن تلقائياً أو تُعالج من درج المزامنة.",
            );
          }
          return;
        }
      } catch {
        /* ignore outbox precheck failures and defer to server lookup */
      }
      if (offline || !hasAuthenticatedUser) {
        notify.errBig("يتطلب تسييج وإلغاء الطلب غير الملتزم اتصالاً حياً بالخادم.");
        return;
      }
      try {
        const res = await utils.offline.lookupPreflightSaleOutcome.fetch({
          branchId,
          clientRequestId: intent.clientRequestId,
          expectedSemanticSha256: intent.semanticPayloadSha256 || undefined,
          mode: "FENCE_IF_UNCOMMITTED",
        });
        if (res.outcome === "COMMITTED") {
          attemptedSameKeyReplayIdsRef.current.delete(intent.clientRequestId);
          await clearPreflightSaleIntent(intent.clientRequestId);
          await refreshRecoverablePreflightQueue();
          setLastInv({ num: res.invoiceNumber, total: Number(res.total) });
          patchTab(intent.tabId, { clientRequestId: newClientRequestId() });
          notify.ok(
            `الفاتورة ملتزمة فعلياً — ${res.invoiceNumber}`,
            "كانت الفاتورة قد التزمت على الخادم مسبقاً؛ تمت المصالحة دون تكرار.",
          );
          return;
        }
        if (res.outcome === "FENCED_NOT_COMMITTED") {
          attemptedSameKeyReplayIdsRef.current.delete(intent.clientRequestId);
          await clearPreflightSaleIntent(intent.clientRequestId);
          await refreshRecoverablePreflightQueue();
          patchTab(intent.tabId, { clientRequestId: newClientRequestId() });
          notify.ok(
            "تم تسييج وإلغاء المعرّف المعلّق خادمياً",
            "ثبّت الخادم حاجز منع التنفيذ المتأخر لهذا المعرّف ويمكنك المتابعة بأمان.",
          );
          return;
        }
        notify.warn(
          "العملية قيد التنفيذ حالياً على الخادم",
          "رفض الخادم التسييج لأن الطلب لا يزال قيد التنفيذ؛ انتظر لحظات ثم أعد التحقق.",
        );
      } catch (err) {
        notify.errBig(err);
      }
    },
    [offline, hasAuthenticatedUser, utils, branchId, refreshRecoverablePreflightQueue, setLastInv, patchTab],
  );

  useEffect(() => {
    if (
      offline ||
      !hasAuthenticatedUser ||
      !unconfirmedSaleIntent ||
      isSalePending ||
      reconcilingPreflightRef.current
    ) {
      return;
    }
    const elapsedMs = Date.now() - lastPreflightAttemptMsRef.current;
    const delayMs = elapsedMs >= 1500 ? 0 : 1500 - elapsedMs;
    const timer = window.setTimeout(() => {
      if (reconcilingPreflightRef.current || isSalePending) return;
      reconcilingPreflightRef.current = true;
      lastPreflightAttemptMsRef.current = Date.now();
      void utils.offline.lookupPreflightSaleOutcome
        .fetch({
          branchId,
          clientRequestId: unconfirmedSaleIntent.clientRequestId,
          expectedSemanticSha256: unconfirmedSaleIntent.semanticPayloadSha256 || undefined,
          mode: "OBSERVE",
        })
        .then(async (lookup) => {
          if (lookup.outcome === "COMMITTED") {
            attemptedSameKeyReplayIdsRef.current.delete(unconfirmedSaleIntent.clientRequestId);
            await clearPreflightSaleIntent(unconfirmedSaleIntent.clientRequestId);
            await refreshRecoverablePreflightQueue();
            setLastInv({ num: lookup.invoiceNumber, total: Number(lookup.total) });
            patchTab(unconfirmedSaleIntent.tabId, {
              extraCharges: undefined,
              cart: [],
              payInput: "",
              selId: null,
              couponInput: "",
              couponCode: null,
              couponLabel: null,
              couponFreeShippingPromo: null,
              clientRequestId: newClientRequestId(),
              paymentRef: "",
              externalPayment: null,
              paymentLegs: [],
              dueDate: "",
              invoiceDiscountPct: "",
              delivery: null,
            });
            notify.ok(
              `تمت مصالحة الفاتورة المعلّقة — ${lookup.invoiceNumber}`,
              "ثبت التزام الفاتورة على الخادم مسبقاً دون تكرار",
            );
            reconcilingPreflightRef.current = false;
            return;
          }
          if (lookup.outcome === "FENCED_NOT_COMMITTED") {
            attemptedSameKeyReplayIdsRef.current.delete(unconfirmedSaleIntent.clientRequestId);
            await clearPreflightSaleIntent(unconfirmedSaleIntent.clientRequestId);
            await refreshRecoverablePreflightQueue();
            patchTab(unconfirmedSaleIntent.tabId, { clientRequestId: newClientRequestId() });
            reconcilingPreflightRef.current = false;
            return;
          }
          if (lookup.outcome === "UNKNOWN_IN_FLIGHT") {
            reconcilingPreflightRef.current = false;
            window.setTimeout(() => setPreflightRecheckTick((n) => n + 1), 1500);
            return;
          }
          const sameOwner =
            Number(unconfirmedSaleIntent.capturedByUserId) === Number(viewerUserId);
          const hasReplayableBody =
            !unconfirmedSaleIntent.commercialPayloadUnavailable &&
            Object.keys(unconfirmedSaleIntent.saleInput ?? {}).length > 0;
          if (
            sameOwner &&
            !unconfirmedSaleIntent.hadManagerApprovalAtSubmit &&
            hasReplayableBody &&
            !attemptedSameKeyReplayIdsRef.current.has(unconfirmedSaleIntent.clientRequestId)
          ) {
            attemptedSameKeyReplayIdsRef.current.add(unconfirmedSaleIntent.clientRequestId);
            markPreflightIntentLiveInMemory(unconfirmedSaleIntent.clientRequestId);
            onTriggerSameKeyReplay(unconfirmedSaleIntent);
            return;
          }
          if (sameOwner && unconfirmedSaleIntent.hadManagerApprovalAtSubmit) {
            patchTab(unconfirmedSaleIntent.tabId, {
              clientRequestId: unconfirmedSaleIntent.clientRequestId,
            });
            setCreditPrompt((prev) =>
              prev ??
              "لم يُعثر على التزام سابق لهذه الفاتورة بعد؛ أدخل موافقة المدير الحية لإتمامها بنفس المعرّف الأصلي أو استخدم زر التسييج والإلغاء الخادمي.",
            );
          }
          reconcilingPreflightRef.current = false;
        })
        .catch(() => {
          reconcilingPreflightRef.current = false;
        });
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [
    offline,
    hasAuthenticatedUser,
    viewerUserId,
    unconfirmedSaleIntent,
    isSalePending,
    branchId,
    utils,
    refreshRecoverablePreflightQueue,
    preflightRecheckTick,
    setLastInv,
    patchTab,
    setCreditPrompt,
    onTriggerSameKeyReplay,
  ]);

  const recordAndDispatchPreflightSale = useCallback(
    async (params: {
      clientRequestId: string;
      tabId: number;
      shiftId: number;
      total: string;
      saleInput: Record<string, unknown>;
      receiptContext?: Record<string, unknown> | null;
      onPersistFailed: () => void;
      dispatch: () => void;
    }) => {
      const persisted = await recordPreflightSaleIntent({
        clientRequestId: params.clientRequestId,
        tabId: params.tabId,
        branchId,
        shiftId: params.shiftId,
        capturedByUserId: Number(viewerUserId ?? 0),
        total: params.total,
        saleInput: params.saleInput,
        receiptContext: params.receiptContext ?? null,
      });
      if (!persisted) {
        params.onPersistFailed();
        const msg =
          "تعذّر حفظ نية البيع بأمان قبل الإرسال — رُفض إرسال العملية لمنع تكرار الفاتورة عند انقطاع الاتصال.";
        notify.errBig(msg);
        setSaleError(msg);
        return false;
      }
      markPreflightIntentLiveInMemory(params.clientRequestId);
      params.dispatch();
      return true;
    },
    [branchId, viewerUserId, setSaleError],
  );

  return {
    unconfirmedSaleIntents,
    unconfirmedSaleIntent,
    foreignOwnerPendingCount,
    activeInOtherTabCount,
    hasBlockingConflict,
    getBlockingMessage,
    fenceAndCancelUnconfirmedIntent,
    handleMutationSuccess,
    handleMutationError,
    recordAndDispatchPreflightSale,
  };
}
