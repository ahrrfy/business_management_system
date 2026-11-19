import {
  ArrowDownLeft,
  ArrowUpRight,
  Banknote,
  Building2,
  CreditCard,
  FileText,
  Landmark,
  Layers,
  RotateCcw,
  Scale,
  Smartphone,
  Wallet,
} from "lucide-react";
import {
  buildBalanceTrailSnapshot,
  movementKindLabel,
  type LedgerPartyKind,
} from "@shared/balanceTrail";
import { Badge, type badgeVariants } from "@/components/ui/badge";
import { D, fmt } from "@/lib/money";
import { paymentMethodLabel } from "@/lib/paymentMethod";
import { cn } from "@/lib/utils";
import type { VariantProps } from "class-variance-authority";

type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>;

function movementVisual(kind: string | null | undefined): {
  variant: BadgeVariant;
  Icon: typeof FileText;
} {
  switch (kind) {
    case "PAYMENT_IN":
    case "RECEIPT":
    case "ADVANCE_REFUND":
      return { variant: "success", Icon: ArrowDownLeft };
    case "PAYMENT_OUT":
    case "PAYMENT":
      return { variant: "info", Icon: ArrowUpRight };
    case "RETURN":
    case "PURCHASE_RETURN":
      return { variant: "warning", Icon: RotateCcw };
    case "MANUAL_JOURNAL":
    case "OPENING":
    case "ADJUSTMENT":
      return { variant: "neutral", Icon: Scale };
    case "SALE":
    case "PURCHASE":
    case "GRNI":
      return { variant: "secondary", Icon: FileText };
    default:
      return { variant: "outline", Icon: FileText };
  }
}

export function MovementTypeBadge({
  kind,
  label,
  className,
}: {
  kind: string | null | undefined;
  label?: string | null;
  className?: string;
}) {
  const { variant, Icon } = movementVisual(kind);
  return (
    <Badge variant={variant} className={cn("font-medium", className)}>
      <Icon aria-hidden className="size-3" />
      <span>{label || movementKindLabel(kind)}</span>
    </Badge>
  );
}

function methodVisual(method: string | null | undefined): {
  variant: BadgeVariant;
  Icon: typeof Banknote;
} {
  switch (method) {
    case "CASH":
      return { variant: "success", Icon: Banknote };
    case "CARD":
      return { variant: "info", Icon: CreditCard };
    case "TRANSFER":
      return { variant: "secondary", Icon: Landmark };
    case "WALLET":
      return { variant: "warning", Icon: Wallet };
    case "TELECOM":
      return { variant: "info", Icon: Smartphone };
    case "EXCHANGE":
      return { variant: "neutral", Icon: Building2 };
    case "MIXED":
      return { variant: "outline", Icon: Layers };
    default:
      return { variant: "neutral", Icon: Banknote };
  }
}

export function PaymentMethodChip({
  method,
  cashBucket,
  cardLastFour,
  creditLabel,
  className,
}: {
  method?: string | null;
  cashBucket?: string | null;
  cardLastFour?: string | null;
  creditLabel?: string | null;
  className?: string;
}) {
  if (!method && creditLabel) {
    return (
      <Badge variant="outline" className={cn("font-medium", className)}>
        <Scale aria-hidden className="size-3" />
        <span>{creditLabel}</span>
      </Badge>
    );
  }
  const { variant, Icon } = methodVisual(method);
  const baseLabel = paymentMethodLabel(method);
  const bucketSuffix =
    method === "CASH" && cashBucket === "DRAWER"
      ? " — الدرج"
      : method === "CASH" && cashBucket === "TREASURY"
        ? " — الخزينة"
        : "";
  const cardSuffix =
    method === "CARD" && cardLastFour ? ` •••• ${cardLastFour}` : "";

  return (
    <Badge variant={variant} className={cn("font-medium", className)}>
      <Icon aria-hidden className="size-3" />
      <span>
        {baseLabel}
        {bucketSuffix}
        {cardSuffix}
      </span>
    </Badge>
  );
}

