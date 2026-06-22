import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { WhatsAppShare } from "@/components/WhatsAppShare";
import { buildReconciliationMessage } from "@/lib/whatsapp";
import { fmt } from "@/lib/money";
import { toast } from "sonner";

interface Props {
  entityName: string;
  entityType: "customer" | "supplier";
  phone?: string | null;
  currentBalance: string | number;
  /** يفتح نافذة طباعة الكشف (المستخدم يحفظه PDF لإرفاقه). */
  onPdf: () => void;
}

/**
 * بطاقة «طلب مطابقة الحساب» — تجمع ما طلبه المالك في خطوتين واضحتين:
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
      toast.success("نُسخ نص رسالة المطابقة");
    } catch {
      toast.error("تعذّر النسخ — انسخ الرسالة يدوياً من واتساب");
    }
  };

  return (
    <Card style={{ borderColor: "color-mix(in oklch, var(--brand-whatsapp) 40%, transparent)" }}>
      <CardContent className="pt-6 space-y-4">
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div>
            <div className="font-semibold">طلب مطابقة الحساب</div>
            <div className="text-xs text-muted-foreground">
              أرسِل الرصيد الحالي لـ{isCustomer ? "العميل" : "المورد"} لتأكيد المطابقة، مع إرفاق كشف PDF تفصيلي.
            </div>
          </div>
          <div className={`rounded-md px-3 py-1.5 text-sm tabular-nums ${num === 0 ? "bg-muted/40" : weHaveClaim ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`} dir="ltr">
            <span className="opacity-70 text-xs me-1">{dirLabel}:</span>
            <span className="font-bold">{fmt(Math.abs(num))}</span>
          </div>
        </div>

        <ol className="space-y-2 text-sm">
          <li className="flex items-center gap-2 flex-wrap">
            <span className="inline-flex size-5 items-center justify-center rounded-full bg-muted text-xs font-bold">١</span>
            <Button variant="outline" size="sm" onClick={onPdf}>كشف PDF للإرفاق</Button>
            <span className="text-muted-foreground text-xs">اطبع ثم اختر «حفظ كـ PDF» واحفظ الملف.</span>
          </li>
          <li className="flex items-center gap-2 flex-wrap">
            <span className="inline-flex size-5 items-center justify-center rounded-full bg-muted text-xs font-bold">٢</span>
            <WhatsAppShare phone={phone} message={msg} label="إرسال طلب المطابقة" />
            <span className="text-muted-foreground text-xs">أرفِق ملف الـPDF بالرسالة ثم اضغط إرسال.</span>
          </li>
        </ol>

        <div className="flex items-center justify-between gap-2 border-t pt-3">
          <p className="text-xs text-muted-foreground">واتساب لا يُرفِق الملف تلقائياً — أرفِقه يدوياً بعد فتح المحادثة.</p>
          <Button variant="ghost" size="sm" onClick={copy}>نسخ نص الرسالة</Button>
        </div>
      </CardContent>
    </Card>
  );
}
