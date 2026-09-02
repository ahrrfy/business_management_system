import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AppSelect } from "@/components/ui/AppSelect";
import { ImageUploader, type ImageItem } from "@/components/form/ImageUploader";
import { FilterField } from "@/components/list/FilterField";
import { ListToolbar } from "@/components/list/ListToolbar";
import { PageHeader } from "@/components/PageHeader";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import { type ExportColumn } from "@/lib/export";
import { fetchAllPaged } from "@/lib/fetchAllRows";
import { notify } from "@/lib/notify";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { keepPreviousData } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Handshake, Paperclip, Plus, Printer, X } from "lucide-react";
import { printConsignmentNote } from "@/lib/printing/printConsignmentNote";
import { WhatsAppShare } from "@/components/WhatsAppShare";
import { buildConsignmentWithdrawMessage } from "@/lib/whatsapp";

type NoteType = "DEPOSIT" | "WITHDRAW" | "EXCHANGE";
type Dir = "IN" | "OUT";
type Line = { key: number; direction: Dir; variantId: number; productUnitId: number; label: string; quantity: string };
type NoteRow = RouterOutputs["consignments"]["list"]["rows"][number];

const TYPE_META: Record<NoteType, { label: string; cls: string }> = {
  DEPOSIT: { label: "إيداع", cls: "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]" },
  WITHDRAW: { label: "سحب", cls: "bg-[var(--sem-neg-bg)] text-[var(--sem-neg)]" },
  EXCHANGE: { label: "استبدال", cls: "bg-blue-100 text-blue-800" },
};

const PAGE = 50;

const dateCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export default function ConsignmentNotes() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const role = me.data?.role ?? "";
  const isElevated = role === "admin"; // عزل مدير الفرع (قرار المالك ١٢/٨): المالك/الأدمن فقط يختاران فرعاً
  // إزالة «?? 1» (نمط PR #288): بلا فرع مُسنَد يختار المرتفع فرع السند صراحةً — لا إسناد صامت للفرع ١
  // (السند حركة مخزون موقَّعة؛ فرع خاطئ = أرصدة أمانة منحرفة). من له فرع مُسنَد يبقى عليه.
  const [pickedBranch, setPickedBranch] = useState<number | null>(null);
  const assignedBranch = me.data?.branchId != null ? Number(me.data.branchId) : null;
  const formBranchId = assignedBranch ?? pickedBranch;
  const [mode, setMode] = useState<"list" | "new">("list");

  const branchesQ = trpc.branches.list.useQuery(undefined, { enabled: isElevated });
  const consignorsQ = trpc.suppliers.search.useQuery(
    { kind: "CONSIGNOR", limit: 500 },
    { enabled: mode === "list" },
  );

  // فلاتر القائمة في الـURL (تعيش مع التنقّل وتُشارَك رابطاً) + ترقيم فعلي على limit/offset+total الخادمية.
  const [f, setF, resetF] = useUrlFilters({ q: "", type: "", consignor: "", branch: "", from: "", to: "" });
  const [page, setPage] = useState(0);
  const debouncedQ = useDebouncedValue(f.q, 250);
  function patchFilters(patch: Partial<{ q: string; type: string; consignor: string; branch: string; from: string; to: string }>) {
    setF(patch);
    setPage(0);
  }

  const filterInput = {
    consignorId: f.consignor ? Number(f.consignor) : undefined,
    noteType: (f.type || undefined) as NoteType | undefined,
    // فلتر الفرع للمرتفعين فقط — غير المرتفع مقصور بفرعه خادمياً (لا يُرسَل).
    branchId: isElevated && f.branch ? Number(f.branch) : undefined,
    from: f.from || undefined,
    to: f.to || undefined,
    q: debouncedQ.trim() || undefined,
  };

  const list = trpc.consignments.list.useQuery(
    { ...filterInput, limit: PAGE, offset: page * PAGE },
    { enabled: mode === "list", placeholderData: keepPreviousData },
  );
  const rows = list.data?.rows ?? [];
  const total = list.data?.total ?? 0;
  const activeFilterCount = [f.type, f.consignor, isElevated ? f.branch : "", f.from, f.to].filter(Boolean).length;

  // أعمدة السندات — داخل المكوّن لأنّ عمود الطباعة يستدعي `printFromNote` (تصريح دالّة مرفوع).
  const noteColumns = useMemo<ColumnDef<NoteRow, unknown>[]>(
    () => [
      { id: "noteNumber", header: "الرقم", accessorFn: (n) => n.noteNumber, meta: { kind: "code", width: "id" }, cell: ({ row }) => row.original.noteNumber },
      {
        id: "noteType",
        header: "النوع",
        // التسمية العربية لا الرمز الخامّ — «نسخ القيمة» يجب أن يطابق ما يقرأه المستعمِل.
        accessorFn: (n) => TYPE_META[n.noteType as NoteType]?.label ?? n.noteType,
        meta: { kind: "status" },
        cell: ({ row }) => (
          <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-bold", TYPE_META[row.original.noteType as NoteType].cls)}>
            {TYPE_META[row.original.noteType as NoteType].label}
          </span>
        ),
      },
      { id: "consignorName", header: "المودِع", accessorFn: (n) => n.consignorName ?? "", meta: { width: "wide" }, cell: ({ row }) => row.original.consignorName },
      {
        id: "hasAttachment",
        header: "مرفق",
        accessorFn: (n) => (n.hasAttachment ? "نعم" : "لا"),
        meta: { align: "center", width: "status" },
        cell: ({ row }) => (row.original.hasAttachment ? <Paperclip aria-hidden className="size-3.5 inline text-[var(--sem-pos)]" /> : null),
      },
      {
        id: "createdAt",
        header: "التاريخ",
        accessorFn: (n) => new Date(n.createdAt).toLocaleDateString("en-GB"),
        meta: { kind: "date" },
        cell: ({ row }) => new Date(row.original.createdAt).toLocaleDateString("en-GB"),
      },
      {
        id: "print",
        header: "طباعة",
        enableSorting: false,
        meta: { kind: "actions" },
        cell: ({ row }) => (
          <Button size="sm" variant="ghost" onClick={() => printFromNote(row.original.id)} title="طباعة السند">
            <Printer aria-hidden className="size-4" />
          </Button>
        ),
      },
    ],
    [],
  );

  const exportColumns: ExportColumn<NoteRow>[] = [
    { key: "noteNumber", header: "رقم السند" },
    { key: "noteType", header: "النوع", map: (r) => TYPE_META[r.noteType as NoteType]?.label ?? r.noteType },
    { key: "consignorName", header: "المودِع" },
    { key: "hasAttachment", header: "مرفق", map: (r) => (r.hasAttachment ? "نعم" : "لا") },
    { key: "createdAt", header: "التاريخ", map: (r) => new Date(r.createdAt).toLocaleDateString("en-GB") },
  ];

  /** يجلب كل السندات المطابقة للفلاتر (لا الصفحة المعروضة) — تصدير كامل. */
  function fetchAll(): Promise<NoteRow[]> {
    return fetchAllPaged<NoteRow>(
      (offset, limit) =>
        utils.consignments.list
          .fetch({ ...filterInput, limit, offset })
          .then((r) => ({ rows: r.rows, total: r.total })),
      { pageSize: 500 },
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="سندات الأمانة"
        description="إيداع/سحب/استبدال بضاعة المودِعين — حركات مخزون بلا أثر ماليّ (المستحق يتكوّن عند البيع)."
        actions={
          mode === "list" ? (
            <Button size="sm" onClick={() => setMode("new")}><Plus aria-hidden className="size-4 me-1" /> سند جديد</Button>
          ) : (
            // زرّ لا رابط: يعود من وضع «سند جديد» إلى وضع «القائمة» داخل الشاشة نفسها (لا تنقّل بين مسارَين)
            // ⇒ لا يستعمل PageHeader.backHref (وهو رابط تنقّل حقيقيّ).
            <Button size="sm" variant="outline" onClick={() => setMode("list")}>العودة للقائمة</Button>
          )
        }
      />

      {mode === "new" ? (
        formBranchId != null ? (
          <NoteForm
            branchId={formBranchId}
            onSaved={() => { setMode("list"); utils.consignments.list.invalidate(); }}
          />
        ) : isElevated ? (
          <BranchChoiceCard branches={branchesQ.data ?? []} onPick={setPickedBranch} />
        ) : (
          <Card>
            <CardContent className="p-6 text-sm text-muted-foreground">
              لا فرع مُسنَد لحسابك — اطلب من المدير إسناد فرع قبل إنشاء سند أمانة.
            </CardContent>
          </Card>
        )
      ) : (
        <Card>
          <CardContent className="space-y-3 p-4">
            <ListToolbar<NoteRow>
              title="السندات"
              count={total}
              loading={list.isLoading}
              search={{
                value: f.q,
                onChange: (v) => patchFilters({ q: v }),
                placeholder: "رقم السند (CSN-…)",
                ariaLabel: "بحث برقم السند",
              }}
              activeFilterCount={activeFilterCount}
              onResetFilters={() => { resetF(); setPage(0); }}
              onRefresh={() => list.refetch()}
              refreshing={list.isFetching}
              exportSpec={{ filename: "سندات-الأمانة", rows, columns: exportColumns, fetchAll }}
              filters={
                <div className="flex flex-wrap items-end gap-2">
                  <FilterField label="المودِع" className="w-44">
                    <AppSelect size="sm" value={f.consignor} onValueChange={(v) => patchFilters({ consignor: v })} placeholder="— كل المودِعين —">
                      <option value="">— كل المودِعين —</option>
                      {(consignorsQ.data?.rows ?? []).map((c) => (
                        <option key={Number(c.id)} value={String(c.id)}>{c.name}</option>
                      ))}
                    </AppSelect>
                  </FilterField>
                  <FilterField label="نوع السند" className="w-32">
                    <AppSelect size="sm" value={f.type} onValueChange={(v) => patchFilters({ type: v })} placeholder="— الكل —">
                      <option value="">— الكل —</option>
                      <option value="DEPOSIT">إيداع</option>
                      <option value="WITHDRAW">سحب</option>
                      <option value="EXCHANGE">استبدال</option>
                    </AppSelect>
                  </FilterField>
                  {isElevated && (
                    <FilterField label="الفرع" className="w-36">
                      <AppSelect size="sm" value={f.branch} onValueChange={(v) => patchFilters({ branch: v })} placeholder="— كل الفروع —">
                        <option value="">— كل الفروع —</option>
                        {(branchesQ.data ?? []).map((b) => (
                          <option key={Number(b.id)} value={String(b.id)}>{b.name}</option>
                        ))}
                      </AppSelect>
                    </FilterField>
                  )}
                  <FilterField label="من">
                    <input type="date" className={dateCls} value={f.from} onChange={(e) => patchFilters({ from: e.target.value })} />
                  </FilterField>
                  <FilterField label="إلى">
                    <input type="date" className={dateCls} value={f.to} onChange={(e) => patchFilters({ to: e.target.value })} />
                  </FilterField>
                </div>
              }
            />

            {/*
              * ترقيم خادميّ داخل الجدول — السندات مستندات موقَّعة، اختفاؤها بعد حدّ الصفحة
              * الصامت خطر حقيقي. وشريط الترقيم صار من `DataTable` وحده (شريطان يقفزان
              * بمقدارَين مختلفَين يُخفيان صفوفاً بصمت).
              * البحث والفلاتر في `ListToolbar` أعلاه ⇒ `searchable={false}` بلا حقلَي بحث متجاورَين.
              */}
            <DataTable<NoteRow>
              columns={noteColumns}
              data={rows}
              searchable={false}
              externalFiltersActive={activeFilterCount > 0 || f.q.trim() !== ""}
              loading={list.isLoading}
              errorState={{ isError: list.isError, message: list.error?.message, onRetry: () => list.refetch() }}
              serverPagination={{ page, onPageChange: setPage, pageSize: PAGE, total, isFetching: list.isFetching }}
              emptyState="لا سندات بعد. أنشئ سند إيداع لأول مودِع."
              emptyFilteredState="لا سندات مطابقة للفلاتر."
            />
          </CardContent>
        </Card>
      )}
    </div>
  );

  async function printFromNote(noteId: number) {
    const note = await utils.consignments.get.fetch({ noteId });
    if (note) printConsignmentNote(note);
  }
}

