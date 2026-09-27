import * as React from "react";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { fmtAr } from "@/lib/money";
import { fmtDateTime, fmtTime } from "@/lib/date";
import { shiftTypeLabel } from "@/lib/labels";
import type { RouterOutputs } from "@/lib/trpc";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Calculator,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Layers,
  Receipt,
  User,
  Vault,
  Wallet,
  Building2,
  Tag,
  FileText,
} from "lucide-react";

type DCShift = RouterOutputs["reports"]["dayCloseReconciliation"]["shifts"][number];
type MovementItem = DCShift["movements"][number];

export type DayCloseHoverField =
  | "cashIn"
  | "operatingOut"
  | "opening"
  | "expected"
  | "counted"
  | "drift"
  | "handoversCash";

interface DayCloseCellDetailsHoverProps {
  shift: DCShift;
  field: DayCloseHoverField;
  children: React.ReactNode;
}

export function DayCloseCellDetailsHover({
  shift,
  field,
  children,
}: DayCloseCellDetailsHoverProps) {
  return (
    <HoverCard openDelay={100} closeDelay={150}>
      <HoverCardTrigger asChild>
        <span className="inline-block">{children}</span>
      </HoverCardTrigger>
      <HoverCardContent
        align="center"
        side="top"
        sideOffset={6}
        className="w-[390px] sm:w-[440px] max-w-[95vw] rounded-xl border border-border/80 bg-popover/95 p-3.5 shadow-2xl backdrop-blur-md text-xs text-foreground z-50"
        dir="rtl"
      >
        <HoverContentBody shift={shift} field={field} />
      </HoverCardContent>
    </HoverCard>
  );
}

function HoverContentBody({
  shift,
  field,
}: {
  shift: DCShift;
  field: DayCloseHoverField;
}) {
  switch (field) {
    case "operatingOut":
      return <OperatingOutDetails shift={shift} />;
    case "cashIn":
      return <CashInDetails shift={shift} />;
    case "handoversCash":
      return <HandoversDetails shift={shift} />;
    case "opening":
      return <OpeningDetails shift={shift} />;
    case "expected":
      return <ExpectedDetails shift={shift} />;
    case "counted":
      return <CountedDetails shift={shift} />;
    case "drift":
      return <DriftDetails shift={shift} />;
    default:
      return null;
  }
}

