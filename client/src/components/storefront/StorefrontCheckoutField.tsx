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
      ? "border-slate-200/90 bg-white ring-slate-900/[0.04]"
      : tone === "lilac"
        ? "border-slate-200/90 bg-white ring-slate-900/[0.04]"
        : "border-slate-200/90 bg-white ring-slate-900/[0.04]";
  return (
    <div
      role="group"
      aria-labelledby={`${htmlFor}-label`}
      aria-describedby={error ? errorId : undefined}
      aria-invalid={Boolean(error)}
      className={`rounded-2xl border p-3 ring-1 transition-[border-color,box-shadow] duration-150 focus-within:border-[var(--store-brand)] focus-within:ring-[var(--store-brand)]/15 dark:border-slate-800 dark:bg-slate-900 dark:ring-slate-800 ${toneClass}`}
    >
      <label
        id={`${htmlFor}-label`}
        htmlFor={htmlFor}
        className="mb-1 flex items-center gap-1.5 text-xs font-bold text-slate-600 dark:text-slate-300"
      >
        <span className="text-[var(--store-brand)]">{icon}</span>
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