/* ============================ اختيار الفرع (مرتفع بلا فرع مُسنَد) ============================ */

function BranchChoiceCard({
  branches,
  onPick,
}: {
  branches: RouterOutputs["branches"]["list"];
  onPick: (id: number) => void;
}) {
  const [sel, setSel] = useState("");
  return (
    <Card>
      <CardHeader className="pb-3"><CardTitle className="text-base">اختر فرع السند</CardTitle></CardHeader>
      <CardContent className="max-w-sm space-y-3">
        <p className="text-sm text-muted-foreground">
          حسابك بلا فرع مُسنَد — اختر الفرع صراحةً قبل إنشاء السند (السند يحرّك مخزون فرع بعينه).
        </p>
        <AppSelect value={sel} onValueChange={setSel} placeholder="— اختر الفرع —" aria-label="فرع السند">
          <option value="">— اختر الفرع —</option>
          {branches.map((b) => (
            <option key={Number(b.id)} value={String(b.id)}>{b.name}</option>
          ))}
        </AppSelect>
        <Button disabled={!sel} onClick={() => onPick(Number(sel))}>
          {sel ? "متابعة" : "اختر الفرع أولاً"}
        </Button>
      </CardContent>
    </Card>
  );
}

/* ============================ نموذج السند ============================ */

