import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { AppSelect } from "@/components/ui/AppSelect";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { DataTable } from "@/components/data-table/DataTable";
import { CollectConsignmentDialog } from "./CollectConsignmentDialog";
import { CancelDeliveryAssignmentDialog } from "./CancelDeliveryAssignmentDialog";
import { ConsignmentTimelineDrawer } from "./ConsignmentTimelineDrawer";
import { ReturnConsignmentDialog } from "./ReturnConsignmentDialog";
import { DeliveryWorkspaceExport } from "./CompanyWorkspace";
import { CompanyConsignmentFinancials } from "./CompanyConsignmentFinancials";
import {
  companyConsignmentColumns,
  CompanyConsignmentActions,
  CompanyConsignmentDriver,
  CN_STATUS,
  PARCEL_STATUS,
} from "./companyConsignmentColumns";
import {
  fetchAllDeliveryPages,
  deliveryTotals,
  requireDeliverySelection,
  DELIVERY_WORKSPACE_STATES,
} from "@/lib/deliveryWorkspace";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { fmtDate } from "@/lib/date";
import { fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
type PartyRow = RouterOutputs["delivery"]["listParties"][number];
type ConsignmentRow = RouterOutputs["delivery"]["consignments"]["rows"][number];
export type OrderState =
  | "ALL"
  | "IN_TRANSIT"
  | "DELIVERED_UNCOLLECTED"
  | "COLLECTED_UNREMITTED"
  | "RETURN_PENDING"
  | "CLOSED";
export function ConsignmentsTab({
  party,
  canEdit,
  canSettle,
  state,
  onState,
}: {
  party: PartyRow;
  canEdit: boolean;
  canSettle: boolean;
  state: OrderState;
  onState: (state: OrderState) => void;
}) {
  const partyId = party.id;
  const [query, setQuery] = useState("");
  const [draftQuery, setDraftQuery] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [cursors, setCursors] = useState<Array<number | undefined>>([
    undefined,
  ]);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Map<number, ConsignmentRow>>(
    new Map(),
  );
  const [timelineId, setTimelineId] = useState<number | null>(null);
  const [returnTarget, setReturnTarget] = useState<{
    consignmentId: number;
    label: string;
  } | null>(null);
  const resetPage = () => {
    setPage(0);
    setCursors([undefined]);
    setSelected(new Map());
  };
  useEffect(resetPage, [query, from, to, state]);
  const filters = {
    partyId,
    query: query || undefined,
    from: from || undefined,
    to: to || undefined,
    state,
    limit: 50,
  };
  const filterLabel = `بحث: ${query || "الكل"} · الحالة: ${DELIVERY_WORKSPACE_STATES.find((option) => option.value === state)?.label ?? state} · تاريخ الإرسال (UTC) من: ${from || "البداية"} · إلى: ${to || "اليوم"}`;
  const [collectConsignmentTarget, setCollectConsignmentTarget] =
    useState<ConsignmentRow | null>(null);
  const [cancelConsignmentTarget, setCancelConsignmentTarget] = useState<{
    id: number;
    number: string;
  } | null>(null);
  const q = trpc.delivery.consignments.useQuery({
    ...filters,
    cursor: cursors[page],
  });
  const members = trpc.delivery.partyMembers.useQuery({ partyId });
  const utils = trpc.useUtils();
  const reassignM = trpc.delivery.reassignConsignment.useMutation({
    onSuccess: () => {
      notify.ok("تم تحديث إسناد الطرد");
      void utils.delivery.consignments.invalidate({ partyId });
    },
    onError: (e) => notify.err(e),
  });
  const list = q.data?.rows ?? [];
  const receiveReturn = trpc.delivery.returnConsignment.useMutation({
    onSuccess: () => {
      setReturnTarget(null);
      refresh();
      notify.ok("تم استلام المرتجع");
    },
    onError: (error) => notify.err(error),
  });
  const refresh = () => {
    void utils.delivery.consignments.invalidate({ partyId });
    void utils.delivery.getParty.invalidate({ id: partyId });
    void utils.delivery.partyFinancials.invalidate({ partyId });
    void utils.delivery.partyStatement.invalidate({ partyId });
    void utils.delivery.remittancesPage.invalidate({ partyId });
    void utils.delivery.consignmentTimeline.invalidate();
    void utils.delivery.listParties.invalidate();
  };
  const exportRecord = (row: ConsignmentRow): Record<string, string> => ({
    consignment: row.consignmentNumber,
    invoice: row.invoiceNumber ?? "",
    tracking: row.externalTrackingRef ?? "",
    customer: row.customerName ?? row.recipientName ?? "",
    phone: row.customerPhone ?? "",
    cod: row.codAmount,
    credited: row.collectedAmount,
    counter: row.counterSettledAmount,
    shortfall: row.shortfallAssigned,
    due: row.remainingDue,
    fee: row.deliveryFee,
    status: CN_STATUS[row.moneyStatus]?.label ?? row.moneyStatus,
    parcel: PARCEL_STATUS[row.parcelStatus] ?? row.parcelStatus,
    driver: row.assignedUserName ?? "",
    dispatched: fmtDate(row.dispatchedAt),
    remittance: row.remittanceNumber ?? "",
  });
  const exportColumns = [
    { key: "consignment", header: "الإرسالية", text: true },
    { key: "invoice", header: "الفاتورة", text: true },
    { key: "tracking", header: "التتبع", text: true },
    { key: "customer", header: "العميل" },
    { key: "phone", header: "الهاتف", text: true },
    { key: "cod", header: "قيمة COD", money: true },
    { key: "credited", header: "سوي بالتوريد", money: true },
    { key: "counter", header: "سوي في المكتبة", money: true },
    { key: "shortfall", header: "عجز محمل", money: true },
    { key: "due", header: "متبقي التسوية", money: true },
    { key: "fee", header: "أجرة التوصيل", money: true },
    { key: "status", header: "التسوية" },
    { key: "parcel", header: "الطرد" },
    { key: "driver", header: "السائق" },
    { key: "dispatched", header: "الإرسال (توقيت الجهاز)" },
    { key: "remittance", header: "التوريد", text: true },
  ];
  const totalExports = (rows: Record<string, string>[]) => {
    const total = deliveryTotals(rows, [
      "cod",
      "credited",
      "counter",
      "shortfall",
      "due",
      "fee",
    ]);
    return {
      "قيمة COD": total.cod,
      "سوي بالتوريد": total.credited,
      "سوي في المكتبة": total.counter,
      "عجز محمل": total.shortfall,
      "متبقي التسوية": total.due,
      أجور: total.fee,
    };
  };
  const drivers = (members.data ?? []).filter(
    (m) => m.isActive && m.memberRole === "DRIVER",
  );
  // الأعمدة تُغلِق على طفرة إعادة الإسناد وقائمة السائقين ⇒ تُبنى في كل تصيير (بلا تجميد يُقادم الحالة).
  const actionOptions = {
    canEdit,
    canSettle,
    partyId,
    drivers,
    reassignM,
    setCollectConsignmentTarget,
    setCancelConsignmentTarget,
    setTimelineId,
    setReturnTarget,
  };
  const columns = companyConsignmentColumns(actionOptions);
  const toggleSelection = (id: number) =>
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(id)) next.delete(id);
      else {
        const row = list.find((item) => item.id === id);
        if (row) next.set(id, row);
      }
      return next;
    });
  return (
    <div className="space-y-3">
      <div className="grid gap-3 rounded-md border bg-card p-3 sm:grid-cols-2 lg:grid-cols-4">
        <UnifiedSearchInput
          value={query}
          onChange={setQuery}
          onImmediateChange={setDraftQuery}
          placeholder="اسم، هاتف، فاتورة، تتبع أو إرسالية"
          aria-label="بحث إرساليات الشركة"
        />
        <AppSelect
          value={state}
          onValueChange={(value) => onState(value as OrderState)}
        >
          {DELIVERY_WORKSPACE_STATES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </AppSelect>
        <label className="flex items-center gap-2 text-sm">
          من{" "}
          <Input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          إلى{" "}
          <Input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
      </div>
      <DeliveryWorkspaceExport
        ready={q.isSuccess && !q.isFetching && draftQuery === query}
        title="إرساليات الشركة"
        company={party.name}
        branch={
          q.data?.scopedBranchId == null
            ? "جميع الفروع المخولة"
            : `الفرع #${q.data.scopedBranchId}`
        }
        filters={filterLabel}
        columns={exportColumns}
        load={async () =>
          (
            await fetchAllDeliveryPages((cursor) =>
              utils.delivery.consignments.fetch(
                {
                  ...filters,
                  limit: 500,
                  cursor,
                },
                { staleTime: 0 },
              ),
            )
          ).map(exportRecord)
        }
        totals={totalExports}
        selectedCount={selected.size}
        loadSelected={async () => {
          const rows = await fetchAllDeliveryPages((cursor) =>
            utils.delivery.consignments.fetch(
              {
                ...filters,
                limit: 500,
                cursor,
              },
              { staleTime: 0 },
            ),
          );
          return requireDeliverySelection(
            rows,
            new Set(selected.keys()),
            (row) => row.id,
          ).map(exportRecord);
        }}
      />
      <p className="text-xs text-muted-foreground">
        التصدير والطباعة يجلبان جميع النتائج المطابقة. التحديد محفوظ بين صفحات
        الفلتر الحالي. إجمالي المطابق: {q.data?.totals.count ?? "—"} · متبقي
        التسوية: {fmt(q.data?.totals.remainingDue)} د.ع
      </p>
      <p className="text-xs text-muted-foreground">
        فلترة تاريخ الإرسال حسب يوم العمل (UTC). تواريخ العرض والتصدير بتوقيت
        جهازك.
      </p>
      <DataTable<ConsignmentRow, number>
        columns={columns}
        defaultColumnVisibility={{
          cod: false,
          collected: false,
          counter: false,
          shortfall: false,
          driver: false,
          dispatchedAt: false,
          remittanceNumber: false,
        }}
        data={list}
        searchable={false}
        externalFiltersActive={Boolean(query || from || to || state !== "ALL")}
        loading={q.isLoading}
        errorState={{
          isError: q.isError,
          message: q.error?.message,
          onRetry: () => void q.refetch(),
        }}
        emptyText="لا إرساليات مطابقة لهذه الفلاتر"
        serverPagination={{
          page,
          pageSize: 50,
          hasMore: q.data?.hasMore,
          isFetching: q.isFetching || draftQuery !== query,
          onPageChange: (next) => {
            if (next < page) setPage(next);
            else if (q.data?.nextCursor != null) {
              setCursors((current) => [
                ...current.slice(0, next),
                q.data!.nextCursor!,
              ]);
              setPage(next);
            }
          },
        }}
        getRowId={(row) => row.id}
        mobileCardRenderer={(row) => (
          <article className="space-y-2 rounded-md border bg-card p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="break-words font-bold">
                  {row.customerName ?? row.recipientName ?? "عميل نقدي"}
                </div>
                <Button
                  variant="link"
                  className="h-auto max-w-full whitespace-normal break-all p-0 text-start text-xs"
                  onClick={() => setTimelineId(row.id)}
                >
                  {row.consignmentNumber}
                </Button>
              </div>
              <Checkbox
                checked={selected.has(row.id)}
                onCheckedChange={() => toggleSelection(row.id)}
                aria-label={`تحديد ${row.consignmentNumber}`}
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="min-w-0">
                {PARCEL_STATUS[row.parcelStatus] ?? row.parcelStatus} ·{" "}
                {CN_STATUS[row.moneyStatus]?.label ?? row.moneyStatus}
              </span>
              <b className="min-w-0 break-words tabular-nums">
                المتبقي: {fmt(row.remainingDue)} د.ع
              </b>
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {row.customerPhone && (
                <a dir="ltr" href={`tel:${row.customerPhone}`}>
                  {row.customerPhone}
                </a>
              )}
              {row.invoiceNumber && <span>الفاتورة: {row.invoiceNumber}</span>}
              {row.externalTrackingRef && (
                <span>
                  التتبع: <b dir="ltr">{row.externalTrackingRef}</b>
                </span>
              )}
            </div>
            <CompanyConsignmentFinancials row={row} />
            <CompanyConsignmentActions {...actionOptions} c={row} />
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">
                السائق والإسناد
              </summary>
              <div className="pt-2">
                <CompanyConsignmentDriver {...actionOptions} c={row} />
              </div>
            </details>
          </article>
        )}
        selection={{
          selected: new Set(selected.keys()),
          count: selected.size,
          isSelected: (id) => selected.has(id),
          toggle: toggleSelection,
        }}
        getRowSelectionLabel={(row) => `تحديد ${row.consignmentNumber}`}
      />
      <ConsignmentTimelineDrawer
        consignmentId={timelineId}
        onClose={() => setTimelineId(null)}
      />
      <ReturnConsignmentDialog
        target={returnTarget}
        pending={receiveReturn.isPending}
        onClose={() => setReturnTarget(null)}
        onConfirm={({ consignmentId, refundShiftId }) =>
          receiveReturn.mutate({
            consignmentId,
            refundShiftId,
            clientRequestId: crypto.randomUUID(),
          })
        }
      />

      {collectConsignmentTarget && (
        <CollectConsignmentDialog
          consignment={{
            id: Number(collectConsignmentTarget.id),
            consignmentNumber: collectConsignmentTarget.consignmentNumber,
            partyId,
            orderNumber:
              collectConsignmentTarget.invoiceNumber ??
              (collectConsignmentTarget.invoiceId
                ? `#${collectConsignmentTarget.invoiceId}`
                : null),
            invoiceNumber: collectConsignmentTarget.invoiceNumber,
            customerName:
              collectConsignmentTarget.customerName ??
              collectConsignmentTarget.recipientName,
            recipientPhone: collectConsignmentTarget.recipientPhone,
            codDue: collectConsignmentTarget.remainingDue,
            codAmount: collectConsignmentTarget.codAmount,
            collectedAmount: collectConsignmentTarget.collectedAmount,
            parcelStatus: collectConsignmentTarget.parcelStatus,
          }}
          open={collectConsignmentTarget != null}
          onOpenChange={(open) => {
            if (!open) setCollectConsignmentTarget(null);
          }}
          onCompleted={() => {
            setCollectConsignmentTarget(null);
            refresh();
          }}
        />
      )}

      <CancelDeliveryAssignmentDialog
        consignment={cancelConsignmentTarget}
        open={cancelConsignmentTarget != null}
        onOpenChange={(open) => {
          if (!open) setCancelConsignmentTarget(null);
        }}
        onCompleted={() => {
          setCancelConsignmentTarget(null);
          refresh();
        }}
      />
    </div>
  );
}

// ───────────────────────── سجل التوريدات ─────────────────────────
