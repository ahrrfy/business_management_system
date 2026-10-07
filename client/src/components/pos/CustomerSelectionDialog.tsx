import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AppSelect } from "@/components/ui/AppSelect";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { D, fmt } from "@/lib/money";
import { priceTierLabel } from "@/lib/labels";
import { ACTION_LABELS } from "@shared/actionLabels";
import { type Tier, type PosColors as C, POS_COLORS } from "./posShared";
import { QuickCustomerCreateForm } from "./QuickCustomerCreateForm";
import {
  User,
  CheckCircle2,
  AlertCircle,
  XCircle,
  Plus,
  RotateCcw,
  CreditCard,
} from "lucide-react";

export interface CustomerSelectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  C?: C;
  customerId: number | null;
  selectedCustomer:
    | RouterOutputs["customers"]["list"][number]
    | NonNullable<RouterOutputs["customers"]["get"]>
    | null;
  effectiveTier: Tier;
  tierOverride: Tier | null;
  onSelectCustomer: (
    id: number | null,
    customer?: RouterOutputs["customers"]["smartSearch"][number] | RouterOutputs["customers"]["list"][number] | null,
  ) => void;
  onSelectTier: (tier: Tier | null) => void;
  canCreate?: boolean;
}

export function CustomerSelectionDialog({
  open,
  onOpenChange,
  C = POS_COLORS,
  customerId,
  selectedCustomer,
  effectiveTier,
  tierOverride,
  onSelectCustomer,
  onSelectTier,
  canCreate = true,
}: CustomerSelectionDialogProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [showNewForm, setShowNewForm] = useState(false);

  const trimmedQuery = searchQuery.trim();
  const searchEnabled = open && trimmedQuery.length >= 1;
  const searchResults = trpc.customers.smartSearch.useQuery(
    { q: trimmedQuery, limit: 16 },
    { enabled: searchEnabled, staleTime: 30_000 },
  );

  // Fallback initial list from loaded customers when search is empty
  const customersList = trpc.customers.list.useQuery(undefined, {
    enabled: open && trimmedQuery.length === 0,
    staleTime: 60_000,
  });

  const displayList = trimmedQuery.length >= 1
    ? (searchResults.data ?? [])
    : (customersList.data ?? []).slice(0, 20);

  const isSearching = searchEnabled && searchResults.isLoading;

  const handlePick = (id: number, cust?: (typeof displayList)[number]) => {
    const picked = cust ?? displayList.find((c) => c.id === id);
    onSelectCustomer(id, picked);
    onOpenChange(false);
  };

  const handleResetToCash = () => {
    onSelectCustomer(null, null);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base font-bold text-foreground">
            <User className="size-5 text-primary" aria-hidden />
            اختيار أو ربط عميل الفاتورة
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            العميل الافتراضي هو «العميل النقدي». يمكنك ربط عميل لتطبيق فئات الأسعار الخاصة أو البيع بالآجل وفق سقف الائتمان.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          {/* 1. One-Click Cash Customer (Default) Option */}
          <div
            onClick={customerId != null ? handleResetToCash : undefined}
            className={`p-3 rounded-lg border transition-colors flex items-center justify-between gap-3 ${
              customerId == null
                ? "bg-primary/5 border-primary/40 ring-1 ring-primary/20"
                : "bg-muted/30 border-border cursor-pointer hover:bg-accent/40"
            }`}
          >
            <div className="flex items-center gap-2.5">
              <div
                className={`size-8 rounded-full flex items-center justify-center shrink-0 ${
                  customerId == null
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                <User className="size-4" aria-hidden />
              </div>
              <div>
                <div className="flex items-center gap-2 font-bold text-sm text-foreground">
                  العميل النقدي
                  <span className="text-[11px] font-normal px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                    الافتراضي
                  </span>
                </div>
                <div className="text-xs text-muted-foreground">
                  دفع فوري نقدي أو بطاقة — لا يُسجل أي ذمة أو دين
                </div>
              </div>
            </div>
            {customerId != null ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleResetToCash}
                className="text-xs shrink-0"
              >
                العودة للعميل النقدي
              </Button>
            ) : (
              <span className="text-xs font-semibold text-primary flex items-center gap-1 shrink-0">
                <CheckCircle2 className="size-4" aria-hidden />
                الافتراضي النشط
              </span>
            )}
          </div>

          {/* 2. Currently Selected Customer Profile Card */}
          {customerId != null && selectedCustomer != null && (
            <div className="p-3.5 rounded-lg border bg-card shadow-xs space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-extrabold text-base text-foreground">
                      {selectedCustomer.name}
                    </span>
                    <span className="text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground font-medium">
                      {(selectedCustomer as any).customerType ?? "فرد"}
                    </span>
                  </div>
                  {selectedCustomer.phone && (
                    <div className="text-xs text-muted-foreground mt-0.5" dir="ltr">
                      {selectedCustomer.phone}
                    </div>
                  )}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleResetToCash}
                  className="text-destructive hover:text-destructive hover:bg-destructive/10 text-xs h-8 px-2.5"
                >
                  <XCircle className="size-4 ml-1" aria-hidden />
                  إلغاء التحديد
                </Button>
              </div>

              {/* Credit Status & Balance Badges */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs pt-1 border-t">
                {/* Credit status */}
                <div className="flex items-center gap-2 p-2 rounded-md bg-muted/30 border">
                  {selectedCustomer.creditLimit != null && Number(selectedCustomer.creditLimit) === 0 ? (
                    <>
                      <AlertCircle className="size-4 text-destructive shrink-0" aria-hidden />
                      <div>
                        <div className="font-bold text-destructive">نقديّ فقط (لا يقبل الآجل)</div>
                        <div className="text-[11px] text-muted-foreground">حد الائتمان: صفر د.ع</div>
                      </div>
                    </>
                  ) : selectedCustomer.creditLimit == null ? (
                    <>
                      <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400 shrink-0" aria-hidden />
                      <div>
                        <div className="font-bold text-emerald-600 dark:text-emerald-400">مسموح بالبيع الآجل</div>
                        <div className="text-[11px] text-muted-foreground">سقف الائتمان: غير محدود</div>
                      </div>
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400 shrink-0" aria-hidden />
                      <div>
                        <div className="font-bold text-emerald-600 dark:text-emerald-400">مسموح بالبيع الآجل</div>
                        <div className="text-[11px] text-muted-foreground">
                          سقف الائتمان: {fmt(selectedCustomer.creditLimit)} د.ع
                        </div>
                      </div>
                    </>
                  )}
                </div>

                {/* Current Balance */}
                <div className="flex items-center gap-2 p-2 rounded-md bg-muted/30 border">
                  <CreditCard className="size-4 text-muted-foreground shrink-0" aria-hidden />
                  <div>
                    <div className="font-medium text-muted-foreground">الرصيد / الذمة الحالية:</div>
                    <div
                      className={`font-bold ${
                        selectedCustomer.currentBalance && D(selectedCustomer.currentBalance).gt(0)
                          ? "text-amber-600 dark:text-amber-400"
                          : "text-foreground"
                      }`}
                    >
                      {selectedCustomer.currentBalance ? fmt(selectedCustomer.currentBalance) : "0"} د.ع
                    </div>
                  </div>
                </div>
              </div>

              {/* Price Tier selector */}
              <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground font-medium">فئة السعر للفاتورة:</span>
                  <div className="w-32">
                    <AppSelect
                      value={effectiveTier}
                      onValueChange={(val) => onSelectTier(val as Tier)}
                      size="sm"
                    >
                      <option value="RETAIL">مفرد</option>
                      <option value="WHOLESALE">جملة</option>
                      <option value="GOVERNMENT">حكومي</option>
                    </AppSelect>
                  </div>
                  {tierOverride != null && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => onSelectTier(null)}
                      className="text-[11px] h-7 px-1.5 text-muted-foreground"
                      title="استعادة فئة العميل الأصلية"
                    >
                      <RotateCcw className="size-3 ml-1" aria-hidden />
                      الافتراضي
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* 3. Search & Customer List */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-bold text-foreground">
                البحث عن عميل (الاسم أو رقم الهاتف)
              </label>
              {canCreate && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setShowNewForm(!showNewForm)}
                  className="text-xs h-7 gap-1"
                >
                  <Plus className="size-3.5" aria-hidden />
                  {showNewForm ? "إلغاء الإضافة" : "عميل جديد"}
                </Button>
              )}
            </div>

            <UnifiedSearchInput
              value={searchQuery}
              onChange={setSearchQuery}
              onSubmit={() => {
                if (displayList.length > 0) handlePick(displayList[0].id, displayList[0]);
              }}
              placeholder="اكتب اسم العميل أو جزءاً من رقم الهاتف…"
              debounceMs={180}
              barcode={false}
              size="default"
              autoFocus
            />

            {/* Results List */}
            <div className="border rounded-md divide-y max-h-56 overflow-y-auto bg-card">
              {isSearching && (
                <div className="p-3 text-center text-xs text-muted-foreground">
                  {ACTION_LABELS.loading}
                </div>
              )}
              {searchResults.isError && (
                <div className="p-3 text-center text-xs text-destructive">
                  تعذّر البحث: {searchResults.error.message}
                </div>
              )}
              {!isSearching && !searchResults.isError && displayList.length === 0 && (
                <div className="p-4 text-center text-xs text-muted-foreground">
                  لا توجد نتائج مطابقة — يمكنك تسجيل عميل جديد بالضغط على «عميل جديد» أعلاه
                </div>
              )}
              {!isSearching &&
                displayList.map((c) => {
                  const isCashOnly = c.creditLimit != null && Number(c.creditLimit) === 0;
                  const tier = (c.defaultPriceTier ?? "RETAIL") as Tier;
                  const isSelected = c.id === customerId;
                  return (
                    <div
                      key={c.id}
                      onClick={() => handlePick(c.id, c)}
                      className={`p-2.5 flex items-center justify-between gap-2 hover:bg-accent/50 transition-colors cursor-pointer ${
                        isSelected ? "bg-accent/40" : ""
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-bold text-sm text-foreground truncate">
                            {c.name}
                          </span>
                          <span className="text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                            {priceTierLabel(tier)}
                          </span>
                          {isCashOnly ? (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-destructive/15 text-destructive font-bold">
                              نقدي فقط
                            </span>
                          ) : (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 font-bold">
                              يقبل الآجل
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
                          {c.phone && <span dir="ltr">{c.phone}</span>}
                          {c.currentBalance && D(c.currentBalance).gt(0) && (
                            <span className="text-amber-600 dark:text-amber-400 font-medium">
                              ذمة: {fmt(c.currentBalance)} د.ع
                            </span>
                          )}
                        </div>
                      </div>

                      <Button
                        type="button"
                        size="sm"
                        variant={isSelected ? "secondary" : "default"}
                        onClick={() => handlePick(c.id, c)}
                        className="text-xs h-7 px-3 shrink-0"
                      >
                        {isSelected ? "محدد" : "اختيار"}
                      </Button>
                    </div>
                  );
                })}
            </div>
          </div>

          {/* 4. Add New Customer Section */}
          {showNewForm && (
            <QuickCustomerCreateForm
              onCustomerCreated={(id, data) => {
                setShowNewForm(false);
                setSearchQuery("");
                handlePick(id, data as any);
              }}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
