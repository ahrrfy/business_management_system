import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";

/** حقل secret: قناع •••• افتراضي + زر إظهار + إدخال نصّ جديد (يستبدل القديم). */
export function SecretField({
  label,
  hint,
  masked,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  hint?: string;
  masked: string | null;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium">{label}</label>
      {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
      <div className="flex gap-2">
        <div className="relative flex-1" dir="ltr">
          <input
            type={show ? "text" : "password"}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={masked ? `الحالي: ${masked}` : (placeholder ?? "الصق القيمة الجديدة")}
            dir="ltr"
            aria-label={label}
            className="w-full h-9 px-3 pe-9 rounded-md border border-input bg-background text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <button
            type="button"
            onClick={() => setShow(!show)}
            className="absolute end-1 top-1/2 -translate-y-1/2 size-7 grid place-items-center text-muted-foreground hover:text-foreground"
            title={show ? "إخفاء" : "إظهار"}
            aria-label={show ? `إخفاء ${label}` : `إظهار ${label}`}
          >
            {show ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
          </button>
        </div>
      </div>
    </div>
  );
}
