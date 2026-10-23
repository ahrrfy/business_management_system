import { type Dispatch, type SetStateAction } from "react";
import { ChevronDown, ChevronUp, SlidersHorizontal, X } from "lucide-react";
import { AppSelect } from "@/components/ui/AppSelect";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import type { RouterOutputs } from "@/lib/trpc";
import { CATEGORY_LABEL, METHOD_LABEL } from "./expenseView";
export interface ExpenseFilterValues {
  branchId: number | "";
  category: string;
  expenseCategoryId: string;
  status: string;
  from: string;
  to: string;
  paymentMethod: string;
  source: string;
  query: string;
}
export interface ExpenseFiltersProps {
  values: ExpenseFilterValues;
  onChange: (patch: Partial<ExpenseFilterValues>) => void;
  advancedOpen: boolean;
  setAdvancedOpen: Dispatch<SetStateAction<boolean>>;
  activeChips: { key: string; label: string; clear: () => void }[];
  resetFilters: () => void;
  branches: RouterOutputs["branches"]["list"];
  categories: RouterOutputs["expenses"]["categories"]["list"];
}
export function ExpenseFilters({
  values,
  onChange,
  advancedOpen,
  setAdvancedOpen,
  activeChips,
  resetFilters,
  branches,
  categories,
}: ExpenseFiltersProps) {
  const {
    branchId,
    category,
    expenseCategoryId,
    status,
    from,
    to,
    paymentMethod,
    source,
    query,
  } = values;
  const setBranchId = (branchId: number | "") => onChange({ branchId });
  const setCategory = (category: string) => onChange({ category });
  const setExpenseCategoryId = (expenseCategoryId: string) =>
    onChange({ expenseCategoryId });
  const setStatus = (status: string) => onChange({ status });
  const setFrom = (from: string) => onChange({ from });
  const setTo = (to: string) => onChange({ to });
  const setPaymentMethod = (paymentMethod: string) =>
    onChange({ paymentMethod });
  const setSource = (source: string) => onChange({ source });
  const setQuery = (query: string) => onChange({ query });
  return (
    <Card className="gap-0 py-0">
      <CardContent className="space-y-2 p-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <SlidersHorizontal
              aria-hidden
              className="size-3.5 text-muted-foreground"
            />
            <h2 className="text-xs font-semibold">بحث وفلاتر المصروفات</h2>
            {activeChips.length > 0 && (
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
                {activeChips.length}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setAdvancedOpen((open) => !open)}
            >
              فلاتر متقدمة
              {advancedOpen ? (
                <ChevronUp aria-hidden className="size-3.5" />
              ) : (
                <ChevronDown aria-hidden className="size-3.5" />
              )}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-muted-foreground"
              disabled={activeChips.length === 0}
              onClick={resetFilters}
            >
              <X aria-hidden className="size-3" /> إعادة ضبط
            </Button>
          </div>
        </div>

        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-6">
          <div className="space-y-1 md:col-span-2 xl:col-span-3">
            <Label htmlFor="expense-search" className="text-xs">
              بحث شامل
            </Label>
            <UnifiedSearchInput
              barcode={false}
              debounceMs={0}
              id="expense-search"
              value={query}
              onChange={setQuery}
              placeholder="البيان، المستفيد، المرجع، رقم المصروف أو السند…"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="expense-branch" className="text-xs">
              الفرع
            </Label>
            <AppSelect
              id="expense-branch"
              className="h-9"
              value={String(branchId)}
              onValueChange={(value) => setBranchId(value ? Number(value) : "")}
            >
              <option value="">كل الفروع</option>
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </AppSelect>
          </div>
          <div className="space-y-1">
            <Label htmlFor="expense-status" className="text-xs">
              الحالة
            </Label>
            <AppSelect
              id="expense-status"
              className="h-9"
              value={status}
              onValueChange={(value) => setStatus(value)}
            >
              <option value="">كل الحالات</option>
              <option value="PENDING_APPROVAL">بانتظار اعتماد المالك</option>
              <option value="ACTIVE">نافذ</option>
              <option value="REJECTED">مرفوض بلا صرف</option>
              <option value="CANCELLED">ملغى</option>
            </AppSelect>
          </div>
          <div className="space-y-1">
            <Label htmlFor="expense-from" className="text-xs">
              من تاريخ
            </Label>
            <Input
              id="expense-from"
              type="date"
              dir="ltr"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="expense-to" className="text-xs">
              إلى تاريخ
            </Label>
            <Input
              id="expense-to"
              type="date"
              dir="ltr"
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </div>
        </div>

        {advancedOpen && (
          <div className="grid gap-2 border-t pt-2 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="expense-category" className="text-xs">
                الدلو المحاسبي
              </Label>
              <AppSelect
                id="expense-category"
                className="h-9"
                value={category}
                onValueChange={(value) => {
                  setCategory(value);
                  // الفلتران متداخلان: تغيير الدلو يُبطل فئةً دقيقةً قد لا تنتمي إليه،
                  // وإلّا خرجت النتيجة فارغةً بلا سببٍ ظاهر للمستخدم.
                  setExpenseCategoryId("");
                }}
              >
                <option value="">كل الدلاء</option>
                {Object.entries(CATEGORY_LABEL).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </AppSelect>
            </div>
            <div className="space-y-1">
              <Label htmlFor="expense-managed-category" className="text-xs">
                الفئة التفصيلية
              </Label>
              <AppSelect
                id="expense-managed-category"
                className="h-9"
                value={expenseCategoryId}
                onValueChange={(value) => setExpenseCategoryId(value)}
              >
                <option value="">كل الفئات</option>
                {categories
                  .filter((c) => !category || c.bucket === category)
                  .map((c) => (
                    <option key={c.id} value={String(c.id)}>
                      {c.name}
                    </option>
                  ))}
              </AppSelect>
            </div>
            <div className="space-y-1">
              <Label htmlFor="exp-f-method" className="text-xs">
                طريقة الدفع
              </Label>
              <AppSelect
                id="exp-f-method"
                value={paymentMethod}
                onValueChange={setPaymentMethod}
                placeholder="كل طرق الدفع"
              >
                <option value="">كل طرق الدفع</option>
                {Object.entries(METHOD_LABEL).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </AppSelect>
            </div>
            <div className="space-y-1">
              <Label htmlFor="exp-f-source" className="text-xs">
                نوع المصروف
              </Label>
              <AppSelect
                id="exp-f-source"
                value={source}
                onValueChange={setSource}
                placeholder="كل الأنواع"
              >
                <option value="">كل الأنواع</option>
                <option value="CASH">مالي</option>
                <option value="STOCK">مخزون (نثرية/تلف)</option>
              </AppSelect>
            </div>
          </div>
        )}

        {activeChips.length > 0 && (
          <div
            className="flex flex-wrap gap-1.5 border-t pt-2"
            aria-label="الفلاتر الفعالة"
          >
            {activeChips.map((chip) => (
              <button
                key={chip.key}
                type="button"
                onClick={chip.clear}
                className="inline-flex min-h-8 items-center gap-1 rounded-full border bg-muted/40 px-3 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {chip.label}
                <X aria-hidden className="size-3" />
              </button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
