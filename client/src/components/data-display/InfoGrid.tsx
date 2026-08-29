import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

export type InfoValueKind = "text" | "number" | "money" | "date" | "datetime" | "code" | "phone" | "status";

type InfoGridProps = {
  children: ReactNode;
  /** compact للحقائق القصيرة، normal للتفاصيل، wide للحقول النصية الطويلة. */
  density?: "compact" | "normal" | "wide";
  className?: string;
};

const GRID_DENSITY = {
  compact: "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6",
  normal: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4",
  wide: "grid-cols-1 lg:grid-cols-2",
} as const;

/** شبكة حقائق دلالية؛ كل عنوان وقيمته يبقيان داخل الخلية نفسها في كل قياس. */
export function InfoGrid({ children, density = "normal", className }: InfoGridProps) {
  return (
    <dl
      className={cn(
        "grid items-stretch gap-x-[var(--ui-detail-gap-x)] gap-y-[var(--ui-detail-gap-y)]",
        GRID_DENSITY[density],
        className,
      )}
    >
      {children}
    </dl>
  );
}

type InfoFieldProps = {
  label: ReactNode;
  value: ReactNode;
  kind?: InfoValueKind;
  span?: 1 | 2;
  tone?: "default" | "positive" | "negative" | "warning";
  className?: string;
};

const TONE_CLASS = {
  default: "text-foreground",
  positive: "text-money-positive",
  negative: "text-money-negative",
  warning: "text-stock-low",
} as const;

const LTR_KINDS = new Set<InfoValueKind>(["number", "money", "date", "datetime", "code", "phone"]);

/**
 * حقل عرض واحد. اتجاه الحروف معزول عن محاذاة الخلية: IP/رقم/تاريخ يبقى LTR داخلياً،
 * لكنه يبدأ من الموضع نفسه الذي يبدأ منه عنوانه في RTL.
 */
export function InfoField({ label, value, kind = "text", span = 1, tone = "default", className }: InfoFieldProps) {
  const isolateLtr = LTR_KINDS.has(kind);
  const mono = kind === "code";
  const numeric = kind === "number" || kind === "money" || kind === "date" || kind === "datetime";

  return (
    <div
      className={cn(
        "min-w-0 rounded-md border border-border/55 bg-muted/15 px-3 py-2.5 text-start",
        span === 2 && "sm:col-span-2",
        className,
      )}
    >
      <dt className="text-xs font-medium leading-5 text-muted-foreground">{label}</dt>
      <dd className={cn("mt-0.5 min-w-0 [overflow-wrap:anywhere] text-sm font-semibold leading-6", numeric && "tabular-nums", mono && "font-mono", TONE_CLASS[tone])}>
        {isolateLtr ? (
          <bdi dir="ltr" className="inline-block max-w-full [unicode-bidi:isolate]">
            {value}
          </bdi>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}
