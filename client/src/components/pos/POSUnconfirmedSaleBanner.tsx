import type { PreflightSaleIntentV4 } from "@/lib/offline/outbox";

interface POSUnconfirmedSaleBannerProps {
  unconfirmedSaleIntents: PreflightSaleIntentV4[];
  foreignOwnerPendingCount: number;
  activeInOtherTabCount: number;
  canServerFence: boolean;
  onFenceIntent: (intent: PreflightSaleIntentV4) => void;
}

/** Alert banner surfaced when an online POS sale outcome is unconfirmed or blocked across tabs/users. */
export function POSUnconfirmedSaleBanner({
  unconfirmedSaleIntents,
  foreignOwnerPendingCount,
  activeInOtherTabCount,
  canServerFence,
  onFenceIntent,
}: POSUnconfirmedSaleBannerProps) {
  const primaryIntent = unconfirmedSaleIntents[0] ?? null;
  if (
    unconfirmedSaleIntents.length === 0 &&
    foreignOwnerPendingCount === 0 &&
    activeInOtherTabCount === 0
  ) {
    return null;
  }

  return (
    <div
      role="alert"
      data-testid="pos-unconfirmed-sale-banner"
      data-queued-count={String(unconfirmedSaleIntents.length)}
      style={{
        margin: "6px 8px 0",
        border: "2px solid #dc2626",
        background: "#fef2f2",
        color: "#991b1b",
        borderRadius: 8,
        padding: "8px 12px",
        fontSize: 13,
        fontWeight: 700,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
        flexWrap: "wrap",
      }}
    >
      <span>
        {unconfirmedSaleIntents.length > 0
          ? `حالة الفاتورة غير مؤكدة على الخادم (${unconfirmedSaleIntents.length > 1 ? `${unconfirmedSaleIntents.length} طلبات معلّقة: ` : "المعرّف "}${unconfirmedSaleIntents.map((i) => i.clientRequestId).join("، ")}) — انقطع الرد أو أُعيد تشغيل المتصفح. لا تعِد البيع ولا تسلّم إيصالاً مكرراً؛ يتحقق النظام بالمعرّف الأصلي تلقائياً فور الاتصال.`
          : activeInOtherTabCount > 0
            ? "توجد عملية بيع قيد الإرسال حالياً في تبويب نشط آخر على هذا المتصفح — انتظر اكتمالها لمنع التكرار."
            : "توجد فاتورة بحالة غير مؤكدة لموظف آخر على هذا الجهاز — سجّل دخول الموظف الأصلي أو المدير لمصالحتها بأمان."}
      </span>
      {canServerFence && primaryIntent && (
        <button
          type="button"
          data-testid="pos-fence-unconfirmed-sale-btn"
          onClick={() => onFenceIntent(primaryIntent)}
          style={{
            border: "1px solid #991b1b",
            background: "#fff",
            color: "#991b1b",
            borderRadius: 6,
            padding: "4px 10px",
            fontSize: 12,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          تسييج وإلغاء الطلب غير الملتزم خادمياً
        </button>
      )}
    </div>
  );
}
