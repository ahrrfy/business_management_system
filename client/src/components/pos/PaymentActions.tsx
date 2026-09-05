// منطقة الفعل في لوحة الدفع: الباقي/المتبقي + زرّا الدفع.
// استُخرج حرفياً من client/src/pages/POS.tsx (برنامج v2 «السهل الممتنع» م١ — PR-A) بلا تغيير
// سلوكيّ: الصفحةُ العملاقة (٣٧٨٣ سطراً) قُسِّمت مكوّنياً كي تنزل تحت خطّ أساس `check:page-size`
// ومقياس الاحتكاك D4، وتبقى كلّ الحالة المالية عند الأب (POS.tsx) وتصل عبر props.

import { Check, Zap } from "lucide-react";
import { paymentMethodLabel } from "@/lib/paymentMethod";
import { CopyButton } from "@/components/CopyButton";
import { ACTION_LABELS } from "@shared/actionLabels";
import { type PaymentMethod, type FluidFn, fmt, type PosColors as C } from "./posShared";

export interface PaymentActionsProps {
  C: C;
  dense: boolean;
  ultra: boolean;
  fluid: FluidFn;
  total: number;
  cartLen: number;
  payInput: string;
  isChange: boolean; isOwing: boolean;
  change: number; credit: number;
  showQuickPay: boolean;
  canPay: boolean; isPending: boolean; hasCustomer: boolean;
  method: PaymentMethod;
  externalPaymentConfirmed: boolean;
  onPay: () => void; onQuickPay: () => void;
}

