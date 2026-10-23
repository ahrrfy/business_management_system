import { INVENTORY_MOVEMENT_LABEL as MTYPE } from "@shared/inventoryTerms";
import { Button } from "@/components/ui/button";
import {
  AlertTriangle,
  RefreshCw,
  Scale,
  CheckCheck,
  Undo2,
  Pen,
} from "lucide-react";
import { variantDescriptor, variantDisplayName } from "@shared/variantDisplay";
import { nf, signed, money, dt, Pill } from "./ReviewDisplay";
import type { ReviewRow, ReviewRowActions, Reason } from "./ReviewRowTypes";
import { D } from "@/lib/money";
import {
  CorrectedCountCell,
  NegativeSettlementPill,
} from "./NegativeSettlementUi";
import { StocktakeOverlapRow } from "./StocktakeOverlapNotice";
import { ReviewDecisionCell } from "./ReviewDecisionCell";

export function ReviewItemRow({
  r,
  actions,
  autoAdjust,
  rowSettlesNegative,
  effReason,
}: {
  r: ReviewRow;
  actions: ReviewRowActions;
  autoAdjust: boolean;
  rowSettlesNegative: (row: ReviewRow) => boolean;
  effReason: (row: ReviewRow) => Reason;
}) {
  const {
    s,
    isOperational,
    canOperation,
    selectedForApproval,
    toggleApprovalSelection,
    setReopenFor,
    setReopenReason,
    setConflictFor,
    decide,
    onDecide,
    openRecount,
    onReasonChange,
  } = actions;
  const conflictOpen = r.conflict != null && r.conflict.resolvedPick == null;
  const recPending = r.recount?.status === "PENDING";
  const recDone = r.recount?.status === "DONE";
  const uncounted = r.rawCount == null;
  const willSettleNegative = rowSettlesNegative(r);
  const movesTitle = r.movesAfter
    .map(
      (m: {
        type: string;
        qty: number;
        ref: string | null;
        at: string | Date;
      }) =>
        `${MTYPE[m.type] ?? m.type} ${signed(m.qty)}${m.ref ? ` (${m.ref})` : ""} — ${dt(m.at)}`,
    )
    .join("\n");
  const reason = effReason(r);
  return (
    <tr
      key={r.variantId}
      className={`border-t align-top ${
        r.overThreshold && !r.decision && !recPending
          ? "bg-[var(--sem-neg-bg)]/60"
          : r.diff != null && r.diff !== 0
            ? "bg-[var(--sem-warn-bg)]/40"
            : ""
      }`}
    >
      <td className="p-2.5 text-center">
        {r.reviewApproved?.isCurrent ? (
          <CheckCheck
            aria-label="معتمد مرحلياً"
            className="mx-auto size-4 text-[var(--stock-ok)]"
          />
        ) : r.readyForReviewApproval && isOperational ? (
          <input
            type="checkbox"
            checked={selectedForApproval.has(r.variantId)}
            onChange={(e) =>
              toggleApprovalSelection(r.variantId, e.target.checked)
            }
            className="size-4 accent-[var(--stock-ok)]"
            aria-label={`تحديد ${r.productName} للاعتماد المرحلي`}
            disabled={!canOperation("stocktakes.approveItems")}
          />
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      {/* المنتج */}
      <td className="p-2.5">
        <p className="font-bold">
          {r.productName}{" "}
          {variantDescriptor(r) && (
            <span className="font-normal text-muted-foreground">
              {variantDescriptor(r)}
            </span>
          )}
        </p>
        <p className="font-mono text-[11px] text-muted-foreground" dir="ltr">
          {r.sku}
        </p>
        {isOperational && <StocktakeOverlapRow row={r} />}
        <p className="text-[11px] text-muted-foreground">
          الوحدة: {r.baseUnit}
          {r.zone ? ` · المنطقة: ${r.zone}` : ""}
          {r.assignmentName ? ` · ${r.assignmentName}` : ""}
        </p>
        {recDone && r.recount && (
          <p className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold text-violet-700">
            <Undo2 aria-hidden className="size-3" />
            <span>
              أُعيد عدّه وتأكدت الكمية{" "}
              <span className="tabular-nums" dir="ltr">
                {r.recount.qty2 != null ? nf(r.recount.qty2) : "—"}
              </span>{" "}
              (طلبها {r.recount.requestedByName} — {r.recount.reason})
            </span>
          </p>
        )}
        {recPending && r.recount && (
          <p className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold text-violet-700">
            <RefreshCw aria-hidden className="size-3" />
            إعادة عدّ معلّقة (طلبها {r.recount.requestedByName} —{" "}
            {r.recount.reason})
          </p>
        )}
        {r.verify && r.verify.match && !conflictOpen && (
          <p className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--sem-pos)]">
            <CheckCheck aria-hidden className="size-3" />
            عدّ تحقّقي مطابق من {r.verify.byName}
          </p>
        )}
        {conflictOpen && r.conflict && (
          <p className="mt-1 inline-flex items-center gap-1 rounded-md bg-[var(--sem-neg-bg)] px-1.5 py-0.5 text-[11px] font-bold text-[var(--sem-neg)]">
            <AlertTriangle aria-hidden className="size-3" />
            تعارض: {r.conflict.by1} عدّ{" "}
            <span dir="ltr">{nf(r.conflict.qty1)}</span> — {r.conflict.by2} عدّ{" "}
            <span dir="ltr">{nf(r.conflict.qty2)}</span>
          </p>
        )}
        {r.conflict?.resolvedPick && (
          <p className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold text-violet-700">
            <Scale aria-hidden className="size-3" />
            فُصل في تعارض العدَّين: اعتُمد عدّ{" "}
            {r.conflict.resolvedPick === "FIRST"
              ? r.conflict.by1
              : r.conflict.by2}
          </p>
        )}
      </td>
      {/* عدّه */}
      <td className="p-2.5 text-xs text-muted-foreground">
        {r.countedByName ? (
          <>
            {r.countedByName}
            <br />
            {dt(r.countedAt)}
            {r.kindUsed === "RECOUNT" && (
              <p className="mt-0.5">
                <Pill tone="violet">إعادة عدّ</Pill>
              </p>
            )}
          </>
        ) : (
          "—"
        )}
      </td>
      {/* الدفتري المتوقع */}
      <td className="p-2.5 text-center font-mono tabular-nums" dir="ltr">
        {nf(r.expectedQty)}
      </td>
      {/* المعدود الخام */}
      <td className="p-2.5 text-center font-mono tabular-nums" dir="ltr">
        {r.rawCount == null ? "—" : nf(r.rawCount)}
      </td>
      {/* الحركات اللاحقة */}
      <td className="p-2.5 text-center">
        {r.netAfter === 0 ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : (
          <span
            className="inline-flex cursor-help items-center rounded-md bg-[var(--sem-info-bg)] px-1.5 py-0.5 font-mono text-xs font-semibold tabular-nums text-[var(--sem-info)]"
            dir="ltr"
            title={movesTitle}
          >
            {signed(r.netAfter)}
          </span>
        )}
        {r.netAfter !== 0 && (
          <p
            className={`mt-0.5 text-[10px] ${autoAdjust ? "text-[var(--sem-info)]" : "font-bold text-money-negative"}`}
          >
            {autoAdjust ? "مُصحَّحة آلياً" : "غير محتسبة!"}
          </p>
        )}
      </td>
      <CorrectedCountCell
        adjustedCount={r.adjustedCount}
        netAfter={r.netAfter}
        rawCount={r.rawCount}
        autoAdjust={autoAdjust}
        willSettleNegative={willSettleNegative}
      />
      {/* رصيد الدفتر الآن */}
      <td className="p-2.5 text-center font-mono tabular-nums" dir="ltr">
        {nf(r.bookNow)}
      </td>
      {/* الفرق */}
      <td
        className={`p-2.5 text-center font-mono font-bold tabular-nums ${
          r.diff != null && r.diff > 0
            ? "text-[var(--sem-info)]"
            : r.diff != null && r.diff < 0
              ? "text-[var(--sem-neg)]"
              : "text-[var(--sem-pos)]"
        }`}
        dir="ltr"
      >
        {r.diff == null ? "—" : signed(r.diff)}
        {r.pct != null && r.diff != null && r.diff !== 0 && (
          <p className="text-[10px] font-normal text-muted-foreground">
            ({r.pct.toFixed(1)}٪)
          </p>
        )}
      </td>
      {/* قيمة الفرق */}
      <td
        className={`p-2.5 text-center font-mono tabular-nums ${
          r.value != null && D(r.value).isNegative()
            ? "text-[var(--sem-neg)]"
            : r.value != null && D(r.value).gt(0)
              ? "text-[var(--sem-info)]"
              : "text-muted-foreground"
        }`}
        dir="ltr"
      >
        {r.value == null || r.diff === 0 ? "—" : money(r.value)}
      </td>
      {/* الحالة */}
      <td className="p-2.5 text-center">
        <div className="flex flex-col items-center gap-1">
          {uncounted ? (
            <Pill tone="muted">لم يُعَدّ</Pill>
          ) : conflictOpen ? (
            <Pill tone="rose">
              <AlertTriangle aria-hidden className="size-3" /> تعارض عدَّين
            </Pill>
          ) : recPending ? (
            <Pill tone="violet">
              <RefreshCw aria-hidden className="size-3" /> إعادة عدّ معلّقة
            </Pill>
          ) : r.diff === 0 ? (
            <Pill tone="emerald">مطابق</Pill>
          ) : r.overThreshold ? (
            <Pill tone="amber">يتجاوز الحدّ</Pill>
          ) : (
            <Pill tone="green">ضمن الحدّ</Pill>
          )}
          {r.reviewApproved?.isCurrent ? (
            <Pill
              tone="emerald"
              title={`اعتمده ${r.reviewApproved.byName} · ${dt(r.reviewApproved.at)} · الكمية المثبّتة ${nf(r.reviewApproved.snapshotQty)}`}
            >
              <CheckCheck aria-hidden className="size-3" /> معتمد ببصمة مثبتة
            </Pill>
          ) : r.reviewApproved ? (
            <Pill
              tone="amber"
              title="اعتماد سابق بلا بصمة مطابقة — حدده ثم أعد تثبيت الاعتماد"
            >
              <AlertTriangle aria-hidden className="size-3" /> يحتاج إعادة تثبيت
            </Pill>
          ) : null}
          {r.reviewApproved && isOperational && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px] text-[var(--sem-neg)]"
              onClick={() => {
                setReopenFor({
                  variantId: r.variantId,
                  label: variantDisplayName(r),
                });
                setReopenReason("");
              }}
              disabled={!canOperation("stocktakes.reopenItemReview")}
            >
              إلغاء الاعتماد
            </Button>
          )}
          {r.requiresDualSign && (
            <Pill
              tone="violet"
              title={`قيمة الفرق تتجاوز حدّ التوقيعين ${money(s.dualThreshold)}`}
            >
              <Pen aria-hidden className="size-3" /> توقيعان
            </Pill>
          )}
          {willSettleNegative && <NegativeSettlementPill />}
          {recDone && !conflictOpen && (
            <Pill tone="violet">
              <Undo2 aria-hidden className="size-3" /> إعادة عدّ منجزة
            </Pill>
          )}
          {r.verify && r.verify.match && !conflictOpen && (
            <Pill tone="emerald">
              <CheckCheck aria-hidden className="size-3" /> تحقّقي مطابق
            </Pill>
          )}
        </div>
      </td>
      <ReviewDecisionCell {...{ r, actions, reason }} />
    </tr>
  );
}
