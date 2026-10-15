// دليل أرقام وهواتف الزبائن — تبويب «جهات الاتصال» داخل CrmHub.tsx (?tab=contacts).
// بحث موحّد عبر الزبائن والموردين ومسؤولي المشتريات والمندوبين وأطراف التوصيل ومرسلي واتساب.
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Download, Eye, FileSpreadsheet, Link2, Phone, Search, User } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { hasModuleAccess, type PermissionMap, type RoleKey } from "@shared/permissions";
import { ACTION_LABELS } from "@shared/actionLabels";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/data-table/DataTable";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { exportRows } from "@/lib/export";
import { Contact360Panel } from "@/components/contacts/Contact360Panel";
import { CustomerDossierDrawer } from "@/components/crm/CustomerDossierDrawer";
import { CopyInline } from "@/components/CopyButton";
import { WhatsAppShare } from "@/components/WhatsAppShare";
import { buildOperationalContactMessage } from "@/lib/whatsapp";

type ContactKind = "customer" | "supplier" | "delivery" | "wa_unlinked";
type PartyKind = "customer" | "supplier";
type ContactRow = RouterOutputs["contacts"]["search"]["rows"][number];

const KIND_META: Record<ContactKind, { label: string; variant: "info" | "warning" | "secondary" | "success" }> = {
  customer: { label: "زبون", variant: "info" },
  supplier: { label: "مورّد", variant: "warning" },
  delivery: { label: "توصيل", variant: "secondary" },
  wa_unlinked: { label: "واتساب غير مربوط", variant: "success" },
};