/** تفاصيل الخارج التشغيلي: لمن صُرف المصروف والمبالغ الدقيقة */
function OperatingOutDetails({ shift }: { shift: DCShift }) {
  const items = (shift.movements || []).filter(
    (m) => m.direction === "OUT" && m.categoryType !== "HANDOVER",
  );

  return (
    <div className="space-y-3">
      {/* رأس البطاقة */}
      <div className="flex items-start justify-between border-b pb-2.5">
        <div className="flex items-center gap-2">
          <div className="rounded-lg bg-destructive/10 p-1.5 text-destructive">
            <ArrowUpRight aria-hidden className="size-4" />
          </div>
          <div>
            <h4 className="font-bold text-sm text-foreground">تفاصيل الخارج التشغيلي</h4>
            <p className="text-[11px] text-muted-foreground">
              وردية #{shift.shiftId} · {shift.userName ?? "غير مسجل"}
            </p>
          </div>
        </div>
        <div className="text-start">
          <span className="text-sm font-bold text-money-negative tabular-nums" dir="ltr">
            {fmtAr(shift.operatingOut)} د.ع
          </span>
          <span className="block text-[10px] text-muted-foreground">إجمالي الخارج</span>
        </div>
      </div>

      {/* ملخص الأبواب الفرعية */}
      <div className="grid grid-cols-2 gap-1.5 rounded-lg bg-muted/40 p-2 text-[11px]">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">مصروفات/سندات:</span>
          <span className="font-semibold text-money-negative tabular-nums" dir="ltr">
            {fmtAr(shift.expensesCash)}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">مرتجعات مبيعات:</span>
          <span className="font-semibold tabular-nums" dir="ltr">
            {fmtAr(shift.returnsCash)}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">سحب أثناء الوردية:</span>
          <span className="font-semibold tabular-nums" dir="ltr">
            {fmtAr(shift.cashDrops)}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">أخرى:</span>
          <span className="font-semibold tabular-nums" dir="ltr">
            {fmtAr(shift.otherOut)}
          </span>
        </div>
      </div>

      {/* قائمة البنود المفصلة */}
      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed py-4 text-center text-muted-foreground text-xs">
          لا توجد مصروفات أو مسحوبات تشغيلية مسجلة لهذه الوردية.
        </div>
      ) : (
        <div className="max-h-[260px] space-y-2 overflow-y-auto pe-1">
          {items.map((item) => (
            <div
              key={item.id}
              className="rounded-lg border border-border/60 bg-muted/15 p-2.5 space-y-1.5 hover:bg-muted/30 transition-colors"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className="rounded bg-destructive/15 px-1.5 py-0.5 font-medium text-[10px] text-destructive">
                    {item.categoryLabel}
                  </span>
                  {item.documentNumber && (
                    <span className="font-mono text-[11px] text-muted-foreground" dir="ltr">
                      {item.documentNumber}
                    </span>
                  )}
                </div>
                <span className="font-bold text-money-negative tabular-nums text-xs" dir="ltr">
                  -{fmtAr(item.amount)} د.ع
                </span>
              </div>

              {/* لمن صُرف المصروف */}
              <div className="flex items-center gap-1 text-[11px]">
                <User aria-hidden className="size-3 text-muted-foreground shrink-0" />
                <span className="text-muted-foreground shrink-0">المستفيد (صُرف لـ):</span>
                <span className="font-semibold text-foreground truncate">
                  {item.payee || item.partyName || "غير محدد"}
                </span>
              </div>

              {/* البيان والغرض */}
              {item.description && (
                <div className="flex items-start gap-1 text-[11px]">
                  <FileText aria-hidden className="size-3 text-muted-foreground shrink-0 mt-0.5" />
                  <span className="text-muted-foreground line-clamp-2">
                    {item.description}
                  </span>
                </div>
              )}

              {/* التصنيف والوقت */}
              <div className="flex items-center justify-between border-t border-border/40 pt-1 text-[10px] text-muted-foreground">
                <div className="flex items-center gap-1">
                  <Tag aria-hidden className="size-2.5" />
                  <span>{item.classification || "مصروف عام"}</span>
                </div>
                <div className="flex items-center gap-1 tabular-nums" dir="ltr">
                  <Clock aria-hidden className="size-2.5" />
                  <span>{fmtTime(item.createdAt)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ذيل التحقق */}
      <div className="flex items-center justify-between border-t pt-2 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1 text-money-positive font-medium">
          <CheckCircle2 aria-hidden className="size-3" /> مطابق لقيود الدرج والدفتر
        </span>
        <span className="tabular-nums" dir="ltr">
          {items.length} حركة مسجلة
        </span>
      </div>
    </div>
  );
}

/** تفاصيل الداخل النقدي: من أين جاء الإيراد والمبيعات والتحصيلات */
function CashInDetails({ shift }: { shift: DCShift }) {
  const items = (shift.movements || []).filter((m) => m.direction === "IN");

  return (
    <div className="space-y-3">
      {/* رأس البطاقة */}
      <div className="flex items-start justify-between border-b pb-2.5">
        <div className="flex items-center gap-2">
          <div className="rounded-lg bg-[var(--sem-pos)]/10 p-1.5 text-[var(--sem-pos)]">
            <ArrowDownLeft aria-hidden className="size-4" />
          </div>
          <div>
            <h4 className="font-bold text-sm text-foreground">تفاصيل الداخل النقدي</h4>
            <p className="text-[11px] text-muted-foreground">
              وردية #{shift.shiftId} · {shift.userName ?? "غير مسجل"}
            </p>
          </div>
        </div>
        <div className="text-start">
          <span className="text-sm font-bold text-money-positive tabular-nums" dir="ltr">
            +{fmtAr(shift.cashIn)} د.ع
          </span>
          <span className="block text-[10px] text-muted-foreground">إجمالي الداخل</span>
        </div>
      </div>

      {/* ملخص مصادر الإيراد */}
      <div className="grid grid-cols-3 gap-1.5 rounded-lg bg-muted/40 p-2 text-[11px]">
        <div>
          <span className="block text-muted-foreground text-[10px]">مبيعات نقدية</span>
          <span className="font-semibold text-money-positive tabular-nums" dir="ltr">
            {fmtAr(shift.salesCash)}
          </span>
        </div>
        <div>
          <span className="block text-muted-foreground text-[10px]">سندات قبض</span>
          <span className="font-semibold text-money-positive tabular-nums" dir="ltr">
            {fmtAr(shift.collectionsCash)}
          </span>
        </div>
        <div>
          <span className="block text-muted-foreground text-[10px]">عرابين/أخرى</span>
          <span className="font-semibold text-money-positive tabular-nums" dir="ltr">
            {fmtAr(shift.otherIn)}
          </span>
        </div>
      </div>

      {/* قائمة البنود */}
      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed py-4 text-center text-muted-foreground text-xs">
          لا توجد مقبوضات نقدية مسجلة لهذه الوردية.
        </div>
      ) : (
        <div className="max-h-[260px] space-y-2 overflow-y-auto pe-1">
          {items.map((item) => (
            <div
              key={item.id}
              className="rounded-lg border border-border/60 bg-muted/15 p-2.5 space-y-1.5 hover:bg-muted/30 transition-colors"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className="rounded bg-[var(--sem-pos)]/15 px-1.5 py-0.5 font-medium text-[10px] text-[var(--sem-pos)]">
                    {item.categoryLabel}
                  </span>
                  {item.documentNumber && (
                    <span className="font-mono text-[11px] text-muted-foreground" dir="ltr">
                      {item.documentNumber}
                    </span>
                  )}
                </div>
                <span className="font-bold text-money-positive tabular-nums text-xs" dir="ltr">
                  +{fmtAr(item.amount)} د.ع
                </span>
              </div>

              {/* من أين جاء الإيراد */}
              <div className="flex items-center gap-1 text-[11px]">
                <User aria-hidden className="size-3 text-muted-foreground shrink-0" />
                <span className="text-muted-foreground shrink-0">المصدر (العميل):</span>
                <span className="font-semibold text-foreground truncate">
                  {item.partyName || "زبون نقدي مباشر"}
                </span>
              </div>

              {/* البيان */}
              {item.description && (
                <div className="flex items-start gap-1 text-[11px]">
                  <FileText aria-hidden className="size-3 text-muted-foreground shrink-0 mt-0.5" />
                  <span className="text-muted-foreground line-clamp-2">
                    {item.description}
                  </span>
                </div>
              )}

              {/* التصنيف والوقت */}
              <div className="flex items-center justify-between border-t border-border/40 pt-1 text-[10px] text-muted-foreground">
                <div className="flex items-center gap-1">
                  <Tag aria-hidden className="size-2.5" />
                  <span>{item.classification || "إيراد نقدي"}</span>
                </div>
                <div className="flex items-center gap-1 tabular-nums" dir="ltr">
                  <Clock aria-hidden className="size-2.5" />
                  <span>{fmtTime(item.createdAt)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ذيل التحقق */}
      <div className="flex items-center justify-between border-t pt-2 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1 text-money-positive font-medium">
          <CheckCircle2 aria-hidden className="size-3" /> مطابق للمقبوضات الفعلية
        </span>
        <span className="tabular-nums" dir="ltr">
          {items.length} حركة مسجلة
        </span>
      </div>
    </div>
  );
}

/** تفاصيل تسليم العهدة إلى الخزينة */
function HandoversDetails({ shift }: { shift: DCShift }) {
  const items = (shift.movements || []).filter((m) => m.categoryType === "HANDOVER");

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between border-b pb-2.5">
        <div className="flex items-center gap-2">
          <div className="rounded-lg bg-primary/10 p-1.5 text-primary">
            <Vault aria-hidden className="size-4" />
          </div>
          <div>
            <h4 className="font-bold text-sm text-foreground">خرج إلى العهدة والخزينة</h4>
            <p className="text-[11px] text-muted-foreground">
              تسليم عهدة الإغلاق من درج الوردية #{shift.shiftId}
            </p>
          </div>
        </div>
        <div className="text-start">
          <span className="text-sm font-bold text-foreground tabular-nums" dir="ltr">
            {fmtAr(shift.handoversCash)} د.ع
          </span>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed py-4 text-center text-muted-foreground text-xs">
          {shift.status === "OPEN"
            ? "الوردية مفتوحة — يتم تسليم العهدة عند إغلاق الوردية."
            : "لم يتم تسجيل سند تسليم عهدة للخزينة لهذه الوردية."}
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <div
              key={item.id}
              className="rounded-lg border border-border/60 bg-muted/15 p-2.5 space-y-1.5"
            >
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs font-semibold" dir="ltr">
                  {item.documentNumber ?? item.referenceNumber}
                </span>
                <span className="font-bold tabular-nums text-xs" dir="ltr">
                  {fmtAr(item.amount)} د.ع
                </span>
              </div>
              <div className="text-[11px] text-muted-foreground">
                المستلم: <span className="font-semibold text-foreground">الخزينة الرئيسية</span>
              </div>
              <div className="text-[11px] text-muted-foreground">
                البيان: <span>{item.description || "تسليم عهدة إغلاق الوردية"}</span>
              </div>
              <div className="text-[10px] text-muted-foreground tabular-nums border-t border-border/40 pt-1" dir="ltr">
                وقت التسليم: {fmtDateTime(item.createdAt)}
              </div>
            </div>
          ))}
        </div>
      )}

      {shift.retainedInDrawer && shift.retainedInDrawer !== "0.00" && (
        <div className="rounded-lg bg-muted/30 p-2 text-[11px] flex justify-between items-center">
          <span className="text-muted-foreground">المتبقي بالدرج بعد التسليم:</span>
          <span className="font-bold tabular-nums" dir="ltr">
            {fmtAr(shift.retainedInDrawer)} د.ع
          </span>
        </div>
      )}
    </div>
  );
}

