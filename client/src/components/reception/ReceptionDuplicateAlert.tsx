import { useEffect, useRef, useState } from "react";
import { skipToken } from "@tanstack/react-query";
import { ExternalLink, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { D, fmt } from "@/lib/money";
import { fmtDateTime } from "@/lib/date";
import { useConnectivity, isDisconnected } from "@/lib/offline/connectivity";
import { useRealtimeEvent } from "@/lib/realtime";
import { moduleAccessAllowed, type PermissionMap } from "@shared/permissions";
import { digitsArabicToLatin } from "@shared/numberNormalize";
import { receptionChannelLabel } from "@shared/receptionChannel";
import { invoiceStatusLabel } from "@shared/invoiceStatus";
import { REALTIME_EVENT_TYPES } from "@shared/realtimeEvents";
import type {
  ReceptionDuplicateInput,
  ReceptionDuplicateMatch,
  ReceptionDuplicateResult,
} from "@shared/receptionDuplicateOrders";
import "./ReceptionDuplicateAlert.css";

export interface ReceptionDuplicateAlertViewProps {
  result: ReceptionDuplicateResult;
  onContinue?: () => void;
  onVerify?: () => void;
  /** Decisions belong to this basket/record snapshot, even when the candidate is unchanged. */
  inputKey?: string;
}

export interface ReceptionDuplicateAlertProps {
  input: ReceptionDuplicateInput | null;
  enabled?: boolean;
  /** A preflight result is displayed directly without another network request. */
  result?: ReceptionDuplicateResult;
  onContinue?: () => void;
  onVerify?: () => void;
}

function DuplicateSprite() {
  return (
    <span className="reception-duplicate-sprite" aria-hidden="true">
      <svg
        className="reception-duplicate-sprite-track"
        viewBox="0 0 72 24"
        width="72"
        height="24"
        shapeRendering="crispEdges"
        focusable="false"
      >
        {[0, 1, 2].map((frame) => (
          <g
            key={frame}
            transform={`translate(${frame * 24} 0)`}
            fill="currentColor"
          >
            <path
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              d="M4 3h12v17H4z"
            />
            <path d="M7 7h6v2H7zM7 11h6v2H7zM7 15h4v2H7z" />
            <path d={`M18 ${6 + frame * 3}h3v3h-3z`} />
          </g>
        ))}
      </svg>
    </span>
  );
}

function ValueComparison({ difference }: { difference: string | null }) {
  if (difference == null) return <span>القيمة غير مكتملة للمقارنة</span>;
  const delta = D(difference);
  if (delta.isZero()) return <span>القيمة متطابقة</span>;
  return (
    <span>
      قيمة الطلب الحالي {delta.isPositive() ? "أعلى" : "أقل"} بمقدار{" "}
      <bdi className="tabular-nums" dir="ltr">
        {fmt(delta.abs().toFixed(2))}
      </bdi>{" "}
      د.ع
    </span>
  );
}

function DuplicateCandidate({ match }: { match: ReceptionDuplicateMatch }) {
  return (
    <li className="reception-duplicate-candidate">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <a
          className="reception-duplicate-link font-semibold"
          href={match.href}
          target="_blank"
          rel="noopener noreferrer"
        >
          الطلب{" "}
          <bdi dir="ltr" className="tabular-nums">
            {match.number}
          </bdi>
          <ExternalLink className="size-3" aria-hidden="true" />
        </a>
        <span>{receptionChannelLabel(match.channel)}</span>
        <Badge variant="neutral">{match.statusLabel}</Badge>
        <time
          className="text-xs text-muted-foreground tabular-nums"
          dir="ltr"
          dateTime={match.createdAt}
        >
          {fmtDateTime(match.createdAt)}
        </time>
      </div>
      <p className="mt-1 text-sm">
        الهاتف مطابق ·{" "}
        {match.contentsMatch
          ? "البنود متطابقة"
          : `${match.matchedLines} بنود مشتركة من ${match.currentLines} حالية و${match.candidateLines} في الطلب المشابه`}
        {" · "}
        {match.quantityMatch
          ? "كميات البنود المشتركة متطابقة"
          : "توجد فروق في الكميات"}
        {match.customizationNeedsReview && " · تفاصيل التخصيص تحتاج مراجعة"}
      </p>
      <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm">
        <span>
          قيمة الطلب المشابه:{" "}
          <bdi dir="ltr" className="tabular-nums font-medium">
            {fmt(match.total)}
          </bdi>{" "}
          د.ع
        </span>
        <ValueComparison difference={match.valueDifference} />
      </p>
      <div className="mt-1 text-sm">
        {match.invoice ? (
          <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
            <a
              className="reception-duplicate-link"
              href={`/invoices/${match.invoice.id}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              الفاتورة{" "}
              <bdi dir="ltr" className="tabular-nums">
                {match.invoice.number}
              </bdi>
              <ExternalLink className="size-3" aria-hidden="true" />
            </a>
            <span>
              <bdi dir="ltr" className="tabular-nums">
                {fmt(match.invoice.total)}
              </bdi>{" "}
              د.ع · {invoiceStatusLabel(match.invoice.status)}
            </span>
          </span>
        ) : (
          <span className="text-muted-foreground">لم تصدر فاتورة بعد</span>
        )}
      </div>
    </li>
  );
}

function DuplicateAlertDecision({
  result,
  onContinue,
  onVerify,
}: ReceptionDuplicateAlertViewProps) {
  const [decision, setDecision] = useState<"CONTINUE" | "VERIFY" | null>(null);
  if (decision === "CONTINUE") return null;
  return (
    <section
      className="reception-duplicate-alert"
      dir="rtl"
      aria-label="تنبيه تشابه الطلبات"
    >
      <div className="flex items-center gap-2" role="status" aria-live="polite">
        <DuplicateSprite />
        <p className="text-sm font-semibold">
          {result.matches.length
            ? "طلب مشابه؛ قرار التجهيز لموظف الاستقبال"
            : "الفحص محدود؛ راجع الطلب قبل التجهيز"}
        </p>
      </div>
      <ul className="mt-2 space-y-2" aria-label="الطلبات المشابهة">
        {result.matches.slice(0, 3).map((match) => (
          <DuplicateCandidate key={match.key} match={match} />
        ))}
      </ul>
      {(result.truncated || result.matches.length > 3) && (
        <p className="mt-2 text-xs text-muted-foreground">
          الفحص محدود؛ اعرض الطلبات المحفوظة للتأكد من بقية النتائج.
        </p>
      )}
      {decision === "VERIFY" && (
        <p className="mt-2 text-sm" role="status">
          راجع الطلب المشابه قبل اتخاذ قرار التجهيز.
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="min-h-11"
          onClick={() => {
            onContinue?.();
            setDecision("CONTINUE");
          }}
        >
          إكمال التجهيز
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="min-h-11"
          onClick={() => {
            onVerify?.();
            setDecision("VERIFY");
          }}
        >
          التأكد أولاً
        </Button>
      </div>
    </section>
  );
}

/** No requests or business mutations: choosing verification never claims a server-side hold. */
export function ReceptionDuplicateAlertView(
  props: ReceptionDuplicateAlertViewProps,
) {
  if (
    !props.result.checked ||
    (!props.result.matches.length && !props.result.truncated)
  )
    return null;
  const fingerprint = JSON.stringify([props.inputKey, props.result]);
  return <DuplicateAlertDecision key={fingerprint} {...props} />;
}

function isUsableInput(
  input: ReceptionDuplicateInput | null,
): input is ReceptionDuplicateInput {
  if (!input || !Number.isInteger(input.branchId) || input.branchId <= 0)
    return false;
  if (input.reference)
    return Number.isInteger(input.reference.id) && input.reference.id > 0;
  if (!input.channel || input.channel === "WALK_IN" || !input.lines?.length)
    return false;
  const digits = digitsArabicToLatin(input.phone ?? "").replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return false;
  try {
    return (
      input.lines.every(
        (line) => D(line.quantity).isFinite() && D(line.quantity).gt(0),
      ) &&
      (input.total == null ||
        (D(input.total).isFinite() && D(input.total).gte(0)))
    );
  } catch {
    return false;
  }
}

/** Bounded, event-driven checks; walk-in sales never issue a duplicate request. */
export function ReceptionDuplicateAlert({
  input,
  enabled = true,
  result,
  onContinue,
  onVerify,
}: ReceptionDuplicateAlertProps) {
  const inputKey = JSON.stringify(input);
  const [settled, setSettled] = useState<{
    key: string;
    input: ReceptionDuplicateInput | null;
  }>({ key: "", input: null });
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connection = useConnectivity();
  const offline = isDisconnected(connection);
  // Observe the already-loaded session cache; this warning must not add an identity request.
  const me = trpc.auth.me.useQuery(undefined, { enabled: false });
  const canRead =
    me.data != null &&
    moduleAccessAllowed(
      me.data.role,
      me.data.permissionsOverride as PermissionMap | null,
      "workorders",
      "FULL",
      ["cashier", "manager", "print_operator"],
    );
  const isReference = input?.reference != null;

  useEffect(() => {
    if (isReference || result !== undefined) return;
    const timer = setTimeout(
      () =>
        setSettled({
          key: inputKey,
          input: JSON.parse(inputKey) as ReceptionDuplicateInput | null,
        }),
      600,
    );
    return () => clearTimeout(timer);
  }, [inputKey, isReference, result]);

  const current = isReference ? input : settled.input;
  const settledForCurrentInput = isReference || settled.key === inputKey;
  const valid = isUsableInput(input);
  const canQuery =
    enabled &&
    result === undefined &&
    canRead &&
    !offline &&
    valid &&
    settledForCurrentInput;
  const query = trpc.reception.duplicateOrders.useQuery(current ?? skipToken, {
    enabled: canQuery,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const utils = trpc.useUtils();
  useRealtimeEvent(
    [
      REALTIME_EVENT_TYPES.STOREFRONT_ORDER_PLACED,
      REALTIME_EVENT_TYPES.WORK_ORDER_CREATED,
      REALTIME_EVENT_TYPES.RECEPTION_QUEUE_UPDATED,
    ],
    (event) => {
      if (
        !canQuery ||
        !current ||
        (event.scope?.branchId != null &&
          event.scope.branchId !== current.branchId) ||
        refreshTimer.current
      )
        return;
      refreshTimer.current = setTimeout(() => {
        refreshTimer.current = null;
        void utils.reception.duplicateOrders.invalidate(current);
      }, 600);
    },
  );
  useEffect(
    () => () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
    },
    [inputKey, canQuery],
  );

  if (!enabled) return null;
  if (result === undefined && (!valid || !canRead)) return null;
  if (
    offline ||
    (result === undefined && settledForCurrentInput && query.isError)
  ) {
    return (
      <div className="reception-duplicate-unavailable" dir="rtl" role="status">
        <span>تعذّر فحص التشابه؛ يمكنك المتابعة أو إعادة الفحص</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="min-h-11"
          disabled={offline || !settledForCurrentInput || query.isFetching}
          onClick={() => {
            void query.refetch();
          }}
        >
          <RotateCcw className="size-3" aria-hidden="true" />
          إعادة الفحص
        </Button>
      </div>
    );
  }
  if (result !== undefined)
    return (
      <ReceptionDuplicateAlertView
        result={result}
        inputKey={inputKey}
        onContinue={onContinue}
        onVerify={onVerify}
      />
    );
  // Never label a previous phone/basket's cached result as evidence for the new basket.
  if (!settledForCurrentInput || !query.data) return null;
  return (
    <ReceptionDuplicateAlertView
      result={query.data}
      inputKey={inputKey}
      onContinue={onContinue}
      onVerify={onVerify}
    />
  );
}
