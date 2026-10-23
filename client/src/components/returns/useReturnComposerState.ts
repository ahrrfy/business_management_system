import { useOperationPermission } from "@/hooks/useOperationPermission";
import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { type RefundRailPickerState } from "@/components/ui/RefundRailPicker";
import { trpc } from "@/lib/trpc";
import { ReturnComposerProps } from "./returnComposerTypes";

export function useReturnComposerState(props: ReturnComposerProps) {
  const {
    invoiceId,
    initialMode,
    approvingRequestId,
    scannedBarcode,
    onBarcodeHandled,
    onDone,
    footer,
  } = props;

  const queryClient = useQueryClient();

  const detail = trpc.returns.getInvoice.useQuery(
    { invoiceId },
    { enabled: invoiceId > 0 },
  );

  /** التنفيذ المباشر تفويض مستقل؛ الخادم يحوّل تجاوز السقف/الوردية/اليوم إلى طلب اعتماد. */
  const me = trpc.auth.me.useQuery();

  const operationPermission = useOperationPermission(
    approvingRequestId ? "returns.approveRequest" : "returns.create",
  );

  const directReturnPermission = useOperationPermission("returns.create");

  const refundRailPermission = useOperationPermission("refundRails.preflight");

  const withdrawControlPermission = useOperationPermission(
    "salesControl.withdraw",
  );

  const withdrawLegacyPermission = useOperationPermission(
    "returns.withdrawRequest",
  );

  const executesImmediately =
    me.data?.isOwner === true || directReturnPermission.allowed;

  /**
   * ⭐ في وضع الاعتماد نُحمّل **بنود الطلب** — هي التي سينفّذها الخادم، لا ما يُدخله المدير.
   * كان الجدول يُفتَح فارغاً فيُدخل المدير كمّياتٍ يُقسم بها حوارُ التأكيد ثمّ يتجاهلها
   * `approveRequest` (يقرأ `linesJson`). مراجعٌ لا يرى ما يراجعه ليس مراجعاً.
   */
  const requestDetail = trpc.returns.getRequest.useQuery(
    { requestId: approvingRequestId ?? 0 },
    { enabled: !!approvingRequestId && approvingRequestId > 0 },
  );

  const [qty, setQty] = useState<Record<number, number>>({});

  const [fastBarcode, setFastBarcode] = useState("");

  const [restock, setRestock] = useState(true);

  const [manualAmount, setManualAmount] = useState<string | null>(null);

  /**
   * **حالةُ منتقي الروافد الموحَّد** — الرافدُ والدرجُ ومرجعُ البطاقة وسببُ الحجب، كلُّها من
   * الخادم (`refundRails.preflight` بنوع `SALE_RETURN` والمبلغ المطلوب). كانت الشاشة تحمل
   * `rail`/`shiftId`/`cardReference` وقائمةَ أدراجٍ محلّية وقاموسَ تسمياتٍ خاصّاً بها.
   */
  const [railState, setRailState] = useState<RefundRailPickerState | null>(
    null,
  );

  const [reason, setReason] = useState("");

  const [error, setError] = useState("");

  const [done, setDone] = useState("");

  // idempotency: مفتاحٌ ثابتٌ للمحاولة، يتجدّد عند تبديل الفاتورة وبعد كل نجاح — نقرةٌ مزدوجة
  // أو إعادة إرسالٍ على شبكةٍ متذبذبة لا تُنشئ مرتجعاً ثانياً ولا تُخرج النقد مرّتين.
  const [clientRequestId, setClientRequestId] = useState(() =>
    crypto.randomUUID(),
  );

  // تبديل الفاتورة يصفّر كل قرارٍ سابق (وإلّا سُجّل مرتجعٌ بكميّات فاتورةٍ أخرى).
  useEffect(() => {
    setQty({});
    setFastBarcode("");
    setRestock(true);
    setManualAmount(null);
    setRailState(null);
    setReason("");
    setError("");
    setDone("");
    setClientRequestId(crypto.randomUUID());
  }, [invoiceId]);

  /** بنود الطلب المعلَّق (وضع الاعتماد) — مصدر الحقيقة للكمّيات، تُقفَل ضدّ التعديل. */
  const lockedLines = approvingRequestId
    ? (requestDetail.data?.lines ?? null)
    : null;

  // تُملأ الكمّيات من الطلب مرّةً عند وصولها، فتحسب الشاشة (القيمة/السقف/الحوار) على ما سيُنفَّذ.
  useEffect(() => {
    if (!lockedLines || !requestDetail.data) return;
    const next: Record<number, number> = {};
    for (const l of lockedLines) next[l.invoiceItemId] = l.baseQuantity;
    setQty(next);
    setReason(requestDetail.data.reason);
  }, [lockedLines, requestDetail.data]);

  const inv = detail.data;

  const isWalkIn = !!inv?.walkInResolutionPolicy;

  const isDeliveryReversal =
    !!inv?.walkInResolutionPolicy?.deliveryCustodyReversal;

  const items = inv?.items ?? [];

  useEffect(() => {
    if (
      initialMode !== "FULL" ||
      approvingRequestId ||
      !inv ||
      inv.status === "RETURNED" ||
      inv.status === "CANCELLED"
    ) {
      return;
    }
    const eligible = inv.items.filter((it) => it.remaining > 0);
    if (eligible.length === 0) return;
    const next: Record<number, number> = {};
    for (const it of eligible) {
      next[it.invoiceItemId] = it.remaining;
    }
    setQty(next);
    setReason((prev) => prev.trim() || "إرجاع كامل الفاتورة");
  }, [initialMode, approvingRequestId, inv?.id]);

  const itemsById = useMemo(
    () => new Map((inv?.items ?? []).map((item) => [item.invoiceItemId, item])),
    [inv?.items],
  );
  return {
    invoiceId,
    initialMode,
    approvingRequestId,
    scannedBarcode,
    onBarcodeHandled,
    onDone,
    footer,
    queryClient,
    detail,
    me,
    operationPermission,
    directReturnPermission,
    refundRailPermission,
    withdrawControlPermission,
    withdrawLegacyPermission,
    executesImmediately,
    requestDetail,
    qty,
    setQty,
    fastBarcode,
    setFastBarcode,
    restock,
    setRestock,
    manualAmount,
    setManualAmount,
    railState,
    setRailState,
    reason,
    setReason,
    error,
    setError,
    done,
    setDone,
    clientRequestId,
    setClientRequestId,
    lockedLines,
    inv,
    isWalkIn,
    isDeliveryReversal,
    items,
    itemsById,
  };
}
