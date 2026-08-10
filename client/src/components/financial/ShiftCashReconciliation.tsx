import { useState, type ReactNode } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Banknote,
  Calculator,
  ChevronDown,
  CircleMinus,
  CirclePlus,
  Clock3,
  Coins,
  Equal,
  FileText,
  HandCoins,
  ReceiptText,
  RotateCcw,
  ShoppingCart,
  TriangleAlert,
  UserRound,
  WalletCards,
  type LucideIcon,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

export const shiftCashReconciliationKeys = [
  "openingBalance",
  "cashSales",
  "laterCollections",
  "otherCashIn",
  "cashReturns",
  "cashExpenses",
  "cashDrops",
  "otherCashOut",
] as const;

export type ShiftCashReconciliationKey =
  (typeof shiftCashReconciliationKeys)[number];

export type ShiftCashMoneyValue = string | number | null | undefined;

/** سطر تدقيقي واحد مرتبط بحركة نقدية فعلية. */
export interface ShiftCashReconciliationEntry {
  id?: string | number;
  documentType?: string | null;
  documentNumber?: string | null;
  voucherNumber?: string | null;
  description?: string | null;
  actorName?: string | null;
  occurredAt?: string | Date | null;
  amount: ShiftCashMoneyValue;
  href?: string | null;
  statusLabel?: string | null;
  extra?: ReactNode;
}

export interface ShiftCashReconciliationBucket {
  amount: ShiftCashMoneyValue;
  entries?: readonly ShiftCashReconciliationEntry[];
  count?: number | null;
  label?: string;
  helperText?: string;
}

/**
 * تقبل القيمة المجملة مباشرة أو كائناً يتضمن السطور التفصيلية؛ وهذا يسهّل
 * ربط المكوّن بعقد API تدريجياً من دون تغيير واجهته.
 */
export type ShiftCashReconciliationBucketInput =
  | ShiftCashMoneyValue
  | ShiftCashReconciliationBucket;

export interface ShiftCashReconciliationData {
  openingBalance?: ShiftCashReconciliationBucketInput;
  cashSales?: ShiftCashReconciliationBucketInput;
  laterCollections?: ShiftCashReconciliationBucketInput;
  otherCashIn?: ShiftCashReconciliationBucketInput;
  cashReturns?: ShiftCashReconciliationBucketInput;
  cashExpenses?: ShiftCashReconciliationBucketInput;
  cashDrops?: ShiftCashReconciliationBucketInput;
  otherCashOut?: ShiftCashReconciliationBucketInput;
  expectedCash?: ShiftCashMoneyValue;
  countedCash?: ShiftCashMoneyValue;
  variance?: ShiftCashMoneyValue;
  isMatched?: boolean | null;
}

export interface ShiftCashReconciliationProps {
  data: ShiftCashReconciliationData;
  title?: string;
  description?: string;
  currencyLabel?: string;
  locale?: string;
  className?: string;
  defaultExpandedKeys?: readonly ShiftCashReconciliationKey[];
  formatMoney?: (value: ShiftCashMoneyValue) => ReactNode;
  formatDateTime?: (value: string | Date | null | undefined) => ReactNode;
  onBucketOpenChange?: (key: ShiftCashReconciliationKey, open: boolean) => void;
  renderEntryExtra?: (
    entry: ShiftCashReconciliationEntry,
    key: ShiftCashReconciliationKey,
  ) => ReactNode;
}

interface BucketMeta {
  label: string;
  helperText: string;
  operator: "+" | "−" | "";
  Icon: LucideIcon;
  tone: string;
}

const bucketMeta: Record<ShiftCashReconciliationKey, BucketMeta> = {
  openingBalance: {
    label: "الرصيد الافتتاحي",
    helperText: "النقد المسلّم عند فتح الوردية",
    operator: "",
    Icon: WalletCards,
    tone: "bg-muted/50",
  },
  cashSales: {
    label: "المبيعات النقدية",
    helperText: "الجزء النقدي فقط من فواتير البيع",
    operator: "+",
    Icon: ShoppingCart,
    tone: "bg-primary/5",
  },
  laterCollections: {
    label: "تحصيلات لاحقة",
    helperText: "قبض نقدي لديون أو فواتير سابقة",
    operator: "+",
    Icon: HandCoins,
    tone: "bg-primary/5",
  },
  otherCashIn: {
    label: "وارد نقدي آخر",
    helperText: "أي قبض نقدي غير مصنّف أعلاه",
    operator: "+",
    Icon: CirclePlus,
    tone: "bg-primary/5",
  },
  cashReturns: {
    label: "المرتجعات النقدية",
    helperText: "المبالغ النقدية المعادة للعملاء",
    operator: "−",
    Icon: RotateCcw,
    tone: "bg-destructive/5",
  },
  cashExpenses: {
    label: "المصروفات النقدية",
    helperText: "مصروفات مدفوعة من صندوق الوردية",
    operator: "−",
    Icon: ReceiptText,
    tone: "bg-destructive/5",
  },
  cashDrops: {
    label: "سحوبات النقد (Cash drops)",
    helperText: "نقد سُحب من الدرج وسُلّم للخزنة",
    operator: "−",
    Icon: ArrowDownToLine,
    tone: "bg-destructive/5",
  },
  otherCashOut: {
    label: "صادر نقدي آخر",
    helperText: "أي صرف نقدي غير مصنّف أعلاه",
    operator: "−",
    Icon: CircleMinus,
    tone: "bg-destructive/5",
  },
};

