// بنك جهات الاتصال — تبويب «جهات الاتصال» داخل CrmHub.tsx (?tab=contacts، S3 T3.3).
// بحث موحّد عبر عملاء/موردين/أطراف توصيل/مرسلي واتساب غير المربوطين (contacts.search) + بطاقة
// ٣٦٠° لكل عميل/مورّد (Contact360Panel.tsx). الخادم جاهز بالكامل (server/routers/contactsRouter.ts
// + server/services/contacts/*) — هذا الملف يستهلكه فقط.
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Eye, Link2, Search } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { hasModuleAccess, type PermissionMap, type RoleKey } from "@shared/permissions";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState } from "@/components/PageState";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { fmt } from "@/lib/money";
import { Contact360Panel } from "@/components/contacts/Contact360Panel";

type ContactKind = "customer" | "supplier" | "delivery" | "wa_unlinked";
type PartyKind = "customer" | "supplier";
type ContactRow = RouterOutputs["contacts"]["search"]["rows"][number];

const KIND_META: Record<ContactKind, { label: string; variant: "info" | "warning" | "secondary" | "success" }> = {
  customer: { label: "عميل", variant: "info" },
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

  return (
    <div className="space-y-4">
      <PageHeader
        title="بنك جهات الاتصال"
        description="بحث موحّد عبر العملاء والموردين وأطراف التوصيل ومرسلي واتساب غير المربوطين بعميل — بطاقة ٣٦٠° لكل عميل/مورّد."
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
              placeholder="ابحث بالاسم أو الهاتف أو الرمز القديم (حرفان فأكثر)…"
              className="h-9 pe-9"
            />
          </div>
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
        </CardContent>
      </Card>

      {!enabled && trimmed.length > 0 && kinds.length === 0 && (
        <p className="text-sm text-muted-foreground px-1">اختر نوعاً واحداً على الأقل للبحث فيه.</p>
      )}
      {!enabled && trimmed.length < 2 && (
        <p className="text-sm text-muted-foreground px-1">اكتب حرفين على الأقل لبدء البحث.</p>
      )}
      {enabled && search.isLoading && <LoadingState />}
      {enabled && search.isError && <ErrorState message="تعذّر تنفيذ البحث." onRetry={() => search.refetch()} />}
      {enabled && !search.isLoading && !search.isError && (
        <>
          <Card>
            <CardContent className="p-0">
              <ScrollTableShell bordered={false}>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-center">النوع</TableHead>
                      <TableHead className="text-right">الاسم</TableHead>
                      <TableHead className="text-right">الهاتف</TableHead>
                      <TableHead className="text-right">تفاصيل</TableHead>
                      <TableHead className="text-center">إجراء</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">لا نتائج.</TableCell>
                      </TableRow>
                    ) : (
                      rows.map((r: ContactRow) => {
                        const kind = r.kind;
                        const openable = kind === "customer" || kind === "supplier";
                        return (
                          <TableRow
                            key={`${kind}-${r.id}`}
                            className={openable ? "cursor-pointer hover:bg-accent/40" : undefined}
                            onClick={
                              kind === "customer" || kind === "supplier"
                                ? () => setSelected({ kind, id: r.id })
                                : undefined
                            }
                          >
                            <TableCell className="text-center">
                              <Badge variant={KIND_META[kind].variant}>{KIND_META[kind].label}</Badge>
                            </TableCell>
                            <TableCell className="font-medium max-w-[220px] truncate">{r.name}</TableCell>
                            <TableCell className="whitespace-nowrap" dir="ltr">{r.phone ?? "—"}</TableCell>
                            <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                              {kind === "delivery"
                                ? r.secondary != null
                                  ? `عهدة: ${fmt(r.secondary)}`
                                  : "—"
                                : r.secondary ?? "—"}
                            </TableCell>
                            <TableCell className="text-center">
                              {kind === "customer" || kind === "supplier" ? (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  onClick={(e) => { e.stopPropagation(); setSelected({ kind, id: r.id }); }}
                                >
                                  <Eye aria-hidden className="size-3.5" /> عرض ٣٦٠
                                </Button>
                              ) : kind === "wa_unlinked" ? (
                                <Button type="button" size="sm" variant="ghost" onClick={() => navigate("/crm?tab=inbox")}>
                                  <Link2 aria-hidden className="size-3.5" /> فتح في الوارد
                                </Button>
                              ) : (
                                <span className="text-xs text-muted-foreground">—</span>
                              )}
                            </TableCell>
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              </ScrollTableShell>
            </CardContent>
          </Card>
          {search.hasNextPage && (
            <div className="flex justify-center">
              <Button variant="outline" size="sm" onClick={() => search.fetchNextPage()} disabled={search.isFetchingNextPage}>
                {search.isFetchingNextPage ? "جارٍ التحميل…" : "تحميل المزيد"}
              </Button>
            </div>
          )}
        </>
      )}

      {selected && (
        <Contact360Panel
          kind={selected.kind}
          id={selected.id}
          onClose={() => setSelected(null)}
          onOpenContact={(kind, id) => setSelected({ kind, id })}
        />
      )}
    </div>
  );
}
