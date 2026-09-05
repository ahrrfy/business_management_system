// نافذة «تم الدفع بنجاح» بعد البيع (الإيصال على الشاشة + الطباعة).
// استُخرج حرفياً من client/src/pages/POS.tsx (برنامج v2 «السهل الممتنع» م١ — PR-A) بلا تغيير
// سلوكيّ: الصفحةُ العملاقة (٣٧٨٣ سطراً) قُسِّمت مكوّنياً كي تنزل تحت خطّ أساس `check:page-size`
// ومقياس الاحتكاك D4، وتبقى كلّ الحالة المالية عند الأب (POS.tsx) وتصل عبر props.

import { Printer, Check, Truck } from "lucide-react";
import { Link } from "wouter";
import { paymentMethodClass } from "@/lib/paymentMethod";
import { CopyButton } from "@/components/CopyButton";
import { type Receipt, fmt, type PosColors as C } from "./posShared";
import { useModalFocus } from "./useModalFocus";

export interface ReceiptOverlayProps {
  C: C;
  receipt: Receipt;
  onDismiss: () => void;
  onPrint: () => void;
}

export function ReceiptOverlay({ C, receipt, onDismiss, onPrint }: ReceiptOverlayProps) {
  const modalRef = useModalFocus<HTMLDivElement>();
  return (
    <div onClick={onDismiss}
      style={{ position: "fixed", inset: 0, zIndex: 100, background: C.overlay, display: "flex", alignItems: "center", justifyContent: "center", animation: "fadeIn .2s ease", cursor: "pointer" }}>
      <div onClick={(e) => e.stopPropagation()} ref={modalRef} role="dialog" aria-modal="true" aria-label="تم الدفع بنجاح"
        style={{ background: C.card, borderRadius: 20, padding: "36px 44px 30px", width: 480, maxWidth: "92vw", boxShadow: "0 28px 72px rgb(0 0 0/.42)", animation: "popIn .22s ease", cursor: "default", textAlign: "center", direction: "rtl" }}>

        <div style={{ width: 76, height: 76, borderRadius: "50%", background: C.success, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 18px", animation: "pulse 1.2s ease-out", color: "#fff" }}>
          <Check aria-hidden size={42} strokeWidth={3} />
        </div>

        <div style={{ fontSize: 24, fontWeight: 900, marginBottom: 4, color: C.fg }}>تم الدفع بنجاح</div>
        <div style={{ fontSize: 13, color: C.mutedFg, marginBottom: 24, display: "inline-flex", alignItems: "center", gap: 4, justifyContent: "center" }}>
          <span>فاتورة: {receipt.invoiceNumber}</span>
          <CopyButton value={receipt.invoiceNumber} title="نسخ رقم الفاتورة" successMessage="تم نسخ رقم الفاتورة" />
          {/* م١ PR-B: الطرد المُنشأ في معاملة البيع — رابطٌ مباشر إلى «قيد التوصيل». */}
          {receipt.consignmentNumber && (
            <>
              <span>·</span>
              <Link href="/delivery?tab=transit" style={{ display: "inline-flex", alignItems: "center", gap: 4, color: C.primary, fontWeight: 800 }} title="متابعة الطرد من إدارة التوصيل">
                <Truck aria-hidden size={14} /> طرد {receipt.consignmentNumber}
              </Link>
            </>
          )}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
          {[
            { label: "المبلغ المدفوع", raw: receipt.received, value: fmt(receipt.received), color: C.primary },
            { label: "إجمالي الفاتورة", raw: receipt.total,    value: fmt(receipt.total),    color: C.fg },
          ].map((item) => (
            <div key={item.label} style={{ background: C.muted, borderRadius: 10, padding: "14px 10px", textAlign: "center", position: "relative" }}>
              <div style={{ position: "absolute", top: 4, left: 4 }}>
                <CopyButton value={item.raw} title={`نسخ ${item.label}`} successMessage={`تم نسخ ${item.label}`} />
              </div>
              <div style={{ fontSize: 12, color: C.mutedFg, marginBottom: 4 }}>{item.label}</div>
              <div style={{ fontSize: 26, fontWeight: 900, direction: "ltr", color: item.color }}>{item.value}</div>
              <div style={{ fontSize: 11, color: C.mutedFg }}>د.ع</div>
            </div>
          ))}
        </div>

        {receipt.change > 0 && (
          <div style={{ background: `color-mix(in oklch, ${C.success} 10%, transparent)`, border: `1.5px solid color-mix(in oklch, ${C.success} 28%, transparent)`, borderRadius: 10, padding: "12px 18px", marginBottom: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: C.success }}>الباقي للعميل</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 26, fontWeight: 900, color: C.success, direction: "ltr" }}>{fmt(receipt.change)} <span style={{ fontSize: 12 }}>د.ع</span></span>
              <CopyButton value={receipt.change} title="نسخ الباقي" successMessage="تم نسخ الباقي" />
            </span>
          </div>
        )}

        {/* م١ PR-B: بيعٌ بتوصيل — المتبقّي يُحصَّل عند التسليم مع المندوب (COD)، لا آجلٌ على العميل. */}
        {receipt.delivery && receipt.total > receipt.received && (
          <div style={{ background: C.primarySoft, border: `1.5px solid ${C.primary}`, borderRadius: 10, padding: "12px 18px", marginBottom: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: C.primary, display: "inline-flex", alignItems: "center", gap: 6 }}>
              <Truck aria-hidden size={16} /> يُحصَّل عند التسليم ({receipt.delivery.partyName})
            </span>
            <span style={{ fontSize: 26, fontWeight: 900, color: C.primary, direction: "ltr" }}>{fmt(receipt.total - receipt.received)} <span style={{ fontSize: 12 }}>د.ع</span></span>
          </div>
        )}
        {receipt.isCredit && receipt.credit > 0 && (
          <div style={{ background: `color-mix(in oklch, ${C.amber} 10%, transparent)`, border: `1.5px solid color-mix(in oklch, ${C.amber} 30%, transparent)`, borderRadius: 10, padding: "12px 18px", marginBottom: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: C.amber }}>آجل على {receipt.customerName ?? "العميل"}</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 26, fontWeight: 900, color: C.amber, direction: "ltr" }}>{fmt(receipt.credit)} <span style={{ fontSize: 12 }}>د.ع</span></span>
              <CopyButton value={receipt.credit} title="نسخ المتبقي الآجل" successMessage="تم نسخ المتبقي" />
            </span>
          </div>
        )}

        <div style={{ marginBottom: 20, fontSize: 13.5, color: C.mutedFg, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, flexWrap: "wrap" }}>
          <span>طريقة الدفع:</span>
          <span className={`inline-block rounded-full px-3 py-1 text-sm font-bold ${paymentMethodClass(receipt.methodCode)}`}>
            {receipt.method}
          </span>
          <span>·</span><span>{receipt.lines.length} منتج</span>
          {receipt.customerName && <><span>·</span><strong style={{ color: C.fg }}>{receipt.customerName}</strong></>}
        </div>

        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={onPrint}
            style={{ flex: 1, height: 50, background: C.card, border: `1.5px solid ${C.border}`, borderRadius: 9, fontFamily: "inherit", fontSize: 14.5, fontWeight: 700, cursor: "pointer", color: C.fg, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
            <Printer size={18} aria-hidden /> طباعة الإيصال
          </button>
          <button onClick={onDismiss}
            style={{ flex: 1, height: 50, background: C.primary, border: "none", borderRadius: 9, fontFamily: "inherit", fontSize: 14.5, fontWeight: 700, cursor: "pointer", color: C.primaryFg }}>
            فاتورة جديدة
          </button>
        </div>

        <div style={{ marginTop: 16, fontSize: 12, color: C.mutedFg }}>المس الشاشة في أي مكان للمتابعة</div>
      </div>

      <style>{`
        @keyframes fadeIn { from { opacity:0; } to { opacity:1; } }
        @keyframes popIn  { from { opacity:0; transform:scale(.88); } to { opacity:1; transform:scale(1); } }
        @keyframes pulse  { 0%,100%{ box-shadow:0 0 0 0 color-mix(in oklch, ${C.success} 40%, transparent); } 60%{ box-shadow:0 0 0 14px color-mix(in oklch, ${C.success} 0%, transparent); } }
      `}</style>
    </div>
  );
}
