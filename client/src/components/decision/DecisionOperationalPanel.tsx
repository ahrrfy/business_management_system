import {
  AlertCircle,
  Building2,
  CheckCircle2,
  FileText,
  Info,
  Layers,
  Truck,
  Wallet,
} from "lucide-react";
import { Link } from "wouter";
import { fmtAr } from "@/lib/money";
import type { DecisionOperationalContext, DecisionOperationalFact } from "@shared/decisionRegistry";

export interface DecisionOperationalPanelProps {
  context: DecisionOperationalContext;
}

const FACT_TONE_CLASSES: Record<NonNullable<DecisionOperationalFact["tone"]>, string> = {
  default: "text-foreground",
  info: "text-blue-600 dark:text-blue-400",
  warn: "text-amber-600 dark:text-amber-400 font-bold",
  success: "text-emerald-600 dark:text-emerald-400 font-bold",
  danger: "text-rose-600 dark:text-rose-400 font-bold",
};

export function DecisionOperationalPanel({ context }: DecisionOperationalPanelProps) {
  const isShipping = context.badgeLabel?.includes("شحن") ?? false;
  const BadgeIcon = isShipping ? Truck : Layers;

  return (
    <section
      aria-label="البيان والذكاء التشغيلي للقرار"
      className="rounded-lg border border-border/70 bg-muted/20 p-3 space-y-2.5 text-xs shadow-2xs"
    >
      {/* ─── الشريط العلوي: شارة المعاملة التشغيلية + المستند المرتبط + مصدر النقد ─── */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-2">
        <div className="flex flex-wrap items-center gap-2">
          {context.badgeLabel && (
            <span className="inline-flex items-center gap-1 rounded bg-primary/10 px-2 py-0.5 text-2xs font-extrabold text-primary border border-primary/20">
              <BadgeIcon aria-hidden className="size-3" />
              {context.badgeLabel}
            </span>
          )}

          {context.sourceDocument && (
            <div className="inline-flex items-center gap-1.5 text-2xs">
              <FileText aria-hidden className="size-3.5 text-primary" />
              <span className="font-semibold text-muted-foreground">{context.sourceDocument.type}:</span>
              {context.sourceDocument.href ? (
                <Link
                  href={context.sourceDocument.href}
                  className="font-extrabold text-primary underline underline-offset-2 hover:text-primary/80"
                >
                  {context.sourceDocument.number}
                </Link>
              ) : (
                <span className="font-bold text-foreground">{context.sourceDocument.number}</span>
              )}
              {context.sourceDocument.totalAmount && (
                <span className="text-muted-foreground tabular-nums font-medium" dir="ltr">
                  ({fmtAr(context.sourceDocument.totalAmount)}{" "}
                  {context.sourceDocument.currency === "USD" ? "$" : "د.ع"})
                </span>
              )}
            </div>
          )}

          {context.underlyingParty && (
            <div className="inline-flex items-center gap-1 text-2xs text-muted-foreground">
              <Building2 aria-hidden className="size-3 text-muted-foreground" />
              <span>{context.underlyingParty.role ?? "الطرف المرتبط"}:</span>
              <span className="font-bold text-foreground">{context.underlyingParty.name}</span>
            </div>
          )}
        </div>

        {context.fundingSource && (
          <div className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-2xs font-medium text-foreground">
            <Wallet aria-hidden className="size-3 text-muted-foreground" />
            <span className="text-muted-foreground">مصدر الصرف:</span>
            <span className="font-bold">{context.fundingSource.label}</span>
          </div>
        )}
      </div>

      {/* ─── شبكة الحقائق التشغيلية ─── */}
      {context.facts && context.facts.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
          {context.facts.map((fact, idx) => {
            const toneCls = fact.tone ? FACT_TONE_CLASSES[fact.tone] : FACT_TONE_CLASSES.default;
            return (
              <div
                key={idx}
                className="rounded-md border border-border/40 bg-card/60 p-2 space-y-0.5"
              >
                <p className="text-2xs text-muted-foreground font-medium">{fact.label}</p>
                <div className="flex items-center justify-between gap-1">
                  <p className={`text-xs truncate font-extrabold ${toneCls}`} title={fact.value}>
                    {fact.value}
                  </p>
                  {fact.badge && (
                    <span className="rounded bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 text-2xs font-bold text-amber-700 dark:text-amber-300">
                      {fact.badge}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ─── توجيه رقابي وتشغيلي ذكي للمعتمد ─── */}
      {context.smartNotice && (
        <div
          role="note"
          className={`flex items-start gap-2 rounded-md p-2.5 text-2xs leading-relaxed border ${
            context.smartNotice.tone === "warn"
              ? "bg-amber-500/10 border-amber-500/30 text-amber-950 dark:text-amber-200"
              : context.smartNotice.tone === "tip"
                ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-950 dark:text-emerald-200"
                : "bg-blue-500/10 border-blue-500/30 text-blue-950 dark:text-blue-200"
          }`}
        >
          {context.smartNotice.tone === "warn" ? (
            <AlertCircle aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          ) : context.smartNotice.tone === "tip" ? (
            <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-blue-600 dark:text-blue-400" />
          )}
          <div className="min-w-0 flex-1">
            <span className="font-extrabold me-1.5 underline underline-offset-2">توجيه رقابي للمعتمد:</span>
            <span>{context.smartNotice.text}</span>
          </div>
        </div>
      )}
    </section>
  );
}
