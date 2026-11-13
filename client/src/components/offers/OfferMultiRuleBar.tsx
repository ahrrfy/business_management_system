/**
 * client/src/components/offers/OfferMultiRuleBar.tsx
 *
 * Interactive rule switcher & multi-type builder bar for Step 2 ("نوع الخصم").
 * Allows combining multiple discount rules inside a single offer creation flow
 * (either competing on shared items so best deal wins automatically, or scoped per rule).
 */

import React from "react";
import { Layers, Plus, Sparkles, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/product/variantBits";
import { summarizeRuleDraft } from "./offersMultiRuleHelpers";
import type { OfferRuleDraft } from "./offersTypes";

export interface OfferMultiRuleBarProps {
  rules: OfferRuleDraft[];
  activeIndex: number;
  onSelectRule: (index: number) => void;
  onAddRule: () => void;
  onRemoveRule: (index: number) => void;
  onChangeActiveRuleLabel: (label: string) => void;
}

export function OfferMultiRuleBar({
  rules,
  activeIndex,
  onSelectRule,
  onAddRule,
  onRemoveRule,
  onChangeActiveRuleLabel,
}: OfferMultiRuleBarProps) {
  const activeRule = rules[activeIndex];
  const isMulti = rules.length > 1;

  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Layers className="size-4 text-primary" />
          <span className="text-xs font-bold text-foreground">
            أنواع الخصم المدمجة بهذا العرض
          </span>
          <Badge variant="outline" className="text-[10px] py-0 px-1.5">
            {rules.length === 1 ? "نوع واحد" : `${rules.length} أنواع مدمجة`}
          </Badge>
        </div>

        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onAddRule}
          className="h-7 text-xs gap-1 border-primary/40 text-primary hover:bg-primary/10"
        >
          <Plus className="size-3.5" /> دمج نوع خصم إضافي بنفس العرض
        </Button>
      </div>

      {/* Rule Switcher Pills */}
      <div className="flex flex-wrap items-center gap-2">
        {rules.map((r, idx) => {
          const isCurrent = idx === activeIndex;
          return (
            <div
              key={r.key}
              className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition-colors ${
                isCurrent
                  ? "border-primary bg-primary text-primary-foreground font-semibold shadow-xs"
                  : "border-border bg-background text-foreground hover:bg-muted"
              }`}
            >
              <button
                type="button"
                onClick={() => onSelectRule(idx)}
                className="text-start cursor-pointer"
              >
                <span className="opacity-80 ml-1">خصم {idx + 1}:</span>
                <span>{summarizeRuleDraft(r)}</span>
              </button>
              {rules.length > 1 && (
                <button
                  type="button"
                  onClick={() => onRemoveRule(idx)}
                  title="إزالة هذا النوع من العرض"
                  className={`rounded p-0.5 transition-colors ${
                    isCurrent
                      ? "hover:bg-primary-foreground/20 text-primary-foreground"
                      : "text-muted-foreground hover:text-[var(--sem-neg)]"
                  }`}
                >
                  <Trash2 className="size-3" />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {isMulti && activeRule && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-border/60 items-end">
          <Field
            label={`تسمية توضيحية لخصم ${activeIndex + 1} (اختياري)`}
            hint="تظهر بجانب اسم العرض بالفواتير والتقارير لتمييزه"
          >
            <Input
              value={activeRule.ruleLabel}
              onChange={(e) => onChangeActiveRuleLabel(e.target.value)}
              placeholder="مثال: سعر المفرد / بكج 3 ملازم / توصيل مجاني..."
              className="h-8 text-xs"
              dir="auto"
            />
          </Field>

          <div className="rounded-md border border-[var(--sem-info)]/30 bg-[var(--sem-info-bg)] p-2.5 text-[11px] leading-relaxed text-[var(--sem-info)] flex items-start gap-2">
            <Sparkles className="size-3.5 shrink-0 mt-0.5" />
            <span>
              إذا اشتركت نفس المواد بأكثر من خصم، يختار النظام للزبون تلقائياً{" "}
              <strong>العرض الأوفر له حسب الكمية بالسلة</strong>، أو يمكنك تخصيص مواد منفصلة لكل خصم بالخطوة 3.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