function NoteForm({ branchId, onSaved }: { branchId: number; onSaved: () => void }) {
  const [noteType, setNoteType] = useState<NoteType>("DEPOSIT");
  const [consignorId, setConsignorId] = useState<number | null>(null);
  const [consignorName, setConsignorName] = useState("");
  const [consignorPhone, setConsignorPhone] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [notes, setNotes] = useState("");
  const [images, setImages] = useState<ImageItem[]>([]);
  const [lineSeq, setLineSeq] = useState(1);
  // بعد حفظ سحب/استبدال: عرض بطاقة إشعار المودِع بواتساب (ضابط SOD تعويضيّ) قبل العودة للقائمة.
  const [postSave, setPostSave] = useState<{ message: string; phone: string | null } | null>(null);
  const clientRequestId = useMemo(() => crypto.randomUUID(), []);
  // سحب/استبدال ⇒ بطاقة إشعار المودِع بواتساب بعد الحفظ. (المُرفق اختياريّ لكل الأنواع — ٣١/٧.)
  const isWithdrawal = noteType !== "DEPOSIT";

  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const consignorSearch = trpc.suppliers.search.useQuery({ q: debounced || undefined, kind: "CONSIGNOR", limit: 15 }, { enabled: !consignorId });
  const products = trpc.consignments.consignorProducts.useQuery(
    { consignorId: consignorId ?? 0, branchId },
    { enabled: !!consignorId },
  );

  const create = trpc.consignments.create.useMutation({
    onSuccess: (res) => {
      notify.ok("تم حفظ السند");
      // السحب/الاستبدال: أظهر بطاقة إشعار المودِع بواتساب لحظياً (لا تُغلق النموذج فوراً).
      if (isWithdrawal) {
        const message = buildConsignmentWithdrawMessage({
          noteNumber: res.noteNumber ?? "",
          noteType: noteType as "WITHDRAW" | "EXCHANGE",
          consignorName,
          lines: lines.map((l) => ({ direction: l.direction, label: l.label, quantity: l.quantity })),
        });
        setPostSave({ message, phone: consignorPhone });
      } else {
        onSaved();
      }
    },
    onError: (e) => notify.err(e),
  });

  function addLine(direction: Dir, p: { variantId: number; productUnitId?: number; label: string }) {
    // نحتاج productUnitId — نأخذ وحدة الأساس من قائمة المنتجات (المبسّطة: variantId + الأساس).
    setLines((ls) => [...ls, { key: lineSeq, direction, variantId: p.variantId, productUnitId: p.productUnitId ?? 0, label: p.label, quantity: "1" }]);
    setLineSeq((n) => n + 1);
  }

  function submit() {
    if (create.isPending) return;
    if (!consignorId) return notify.err("اختر المودِع");
    if (!lines.length) return notify.err("أضف منتجاً واحداً على الأقل");
    create.mutate({
      noteType, consignorId, branchId, clientRequestId,
      notes: notes.trim() || null,
      attachmentUrl: images[0]?.url || images[0]?.dataUrl || null,
      lines: lines.map((l) => ({ lineDirection: l.direction, variantId: l.variantId, productUnitId: l.productUnitId, quantity: l.quantity })),
    });
  }

  // بعد حفظ سحب/استبدال: بطاقة إشعار المودِع بواتساب (ضابط SOD تعويضيّ) — يفتحها المستخدم بنقرة واحدة.
  if (postSave) {
    return (
      <Card className="border-[var(--sem-warn)]/40">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Handshake aria-hidden className="size-4 text-[var(--sem-warn)]" /> تم حفظ السند — أبلِغ المودِع
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            إشعار المودِع بالسحب فورياً ضابطٌ رقابيّ (يتحقّق المودِع ممّا خرج من بضاعته). يفتح الزرّ واتساب برسالة جاهزة.
          </p>
          {!postSave.phone && (
            <p className="text-xs text-[var(--sem-warn)]">لا رقم هاتف مسجَّل لهذا المودِع — سيفتح واتساب لتختار المحادثة يدوياً.</p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <WhatsAppShare phone={postSave.phone} message={postSave.message} label="إشعار المودِع عبر واتساب" size="default" />
            <Button variant="outline" onClick={() => { setPostSave(null); onSaved(); }}>تخطّي والعودة للقائمة</Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* النوع + المودِع */}
      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base flex items-center gap-2"><Handshake aria-hidden className="size-4 text-[var(--sem-warn)]" /> سند جديد</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="نوع السند">
            {(["DEPOSIT", "WITHDRAW", "EXCHANGE"] as NoteType[]).map((t) => (
              <button key={t} type="button" role="radio" aria-checked={noteType === t}
                onClick={() => { setNoteType(t); setLines([]); }}
                className={cn("rounded-md border px-3 py-2 text-sm transition-colors",
                  noteType === t ? "border-[var(--sem-warn)]/60 bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]" : "border-input text-muted-foreground hover:bg-muted")}>
                {TYPE_META[t].label}
              </button>
            ))}
          </div>
          <div className="space-y-1.5 max-w-md">
            <Label>المودِع <span className="text-destructive">*</span></Label>
            {consignorId ? (
              <div className="flex items-center justify-between rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] px-3 py-2">
                <span className="text-sm font-medium text-[var(--sem-warn)]">{consignorName}</span>
                <button type="button" onClick={() => { setConsignorId(null); setConsignorPhone(null); setLines([]); }} aria-label="تغيير المودِع"><X aria-hidden className="size-4 text-[var(--sem-warn)]" /></button>
              </div>
            ) : (
              <div className="relative">
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ابحث عن مودِع…" />
                {(consignorSearch.data?.rows.length ?? 0) > 0 && (
                  <div className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-md border bg-popover shadow-md">
                    {consignorSearch.data!.rows.map((r) => (
                      <button key={r.id} type="button" onClick={() => { setConsignorId(Number(r.id)); setConsignorName(r.name ?? ""); setConsignorPhone(r.phone ?? null); }}
                        className="flex w-full items-center justify-between px-3 py-2 text-right text-sm hover:bg-muted">
                        <span>{r.name}</span>{r.phone && <span dir="ltr" className="text-xs text-muted-foreground">{r.phone}</span>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* المنتجات */}
      {consignorId && (
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-base">المنتجات</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {/* منتقي منتجات المودِع */}
            <div className="flex flex-wrap gap-2">
              {(products.data ?? []).map((p) => (
                <div key={p.variantId} className="flex items-center gap-1 rounded border px-2 py-1 text-xs">
                  <span>{p.productName}{p.color ? ` — ${p.color}` : ""}</span>
                  {noteType !== "WITHDRAW" && (
                    <button type="button" className="text-[var(--sem-pos)]" title="إيداع" onClick={() => addLine("IN", { variantId: p.variantId, productUnitId: p.productUnitId, label: p.productName })}>+ إيداع</button>
                  )}
                  {noteType !== "DEPOSIT" && (
                    <button type="button" className="text-[var(--sem-neg)]" title="سحب" onClick={() => addLine("OUT", { variantId: p.variantId, productUnitId: p.productUnitId, label: p.productName })}>+ سحب</button>
                  )}
                </div>
              ))}
              {(products.data?.length ?? 0) === 0 && <p className="text-xs text-muted-foreground">لا منتجات لهذا المودِع بعد — أضِف منتج أمانة من المنتجات باسمه.</p>}
            </div>
            {/* أسطر السند — شبكةُ تحرير لا عرض (موجة الجداول ٢/٩/٢٦): كل صفٍّ يحمل حقلَ
                الكمية وزرَّ حذف السطر يكتبان في حالة `lines` المحلّية قبل الحفظ؛ `DataTable`
                أداةُ عرضٍ فتبقى هذه خامّةً عن قصد. */}
            {lines.length > 0 && (
              <table className="w-full text-sm">
                <thead className="bg-muted/50"><tr><th className="p-2">الاتجاه</th><th className="p-2">المنتج</th><th className="p-2">الكمية</th><th className="p-2"></th></tr></thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.key} className="border-t">
                      <td className="p-2"><span className={cn("rounded px-1.5 py-0.5 text-[10px] font-bold", l.direction === "IN" ? "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]" : "bg-[var(--sem-neg-bg)] text-[var(--sem-neg)]")}>{l.direction === "IN" ? "إيداع" : "سحب"}</span></td>
                      <td className="p-2">{l.label}</td>
                      {/* المخزون بالوحدة الأساس عدد صحيح (§٥) — يُرفَض إدخال كسور من الأصل. */}
                      <td className="p-2 w-28"><Input dir="ltr" inputMode="numeric" value={l.quantity} onChange={(e) => setLines((ls) => ls.map((x) => x.key === l.key ? { ...x, quantity: e.target.value.replace(/[^\d]/g, "") } : x))} className="h-8" /></td>
                      <td className="p-2"><button type="button" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} aria-label="حذف"><X aria-hidden className="size-4 text-muted-foreground hover:text-destructive" /></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      )}

      {/* المرفق + الملاحظات */}
      {consignorId && (
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-base">التوثيق</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <Label>صورة السند الموقَّع (اختياري)</Label>
              <ImageUploader value={images} onChange={setImages} maxItems={1} singlePrimary={false} hint="صورة السند بتوقيع المودِع — اختيارية، موصى بها للسحب/الاستبدال." />
            </div>
            <div className="space-y-1">
              <Label htmlFor="notes">ملاحظات</Label>
              <Textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
            </div>
          </CardContent>
        </Card>
      )}

      <div className="sticky bottom-0 z-10 flex items-center gap-2 border-t bg-background/95 py-3 backdrop-blur">
        <Button onClick={submit} disabled={create.isPending || !consignorId || !lines.length}>
          {create.isPending ? "جارٍ الحفظ…" : "حفظ السند"}
        </Button>
        <Button variant="outline" onClick={onSaved}>إلغاء</Button>
      </div>
    </div>
  );
}
