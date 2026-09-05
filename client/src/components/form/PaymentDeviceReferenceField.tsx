import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * حقل مرجع عملية جهاز الدفع (بطاقة) — يظهر شرطياً عند رافد ردٍّ فوريّ غير نقديّ.
 * الخادم هو من يفرض إلزاميّته فعلياً؛ هذا مجرّد إثباتٍ مبكر في الواجهة.
 */
export function PaymentDeviceReferenceField({
  id,
  value,
  onChange,
  hint,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  hint: string;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>مرجع عملية الاسترداد من جهاز الدفع</Label>
      <Input id={id} dir="ltr" value={value} maxLength={100}
        onChange={(e) => onChange(e.target.value)}
        placeholder="رقم العملية / كود الموافقة" />
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}
