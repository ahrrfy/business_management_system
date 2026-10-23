import React from "react";
export function StorefrontCheckoutField({
  icon,
  label,
  htmlFor,
  required = false,
  error,
  tone = "plain",
  children,
}: {
  icon: React.ReactNode;
  label: string;
  htmlFor: string;
  required?: boolean;
  error?: string;
  tone?: "plain" | "mint" | "lilac";
  children: React.ReactNode;
}) {
  const errorId = `${htmlFor}-error`;
  const toneClass =
    tone === "mint"
      ? "border-[#c5e8dc] bg-[#f7fffc] ring-[#e9f7f2]"
      : tone === "lilac"
        ? "border-[#dfcdea] bg-[#fcf8ff] ring-[#f3ebf8]"
        : "border-[#ead8c8] bg-white ring-[#f3e5da]";
  return (
    <div
      role="group"
      aria-labelledby={`${htmlFor}-label`}
      aria-describedby={error ? errorId : undefined}
      aria-invalid={Boolean(error)}
      className={`rounded-2xl border p-3 ring-1 dark:bg-slate-900 dark:ring-slate-700 ${toneClass}`}
    >
      <label
        id={`${htmlFor}-label`}
        htmlFor={htmlFor}
        className="mb-1 flex items-center gap-1.5 text-xs font-bold text-slate-600"
      >
        <span className="text-emerald-500">{icon}</span>
        {label}
        {required && (
          <>
            <span aria-hidden="true" className="text-[var(--store-accent)]">
              *
            </span>
            <span className="sr-only"> — مطلوب</span>
          </>
        )}
      </label>
      {children}
      {error && (
        <p
          id={errorId}
          role="alert"
          className="mt-1.5 text-xs font-bold text-[var(--sem-neg)]"
        >
          {error}
        </p>
      )}
    </div>
  );
}