export function BalanceSnapshotStrip({
  partyType,
  before,
  debit,
  credit,
  unit = "د.ع",
  pendingReserved,
  className,
}: {
  partyType: LedgerPartyKind;
  before: string | number | null | undefined;
  debit?: string | number | null | undefined;
  credit?: string | number | null | undefined;
  unit?: string;
  pendingReserved?: string | number | null | undefined;
  className?: string;
}) {
  const snap = buildBalanceTrailSnapshot({
    partyType,
    before,
    debit,
    credit,
  });
  const debitD = D(snap.debit);
  const creditD = D(snap.credit);
  const deltaD = D(snap.delta);
  const afterD = D(snap.after);
  const hasDebit = debitD.gt(0);
  const hasCredit = creditD.gt(0);
  const effectPrefix = hasDebit && !hasCredit ? "مدين" : hasCredit && !hasDebit ? "دائن" : "الصافي";
  const signPrefix = deltaD.isNegative() ? "− " : deltaD.gt(0) ? "+ " : "";
  const shownAmount = hasDebit && !hasCredit
    ? debitD.toFixed(2)
    : hasCredit && !hasDebit
      ? creditD.toFixed(2)
      : deltaD.abs().toFixed(2);
  const deltaIsGood = partyType === "SUPPLIER" ? deltaD.isNegative() : deltaD.isNegative();
  // اتجاه الأثر الجيد: نقص الذمة (delta < 0) إيجابي لكلا الطرفين (للمورد يخفّض الدين علينا، وللعميل يسدّد ديناً لنا).
  // أمّا لون الرصيد بعد الحركة: للمورد (>0 له علينا أحمر، <0 لنا عليه أخضر)، وللعميل (>0 لنا عليه أخضر، <0 له علينا أحمر).
  const afterColorClass = afterD.isZero()
    ? "text-muted-foreground"
    : partyType === "CUSTOMER"
      ? afterD.isPositive()
        ? "text-[var(--sem-pos)]"
        : "text-[var(--sem-neg)]"
      : afterD.isPositive()
        ? "text-[var(--sem-neg)]"
        : "text-[var(--sem-pos)]";
  const pendingD = D(pendingReserved);
  const hasPending = pendingReserved != null && pendingD.gt(0);

  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-2 rounded-lg border bg-muted/20 p-2.5 sm:grid-cols-3",
        hasPending && "lg:grid-cols-4",
        className,
      )}
    >
      <div className="space-y-0.5 rounded-md bg-background/80 px-2.5 py-1.5 border">
        <div className="text-[11px] text-muted-foreground">قبل الحركة</div>
        <div className="flex items-baseline justify-between gap-2 text-sm font-semibold tabular-nums">
          <bdi dir="ltr">
            {fmt(snap.beforeAbs)} {unit}
          </bdi>
          <span className="text-xs font-medium text-muted-foreground">
            {snap.beforeDirectionLabel}
          </span>
        </div>
      </div>

      <div className="space-y-0.5 rounded-md bg-background/80 px-2.5 py-1.5 border">
        <div className="text-[11px] text-muted-foreground">أثر الحركة ({effectPrefix})</div>
        <div
          className={cn(
            "text-sm font-bold tabular-nums",
            deltaIsGood ? "text-[var(--sem-pos)]" : "text-[var(--sem-neg)]",
          )}
        >
          <bdi dir="ltr">
            {signPrefix}
            {fmt(shownAmount)} {unit}
          </bdi>
        </div>
      </div>

      <div className="space-y-0.5 rounded-md bg-background px-2.5 py-1.5 border">
        <div className="text-[11px] text-muted-foreground">الرصيد بعد الحركة</div>
        <div className="flex items-baseline justify-between gap-2 text-sm font-bold tabular-nums">
          <bdi dir="ltr">
            {fmt(snap.afterAbs)} {unit}
          </bdi>
          <span className={cn("text-xs font-semibold", afterColorClass)}>
            {snap.afterDirectionLabel}
          </span>
        </div>
      </div>

      {hasPending ? (
        <div className="space-y-0.5 rounded-md bg-background/80 px-2.5 py-1.5 border">
          <div className="text-[11px] text-muted-foreground">معلق بالاعتماد</div>
          <div className="text-sm font-semibold tabular-nums text-[var(--sem-warn)]">
            <bdi dir="ltr">
              {fmt(pendingReserved)} {unit}
            </bdi>
          </div>
        </div>
      ) : null}
    </div>
  );
}
