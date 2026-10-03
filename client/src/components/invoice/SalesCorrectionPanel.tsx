/**
 * لوحة «التصحيح الكامل» لفاتورة البيع — مستخرَجة من SalesInvoiceNew (حارس حجم الصفحة).
 *
 * قرار المالك: الموظّف يعدّل الفاتورة كأنّها جديدة ثم يحفظ؛ النظام يستنتج التسوية من الفرق
 * (كان/أصبح) ولا يطلب لوحة تسوية لكلّ إيصال. هنا عرضٌ للقراءة فقط + مفتاحٌ واحد اختياريّ
 * «استُلم فعلاً / لم يُستلم» لتصحيح الاستنتاج حين يخطئ. لا منطق ماليّ — الخادم هو الحكم.
 */
import { FileWarning } from "lucide-react";
import { D, fmt } from "@/lib/money";
import { MoneyInput } from "@/components/form/MoneyInput";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { isPosPaymentMethodEnabled } from "@shared/posPaymentPolicy";
import { PAYMENT_METHODS, PAYMENT_TERMS, type PaymentMethod, type PaymentTerm } from "./types";
import type { PriorReceiptMode } from "./priorReceipt";

export { resolvePriorReceipt, type PriorReceiptMode } from "./priorReceipt";

function CorrRow({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className={className ?? "font-semibold tabular-nums"} dir="ltr">{value}</span>
    </div>
  );
}

const termLabel = (t: PaymentTerm) => PAYMENT_TERMS.find((x) => x.value === t)?.label ?? t;

export interface SalesCorrectionPanelProps {
  original: { invoiceNumber?: string | null } | null;
  /** المقبوض المسجَّل على الأصل. */
  recordedPaid: ReturnType<typeof D>;
  /** ما استُلم فعلاً منه (بعد الاستنتاج/المفتاح) — أساس فرق التصحيح. */
  receivedPrior: ReturnType<typeof D>;
  receiptMode: PriorReceiptMode;
  setReceiptMode: (v: PriorReceiptMode) => void;
  inferredNotReceived: boolean;
  customerChanged: boolean;
  originalTerms: PaymentTerm;
  targetTerms: PaymentTerm;
  /** المالك النشط ينفّذ فوراً؛ غيره يرسل طلباً لمراجع مستقل. */
  ownerExecutes: boolean;
  grandTotal: string;
  reason: string;
  setReason: (v: string) => void;
  correctionKind: "REISSUE" | "EXCHANGE";
  setCorrectionKind: (v: "REISSUE" | "EXCHANGE") => void;
  collectNow: string;
  setCollectNow: (v: string) => void;
  paymentMethod: PaymentMethod;
  setPaymentMethod: (v: PaymentMethod) => void;
  overpayHandling: "CREDIT" | "CASH_REFUND";
  setOverpayHandling: (v: "CREDIT" | "CASH_REFUND") => void;
  hasCustomer: boolean;
}

