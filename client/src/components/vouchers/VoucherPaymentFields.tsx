import { AppSelect } from "@/components/ui/AppSelect";
import { Button } from "@/components/ui/button";
import { CardBrandLogos } from "@/components/ui/CardBrandLogos";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/form/MoneyInput";
import { InferredBranchField } from "@/components/form/InferredField";
import { cn } from "@/lib/utils";
import { isInboundPaymentMethodEnabled } from "@shared/inboundPaymentPolicy";
import { AlertTriangle, Info, Plus, ShieldQuestion } from "lucide-react";
import { Link } from "wouter";
import {
  isVoucherCategoryRoleCompatible,
  UNRESOLVED_DEFAULT_VOUCHER_CATEGORIES,
  voucherCategoryAccountingGuidance,
  voucherCategoryRoleLabel,
} from "@shared/voucherCategoryAccounting";
import type { VoucherFormModel } from "./useVoucherForm";
import { MethodValue, METHODS } from "./voucherFormTypes";

type Props = Pick<
  VoucherFormModel,
  | "isReceipt"
  | "direction"
  | "branchId"
  | "setBranchId"
  | "businessDay"
  | "amount"
  | "setAmount"
  | "method"
  | "setMethod"
  | "partyType"
  | "description"
  | "referenceNumber"
  | "setReferenceNumber"
  | "cardLastFour"
  | "setCardLastFour"
  | "voucherCategoryId"
  | "setVoucherCategoryId"
  | "voucherDate"
  | "setVoucherDate"
  | "setVoucherDateTouched"
  | "categories"
  | "categoryOptions"
  | "selectedCategory"
  | "selectedCategoryReady"
  | "readyCategoryCount"
  | "canManageCategories"
  | "canRestoreCategories"
  | "setShowCategoryDialog"
  | "restoreDefaults"
  | "awaitsOwnerDisbursement"
  | "create"
