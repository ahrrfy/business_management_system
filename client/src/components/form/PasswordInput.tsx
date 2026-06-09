import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useState } from "react";

/**
 * حقل كلمة مرور بزرّ عين (إظهار/إخفاء) — v3-add-screens.
 * يدعم placeholder، autoComplete (new-password/current-password)، وحالة aria-invalid.
 *
 * عمداً لا نحفظ القيمة هنا؛ القيمة تبقى على المستهلك (controlled). الزرّ مجرّد toggle بصري.
 */
export interface PasswordInputProps {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoComplete?: "new-password" | "current-password" | "off";
  invalid?: boolean;
  disabled?: boolean;
  className?: string;
}

export function PasswordInput({
  id,
  value,
  onChange,
  placeholder = "••••••••",
  autoComplete = "new-password",
  invalid,
  disabled,
  className,
}: PasswordInputProps) {
  const [shown, setShown] = useState(false);

  return (
    <div dir="ltr" className={cn("relative", className)}>
      <Input
        id={id}
        type={shown ? "text" : "password"}
        dir="ltr"
        autoComplete={autoComplete}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        className="pl-9"
      />
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        disabled={disabled}
        tabIndex={-1}
        aria-label={shown ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"}
        title={shown ? "إخفاء" : "إظهار"}
        className="absolute left-1 top-1/2 -translate-y-1/2 inline-flex items-center justify-center w-7 h-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
      >
        {shown ? <EyeOffIcon /> : <EyeIcon />}
      </button>
    </div>
  );
}

function EyeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
      <line x1="2" y1="2" x2="22" y2="22" />
    </svg>
  );
}
