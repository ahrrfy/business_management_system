import { useState } from "react";
import { Check, Loader2, Truck } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ErrorState } from "@/components/PageState";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { fmtInt } from "@/lib/money";
export type DispatchOrder = {
  id: number;
  orderNumber: string;
  total: string;
  customerName: string | null;
  deliveryFree?: boolean;
  deliveryWaivedAmount?: string;
};
const money = (value: string | null | undefined) => fmtInt(value || "0");
/** منتقي المندوب عند الإرسال — يُنشئ الفاتورة (COD) + يُسند الطلب. z-[100] (فوق Radix، تحت confirm). */
export function OrderDispatchDialog({
  order,
  pending,
  onCancel,
  onConfirm,
}: {
  order: DispatchOrder;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (input: { partyId: number; externalTrackingRef?: string }) => void;
}) {
  const [partyId, setPartyId] = useState<number | null>(null);
  const [externalTrackingRef, setExternalTrackingRef] = useState("");
  const partiesQ = trpc.storeAdmin.orders.parties.useQuery();
  // الشركات الخارجية بلا حساب أصبحت تُغلق بكشف الشركة الممسوح؛ لذلك تظهر هنا مع المناديب،
  // ويُفرض عليها رقم البوليصة أدناه بدل حجبها وإبقاء الطلب بلا مسار إرسال.
  const parties = partiesQ.data ?? [];
  const selectedParty = parties.find((p) => p.id === partyId);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onCancel();
      }}
    >
      <DialogContent
        showCloseButton={!pending}
        className="sm:max-w-md"
        aria-describedby={undefined}
        onEscapeKeyDown={(event) => {
          if (pending) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (pending) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2 pe-6 text-base">
            <Truck aria-hidden className="size-5" />
            إرسال الطلب{" "}
            <span dir="ltr" className="break-all">
              {order.orderNumber}
            </span>
          </DialogTitle>
        </DialogHeader>
        {order.deliveryFree ? (
          <div className="mb-3 space-y-1 rounded-xl border border-[var(--sem-pos)]/30 bg-[var(--sem-pos-bg)] p-3 text-xs leading-relaxed text-foreground">
            <div className="flex items-center gap-1.5 font-bold text-[var(--sem-pos)]">
              <Truck aria-hidden className="size-4 shrink-0" />
              <span>
                توصيل مجاني — تتحمل المكتبة أجرته (
                {money(order.deliveryWaivedAmount)} د.ع)
              </span>
            </div>
            <p className="text-muted-foreground">
              يُحصّل المندوب{" "}
              <b className="text-foreground">{money(order.total)} د.ع</b> فقط
              عند التسليم (COD) من{" "}
              {order.customerName ? (
                <b className="text-foreground">{order.customerName}</b>
              ) : (
                "العميل"
              )}{" "}
              (قيمة البضاعة كاملةً). لا يدفع الزبون أي أجرة توصيل؛ وتُستحق أجرة
              التوصيل للمندوب على عاتق المكتبة وتُسوّى دفترياً.
            </p>
          </div>
        ) : (
          <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
            {/* ١٠/٨ تمرير كامل: order.total (بضاعة+شحن) = ما يُحصّله المندوب عند الباب، لا «قيمة
                الفاتورة/الذمّة» — الفاتورة وذمّة العميل تُنشآن بقيمة البضاعة فقط، وأجرة التوصيل
                يقبضها المندوب من الزبون ويحتفظ بها (خارج الفاتورة). لا تُلصِق الرقم بـ«فاتورة». */}
            يُحصّل المندوب{" "}
            <b className="text-foreground">{money(order.total)} د.ع</b> عند
            التسليم (COD) من{" "}
            {order.customerName ? (
              <b className="text-foreground">{order.customerName}</b>
            ) : (
              "العميل"
            )}
            : قيمة البضاعة تُنشأ فاتورةً على ذمّته ويورّدها للمكتبة، وأجرة
            التوصيل يحتفظ بها المندوب. يُخصم المخزون ثم يُسند الطلب للمندوب
            المُختار.
          </p>
        )}

        {partiesQ.isLoading ? (
          <div className="py-8 text-center text-muted-foreground">
            <Loader2 aria-hidden className="mx-auto size-6 animate-spin" />
          </div>
        ) : partiesQ.isError ? (
          <ErrorState
            message={partiesQ.error.message}
            onRetry={() => void partiesQ.refetch()}
          />
        ) : parties.length === 0 ? (
          <div className="rounded-lg bg-muted p-4 text-center text-sm text-muted-foreground">
            لا توجد جهة توصيل نشطة. أضف مندوباً أو شركةً من إدارة التوصيل ثم أعد
            المحاولة.
          </div>
        ) : (
          <div className="max-h-64 space-y-2 overflow-y-auto">
            {parties.map((p) => (
              <label
                key={p.id}
                className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition ${
                  partyId === p.id
                    ? "border-teal-500 bg-teal-50 dark:bg-teal-500/10"
                    : "border-border hover:bg-accent"
                }`}
              >
                <input
                  type="radio"
                  name="dispatch-party"
                  className="size-4 accent-teal-600"
                  checked={partyId === p.id}
                  onChange={() => {
                    setPartyId(p.id);
                    setExternalTrackingRef("");
                  }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm font-bold">
                    {p.name}
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                      {p.partyType === "COMPANY" ? "شركة توصيل" : "مندوب"}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-3 text-xs text-muted-foreground">
                    {p.phone && <span dir="ltr">{p.phone}</span>}
                    {p.openConsignments > 0 && (
                      <span>قيد التوصيل: {p.openConsignments}</span>
                    )}
                  </div>
                </div>
              </label>
            ))}
          </div>
        )}

        {selectedParty?.partyType === "COMPANY" && (
          <div className="mt-3 space-y-1">
            <label
              htmlFor="store-dispatch-tracking"
              className="text-xs font-bold"
            >
              رقم تتبّع / بوليصة الشركة{" "}
              <span className="text-destructive">*</span>
            </label>
            <Input
              id="store-dispatch-tracking"
              value={externalTrackingRef}
              onChange={(event) => setExternalTrackingRef(event.target.value)}
              placeholder="امسح باركود بوليصة الشركة أو أدخل الرقم"
              maxLength={100}
              dir="ltr"
              className="font-mono"
            />
          </div>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={pending}
            className="rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition hover:bg-accent disabled:opacity-50"
          >
            إلغاء
          </button>
          <button
            onClick={() =>
              partyId != null &&
              onConfirm({
                partyId,
                externalTrackingRef: externalTrackingRef.trim() || undefined,
              })
            }
            disabled={
              pending ||
              partiesQ.isError ||
              !selectedParty ||
              parties.length === 0 ||
              (selectedParty?.partyType === "COMPANY" &&
                !externalTrackingRef.trim())
            }
            className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-teal-700 disabled:opacity-50"
          >
            {pending ? (
              <Loader2 aria-hidden className="size-4 animate-spin" />
            ) : (
              <Check aria-hidden className="size-4" />
            )}
            تأكيد الإرسال
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