>;
export function VoucherPaymentFields({
  isReceipt,
  direction,
  branchId,
  setBranchId,
  businessDay,
  amount,
  setAmount,
  method,
  setMethod,
  partyType,
  description,
  referenceNumber,
  setReferenceNumber,
  cardLastFour,
  setCardLastFour,
  voucherCategoryId,
  setVoucherCategoryId,
  voucherDate,
  setVoucherDate,
  setVoucherDateTouched,
  categories,
  categoryOptions,
  selectedCategory,
  selectedCategoryReady,
  readyCategoryCount,
  canManageCategories,
  canRestoreCategories,
  setShowCategoryDialog,
  restoreDefaults,
  awaitsOwnerDisbursement,
  create,
}: Props) {
  return (
    <Card>
      <CardHeader className="py-2.5 px-3.5">
        <CardTitle className="text-sm">البيانات الرئيسية</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-2.5 px-3.5 pb-3.5 pt-0">
        <InferredBranchField
          label="الفرع *"
          value={branchId}
          onChange={setBranchId}
          disabled={create.isPending}
        />
        <div className="space-y-1">
          <Label>المبلغ * (IQD)</Label>
          <MoneyInput
            value={amount}
            onChange={setAmount}
            placeholder="50000"
            ariaLabel="مبلغ السند بالدينار"
            className="text-right"
          />
          {awaitsOwnerDisbursement && (
            <p className="text-[11px] text-[var(--sem-warn)] flex items-center gap-1 mt-0.5">
              <ShieldQuestion aria-hidden className="size-3" />
              سيبقى طلباً بلا أثر حتى يعتمد ويصرفه حساب مالك آخر.
            </p>
          )}
        </div>

        <div className="space-y-1">
          <Label
            className="flex items-center gap-1"
            title={`${businessDay ? `افتراضه اليوم التشغيلي بتوقيت بغداد (${businessDay}). ` : ""}التاريخ الفعلي للمُعاملة (قد يَختلف عن تاريخ الإدخال).`}
          >
            تاريخ السند *
            <Info aria-hidden className="size-3 text-muted-foreground" />
          </Label>
          <Input
            type="date"
            dir="ltr"
            value={voucherDate}
            onChange={(e) => {
              setVoucherDateTouched(true);
              setVoucherDate(e.target.value);
            }}
          />
        </div>
        <div className="space-y-1">
          <Label className="inline-flex items-center gap-1.5">
            <span>طريقة الدفع *</span>
            {method === "CARD" && <CardBrandLogos size="xs" />}
          </Label>
          <AppSelect
            className="h-9"
            value={method}
            onValueChange={(value) => setMethod(value as MethodValue)}
          >
            {METHODS.map((m) => (
              <option
                key={m.value}
                value={m.value}
                disabled={!isInboundPaymentMethodEnabled(m.value)}
              >
                {m.label}
              </option>
            ))}
          </AppSelect>
        </div>

        {(method === "TRANSFER" ||
          method === "CARD" ||
          method === "WALLET") && (
          <div className="space-y-1">
            <Label>
              الرقم المرجعي {method === "TRANSFER" ? "*" : "(اختياري)"}
            </Label>
            <Input
              value={referenceNumber}
              onChange={(e) => setReferenceNumber(e.target.value)}
              placeholder="رقم العملية/التحويل"
              dir="ltr"
            />
          </div>
        )}
        {method === "CARD" && (
          <div className="space-y-1">
            <Label className="inline-flex items-center gap-1.5">
              <CardBrandLogos size="xs" />
              <span>آخر 4 من البطاقة *</span>
            </Label>
            <Input
              value={cardLastFour}
              onChange={(e) =>
                setCardLastFour(e.target.value.replace(/\D/g, "").slice(0, 4))
              }
              placeholder="1234"
              maxLength={4}
              dir="ltr"
              className="tabular-nums text-center"
            />
          </div>
        )}
        <div className="space-y-1 md:col-span-2">
          <div className="flex items-center justify-between gap-2">
            <Label
              className="flex items-center gap-1"
              title={
                partyType === "OTHER"
                  ? `توجيه محاسبي للطرف (أخرى) — تحدد الحساب المقابل الذي سيظهر في دفتر الأستاذ. ${
                      isReceipt
                        ? "سند القبض يثبت المقبوضات النقدية والبنكية والإيرادات التشغيلية والخدمية والتمويلية المباشرة. لمبيعات الأصناف ذات الخصم المخزني الآلي يُنصح باستخدام فواتير المبيعات أو نقاط البيع."
                        : "سند الصرف يثبت المصروفات التشغيلية المباشرة والمسحوبات وسداد الالتزامات. لسداد فواتير الموردين المعتمدة يُفضل اختيار الطرف (مورد)."
                    }`
                  : "تحدد الحساب المقابل الذي سيظهر في دفتر الأستاذ"
              }
            >
              فئة السند {direction === "OUT" ? "(مصروف)" : "(إيراد)"}
              {partyType === "OTHER" ? " *" : ""}
              {partyType === "OTHER" && (
                <Info aria-hidden className="size-3 text-muted-foreground" />
              )}
            </Label>
            <div className="flex items-center gap-2">
              <Link
                href="/voucher-categories"
                className="text-[11px] text-muted-foreground underline"
              >
                إدارة الفئات
              </Link>
              {canManageCategories && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-[11px]"
                  onClick={() => setShowCategoryDialog(true)}
                >
                  <Plus aria-hidden className="size-3 ms-1" /> فئة جديدة
                </Button>
              )}
            </div>
          </div>
          <AppSelect
            className="h-9"
            value={voucherCategoryId === "" ? "" : String(voucherCategoryId)}
            onValueChange={(value) =>
              setVoucherCategoryId(value === "" ? "" : Number(value))
            }
          >
            <option value="">— اختر الفئة المحاسبية —</option>
            {categoryOptions.map((c) => (
              <option
                key={Number(c.id)}
                value={Number(c.id)}
                disabled={
                  !isVoucherCategoryRoleCompatible(direction, c.postingRole)
                }
              >
                {c.name}
                {!isVoucherCategoryRoleCompatible(direction, c.postingRole)
                  ? (
                      UNRESOLVED_DEFAULT_VOUCHER_CATEGORIES as readonly string[]
                    ).includes(c.name)
                    ? " — تحتاج مساراً تخصصياً"
                    : " — غير مهيأة محاسبياً"
                  : ` — ${voucherCategoryRoleLabel(c.postingRole)}`}
              </option>
            ))}
          </AppSelect>
          {selectedCategory && (
            <div className="rounded-md border border-border/70 bg-muted/40 px-2.5 py-1.5 text-xs flex flex-wrap items-center justify-between gap-2">
              <span
                className="font-semibold text-foreground flex items-center gap-1.5"
                title={selectedCategory.description ?? undefined}
              >
                <Info aria-hidden className="size-3.5 text-primary shrink-0" />
                {selectedCategory.name}
                {selectedCategoryReady && (
                  <span className="font-normal text-[11px] text-muted-foreground">
                    (
                    {voucherCategoryAccountingGuidance(
                      direction,
                      selectedCategory,
                    )}
                    )
                  </span>
                )}
              </span>
              <span
                className={cn(
                  "text-[11px] font-medium px-2 py-0.5 rounded",
                  selectedCategoryReady
                    ? "text-primary bg-primary/10"
                    : "text-[var(--sem-warn)] bg-[var(--sem-warn-bg)] border border-[var(--sem-warn)]/30",
                )}
              >
                {selectedCategoryReady
                  ? `مهيأة: ${voucherCategoryRoleLabel(selectedCategory.postingRole)}`
                  : "غير مهيأة محاسبياً"}
              </span>
            </div>
          )}
          {partyType === "OTHER" &&
            readyCategoryCount === 0 &&
            !categories.isLoading && (
              <div className="rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-2 text-[11px] text-[var(--sem-warn)] space-y-1.5">
                <p className="flex items-start gap-1.5 font-medium">
                  <AlertTriangle
                    aria-hidden
                    className="size-3.5 mt-px shrink-0"
                  />
                  لا توجد فئة {isReceipt ? "قبض" : "صرف"} مهيأة محاسبياً — سند
                  «أخرى» لا يُحفظ بدونها.
                </p>
                {canRestoreCategories && (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-xs"
                      onClick={() => setShowCategoryDialog(true)}
                    >
                      إنشاء فئة الآن
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-xs"
                      disabled={restoreDefaults.isPending}
                      onClick={() => restoreDefaults.mutate()}
                    >
                      {restoreDefaults.isPending
                        ? "جارٍ الاستعادة…"
                        : "استعادة الفئات الافتراضية"}
                    </Button>
                  </div>
                )}
              </div>
            )}
        </div>
      </CardContent>
    </Card>
  );
}
