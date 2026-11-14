/**
 * client/src/components/offers/OfferRuleValueFields.tsx
 *
 * Step 2 rule-specific value inputs for all 6 promotion types:
 * PERCENT, AMOUNT, FIXED_PRICE, BUNDLE_PRICE, BOGO, TIERED_QTY.
 */

import React from "react";
import { Plus, Trash2, Truck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/form/MoneyInput";
import { Field } from "@/components/product/variantBits";
import { AppSelect } from "@/components/ui/AppSelect";
import type { OfferRuleDraft } from "./offersTypes";

export interface OfferRuleValueFieldsProps {
  activeRule: OfferRuleDraft;
  onUpdateRule: (patch: Partial<OfferRuleDraft>) => void;
}

export function OfferRuleValueFields({ activeRule, onUpdateRule }: OfferRuleValueFieldsProps) {
  return (
    <>
      {activeRule.type === "PERCENT" && (
        <>
          <Field label="نسبة الخصم (%)" required hint="من 1% إلى 100%">
            <Input
              type="number"
              min={1}
              max={100}
              step="0.01"
              value={activeRule.discountPercent}
              onChange={(e) => onUpdateRule({ discountPercent: e.target.value })}
            />
          </Field>
          <Field label="أعلى مبلغ خصم مسموح (اختياري)">
            <MoneyInput
              value={activeRule.maxDiscountAmount}
              onChange={(val) => onUpdateRule({ maxDiscountAmount: val })}
              placeholder="مثال: 10,000 د.ع كحد أقصى"
            />
          </Field>
        </>
      )}

      {activeRule.type === "AMOUNT" && (
        <Field label="مبلغ الخصم للقطعة الواحدة" required className="md:col-span-2">
          <MoneyInput
            value={activeRule.discountAmount}
            onChange={(val) => onUpdateRule({ discountAmount: val })}
            placeholder="مثال: 1,000 د.ع تنزيل من كل قطعة"
          />
        </Field>
      )}

      {activeRule.type === "FIXED_PRICE" && (
        <div className="md:col-span-3 space-y-3">
          <Field label="السعر الموحد للقطعة" required>
            <MoneyInput
              value={activeRule.fixedPrice}
              onChange={(val) => onUpdateRule({ fixedPrice: val })}
              placeholder="السعر الجديد لكل قطعة مشمولة"
            />
          </Field>
          <div className="rounded-md border border-[var(--sem-info)]/30 bg-[var(--sem-info-bg)] p-3 text-xs text-[var(--sem-info)]">
            حماية تلقائية للسعر: إذا كان سعر المادة الأصلي أقل من السعر الموحد، تبقى على سعرها الأصلي تلقائياً ولا يرتفع سعرها أبداً.
          </div>
        </div>
      )}

      {activeRule.type === "BUNDLE_PRICE" && (
        <>
          <Field label="طريقة حساب البكج">
            <AppSelect
              value={activeRule.bundleMode}
              onValueChange={(v) => onUpdateRule({ bundleMode: v as any })}
              className="h-9 border-input px-3 py-1 text-sm"
            >
              <option value="ALL_REQUIRED">شراء كل مواد البكج سوية</option>
              <option value="PICK_ANY_N">اختيار عدد معين من المواد المشمولة (مثلاً أي 3 قطع)</option>
            </AppSelect>
          </Field>
          {activeRule.bundleMode === "PICK_ANY_N" && (
            <Field label="عدد القطع المطلوبة بالبكج" required>
              <Input
                type="number"
                min={2}
                value={activeRule.bundleQuantity}
                onChange={(e) =>
                  onUpdateRule({ bundleQuantity: parseInt(e.target.value, 10) || 2 })
                }
              />
            </Field>
          )}
          <Field label="سعر البكج الكامل" required>
            <MoneyInput
              value={activeRule.bundlePrice}
              onChange={(val) => onUpdateRule({ bundlePrice: val })}
              placeholder="سعر البكج بعد التخفيض"
            />
          </Field>
        </>
      )}

      {activeRule.type === "BOGO" && (
        <>
          <Field label="العدد المطلوب شراؤه (اشتري)" required>
            <Input
              type="number"
              min={1}
              value={activeRule.bogoBuyQuantity}
              onChange={(e) =>
                onUpdateRule({ bogoBuyQuantity: parseInt(e.target.value, 10) || 1 })
              }
            />
          </Field>
          <Field label="العدد المجاني أو المخفض (واحصل على)" required>
            <Input
              type="number"
              min={1}
              value={activeRule.bogoGetQuantity}
              onChange={(e) =>
                onUpdateRule({ bogoGetQuantity: parseInt(e.target.value, 10) || 1 })
              }
            />
          </Field>
          <Field label="نسبة خصم القطعة الإضافية" hint="100% يعني مجاناً بالكامل، و50% يعني نصف السعر">
            <Input
              type="number"
              min={1}
              max={100}
              value={activeRule.bogoGetDiscountPercent}
              onChange={(e) => onUpdateRule({ bogoGetDiscountPercent: e.target.value })}
            />
          </Field>
        </>
      )}

      {activeRule.type === "TIERED_QTY" && (
        <div className="md:col-span-3 space-y-3">
          <Field label="طريقة حساب الكمية">
            <AppSelect
              value={activeRule.tieredMode}
              onValueChange={(v) => onUpdateRule({ tieredMode: v as any })}
              className="h-9 border-input px-3 py-1 text-sm"
            >
              <option value="PER_ITEM">حسب كمية كل مادة لوحدها</option>
              <option value="POOL_ACROSS_TARGETS">حسب مجموع كميات المواد المشمولة سوية</option>
            </AppSelect>
          </Field>

          <div className="rounded-md border border-border p-3">
            <div className="flex justify-between items-center mb-2">
              <span className="text-xs font-semibold">أسعار وخصومات الكميات</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  onUpdateRule({
                    tiers: [
                      ...activeRule.tiers,
                      { minQuantity: "5", tierType: "PERCENT", discountPercent: "10" },
                    ],
                  })
                }
                className="h-7 text-xs gap-1"
              >
                <Plus className="size-3" /> إضافة كمية جديدة
              </Button>
            </div>
            {activeRule.tiers.length === 0 ? (
              <div className="text-xs text-muted-foreground text-center py-4">
                لم تضف كميات بعد. اضغط «إضافة كمية جديدة» للبدء.
              </div>
            ) : (
              <div className="space-y-2">
                {activeRule.tiers.map((tr, idx) => (
                  <div key={idx} className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="text-muted-foreground">من كمية</span>
                    <Input
                      type="number"
                      min="1"
                      value={tr.minQuantity}
                      onChange={(e) => {
                        const val = e.target.value;
                        onUpdateRule({
                          tiers: activeRule.tiers.map((t, i) =>
                            i === idx ? { ...t, minQuantity: val } : t
                          ),
                        });
                      }}
                      className="w-16 h-8 text-center"
                    />
                    <span>قطعة فأكثر:</span>
                    <AppSelect
                      value={tr.tierType}
                      onValueChange={(tt) =>
                        onUpdateRule({
                          tiers: activeRule.tiers.map((t, i) =>
                            i === idx
                              ? {
                                  ...t,
                                  tierType: tt as any,
                                  discountPercent:
                                    tt === "PERCENT" ? (t.discountPercent || "10") : undefined,
                                  discountAmount: tt === "AMOUNT" ? t.discountAmount : undefined,
                                  fixedPrice: tt === "FIXED_PRICE" ? t.fixedPrice : undefined,
                                }
                              : t
                          ),
                        })
                      }
                      className="w-28 h-8 text-xs"
                    >
                      <option value="PERCENT">نسبة (%)</option>
                      <option value="AMOUNT">مبلغ (د.ع)</option>
                      <option value="FIXED_PRICE">سعر موحد</option>
                    </AppSelect>
                    <Input
                      value={
                        tr.tierType === "PERCENT"
                          ? tr.discountPercent ?? ""
                          : tr.tierType === "AMOUNT"
                          ? tr.discountAmount ?? ""
                          : tr.fixedPrice ?? ""
                      }
                      onChange={(e) => {
                        const val = e.target.value;
                        onUpdateRule({
                          tiers: activeRule.tiers.map((t, i) =>
                            i === idx
                              ? {
                                  ...t,
                                  discountPercent:
                                    t.tierType === "PERCENT" ? val : t.discountPercent,
                                  discountAmount:
                                    t.tierType === "AMOUNT" ? val : t.discountAmount,
                                  fixedPrice: t.tierType === "FIXED_PRICE" ? val : t.fixedPrice,
                                }
                              : t
                          ),
                        });
                      }}
                      className="w-24 h-8 text-center"
                      placeholder="القيمة"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() =>
                        onUpdateRule({
                          tiers: activeRule.tiers.filter((_, i) => i !== idx),
                        })
                      }
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {activeRule.type === "FREE_SHIPPING" && (
        <div className="md:col-span-3 rounded-lg border border-[var(--sem-pos)]/35 bg-[var(--sem-pos-bg)]/50 p-3.5 space-y-1.5 text-xs">
          <div className="flex items-center gap-2 font-bold text-[var(--sem-pos)]">
            <Truck className="size-4 shrink-0" />
            <span>توصيل مجاني تلقائي على حساب المكتبة</span>
          </div>
          <p className="text-muted-foreground leading-relaxed">
            تصير أجرة التوصيل مجاناً للزبون تلقائياً عند إتمام البيع في الكاشير والاستقبال والفواتير والمتجر الإلكتروني، وتُسجَّل «على المكتبة» مع طباعة التوصيل المجاني وقيمته في الفاتورة وملصق الطلب.
          </p>
          <p className="text-[11px] text-[var(--sem-info)] font-medium">
            يمكنك تحديد مواد أو أقسام معينة بالخطوة 3، أو اشتراط أقل مبلغ للفاتورة بالخطوة 4، كما يمكنك دمج التوصيل المجاني مع أي خصم سعري آخر بنفس العرض.
          </p>
        </div>
      )}
    </>
  );
}