/** تفاصيل الرصيد الافتتاحي */
function OpeningDetails({ shift }: { shift: DCShift }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 border-b pb-2">
        <div className="rounded-lg bg-muted p-1.5">
          <Wallet aria-hidden className="size-4" />
        </div>
        <div>
          <h4 className="font-bold text-sm text-foreground">الرصيد الافتتاحي للدرج</h4>
          <p className="text-[11px] text-muted-foreground">وردية #{shift.shiftId}</p>
        </div>
      </div>
      <div className="space-y-2 text-[11px]">
        <div className="flex justify-between items-center rounded-lg bg-muted/40 p-2">
          <span className="text-muted-foreground">المبلغ الافتتاحي:</span>
          <span className="font-bold text-foreground text-sm tabular-nums" dir="ltr">
            {fmtAr(shift.opening)} د.ع
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">الكاشير:</span>
          <span className="font-semibold">{shift.userName ?? "غير مسجل"}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">الفرع:</span>
          <span>{shift.branchName ?? "—"}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">نوع الوردية:</span>
          <span>{shiftTypeLabel(shift.shiftType)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">تاريخ ووقت الفتح:</span>
          <span className="tabular-nums" dir="ltr">{fmtDateTime(shift.openedAt)}</span>
        </div>
      </div>
    </div>
  );
}