export default function ContactsBank() {
  const [, navigate] = useLocation();
  const me = trpc.auth.me.useQuery();
  const role = (me.data?.role ?? "") as RoleKey;
  const override = (me.data?.permissionsOverride ?? null) as PermissionMap | null;
  const canReadSuppliers = !!role && hasModuleAccess(role, override, "suppliers", "READ");

  const [rawQ, setRawQ] = useState("");
  const q = useDebouncedValue(rawQ, 300);
  const trimmed = q.trim();

  const [kCustomer, setKCustomer] = useState(true);
  const [kSupplier, setKSupplier] = useState(true);
  const [kDelivery, setKDelivery] = useState(true);
  const [kWaUnlinked, setKWaUnlinked] = useState(true);
  const activeMap: Record<ContactKind, boolean> = {
    customer: kCustomer,
    supplier: kSupplier,
    delivery: kDelivery,
    wa_unlinked: kWaUnlinked,
  };

  function toggle(kind: ContactKind) {
    if (kind === "customer") setKCustomer((v) => !v);
    else if (kind === "supplier") setKSupplier((v) => !v);
    else if (kind === "delivery") setKDelivery((v) => !v);
    else setKWaUnlinked((v) => !v);
  }

  const kinds = useMemo(() => {
    const arr: ContactKind[] = [];
    if (kCustomer) arr.push("customer");
    if (kSupplier && canReadSuppliers) arr.push("supplier");
    if (kDelivery) arr.push("delivery");
    if (kWaUnlinked) arr.push("wa_unlinked");
    return arr;
  }, [kCustomer, kSupplier, kDelivery, kWaUnlinked, canReadSuppliers]);

  const enabled = trimmed.length >= 2 && kinds.length > 0;
  const search = trpc.contacts.search.useInfiniteQuery(
    { q: trimmed, kinds, limit: 20 },
    { getNextPageParam: (last) => last.nextCursor ?? undefined, enabled },
  );
  const rows = useMemo(() => (search.data?.pages ?? []).flatMap((p) => p.rows), [search.data]);

  const [selected, setSelected] = useState<{ kind: PartyKind; id: number } | null>(null);
  const [dossierCustomerId, setDossierCustomerId] = useState<number | null>(null);

  const handleExport = async (format: "xlsx" | "csv") => {
    if (rows.length === 0) {
      notify.err("لا توجد بيانات متاحة للتصدير");
      return;
    }
    await exportRows(rows, {
      filename: `دليل_أرقام_وهواتف_الزبائن_${new Date().toISOString().slice(0, 10)}`,
      title: "دليل أرقام وهواتف الزبائن",
      format,
      columns: [
        { key: "kind", header: "النوع", map: (r) => KIND_META[r.kind]?.label ?? r.kind },
        { key: "name", header: "الاسم" },
        { key: "phone", header: "الهاتف", text: true, map: (r) => r.phone ?? "" },
        {
          key: "secondary",
          header: "تفاصيل إضافية / عهدة",
          map: (r) =>
            r.kind === "delivery"
              ? r.secondary != null
                ? `عهدة: ${fmt(r.secondary)}`
                : ""
              : r.secondary ?? "",
        },
      ],
    });
  };

  const columns = useMemo<ColumnDef<ContactRow>[]>(() => [
    {
      accessorKey: "kind",
      header: "النوع",
      cell: ({ row }) => {
        const meta = KIND_META[row.original.kind];
        return <Badge variant={meta.variant}>{meta.label}</Badge>;
      },
    },
    {
      accessorKey: "name",
      header: "الاسم والبيانات",
      cell: ({ row }) => {
        const r = row.original;
        return (
          <div className="flex flex-col">
            <span className="font-medium text-foreground">{r.name}</span>
            {r.kind === "customer" && (
              <span className="text-xs text-muted-foreground">ملف زبون معتمد</span>
            )}
            {r.kind === "supplier" && (
              <span className="text-xs text-muted-foreground">مورّد معتمد</span>
            )}
          </div>
        );
      },
    },
    {
      accessorKey: "phone",
      header: "الهاتف",
      cell: ({ row }) => {
        const phone = row.original.phone;
        if (!phone) return <span className="text-muted-foreground">—</span>;
        return (
          <div className="flex items-center gap-1.5" dir="ltr">
            <CopyInline value={phone} />
          </div>
        );
      },
    },
    {
      accessorKey: "secondary",
      header: "تفاصيل",
      cell: ({ row }) => {
        const r = row.original;
        return (
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            {r.kind === "delivery"
              ? r.secondary != null
                ? `عهدة: ${fmt(r.secondary)}`
                : "—"
              : r.secondary ?? "—"}
          </span>
        );
      },
    },
    {
      id: "tools",
      header: "اتصال مباشر",
      cell: ({ row }) => {
        const r = row.original;
        if (!r.phone) return <span className="text-xs text-muted-foreground">—</span>;
        return (
          <div className="flex items-center justify-center gap-1" onClick={(e) => e.stopPropagation()}>
            <a
              href={`tel:${r.phone}`}
              className="inline-flex items-center justify-center size-8 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
              title="اتصال هاتفي مباشر"
            >
              <Phone className="size-4 text-[var(--sem-pos)]" />
              <span className="sr-only">اتصال هاتفي مباشر</span>
            </a>
            <WhatsAppShare
              phone={r.phone}
              message={buildOperationalContactMessage({
                entityLabel: KIND_META[r.kind].label,
                reference: String(r.id),
                partyName: r.name,
                title: "متابعة من دليل أرقام وهواتف الزبائن",
              })}
              size="icon-sm"
              iconOnly
              label="محادثة واتساب"
              className="size-8 p-0"
            />
          </div>
        );
      },
    },
    {
      id: "actions",
      header: "إجراءات",
      cell: ({ row }) => {
        const r = row.original;
        const kind = r.kind;
        return (
          <div className="flex items-center justify-center gap-1" onClick={(e) => e.stopPropagation()}>
            {kind === "customer" && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className="size-8 p-0"
                  title="الملف الشامل 360°"
                  onClick={() => setDossierCustomerId(r.id)}
                >
                  <User className="size-4 text-primary" />
                  <span className="sr-only">الملف الشامل 360°</span>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="size-8 p-0"
                  title="بطاقة جهة الاتصال والمسؤولين"
                  onClick={() => setSelected({ kind: "customer", id: r.id })}
                >
                  <Eye className="size-4 text-muted-foreground" />
                  <span className="sr-only">بطاقة جهة الاتصال والمسؤولين</span>
                </Button>
              </>
            )}
            {kind === "supplier" && (
              <Button
                variant="ghost"
                size="sm"
                className="size-8 p-0"
                title="عرض بطاقة المورّد"
                onClick={() => setSelected({ kind: "supplier", id: r.id })}
              >
                <Eye className="size-4 text-[var(--sem-warn)]" />
                <span className="sr-only">عرض بطاقة المورّد</span>
              </Button>
            )}
            {kind === "wa_unlinked" && (
              <Button
                variant="ghost"
                size="sm"
                className="size-8 p-0"
                title="فتح المحادثة في الوارد"
                onClick={() => navigate("/crm?tab=inbox")}
              >
                <Link2 className="size-4 text-[var(--sem-pos)]" />
                <span className="sr-only">فتح في الوارد</span>
              </Button>
            )}
          </div>
        );
      },
    },
  ], [navigate]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="دليل أرقام وهواتف الزبائن"
        description="بحث موحّد في أرقام وهواتف الزبائن ومسؤولي المشتريات والمندوبين والموردين وأطراف التوصيل مع اتصال مباشر وواتساب وبطاقة 360° وتصدير."
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={rows.length === 0}
              onClick={() => void handleExport("xlsx")}
              title="تصدير النتائج إلى Excel"
            >
              <FileSpreadsheet className="size-4 me-1.5 text-[var(--sem-pos)]" />
              تصدير Excel
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={rows.length === 0}
              onClick={() => void handleExport("csv")}
              title="تصدير النتائج إلى CSV"
            >
              <Download className="size-4 me-1.5" />
              تصدير CSV
            </Button>
          </div>
        }
      />

      <Card>
        <CardContent className="p-3 space-y-3">
          <div className="relative">
            <span aria-hidden className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground">
              <Search className="size-4" />
            </span>
            <Input
              value={rawQ}
              onChange={(e) => setRawQ(e.target.value)}
              placeholder="ابحث بالاسم أو الهاتف أو مسؤول المشتريات أو الرقم القديم (حرفان فأكثر)…"
              className="h-9 pe-9"
              autoComplete="off"
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1.5">
              {(Object.keys(KIND_META) as ContactKind[])
                .filter((k) => k !== "supplier" || canReadSuppliers)
                .map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => toggle(k)}
                    aria-pressed={activeMap[k]}
                    className={`text-xs px-3 py-1 rounded-md font-medium border transition-colors ${
                      activeMap[k]
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-muted text-muted-foreground border-transparent hover:bg-accent"
                    }`}
                  >
                    {KIND_META[k].label}
                  </button>
                ))}
            </div>
            {rows.length > 0 && (
              <span className="text-xs text-muted-foreground font-mono">
                {rows.length} نتيجة متوفرة
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {!enabled && trimmed.length > 0 && kinds.length === 0 && (
        <p className="text-sm text-muted-foreground px-1">اختر نوعاً واحداً على الأقل للبحث فيه.</p>
      )}
      {!enabled && trimmed.length < 2 && (
        <p className="text-sm text-muted-foreground px-1">اكتب حرفين على الأقل لبدء البحث.</p>
      )}

      {enabled && (
        <Card>
          <CardContent className="p-0">
            <DataTable<ContactRow>
              columns={columns}
              data={rows}
              searchable={false}
              pageSize={Infinity}
              loading={search.isLoading}
              errorState={{
                isError: search.isError,
                message: "تعذّر تنفيذ البحث.",
                onRetry: () => search.refetch(),
              }}
              emptyState={
                <div className="py-8 text-center text-muted-foreground text-sm">
                  لا توجد نتائج مطابقة لبحثك.
                </div>
              }
              getRowId={(r) => `${r.kind}-${r.id}`}
              onRowClick={(r) => {
                if (r.kind === "customer") {
                  setDossierCustomerId(r.id);
                } else if (r.kind === "supplier") {
                  setSelected({ kind: "supplier", id: r.id });
                }
              }}
              getRowClassName={(r) =>
                r.kind === "customer" || r.kind === "supplier" ? "cursor-pointer hover:bg-accent/40" : undefined
              }
            />

            {search.hasNextPage && (
              <div className="flex justify-center p-3 border-t">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => search.fetchNextPage()}
                  disabled={search.isFetchingNextPage}
                >
                  {search.isFetchingNextPage ? ACTION_LABELS.loading : "تحميل المزيد"}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {selected && (
        <Contact360Panel
          kind={selected.kind}
          id={selected.id}
          onClose={() => setSelected(null)}
          onOpenContact={(kind, id) => setSelected({ kind, id })}
        />
      )}

      {dossierCustomerId && (
        <CustomerDossierDrawer
          customerId={dossierCustomerId}
          open={!!dossierCustomerId}
          onClose={() => setDossierCustomerId(null)}
        />
      )}
    </div>
  );
}
