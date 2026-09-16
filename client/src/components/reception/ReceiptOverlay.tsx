import { Check, Printer, Truck, FileText, Wrench } from "lucide-react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/CopyButton";
import { fmt } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { LastSaleSummary } from "./cartMath";
import { DeliveryDepartureOverlay, type DeliveryDepartureData } from "@/components/delivery/DeliveryDepartureOverlay";

/** ش١ (§٨.٦) — نافذة الإيصال بعد الإتمام بأنيميشن خروج الورقة الحرارية ورأس الطابعة والختم التفاعلي. */
export function ReceiptOverlay({
  lastSale,
  deliveryDeparture,
  onCloseDeliveryDeparture,
  onReprint,
  onClose,
}: {
  lastSale: LastSaleSummary;
  deliveryDeparture?: DeliveryDepartureData | null;
  onCloseDeliveryDeparture?: () => void;
  onReprint: () => void;
  onClose: () => void;
}) {
  const isCredit = Boolean(lastSale.creditStr && Number(lastSale.creditStr) > 0);
  const allItems = (lastSale.receipts ?? []).flatMap((r) => r.items ?? []);
  const now = new Date();
  const timeStr = now.toLocaleTimeString("ar-IQ", { hour: "2-digit", minute: "2-digit" });

  return (
    <div
      className="fixed inset-0 z-[90] flex flex-col items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      dir="rtl"
      onClick={onClose}
    >
      <div
        className="relative flex w-full max-w-sm flex-col items-center cursor-default"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="إيصال استلام الطلب"
      >
        {/* رأس الطابعة الحرارية المعدني (Printer Head Slot) */}
        <div className="relative z-10 flex h-[38px] w-full items-center justify-between rounded-t-2xl border border-b-0 border-slate-700 bg-slate-800 px-4 text-xs font-bold text-slate-400 shadow-md">
          <div className="flex items-center gap-2">
            <motion.span
              animate={{ opacity: [0.3, 1, 0.3], scale: [0.85, 1.15, 0.85] }}
              transition={{ duration: 1.1, repeat: Infinity, ease: "easeInOut" }}
              className="inline-block size-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.8)]"
            />
            <span className="text-[11px] font-semibold text-slate-300">طابعة الاستقبال الحرارية</span>
          </div>
          <span className="font-mono text-[10px] text-slate-400">ESC/POS 80mm</span>
          {/* شق خروج الورقة في المنتصف */}
          <div className="absolute -bottom-[2px] left-1/2 h-[3px] w-[88%] -translate-x-1/2 rounded bg-slate-950" />
        </div>

        {/* الورقة الحرارية المطبوعة المنسابة من رأس الطابعة */}
        <motion.div
          initial={{ y: -90, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ type: "spring", damping: 18, stiffness: 120 }}
          className="relative z-[5] w-full space-y-3 border-x border-slate-200 bg-white p-5 text-slate-800 shadow-2xl font-sans"
        >
          {/* ختم مدفوع / آجل / توصيل ينطبع بحركة تفاعلية */}
          <motion.div
            initial={{ scale: 2, rotate: -15, opacity: 0 }}
            animate={{ scale: 1, rotate: -7, opacity: 0.92 }}
            transition={{ delay: 0.28, type: "spring", stiffness: 220, damping: 14 }}
            className={cn(
              "pointer-events-none absolute top-4 left-4 flex items-center gap-1.5 rounded-lg border-2 px-2.5 py-0.5 text-xs font-black tracking-wider",
              isCredit
                ? "border-amber-600 bg-amber-50/90 text-amber-700"
                : deliveryDeparture
                  ? "border-sky-600 bg-sky-50/90 text-sky-700"
                  : "border-emerald-600 bg-emerald-50/90 text-emerald-700",
            )}
          >
            {isCredit ? (
              <span>آجل • DEFERRED</span>
            ) : deliveryDeparture ? (
              <>
                <Truck size={13} strokeWidth={2.5} aria-hidden />
                <span>طلب توصيل</span>
              </>
            ) : (
              <>
                <Check size={13} strokeWidth={3} aria-hidden />
                <span>مدفوع • PAID</span>
              </>
            )}
          </motion.div>

          {/* ترويسة الإيصال */}
          <div className="border-b border-dashed border-slate-300 pb-2 text-center">
            <div className="text-base font-black text-slate-900">الرؤية العربية</div>
            <div className="text-[11px] text-slate-500">إيصال قسم الاستقبال والمبيعات المعتمد</div>
            <div className="mt-1 flex items-center justify-between text-[10px] text-slate-400">
              <span className="font-mono">{new Date().toLocaleDateString("ar-IQ")}</span>
              <span dir="ltr" className="font-mono">{timeStr}</span>
            </div>
          </div>

          {/* الفكّة للزبون إن وجدت */}
          {lastSale.changeStr && (
            <div className="rounded-xl border-2 border-emerald-600/40 bg-emerald-50 p-3 text-center">
              <div className="text-xs font-bold text-emerald-800">الفكّة للزبون</div>
              <div className="text-4xl font-black tabular-nums text-emerald-700" dir="ltr">
                {fmt(lastSale.changeStr)}
              </div>
            </div>
          )}

          {/* المتبقّي آجل أو عند الاستلام إن وجد */}
          {lastSale.creditStr && (
            <div className="rounded-xl border-2 border-amber-600/40 bg-amber-50 p-3 text-center">
              <div className="text-xs font-bold text-amber-800">المتبقّي (آجل / عند الاستلام)</div>
              <div className="text-3xl font-black tabular-nums text-amber-700" dir="ltr">
                {fmt(lastSale.creditStr)}
              </div>
            </div>
          )}

          {/* بنود الفاتورة إن وُجدت بالتفصيل */}
          {allItems.length > 0 && (
            <div className="space-y-1 rounded-lg border border-slate-200 bg-slate-50/70 p-2.5 text-xs">
              <div className="grid grid-cols-12 pb-1 border-b border-slate-200 text-[10px] font-bold text-slate-500">
                <span className="col-span-6">الصنف</span>
                <span className="col-span-2 text-center">الكمية</span>
                <span className="col-span-4 text-left">الإجمالي</span>
              </div>
              <div className="max-h-28 overflow-y-auto space-y-1 py-1">
                {allItems.map((item, idx) => (
                  <div key={idx} className="grid grid-cols-12 items-center text-[11px] border-b border-dotted border-slate-100 pb-0.5 last:border-b-0">
                    <span className="col-span-6 truncate font-semibold text-slate-800" title={item.name}>
                      {item.name}
                    </span>
                    <span className="col-span-2 text-center tabular-nums text-slate-500" dir="ltr">
                      {item.quantity}
                    </span>
                    <span className="col-span-4 text-left font-bold tabular-nums text-slate-900" dir="ltr">
                      {fmt(item.total)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* المستندات المنشأة (فواتير / أوامر شغل) */}
          <div className="space-y-1.5 rounded-lg border border-slate-200 bg-slate-50/70 p-2.5 text-xs">
            {lastSale.invoiceNumbers.map((n) => (
              <div key={n} className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1 font-medium text-slate-500">
                  <FileText className="size-3 text-slate-400" aria-hidden /> فاتورة مبيعات
                </span>
                <span className="inline-flex items-center gap-1 font-bold tabular-nums text-slate-900" dir="ltr">
                  #{n}
                  <CopyButton value={n} title="نسخ رقم الفاتورة" size="icon-sm" />
                </span>
              </div>
            ))}
            {lastSale.workOrderNumbers.map((n) => (
              <div key={n} className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1 font-medium text-slate-500">
                  <Wrench className="size-3 text-slate-400" aria-hidden /> طلب تخصيص إنتاج
                </span>
                <span className="inline-flex items-center gap-1 font-bold tabular-nums text-slate-900" dir="ltr">
                  #{n}
                  <CopyButton value={n} title="نسخ رقم أمر الشغل" size="icon-sm" />
                </span>
              </div>
            ))}
            <div className="flex items-center justify-between border-t border-slate-200 pt-1.5 mt-1">
              <span className="font-extrabold text-slate-700">الإجمالي الكلي</span>
              <span className="text-base font-black tabular-nums text-slate-900" dir="ltr">
                {fmt(lastSale.totalStr)} <span className="text-xs font-normal">د.ع</span>
              </span>
            </div>
          </div>

          {/* تنبيه فشل الطباعة إن وجد */}
          {lastSale.printFailures > 0 && (
            <p className="rounded-md border border-red-300 bg-red-50 px-2.5 py-1.5 text-[11px] font-bold text-red-700">
              تعذّرت طباعة {lastSale.printFailures} مستند — أعد الطباعة أدناه بعد فحص الطابعة.
            </p>
          )}

          {/* إعلان المتجر الإلكتروني */}
          <div className="flex items-center justify-between rounded-lg border border-dashed border-slate-300 bg-slate-50/80 p-2 text-[10px] text-slate-600">
            <div>
              <div className="font-bold text-slate-800">تسوق عبر متجرنا الإلكتروني</div>
              <div className="font-mono text-[9px] text-sky-600" dir="ltr">alarabiya.online/store</div>
            </div>
            <div className="font-mono text-[9px] text-slate-400">#RECEPTION</div>
          </div>

          {/* الحافة السفلية المسننة (Sawtooth Tear-off Edge) */}
          <div
            className="pointer-events-none absolute -bottom-2 left-0 right-0 h-2"
            style={{
              background: "repeating-linear-gradient(45deg, #ffffff, #ffffff 5px, transparent 5px, transparent 10px)",
            }}
          />
        </motion.div>

        {/* أزرار الإجراءات الفورية أسفل الفاتورة */}
        <div className="mt-4 flex w-full gap-2 z-10">
          <Button
            variant="outline"
            className="flex-1 bg-slate-800 border-slate-700 text-white hover:bg-slate-700 hover:text-white"
            onClick={onReprint}
          >
            <Printer aria-hidden className="size-4 me-1" /> إعادة طباعة (F9)
          </Button>
          <Button className="flex-1" onClick={onClose}>
            طلب جديد (Esc)
          </Button>
        </div>
      </div>

      {deliveryDeparture && (
        <DeliveryDepartureOverlay
          open={!!deliveryDeparture}
          onClose={() => onCloseDeliveryDeparture?.()}
          data={deliveryDeparture}
        />
      )}
    </div>
  );
}