/** منطقة الفعل — خارج التمرير ولا تنكمش: الباقي/المتبقي + زرّا الدفع + تلميح الاختصارات. */
export function PaymentActions({ C, dense, ultra, fluid, total, cartLen, payInput, isChange, isOwing, change, credit, showQuickPay, canPay, isPending, hasCustomer, method, externalPaymentConfirmed, onPay, onQuickPay }: PaymentActionsProps) {
  return (
    <div style={{ flexShrink: 0, background: C.card }}>

    {/* Change / owing indicator */}
    <div style={{ borderTop: `1px solid ${C.border}`, padding: "4px 12px", display: "flex", alignItems: "center", justifyContent: "space-between", minHeight: ultra ? 28 : 36, flexShrink: 0 }}>
      {!cartLen && <span style={{ fontSize: 13, color: C.mutedFg }}>أضف منتجات للبدء</span>}
      {cartLen > 0 && !payInput && <span style={{ fontSize: 12.5, color: C.mutedFg }}>أدخل المبلغ أو «إتمام» للدفع الكامل</span>}
      {cartLen > 0 && !!payInput && isChange && (
        <>
          <span style={{ fontSize: 13.5, color: C.mutedFg, fontWeight: 600 }}>الباقي للعميل</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <span style={{ fontSize: 22, fontWeight: 900, color: C.success, direction: "ltr" }}>{fmt(change)} <span style={{ fontSize: 12.5, fontWeight: 500, color: C.mutedFg }}>د.ع</span></span>
            <CopyButton value={change} title="نسخ الباقي" successMessage="تم نسخ الباقي" />
          </span>
        </>
      )}
      {cartLen > 0 && !!payInput && isOwing && (
        <>
          <span style={{ fontSize: 13.5, color: C.amber, fontWeight: 600 }}>المتبقي للدفع</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <span style={{ fontSize: 22, fontWeight: 900, color: C.amber, direction: "ltr" }}>{fmt(credit)} <span style={{ fontSize: 12.5, fontWeight: 500 }}>د.ع</span></span>
            <CopyButton value={credit} title="نسخ المتبقي" successMessage="تم نسخ المتبقي" />
          </span>
        </>
      )}
    </div>

    {/* أزرار الفعل. «دفع سريع» يُخفى عند اختيار عميل أو دفعة جزئية (نيّة غير «نقدي كامل»)
        ⇒ يبقى CTA أساسي واحد فيمتنع الضغط الخاطئ الذي كان يُسجّل عميل الآجل «مدفوعاً
        نقداً بالكامل». الزرّ الأخضر يؤدّي الدفع الكامل أصلاً.
        عند ضيق الارتفاع يصطفّ الزرّان في **صفٍّ واحد** (نمط شاشة الطباعة نفسه) فيوفّران
        صفّاً كاملاً (~٥٨px) دون فقد ميزة «الدفع السريع» على الشاشات الصغيرة التي تحتاجها
        أكثر — والارتفاع يبقى ≥50px لكليهما. */}
    <div style={{ padding: dense ? "4px 11px 9px" : "4px 11px 10px", flexShrink: 0, display: "flex", flexDirection: dense ? "row" : "column", gap: dense ? 7 : 0 }}>

      {showQuickPay && (
        <button
          disabled={!canPay || isPending}
          onClick={() => onQuickPay()}
          title={
            // ٢٣/٨ (بلاغ Codex P2): كان يذكر «مرجع البطاقة» على دفعةٍ نقديّةٍ جزئيّةٍ بلا عميل —
            // لا حقلَ كذلك أصلاً. صار يميّز الحالات الثلاثة.
            isPending ? ACTION_LABELS.saving :
            !cartLen ? "أضف منتجاً أوّلاً" :
            isOwing && !hasCustomer ? "الدفعة الجزئيّة (الآجل) تحتاج عميلاً مرتبطاً — أو حصّل المبلغ كاملاً" :
            method !== "CASH" && !externalPaymentConfirmed ? "أكمل مرجع الدفع الخارجي وتأكيده" :
            !canPay ? "أكمل بيانات الدفع" :
            `دفع سريع وطباعة — ${paymentMethodLabel(method)}`
          }
          style={{
            ...(dense ? { width: 128, flexShrink: 0 } : { width: "100%", marginBottom: 7 }),
            height: fluid(50, 6.6, 58),
            background: canPay && !isPending ? "linear-gradient(135deg, oklch(0.62 0.18 50), oklch(0.56 0.20 40))" : C.muted,
            color: canPay && !isPending ? "#fff" : C.mutedFg,
            border: "none", borderRadius: 9, fontFamily: "inherit", fontSize: dense ? 13.5 : 15, fontWeight: 900,
            cursor: canPay && !isPending ? "pointer" : "not-allowed",
            display: "flex", alignItems: "center", justifyContent: "center", gap: dense ? 5 : 7,
            boxShadow: canPay && !isPending ? "0 4px 14px oklch(0.60 0.18 50 / .38)" : "none",
            transition: "background .1s, color .1s, box-shadow .1s",
          }}>
          <Zap aria-hidden size={18} />{dense ? "دفع سريع" : `دفع سريع وطباعة — ${paymentMethodLabel(method)}`}
        </button>
      )}

      <button
        disabled={!canPay || isPending}
        onClick={() => onPay()}
        title={
          isPending ? ACTION_LABELS.saving :
          !cartLen ? "أضف منتجاً أوّلاً" :
          isOwing && !hasCustomer ? "الدفعة الجزئيّة (الآجل) تحتاج عميلاً مرتبطاً — أو حصّل المبلغ كاملاً" :
          method !== "CASH" && !externalPaymentConfirmed ? "أكمل مرجع الدفع الخارجي وتأكيده" :
          !canPay ? "أكمل بيانات الدفع" :
          `إتمام الدفع — ${fmt(total)} د.ع`
        }
        style={{
          ...(dense && showQuickPay ? { flex: 1, minWidth: 0 } : { width: "100%" }),
          height: fluid(50, 6.6, 58),
          background: canPay && !isPending ? C.success : C.muted,
          color: canPay && !isPending ? "#fff" : C.mutedFg,
          border: "none", borderRadius: 9, fontFamily: "inherit", fontSize: 15, fontWeight: 900,
          cursor: canPay && !isPending ? "pointer" : "not-allowed",
          display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
          boxShadow: canPay && !isPending ? `0 3px 12px color-mix(in oklch, ${C.success} 30%, transparent)` : "none",
          transition: "background .1s, color .1s, box-shadow .1s",
        }}>
        {isPending
          ? "جارٍ…"
          : !cartLen
            ? "السلة فارغة"
            : <><Check aria-hidden size={18} strokeWidth={3} /> إتمام الدفع — {fmt(total)} د.ع</>}
      </button>
    </div>

    {/* ٢٣/٨ (بلاغ فحص UX): تلميحُ الاختصارات كان يُخفى على الشاشات القصيرة (dense) — وهي تحديداً
        شاشات الكاشير اللوحيّة ١٣٦٦×٧٦٨ حيث يعطي الاختصار أعظم قيمة (لا ماوس، لوحة مفاتيح فقط).
        نُبقيه ظاهراً مع خطٍّ أصغر على dense كي لا يزاحم أزرار الدفع. */}
    <div style={{ textAlign: "center", padding: dense ? "0 11px 4px" : "0 11px 8px", fontSize: dense ? 9.5 : 10.5, color: C.mutedFg, flexShrink: 0 }}>F4 للدفع · F2 للبحث · F9 طباعة · F12 تفريغ</div>

    </div>
  );
}