export function SalesCorrectionPanel(p: SalesCorrectionPanelProps) {
  const diff = D(p.grandTotal).minus(p.receivedPrior); // موجب=نقص يُحصَّل، سالب=فائض يُردّ/يُرصَّد
  const isShort = diff.gt(0);
  const isOver = diff.lt(0);
  const collect = D(p.collectNow || "0");
  const remainingCredit = isShort ? diff.minus(collect) : D("0");
  const notReceived = p.recordedPaid.minus(p.receivedPrior);
  const hasPrior = p.recordedPaid.gt(0);

  return (
    <div dir="rtl" className="space-y-3 rounded-lg border border-primary/40 bg-primary/5 p-3 text-sm">
      <div className="flex items-center gap-2 font-bold text-primary">
        <FileWarning aria-hidden className="size-4 shrink-0" />
        <span>تصحيح موثَّق{p.original?.invoiceNumber ? ` — ${p.original.invoiceNumber}` : ""}</span>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {p.ownerExecutes
          ? "بصفتك المالك يُنفَّذ التصحيح عند الحفظ مباشرة: يُعكس الأصل وتصدر الفاتورة البديلة وتسوى الفروق في معاملة واحدة."
          : "الطلب لا يغيّر شيئاً الآن. عند الاعتماد يُعكس الأصل وتصدر الفاتورة البديلة وتسوى الفروق في معاملة واحدة، ثم تصبح البديلة جاهزة للطباعة."}
      </p>

      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="نوع العملية">
        <Button type="button" variant={p.correctionKind === "REISSUE" ? "default" : "outline"}
          onClick={() => p.setCorrectionKind("REISSUE")} aria-pressed={p.correctionKind === "REISSUE"}>
          تصحيح وإعادة إصدار
        </Button>
        <Button type="button" variant={p.correctionKind === "EXCHANGE" ? "default" : "outline"}
          onClick={() => p.setCorrectionKind("EXCHANGE")} aria-pressed={p.correctionKind === "EXCHANGE"}>
          استبدال للعميل
        </Button>
      </div>

      <div className="space-y-1">
        <Label className="text-xs font-semibold">
          سبب التصحيح <span className="text-destructive">*</span>
        </Label>
        <Textarea value={p.reason} onChange={(e) => p.setReason(e.target.value)} rows={2}
          placeholder="مثال: صُحِّحت الكمية بعد مراجعة الطلب" className="text-sm" />
      </div>

      {/* ملخّص كان/أصبح — للقراءة فقط؛ كلّ ما فيه مستنتَجٌ من تعديلات الفاتورة نفسها. */}
      <Card className="space-y-1 p-2 text-xs">
        <CorrRow label="شروط الدفع" value={p.originalTerms === p.targetTerms
          ? termLabel(p.targetTerms)
          : `${termLabel(p.originalTerms)} ← ${termLabel(p.targetTerms)}`} className="font-semibold" />
        {p.customerChanged && <CorrRow label="العميل" value="تغيّر — يُنقل الحساب للعميل الجديد" className="font-semibold" />}
        <CorrRow label="مقبوضٌ مسجَّل على الأصل" value={fmt(p.recordedPaid.toString())} />
        {hasPrior && notReceived.gt(0) && (
          <CorrRow label="لم يُستلم فعلاً — يُعكس من ورديته" value={fmt(notReceived.toString())}
            className="font-bold tabular-nums text-money-negative" />
        )}
        {hasPrior && p.receivedPrior.gt(0) && (p.customerChanged || notReceived.gt(0)) && (
          <CorrRow label="مستلَمٌ يُحمَل إلى البديلة" value={fmt(p.receivedPrior.toString())} />
        )}
        <CorrRow label="إجمالي بعد التصحيح" value={fmt(p.grandTotal)} />
        <div className="my-1 h-px bg-border" />
        {diff.isZero() ? (
          <div className="font-semibold text-money-positive">لا فرق ماليّ — التصحيح متوازن.</div>
        ) : isShort ? (
          <CorrRow label="فرقٌ مستحقّ (نقص)" value={fmt(diff.toString())} className="font-bold tabular-nums text-money-negative" />
        ) : (
          <CorrRow label="فائضٌ للزبون" value={fmt(diff.abs().toString())} className="font-bold tabular-nums text-money-positive" />
        )}
      </Card>

      {hasPrior && (
        <div className="space-y-1.5">
          <Label className="text-xs font-semibold">المقبوض المسجَّل على الأصل</Label>
          <RadioGroup value={p.receiptMode} onValueChange={(v) => p.setReceiptMode(v as PriorReceiptMode)} className="gap-2">
            <label className="flex cursor-pointer items-center gap-2 text-xs">
              <RadioGroupItem value="AUTO" />
              {p.inferredNotReceived ? "يستنتجه النظام: لم يُستلم (صارت آجلة)" : "يستنتجه النظام: استُلم فعلاً"}
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-xs">
              <RadioGroupItem value="RECEIVED" /> استُلم فعلاً
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-xs">
              <RadioGroupItem value="NOT_RECEIVED" /> لم يُستلم
            </label>
          </RadioGroup>
          {notReceived.gt(0) && (
            <p className="text-xs text-muted-foreground">
              يُعلَّم الإيصال الأصليّ معكوساً بقيدٍ معاكس في ورديته؛ إن كانت مغلقة يُوثَّق تعديلٌ بعد الإغلاق يسدّ عجزها دون إعادة فتح تقرير Z.
            </p>
          )}
        </div>
      )}

      {isShort && (
        <div className="space-y-1">
          <Label className="text-xs font-semibold">المبلغ المقترح تحصيله عند الاعتماد</Label>
          <MoneyInput value={p.collectNow} onChange={p.setCollectNow} placeholder="0" ariaLabel="المبلغ المقترح تحصيله عند الاعتماد" />
          {collect.gt(0) && (
            <div className="space-y-1 pt-1">
              <Label className="text-xs font-semibold">طريقة القبض</Label>
              <div className="flex flex-wrap gap-1.5">
                {PAYMENT_METHODS.filter((m) => isPosPaymentMethodEnabled(m.value)).map((m) => {
                  const MIcon = m.icon;
                  const active = p.paymentMethod === m.value;
                  return (
                    <button key={m.value} type="button" onClick={() => p.setPaymentMethod(m.value)} aria-pressed={active}
                      className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-bold transition outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                        active ? "border-primary bg-primary/10 text-primary" : "border-input bg-card text-foreground hover:bg-muted"
                      }`}>
                      <MIcon aria-hidden className="size-4" />
                      {m.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {remainingCredit.gt(0) && (
            <p className={`text-xs ${p.hasCustomer ? "text-muted-foreground" : "text-destructive"}`}>
              {p.hasCustomer
                ? `المتبقّي ${fmt(remainingCredit.toString())} يُسجَّل ذمّةً على العميل.`
                : `المتبقّي ${fmt(remainingCredit.toString())} ذمّة — اختر عميلاً أو حصِّل الفرق كاملاً.`}
            </p>
          )}
        </div>
      )}

      {isOver && (
        <div className="space-y-1.5">
          <Label className="text-xs font-semibold">معالجة الفائض</Label>
          <RadioGroup value={p.overpayHandling} onValueChange={(v) => p.setOverpayHandling(v as "CREDIT" | "CASH_REFUND")} className="gap-2">
            <label className="flex cursor-pointer items-center gap-2 text-xs">
              <RadioGroupItem value="CASH_REFUND" /> استرداد نقديّ من الدرج
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-xs">
              <RadioGroupItem value="CREDIT" /> رصيدٌ دائنٌ للعميل
            </label>
          </RadioGroup>
          {p.overpayHandling === "CREDIT" && !p.hasCustomer && (
            <p className="text-xs text-destructive">الرصيد الدائن يتطلّب عميلاً — اختر عميلاً أو استرداداً نقدياً.</p>
          )}
          {p.overpayHandling === "CASH_REFUND" && (
            <p className="text-xs text-muted-foreground">
              {p.ownerExecutes
                ? "يُصرف الاسترداد من الدرج المفتوح الآن."
                : "يختار المراجع الدرج المفتوح لحظة الاعتماد؛ لا يخرج أي نقد عند إرسال الطلب."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
