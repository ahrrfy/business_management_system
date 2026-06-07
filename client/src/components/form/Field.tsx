// حقل نموذج موحّد — مربوط بـreact-hook-form عبر السياق، يعرض التسمية ورسالة الخطأ العربية.
// يُستعمل داخل <Form>. يدعم نص/رقم/تاريخ/منطقة نص/قائمة.
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useFormContext } from "react-hook-form";

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

type Option = { value: string; label: string };

type FieldProps = {
  name: string;
  label: string;
  as?: "input" | "textarea" | "select";
  type?: string;
  dir?: "rtl" | "ltr";
  options?: Option[];
  placeholder?: string;
  required?: boolean;
  /** يمتدّ على عمودين في شبكة md. */
  wide?: boolean;
  rows?: number;
  hint?: string;
};

export function Field({
  name,
  label,
  as = "input",
  type = "text",
  dir,
  options = [],
  placeholder,
  required,
  wide,
  rows = 2,
  hint,
}: FieldProps) {
  const {
    register,
    formState: { errors },
  } = useFormContext();
  const error = errors[name];
  const errorId = `${name}-error`;

  return (
    <div className={cn("space-y-1", wide && "md:col-span-2")}>
      <Label htmlFor={name}>
        {label}
        {required && <span className="text-destructive"> *</span>}
      </Label>

      {as === "textarea" ? (
        <Textarea id={name} rows={rows} placeholder={placeholder} aria-invalid={!!error}
          aria-describedby={error ? errorId : undefined} {...register(name)} />
      ) : as === "select" ? (
        <select id={name} className={selectCls} aria-invalid={!!error}
          aria-describedby={error ? errorId : undefined} {...register(name)}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      ) : (
        <Input id={name} type={type} dir={dir} placeholder={placeholder} aria-invalid={!!error}
          aria-describedby={error ? errorId : undefined}
          {...register(name, type === "number" ? { valueAsNumber: true } : undefined)} />
      )}

      {hint && !error && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && (
        <p id={errorId} className="text-xs text-destructive">{String(error.message)}</p>
      )}
    </div>
  );
}