/** تفاصيل معادلة النقد المتوقع بالدرج */
function ExpectedDetails({ shift }: { shift: DCShift }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 border-b pb-2">
        <div className="rounded-lg bg-[var(--sem-info)]/10 p-1.5 text-[var(--sem-info)]">
          <Calculator aria-hidden className="size-4" />
        </div>
        <div>
          <h4 className="font-bold text-sm text-foreground">معادلة النقد المتوقع بالدرج</h4>
          <p className="text-[11px] text-muted-foreground">وردية #{shift.shiftId}</p>
        </div>
      </div>

      <div className="space-y-1.5 rounded-lg bg-muted/30 p-2.5 text-[11px]">
        <div className="flex justify-between">
          <span className="text-muted-foreground">الرصيد الافتتاحي (+)</span>
          <span className="font-semibold tabular-nums" dir="ltr">{fmtAr(shift.opening)}</span>
        </div>
        <div className="flex justify-between text-money-positive">
          <span>الداخل النقدي (+)</span>
          <span className="font-semibold tabular-nums" dir="ltr">+{fmtAr(shift.cashIn)}</span>
        </div>
        <div className="flex justify-between text-money-negative">
          <span>الخارج التشغيلي (−)</span>
          <span className="font-semibold tabular-nums" dir="ltr">−{fmtAr(shift.operatingOut)}</span>
        </div>
        <div className="border-t pt-1.5 flex justify-between font-bold text-xs text-[var(--sem-info)]">
          <span>المتوقع بالدرج عند العد (=)</span>
          <span className="tabular-nums" dir="ltr">{fmtAr(shift.expected)} د.ع</span>
        </div>
      </div>

      <p className="text-[10px] text-muted-foreground leading-relaxed">
        * تسليم الخزينة (خرج إلى العهدة) لا يُخصم من المتوقع؛ بل يُسلَّم من النقد الفعلي عند الإغلاق بعد احتساب الفروقات.
      </p>
    </div>
  );
}

