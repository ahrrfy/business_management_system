import { Fragment, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { AppSelect } from "@/components/ui/AppSelect";
import { ErrorState, LoadingState } from "@/components/PageState";
import { receptionOperationAllowed } from "@/lib/receptionOperationAccess";
import { trpc } from "@/lib/trpc";

/** Branch-dependent queries and workspace restoration mount only after a real branch exists. */
export function ReceptionBranchGate({
  children,
}: {
  children: (branchId: number) => ReactNode;
}) {
  const me = trpc.auth.me.useQuery();
  const [selection, setSelection] = useState<{
    userId: number;
    companyId: number | null;
    branchId: number;
  } | null>(null);
  const canChoose =
    me.data?.isOwner === true ||
    me.data?.role === "admin" ||
    me.data?.role === "manager";
  const canReadBranches = receptionOperationAllowed(me.data, "branches.list");
  const branches = trpc.branches.list.useQuery(undefined, {
    enabled:
      me.data != null &&
      me.data.branchId == null &&
      canChoose &&
      canReadBranches,
  });
  if (me.isPending) return <LoadingState />;
  if (me.isError)
    return (
      <ErrorState
        message={me.error.message}
        onRetry={() => void me.refetch()}
      />
    );
  const selectedBranch =
    me.data &&
    selection !== null &&
    selection.userId === me.data.id &&
    selection.companyId === (me.data.companyId ?? null)
      ? selection.branchId
      : null;
  const branchId =
    me.data?.branchId != null ? Number(me.data.branchId) : selectedBranch;
  if (branchId != null && Number.isSafeInteger(branchId) && branchId > 0)
    return (
      <Fragment
        key={`${me.data?.id}:${me.data?.companyId ?? "single"}:${branchId}`}
      >
        {children(branchId)}
      </Fragment>
    );
  return (
    <div
      className="flex h-full items-center justify-center bg-background p-4"
      dir="rtl"
    >
      <div className="w-full max-w-md rounded-xl border bg-card p-6">
        <h2 className="mb-2 text-xl font-bold">اختر فرع الاستقبال</h2>
        {canChoose && canReadBranches ? (
          <>
            <p className="mb-4 text-sm text-muted-foreground">
              اختر الفرع قبل تحميل الوردية والطلبات.
            </p>
            {branches.isPending ? (
              <LoadingState />
            ) : branches.isError ? (
              <ErrorState
                message={branches.error.message}
                onRetry={() => void branches.refetch()}
              />
            ) : (
              <AppSelect
                aria-label="فرع الاستقبال"
                value={selectedBranch == null ? "" : String(selectedBranch)}
                onValueChange={(value) =>
                  setSelection(
                    value && me.data
                      ? {
                          userId: me.data.id,
                          companyId: me.data.companyId ?? null,
                          branchId: Number(value),
                        }
                      : null,
                  )
                }
              >
                <option value="">— اختر الفرع —</option>
                {(branches.data ?? []).map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}
                  </option>
                ))}
              </AppSelect>
            )}
          </>
        ) : (
          <p role="alert" className="text-sm text-muted-foreground">
            لم يُسنَد فرع صالح إلى حسابك. اطلب من المدير إسناد الفرع قبل بدء
            الوردية.
          </p>
        )}
        <Link
          href="/"
          className="mt-4 block text-center text-sm text-muted-foreground"
        >
          ← الرئيسية
        </Link>
      </div>
    </div>
  );
}
