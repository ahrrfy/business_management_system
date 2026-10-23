import { confirm } from "@/lib/confirm";
import { D, fmt } from "@/lib/money";
import { trpc, type RouterInputs } from "@/lib/trpc";
import {
  allocateOfflineReceiptNumber,
  assertCanCapture,
  enqueueOfflineReturn,
  isOfflineSaleEnabled,
} from "@/lib/offline/outbox";
import { notify } from "@/lib/notify";
import { invalidateFinancialQueries } from "@/lib/realtime/financialQueries";
import { ReturnComposerProps } from "./returnComposerTypes";
import type { useReturnComposerState } from "./useReturnComposerState";
import type { useReturnComposerSettlement } from "./useReturnComposerSettlement";
export function useReturnComposerMutations(
  ctx: Pick<
    ReturnType<typeof useReturnComposerState> &
      ReturnType<typeof useReturnComposerSettlement> &
      ReturnComposerProps,
    | "queryClient"
    | "me"
    | "setQty"
    | "setManualAmount"
    | "setRailState"
    | "setReason"
    | "setError"
    | "setDone"
    | "setClientRequestId"
    | "inv"
    | "pending"
    | "canWithdrawPending"
    | "onDone"
  >,
) {
  const {
    queryClient,
    me,
    setQty,
    setManualAmount,
    setRailState,
    setReason,
    setError,
    setDone,
    setClientRequestId,
    inv,
    pending,
    canWithdrawPending,
    onDone,
  } = ctx;

  // اعتماد طلبٍ قائم — يشارك نفس معالجات النجاح/الخطأ (سلوكٌ واحد للمستخدم).
  const approve = trpc.returns.approveRequest.useMutation({
    onSuccess: async (res) => {
      setDone("اعتُمد الطلب ونُفِّذ المرتجع.");
      setQty({});
      setManualAmount(null);
      setReason("");
      setClientRequestId(crypto.randomUUID());
      await invalidateFinancialQueries(queryClient, inv?.branchId);
      onDone?.({
        fullyReturned: !!res.fullyReturned,
        returnedTotal: String(res.returnedTotal ?? "0"),
      });
    },
    onError: (e) => setError(e.message),
  });

  /**
   * ⭐ **التقاطُ مرتجعٍ نقديّ عند فشل النقل فعلاً** (تدقيق ١/٩/٢٦ — البند الرابع).
   *
   * كان الأوفلاين بلا مرتجعٍ ولا طابور، فالزبونُ يعود ببضاعته أثناء الانقطاع ولا مسارَ أمام
   * الموظّف إلّا الدفعُ من خارج النظام والتسجيلُ لاحقاً — مصدرُ النقد اليتيم والعجز غير
   * المفسَّر في Z-report. الالتقاطُ يجعل الدينارَ موثَّقاً من لحظته.
   *
   * ⛔ **حدودٌ صريحة، ولا واحدٌ منها تجميليّ:**
   *  · **عند فشل النقل حصراً** (`Failed to fetch`) لا بالاختيار — نفس عقد الكاشير.
   *  · **نقدٌ فقط** (`method === "CASH"`) — البطاقة تحتاج جهازاً والآجل يحتاج سقفاً حيّاً.
   *  · **المالك وحده**: التنفيذ الفوريّ سلطتُه، والتقاطُ «طلبٍ» يترك النقدَ بلا مستند.
   *  · صمّاما الكاشير نفساهما: عمرُ اللقطة ≤٤٨س وسقفُ الطابور (`assertCanCapture`).
   *  · **السقفُ الماليّ يُقيَّم خادمياً عند الترحيل** — رفضُه يُعلّق العنصر في طابور
   *    الاسترداد بقناة RETURN لمراجعة المدير، فيصير العجزُ موثَّقاً بمستندٍ لا ضياعاً صامتاً.
   */
  async function captureOfflineReturn(
    submission: RouterInputs["returns"]["create"],
    snapshot: { branchId?: number; isOwner: boolean } | undefined,
  ): Promise<boolean> {
    const capturedRefund =
      submission.refund ??
      (submission.resolution?.kind === "IMMEDIATE_REFUND"
        ? submission.resolution
        : undefined);
    if (
      !snapshot?.branchId ||
      !snapshot.isOwner ||
      capturedRefund?.method !== "CASH" ||
      !D(capturedRefund.amount).gt(0)
    )
      return false;
    const capturedShiftId = capturedRefund.shiftId ?? null;
    if (!(await isOfflineSaleEnabled())) {
      notify.errBig(
        "العمل دون اتصال مُعطَّل على هذا الجهاز",
        "عُطِّل يدوياً من «إعدادات الجهاز» في شارة المزامنة — أعِد تفعيله ليقبل المرتجع أثناء الانقطاع.",
      );
      return false;
    }
    const gate = await assertCanCapture(D(capturedRefund.amount).toNumber());
    if (!gate.ok) {
      notify.errBig(gate.reason);
      return false;
    }
    const receiptNumber = await allocateOfflineReceiptNumber(snapshot.branchId);
    const ok = await enqueueOfflineReturn({
      payload: {
        branchId: snapshot.branchId,
        shiftId: capturedShiftId,
        invoiceId: submission.invoiceId,
        lines: submission.lines,
        refund: {
          amount: capturedRefund.amount,
          method: "CASH",
          ...(capturedShiftId != null ? { shiftId: capturedShiftId } : {}),
        },
        restock:
          submission.resolution?.kind === "IMMEDIATE_REFUND"
            ? submission.resolution.disposition === "RESTOCK"
            : (submission.restock ?? true),
        reason:
          submission.reason ??
          (submission.resolution?.kind === "IMMEDIATE_REFUND"
            ? submission.resolution.reason
            : ""),
        clientRequestId: submission.clientRequestId!,
      },
      offlineReceiptNumber: receiptNumber,
      total: capturedRefund.amount,
    });
    if (!ok) {
      notify.errBig(
        "تعذّر حفظ المرتجع في طابور المزامنة — لا تُسلّم النقد قبل نجاح الحفظ.",
      );
      return false;
    }
    setDone(
      `التُقط المرتجع دون اتصال برقم ${receiptNumber} — يُرحَّل تلقائياً عند عودة الشبكة.`,
    );
    setQty({});
    setManualAmount(null);
    setReason("");
    setClientRequestId(crypto.randomUUID());
    return true;
  }

  const create = trpc.returns.create.useMutation({
    onMutate: () => ({
      branchId: inv?.branchId,
      isOwner: me.data?.isOwner === true,
    }),
    onSuccess: async (res) => {
      /**
       * العائدُ نوعٌ مُميَّزٌ بـ`mode` (قرار المالك ١/٩/٢٦): المالكُ يُنفَّذ مرتجعُه فوراً،
       * وغيرُه يُرسل طلباً. الشاشة تقول أيَّهما وقع — لا نصّاً واحداً يصف الحالتين.
       */
      const isExecuted =
        res.mode === "EXECUTED" ||
        (res as { status?: string }).status === "APPROVED";
      if (isExecuted) {
        const total =
          "returnedTotal" in res && res.returnedTotal
            ? ` بقيمة ${fmt(String(res.returnedTotal))} د.ع`
            : "";
        setDone(`نُفِّذ المرتجع فعلاً${total} واكتمل تحديث الفاتورة وآثاره.`);
      } else {
        setDone(
          `أُرسل طلب المرتجع #${res.requestId} للاعتماد — لم يتغيّر المخزون أو المال بعد.`,
        );
      }
      setQty({});
      setManualAmount(null);
      setReason("");
      setClientRequestId(crypto.randomUUID());
      await invalidateFinancialQueries(queryClient, inv?.branchId);
      if (isExecuted) {
        onDone?.({
          fullyReturned: "fullyReturned" in res ? !!res.fullyReturned : false,
          returnedTotal:
            "returnedTotal" in res ? String(res.returnedTotal ?? "0") : "0",
        });
      }
    },
    onError: (e, submission, snapshot) => {
      // انقطاعُ الشبكة ≠ رفضُ أعمال: الأوّل يُلتقَط، والثاني يُعرَض. الخلطُ بينهما يبتلع
      // رفضاً مشروعاً في طابورٍ أو يُفقد نقداً خرج فعلاً.
      const isTransport =
        /Failed to fetch|NetworkError|Load failed|ERR_INTERNET_DISCONNECTED/i.test(
          e.message,
        );
      if (isTransport) {
        void captureOfflineReturn(submission, snapshot).then((captured) => {
          if (!captured) setError(e.message);
        });
        return;
      }
      setError(e.message);
    },
  });

  async function afterWithdrawal() {
    // Withdrawal starts a new intent; never reuse the bound key of the withdrawn request.
    setClientRequestId(crypto.randomUUID());
    setRailState(null);
    setError("");
    setDone("سُحب طلبك السابق — راجع البنود ثم نفّذ المرتجع الجديد.");
    await invalidateFinancialQueries(queryClient, inv?.branchId);
  }

  const withdrawControl = trpc.salesControl.withdraw.useMutation({
    onSuccess: afterWithdrawal,
    onError: (e) => setError(e.message),
  });

  const withdrawLegacy = trpc.returns.withdrawRequest.useMutation({
    onSuccess: afterWithdrawal,
    onError: (e) => setError(e.message),
  });

  async function withdrawPending() {
    if (!pending?.isMine || !canWithdrawPending) return;
    if (
      !(await confirm({
        variant: "warning",
        title: `سحب طلبي #${pending.id}`,
        description:
          "يُغلق طلبك السابق بلا حركة مخزون أو مال. تبقى اختياراتك الحالية للمراجعة قبل إرسال مرتجع جديد.",
        confirmText: "سحب طلبي",
      }))
    )
      return;
    const mutation =
      pending.source === "CONTROL" ? withdrawControl : withdrawLegacy;
    try {
      await mutation.mutateAsync({
        requestId: pending.id,
        reason: "سحب الطالب لإعادة إعداد المرتجع",
      });
    } catch {
      /* The mutation displays the server reason and leaves the pending request intact. */
    }
  }

  const withdrawing = withdrawControl.isPending || withdrawLegacy.isPending;
  return {
    approve,
    captureOfflineReturn,
    create,
    afterWithdrawal,
    withdrawControl,
    withdrawLegacy,
    withdrawPending,
    withdrawing,
  };
}