/** تفاصيل النقد المعدود */
function CountedDetails({ shift }: { shift: DCShift }) {
  const isClosed = shift.counted != null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 border-b pb-2">
        <div className="rounded-lg bg-muted p-1.5">
          <Layers aria-hidden className="size-4" />
        </div>
        <div>
          <h4 className="font-bold text-sm text-foreground">النقد المعدود بالدرج</h4>
          <p className="text-[11px] text-muted-foreground">وردية #{shift.shiftId}</p>
        </div>
      </div>

      <div className="space-y-2 text-[11px]">
        <div className="flex justify-between items-center rounded-lg bg-muted/40 p-2">
          <span className="text-muted-foreground">المعدود عند الإغلاق:</span>
          <span className="font-bold text-foreground text-sm tabular-nums" dir="ltr">
            {isClosed ? `${fmtAr(shift.counted)} د.ع` : "جارية (لم تُغلق)"}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">المتوقع الدفتري:</span>
          <span className="font-semibold tabular-nums" dir="ltr">{fmtAr(shift.expected)} د.ع</span>
        </div>
        {isClosed && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">وقت الإغلاق والعد:</span>
            <span className="tabular-nums" dir="ltr">{fmtDateTime(shift.closedAt)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

/** تفاصيل الفرق (فائض / عجز) */
function DriftDetails({ shift }: { shift: DCShift }) {
  const driftNum = shift.drift == null ? null : Number(shift.drift);
  const isBalanced = driftNum === 0;
  const isOver = driftNum != null && driftNum > 0;
  const isShort = driftNum != null && driftNum < 0;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 border-b pb-2">
        <div
          className={`rounded-lg p-1.5 ${
            isBalanced
              ? "bg-[var(--sem-pos)]/10 text-[var(--sem-pos)]"
              : isOver
                ? "bg-[var(--sem-warn)]/10 text-[var(--sem-warn)]"
                : "bg-destructive/10 text-destructive"
          }`}
        >
          {isBalanced ? (
            <CheckCircle2 aria-hidden className="size-4" />
          ) : (
            <AlertTriangle aria-hidden className="size-4" />
          )}
        </div>
        <div>
          <h4 className="font-bold text-sm text-foreground">نتيجة المطابقة (فائض/عجز)</h4>
          <p className="text-[11px] text-muted-foreground">وردية #{shift.shiftId}</p>
        </div>
      </div>

      <div className="space-y-2 text-[11px]">
        <div className="flex justify-between items-center rounded-lg bg-muted/40 p-2">
          <span className="text-muted-foreground">الفرق المسجل:</span>
          <span
            className={`font-bold text-sm tabular-nums ${
              isBalanced
                ? "text-money-positive"
                : isOver
                  ? "text-stock-low"
                  : "text-money-negative"
            }`}
            dir="ltr"
          >
            {driftNum == null ? "—" : `${fmtAr(shift.drift)} د.ع`}
          </span>
        </div>

        <div className="rounded-lg border p-2 text-xs leading-relaxed">
          {driftNum == null ? (
            <span className="text-muted-foreground">الوردية لا تزال مفتوحة ولم يتم جردها بعد.</span>
          ) : isBalanced ? (
            <span className="text-money-positive font-medium">
              مطابق تماماً 100% — النقد المعدود بالدرج يطابق العمليات الدفترية فلساً بفلس.
            </span>
          ) : isOver ? (
            <span className="text-stock-low font-medium">
              فائض نقدي — النقد المعدود بالدرج يزيد عن العمليات المسجلة بمقدار {fmtAr(shift.drift)} د.ع.
            </span>
          ) : (
            <span className="text-money-negative font-medium">
              عجز نقدي — النقد المعدود بالدرج ينقص عن العمليات المسجلة بمقدار {fmtAr(shift.drift)} د.ع.
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
