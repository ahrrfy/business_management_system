import { useEffect, useState } from "react";
import { useSearch } from "wouter";
import type { ColumnDef } from "@tanstack/react-table";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { AppSelect } from "@/components/ui/AppSelect";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/data-table/DataTable";
import {
  fulfillmentRequestStatusLabel,
  FULFILLMENT_REQUEST_STATUSES,
  type FulfillmentRequestStatus,
} from "@shared/fulfillment";
import { hasModuleAccess } from "@shared/permissions";
import {
  hasOperationPolicy,
  operationDecision,
} from "@shared/operationPermissions";
import { RequestEditor } from "./RequestEditor";
import { RequestDetails } from "./RequestDetails";

type Row =
  RouterOutputs["delivery"]["fulfillment"]["requests"]["list"]["rows"][number];
export function RequestsWorkspace() {
  const me = trpc.auth.me.useQuery();
  const branches = trpc.branches.list.useQuery();
  const utils = trpc.useUtils();
  const params = new URLSearchParams(useSearch());
  const contextRequestId = Number(params.get("requestId")) || null;
  const contextInvoiceId = Number(params.get("invoiceId")) || undefined;
  const contextWorkOrderId = Number(params.get("workOrderId")) || undefined;
  const [chosenBranch, setChosenBranch] = useState("");
  const branchId =
    Number(chosenBranch || params.get("branchId") || me.data?.branchId) ||
    undefined;
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<FulfillmentRequestStatus | "">("");
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(contextRequestId);
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(
    Boolean(contextInvoiceId || contextWorkOrderId),
  );
  useEffect(() => {
    if (contextRequestId) {
      setSelectedId(contextRequestId);
      setCreating(false);
      setEditing(false);
    }
  }, [contextRequestId]);
  const allowed = (action: string) => {
    const user = me.data;
    if (!user) return false;
    if (hasOperationPolicy(user))
      return operationDecision(user, `delivery.fulfillment.requests.${action}`)
        .allowed;
    return hasModuleAccess(
      user.role,
      user.permissionsOverride,
      "store",
      "FULL",
    );
  };
  const list = trpc.delivery.fulfillment.requests.list.useQuery(
    {
      branchId,
      search,
      status: status || undefined,
      limit: 25,
      offset: page * 25,
    },
    { enabled: branchId != null },
  );
  const detail = trpc.delivery.fulfillment.requests.get.useQuery(
    { id: selectedId ?? 0 },
    { enabled: selectedId != null },
  );
  const refresh = () => {
    void utils.delivery.fulfillment.requests.invalidate();
    void utils.delivery.invalidate();
  };
  const columns: ColumnDef<Row, unknown>[] = [
    {
      accessorKey: "requestNumber",
      header: "الطلب",
      cell: ({ row }) => (
        <Button
          variant="link"
          className="px-0"
          onClick={() => {
            setSelectedId(row.original.id);
            setEditing(false);
            setCreating(false);
          }}
        >
          {row.original.requestNumber}
        </Button>
      ),
    },
    { accessorKey: "recipientName", header: "المستلم" },
    { accessorKey: "recipientPhone", header: "الهاتف" },
    {
      accessorKey: "status",
      header: "الحالة",
      cell: ({ row }) => fulfillmentRequestStatusLabel[row.original.status],
    },
  ];
  return (
    <div className="space-y-4" dir="rtl">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="me-auto font-semibold">طلبات التوصيل والتجهيز</h2>
        {allowed("create") && (
          <Button
            disabled={!branchId}
            onClick={() => {
              setCreating(true);
              setEditing(false);
              setSelectedId(null);
            }}
          >
            طلب جديد
          </Button>
        )}
        <Button variant="outline" onClick={refresh}>
          تحديث
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          الفرع
          <AppSelect
            value={branchId ? String(branchId) : ""}
            disabled={me.data?.role !== "admin" && me.data?.isOwner !== true}
            onValueChange={(v) => {
              setChosenBranch(v);
              setPage(0);
              setSelectedId(null);
              setCreating(false);
            }}
          >
            <option value="">اختر الفرع</option>
            {(branches.data ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </AppSelect>
        </label>
        <label className="space-y-1 text-sm">
          الحالة
          <AppSelect
            value={status}
            onValueChange={(v) => {
              setStatus(v as typeof status);
              setPage(0);
            }}
          >
            <option value="">كل الحالات</option>
            {FULFILLMENT_REQUEST_STATUSES.map((s) => (
              <option key={s} value={s}>
                {fulfillmentRequestStatusLabel[s]}
              </option>
            ))}
          </AppSelect>
        </label>
      </div>
      {creating && branchId && allowed("create") && (
        <RequestEditor
          key={`new-${branchId}`}
          branchId={branchId}
          contextInvoiceId={contextInvoiceId}
          contextWorkOrderId={contextWorkOrderId}
          onClose={() => setCreating(false)}
          onSaved={(id) => {
            setCreating(false);
            setSelectedId(id);
            refresh();
          }}
        />
      )}
      <DataTable
        columns={columns}
        data={list.data?.rows ?? []}
        loading={list.isLoading && branchId != null}
        errorState={{
          isError: list.isError,
          message: list.error?.message,
          onRetry: () => void list.refetch(),
        }}
        serverPagination={{
          page,
          pageSize: 25,
          total: list.data?.total ?? 0,
          onPageChange: setPage,
          isFetching: list.isFetching,
        }}
        serverSearch={{
          value: search,
          onChange: (v) => {
            setSearch(v);
            setPage(0);
          },
        }}
      />
      {detail.isError && (
        <p role="alert" className="text-destructive">
          {detail.error.message}
        </p>
      )}
      {detail.data &&
        selectedId != null &&
        (editing && allowed("update") ? (
          <RequestEditor
            key={`${selectedId}-${detail.data.request.version}`}
            branchId={detail.data.request.branchId}
            detail={detail.data}
            onClose={() => setEditing(false)}
            onSaved={() => {
              setEditing(false);
              refresh();
            }}
          />
        ) : (
          <RequestDetails
            detail={detail.data}
            allowed={allowed}
            onChanged={refresh}
            onEdit={() => setEditing(true)}
          />
        ))}
    </div>
  );
}
export default RequestsWorkspace;