function normalizeBucket(
  input: ShiftCashReconciliationBucketInput,
): ShiftCashReconciliationBucket {
  if (typeof input === "object" && input !== null) return input;
  return { amount: input };
}

function defaultMoneyFormatter(value: ShiftCashMoneyValue): ReactNode {
  if (value === null || value === undefined || value === "") return "—";

  const raw = String(value).trim();
  const normalized = raw.replace(/[\s,٬]/g, "");
  const match = normalized.match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
  if (!match) return raw;

  const [, sign, integer, fraction] = match;
  const groupedInteger = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}${groupedInteger}${fraction ? `.${fraction}` : ""}`;
}

function isZeroMoney(value: ShiftCashMoneyValue): boolean | null {
  if (value === null || value === undefined || value === "") return null;
  const normalized = String(value)
    .trim()
    .replace(/[\s,٬]/g, "");
  return /^[+-]?0+(?:\.0+)?$/.test(normalized);
}

function defaultDateTimeFormatter(
  value: string | Date | null | undefined,
  locale: string,
): ReactNode {
  if (value === null || value === undefined || value === "") return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);

  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

interface BucketCardProps {
  bucketKey: ShiftCashReconciliationKey;
  bucket: ShiftCashReconciliationBucket;
  currencyLabel: string;
  defaultOpen: boolean;
  formatMoney: (value: ShiftCashMoneyValue) => ReactNode;
  formatDateTime: (value: string | Date | null | undefined) => ReactNode;
  onOpenChange?: (key: ShiftCashReconciliationKey, open: boolean) => void;
  renderEntryExtra?: ShiftCashReconciliationProps["renderEntryExtra"];
}

function BucketCard({
  bucketKey,
  bucket,
  currencyLabel,
  defaultOpen,
  formatMoney,
  formatDateTime,
  onOpenChange,
  renderEntryExtra,
}: BucketCardProps) {
  const [open, setOpen] = useState(defaultOpen);
  const meta = bucketMeta[bucketKey];
  const entries = bucket.entries ?? [];
  const count = bucket.count ?? entries.length;
  const label = bucket.label ?? meta.label;

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    onOpenChange?.(bucketKey, nextOpen);
  };

  return (
    <Collapsible
      open={open}
      onOpenChange={handleOpenChange}
      className={cn(
        "relative min-w-0 overflow-hidden rounded-xl border",
        meta.tone,
      )}
    >
      {meta.operator ? (
        <span
          aria-hidden="true"
          className="bg-background absolute start-3 top-3 z-10 inline-flex size-7 items-center justify-center rounded-full border text-base font-bold shadow-sm"
        >
          {meta.operator}
        </span>
      ) : null}

      <CollapsibleTrigger
        className="hover:bg-accent/40 focus-visible:ring-ring group flex w-full items-start gap-3 p-4 text-start outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset"
        aria-label={`${open ? "إخفاء" : "عرض"} تفاصيل ${label}`}
      >
        <span className="bg-background/80 mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-lg border">
          <meta.Icon className="size-4" aria-hidden="true" />
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{label}</span>
            <Badge variant="neutral">{count} حركة</Badge>
          </span>
          <span className="text-muted-foreground mt-1 block text-xs leading-5">
            {bucket.helperText ?? meta.helperText}
          </span>
          <span className="mt-3 flex items-baseline gap-1.5">
            <span dir="ltr" className="text-lg font-bold tabular-nums">
              {formatMoney(bucket.amount)}
            </span>
            <span className="text-muted-foreground text-xs">
              {currencyLabel}
            </span>
          </span>
        </span>

        <ChevronDown
          className={cn(
            "text-muted-foreground mt-1 size-4 shrink-0 transition-transform",
            open && "rotate-180",
          )}
          aria-hidden="true"
        />
      </CollapsibleTrigger>

      <CollapsibleContent className="border-t bg-background/75">
        <div className="p-3 sm:p-4">
          {entries.length === 0 ? (
            <p className="text-muted-foreground py-3 text-center text-sm">
              لا توجد سطور تفصيلية متاحة لهذا البند.
            </p>
          ) : (
            <div className="space-y-2">
              {entries.map((entry, index) => {
                const reference = [
                  entry.documentType,
                  entry.documentNumber ?? entry.voucherNumber,
                ]
                  .filter(Boolean)
                  .join(" ");
                const entryKey = entry.id ?? `${bucketKey}-${index}`;

                return (
                  <div
                    key={entryKey}
                    className="grid min-w-0 gap-3 rounded-lg border bg-card p-3 sm:grid-cols-2 xl:grid-cols-[minmax(12rem,1.35fr)_minmax(8rem,.8fr)_minmax(10rem,1fr)_minmax(8rem,.7fr)] xl:items-center"
                  >
                    <div className="min-w-0">
                      <span className="text-muted-foreground flex items-center gap-1.5 text-[11px] font-medium">
                        <FileText className="size-3" aria-hidden="true" />
                        المستند / السند
                      </span>
                      {entry.href && reference ? (
                        <a
                          href={entry.href}
                          className="text-primary mt-1 block truncate text-sm font-medium underline-offset-4 hover:underline"
                        >
                          {reference}
                        </a>
                      ) : (
                        <span className="mt-1 block truncate text-sm font-medium">
                          {reference || "—"}
                        </span>
                      )}
                      {entry.description ? (
                        <span className="text-muted-foreground mt-0.5 block truncate text-xs">
                          {entry.description}
                        </span>
                      ) : null}
                    </div>

                    <div className="min-w-0">
                      <span className="text-muted-foreground flex items-center gap-1.5 text-[11px] font-medium">
                        <UserRound className="size-3" aria-hidden="true" />
                        المنفّذ
                      </span>
                      <span className="mt-1 block truncate text-sm">
                        {entry.actorName || "—"}
                      </span>
                    </div>

                    <div className="min-w-0">
                      <span className="text-muted-foreground flex items-center gap-1.5 text-[11px] font-medium">
                        <Clock3 className="size-3" aria-hidden="true" />
                        الوقت
                      </span>
                      <span className="mt-1 block text-sm">
                        {formatDateTime(entry.occurredAt)}
                      </span>
                    </div>

                    <div className="min-w-0 sm:text-end">
                      <span className="text-muted-foreground text-[11px] font-medium">
                        المبلغ
                      </span>
                      <span className="mt-1 flex items-baseline gap-1 sm:justify-end">
                        <span dir="ltr" className="font-semibold tabular-nums">
                          {formatMoney(entry.amount)}
                        </span>
                        <span className="text-muted-foreground text-[11px]">
                          {currencyLabel}
                        </span>
                      </span>
                      {entry.statusLabel ? (
                        <Badge variant="outline" className="mt-1">
                          {entry.statusLabel}
                        </Badge>
                      ) : null}
                    </div>

                    {entry.extra || renderEntryExtra ? (
                      <div className="sm:col-span-2 xl:col-span-4">
                        {entry.extra}
                        {renderEntryExtra?.(entry, bucketKey)}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ShiftCashReconciliation({
  data,
  title = "مطابقة نقد الوردية",
  description = "تفصيل الرصيد المتوقع ومقارنته بالنقد المعدود فعلياً.",
  currencyLabel = "د.ع",
  locale = "ar-IQ",
  className,
  defaultExpandedKeys = [],
  formatMoney = defaultMoneyFormatter,
  formatDateTime,
  onBucketOpenChange,
  renderEntryExtra,
}: ShiftCashReconciliationProps) {
  const inferredMatch = isZeroMoney(data.variance);
  const matchState = data.isMatched ?? inferredMatch;
  const resolvedDateTimeFormatter =
    formatDateTime ??
    ((value: string | Date | null | undefined) =>
      defaultDateTimeFormatter(value, locale));

  return (
    <Card dir="rtl" className={cn("overflow-hidden", className)}>
      <CardHeader className="gap-2">
        <div className="flex items-center gap-2">
          <span className="bg-primary/10 text-primary inline-flex size-9 items-center justify-center rounded-lg">
            <Calculator className="size-5" aria-hidden="true" />
          </span>
          <CardTitle>{title}</CardTitle>
        </div>
        <CardDescription className="leading-6">{description}</CardDescription>
        <CardAction>
          {matchState === true ? (
            <Badge variant="success">متطابق</Badge>
          ) : matchState === false ? (
            <Badge variant="danger">يوجد فرق</Badge>
          ) : (
            <Badge variant="neutral">بانتظار العد</Badge>
          )}
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-5 px-4 sm:px-6">
        <Alert className="border-warning/30 bg-warning/5">
          <TriangleAlert className="text-warning" aria-hidden="true" />
          <AlertTitle>إجمالي الفواتير ليس هو النقد المتوقع</AlertTitle>
          <AlertDescription>
            <p>
              الفواتير قد تشمل الآجل والبطاقات والتحويلات، بينما الإغلاق يعتمد
              فقط على حركات النقد الفعلية المرتبطة بهذه الوردية، بما فيها القبض
              اللاحق والمصروفات والمرتجعات والسحوبات.
            </p>
          </AlertDescription>
        </Alert>

        <section aria-labelledby="cash-equation-heading" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="cash-equation-heading" className="font-semibold">
              معادلة الإغلاق النقدي
            </h3>
            <Badge variant="outline" className="gap-1.5">
              <Banknote className="size-3" aria-hidden="true" />
              نقد فقط
            </Badge>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {shiftCashReconciliationKeys.map((key) => (
              <BucketCard
                key={key}
                bucketKey={key}
                bucket={normalizeBucket(data[key])}
                currencyLabel={currencyLabel}
                defaultOpen={defaultExpandedKeys.includes(key)}
                formatMoney={formatMoney}
                formatDateTime={resolvedDateTimeFormatter}
                onOpenChange={onBucketOpenChange}
                renderEntryExtra={renderEntryExtra}
              />
            ))}
          </div>

          <div className="border-primary/20 bg-primary/5 flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <span className="bg-primary text-primary-foreground inline-flex size-10 shrink-0 items-center justify-center rounded-lg">
                <Equal className="size-5" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p className="font-semibold">النقد المتوقع في الدرج</p>
                <p className="text-muted-foreground text-xs">
                  ناتج البنود النقدية أعلاه كما يورده الخادم
                </p>
              </div>
            </div>
            <div className="flex items-baseline gap-2 sm:justify-end">
              <output
                dir="ltr"
                aria-label="النقد المتوقع"
                className="text-primary text-2xl font-bold tabular-nums"
              >
                {formatMoney(data.expectedCash)}
              </output>
              <span className="text-muted-foreground text-sm">
                {currencyLabel}
              </span>
            </div>
          </div>
        </section>

        <section
          aria-label="نتيجة العد والمطابقة"
          className="grid gap-3 md:grid-cols-2"
        >
          <div className="bg-muted/35 rounded-xl border p-4">
            <div className="flex items-center gap-2">
              <Coins
                className="text-muted-foreground size-4"
                aria-hidden="true"
              />
              <p className="text-sm font-medium">النقد المعدود فعلياً</p>
            </div>
            <div className="mt-3 flex items-baseline gap-2">
              <output
                dir="ltr"
                aria-label="النقد المعدود"
                className="text-xl font-bold tabular-nums"
              >
                {formatMoney(data.countedCash)}
              </output>
              <span className="text-muted-foreground text-xs">
                {currencyLabel}
              </span>
            </div>
          </div>

          <div
            className={cn(
              "rounded-xl border p-4",
              matchState === true
                ? "border-success/30 bg-success/5"
                : matchState === false
                  ? "border-destructive/30 bg-destructive/5"
                  : "bg-muted/35",
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                {matchState === false ? (
                  <TriangleAlert
                    className="text-destructive size-4"
                    aria-hidden="true"
                  />
                ) : (
                  <ArrowUpFromLine
                    className="text-muted-foreground size-4"
                    aria-hidden="true"
                  />
                )}
                <p className="text-sm font-medium">الفرق (المعدود − المتوقع)</p>
              </div>
              {matchState === true ? (
                <Badge variant="success">صفر</Badge>
              ) : null}
            </div>
            <div className="mt-3 flex items-baseline gap-2">
              <output
                dir="ltr"
                aria-live="polite"
                aria-label="فرق المطابقة"
                className={cn(
                  "text-xl font-bold tabular-nums",
                  matchState === false && "text-destructive",
                )}
              >
                {formatMoney(data.variance)}
              </output>
              <span className="text-muted-foreground text-xs">
                {currencyLabel}
              </span>
            </div>
          </div>
        </section>
      </CardContent>
    </Card>
  );
}

export default ShiftCashReconciliation;
