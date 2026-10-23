import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { WhatsAppShare } from "@/components/WhatsAppShare";
import { buildReconciliationMessage } from "@/lib/whatsapp";
import { fmt } from "@/lib/money";
import { notify } from "@/lib/notify";

interface Props {
  entityName: string;
  entityType: "customer" | "supplier";
  phone?: string | null;
  currentBalance: string | number;
  /** يفتح نافذة طباعة الكشف (المستخدم يحفظه PDF لإرفاقه). */
  onPdf: () => void;
}

/**
 * شريط «طلب مطابقة الحساب» — يجمع ما طلبه المالك في خطوتين واضحتين بصفٍّ تشغيلي مكثّف:
 *  ١) كشف PDF للإرفاق (طباعة ← حفظ كـPDF).
 *  ٢) إرسال رسالة طلب مطابقة عبر واتساب (الرصيد الحالي + طلب التأكيد)، ويُرفَق الـPDF يدوياً.
 * بلا رابط خارجي ولا بيانات على الإنترنت — أأمن مسار (قرار المالك: PDF فقط).
 */
export function StatementReconcile({ entityName, entityType, phone, currentBalance, onPdf }: Props) {
  const msg = buildReconciliationMessage({ entityName, entityType, currentBalance, attachedPdf: true });
  const num = Number(currentBalance);
  const isCustomer = entityType === "customer";
  const weHaveClaim = isCustomer ? num > 0 : num < 0;
  const dirLabel = num === 0 ? "لا توجد ذمم مستحقّة" : weHaveClaim ? "لنا عليه" : "له علينا";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(msg);
      notify.ok("نُسخ نص رسالة المطابقة");
    } catch {
      notify.err("تعذّر النسخ — انسخ الرسالة يدوياً من واتساب");
    }
  };

  return (
    <Card style={{ borderColor: "color-mix(in oklch, var(--brand-whatsapp) 40%, transparent)" }}>
      <CardContent className="px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-xs">طلب مطابقة الحساب</span>
          <div className={`rounded px-2 py-0.5 text-xs tabular-nums ${num === 0 ? "bg-muted/40" : weHaveClaim ? "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]" : "bg-[var(--sem-neg-bg)] text-[var(--sem-neg)]"}`} dir="ltr">
            <span className="opacity-70 text-[11px] me-1">{dirLabel}:</span>
            <span className="font-bold">{fmt(Math.abs(num))}</span>
          </div>
          <span className="text-[11px] text-muted-foreground">
            احفظ كشف الـPDF أولاً ثم أرفِقه يدوياً بعد فتح واتساب.
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5" onClick={onPdf} title="اطبع ثم اختر «حفظ كـ PDF» واحفظ الملف">
            <span className="inline-flex size-4 items-center justify-center rounded-full bg-muted text-[10px] font-bold">١</span>
            كشف PDF للإرفاق
          </Button>
          <span className="inline-flex items-center gap-1">
            <span className="inline-flex size-4 items-center justify-center rounded-full bg-muted text-[10px] font-bold">٢</span>
            <WhatsAppShare phone={phone} message={msg} label="إرسال طلب المطابقة" />
          </span>
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={copy}>
            نسخ نص الرسالة
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
