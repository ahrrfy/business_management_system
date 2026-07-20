import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ImageUploader, type ImageItem } from "@/components/form/ImageUploader";
import { PageHeader } from "@/components/PageHeader";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { TableEmptyRow } from "@/components/PageState";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { useEffect, useMemo, useState } from "react";
import { Handshake, Paperclip, Plus, Printer, X } from "lucide-react";
import { printConsignmentNote } from "@/lib/printing/printConsignmentNote";

type NoteType = "DEPOSIT" | "WITHDRAW" | "EXCHANGE";
type Dir = "IN" | "OUT";
type Line = { key: number; direction: Dir; variantId: number; productUnitId: number; label: string; quantity: string };

const TYPE_META: Record<NoteType, { label: string; cls: string }> = {
  DEPOSIT: { label: "إيداع", cls: "bg-emerald-100 text-emerald-800" },
  WITHDRAW: { label: "سحب", cls: "bg-red-100 text-red-800" },
  EXCHANGE: { label: "استبدال", cls: "bg-blue-100 text-blue-800" },
};

export default function ConsignmentNotes() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const branchId = me.data?.branchId ?? 1;
  const [mode, setMode] = useState<"list" | "new">("list");

  const list = trpc.consignments.list.useQuery({ limit: 50 }, { enabled: mode === "list" });

  return (
    <div className="space-y-4">
      <PageHeader
        title="سندات الأمانة"
        description="إيداع/سحب/استبدال بضاعة المودِعين — حركات مخزون بلا أثر ماليّ (المستحق يتكوّن عند البيع)."
        actions={
          mode === "list" ? (
            <Button size="sm" onClick={() => setMode("new")}><Plus aria-hidden className="size-4 me-1" /> سند جديد</Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setMode("list")}>← رجوع للقائمة</Button>
          )
        }
      />

      {mode === "new" ? (
        <NoteForm
          branchId={branchId}
          onSaved={() => { setMode("list"); utils.consignments.list.invalidate(); }}
        />
      ) : (
        <Card>
          <CardHeader><CardTitle className="text-base">آخر السندات</CardTitle></CardHeader>
          <CardContent className="p-0">
            <ScrollTableShell bordered={false}>
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="p-2">الرقم</th><th className="p-2">النوع</th><th className="p-2">المودِع</th>
                    <th className="p-2">الأصناف</th><th className="p-2">التاريخ</th><th className="p-2 text-center">طباعة</th>
                  </tr>
                </thead>
                <tbody>
                  {(list.data?.rows ?? []).map((n) => (
                    <tr key={n.id} className="border-t">
                      <td className="p-2 font-mono text-xs" dir="ltr">{n.noteNumber}</td>
                      <td className="p-2"><span className={cn("rounded px-1.5 py-0.5 text-[10px] font-bold", TYPE_META[n.noteType as NoteType].cls)}>{TYPE_META[n.noteType as NoteType].label}</span></td>
                      <td className="p-2">{n.consignorName}</td>
                      <td className="p-2 text-xs text-muted-foreground">{n.hasAttachment ? <Paperclip aria-hidden className="size-3.5 inline text-emerald-600" /> : null}</td>
                      <td className="p-2 text-xs" dir="ltr">{new Date(n.createdAt).toLocaleDateString("en-GB")}</td>
                      <td className="p-2 text-center">
                        <Button size="sm" variant="ghost" onClick={() => printFromNote(n.id)} title="طباعة السند">
                          <Printer aria-hidden className="size-4" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                  {!list.isLoading && (list.data?.rows.length ?? 0) === 0 && (
                    <TableEmptyRow colSpan={6} message="لا سندات بعد. أنشئ سند إيداع لأول مودِع." />
                  )}
                </tbody>
              </table>
            </ScrollTableShell>
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

/* ============================ نموذج السند ============================ */

function NoteForm({ branchId, onSaved }: { branchId: number; onSaved: () => void }) {
  const [noteType, setNoteType] = useState<NoteType>("DEPOSIT");
  const [consignorId, setConsignorId] = useState<number | null>(null);
  const [consignorName, setConsignorName] = useState("");
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [notes, setNotes] = useState("");
  const [images, setImages] = useState<ImageItem[]>([]);
  const [lineSeq, setLineSeq] = useState(1);
  const clientRequestId = useMemo(() => crypto.randomUUID(), []);
  const needsAttachment = noteType !== "DEPOSIT";

  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const consignorSearch = trpc.suppliers.search.useQuery({ q: debounced || undefined, kind: "CONSIGNOR", limit: 15 }, { enabled: !consignorId });
  const products = trpc.consignments.consignorProducts.useQuery(
    { consignorId: consignorId ?? 0, branchId },
    { enabled: !!consignorId },
  );

  const create = trpc.consignments.create.useMutation({
    onSuccess: () => { notify.ok("تم حفظ السند"); onSaved(); },
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
    if (!lines.length) return notify.err("أضف صنفاً واحداً على الأقل");
    if (needsAttachment && !images[0]) return notify.err("سند السحب/الاستبدال يلزمه صورة السند الموقَّع");
    create.mutate({
      noteType, consignorId, branchId, clientRequestId,
      notes: notes.trim() || null,
      attachmentUrl: needsAttachment ? (images[0]?.url || images[0]?.dataUrl || null) : null,
      lines: lines.map((l) => ({ lineDirection: l.direction, variantId: l.variantId, productUnitId: l.productUnitId, quantity: l.quantity })),
    });
  }

  return (
    <div className="space-y-4">
      {/* النوع + المودِع */}
      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base flex items-center gap-2"><Handshake aria-hidden className="size-4 text-amber-600" /> سند جديد</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="نوع السند">
            {(["DEPOSIT", "WITHDRAW", "EXCHANGE"] as NoteType[]).map((t) => (
              <button key={t} type="button" role="radio" aria-checked={noteType === t}
                onClick={() => { setNoteType(t); setLines([]); }}
                className={cn("rounded-md border px-3 py-2 text-sm transition-colors",
                  noteType === t ? "border-amber-400 bg-amber-50 text-amber-900" : "border-input text-muted-foreground hover:bg-muted")}>
                {TYPE_META[t].label}
              </button>
            ))}
          </div>
          <div className="space-y-1.5 max-w-md">
            <Label>المودِع <span className="text-destructive">*</span></Label>
            {consignorId ? (
              <div className="flex items-center justify-between rounded-md border border-amber-300 bg-amber-50 px-3 py-2">
                <span className="text-sm font-medium text-amber-900">{consignorName}</span>
                <button type="button" onClick={() => { setConsignorId(null); setLines([]); }} aria-label="تغيير المودِع"><X aria-hidden className="size-4 text-amber-700" /></button>
              </div>
            ) : (
              <div className="relative">
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ابحث عن مودِع…" />
                {(consignorSearch.data?.rows.length ?? 0) > 0 && (
                  <div className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-md border bg-popover shadow-md">
                    {consignorSearch.data!.rows.map((r) => (
                      <button key={r.id} type="button" onClick={() => { setConsignorId(Number(r.id)); setConsignorName(r.name ?? ""); }}
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

      {/* الأصناف */}
      {consignorId && (
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-base">الأصناف</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {/* منتقي أصناف المودِع */}
            <div className="flex flex-wrap gap-2">
              {(products.data ?? []).map((p) => (
                <div key={p.variantId} className="flex items-center gap-1 rounded border px-2 py-1 text-xs">
                  <span>{p.productName}{p.color ? ` — ${p.color}` : ""}</span>
                  {noteType !== "WITHDRAW" && (
                    <button type="button" className="text-emerald-700" title="إيداع" onClick={() => addLine("IN", { variantId: p.variantId, productUnitId: p.productUnitId, label: p.productName })}>+ إيداع</button>
                  )}
                  {noteType !== "DEPOSIT" && (
                    <button type="button" className="text-red-700" title="سحب" onClick={() => addLine("OUT", { variantId: p.variantId, productUnitId: p.productUnitId, label: p.productName })}>+ سحب</button>
                  )}
                </div>
              ))}
              {(products.data?.length ?? 0) === 0 && <p className="text-xs text-muted-foreground">لا أصناف لهذا المودِع بعد — أضِف صنف أمانة من المنتجات باسمه.</p>}
            </div>
            {/* أسطر السند */}
            {lines.length > 0 && (
              <table className="w-full text-sm">
                <thead className="bg-muted/50"><tr><th className="p-2">الاتجاه</th><th className="p-2">الصنف</th><th className="p-2">الكمية</th><th className="p-2"></th></tr></thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.key} className="border-t">
                      <td className="p-2"><span className={cn("rounded px-1.5 py-0.5 text-[10px] font-bold", l.direction === "IN" ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-800")}>{l.direction === "IN" ? "إيداع" : "سحب"}</span></td>
                      <td className="p-2">{l.label}</td>
                      <td className="p-2 w-28"><Input dir="ltr" inputMode="numeric" value={l.quantity} onChange={(e) => setLines((ls) => ls.map((x) => x.key === l.key ? { ...x, quantity: e.target.value.replace(/[^\d.]/g, "") } : x))} className="h-8" /></td>
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
            {needsAttachment && (
              <div className="space-y-1">
                <Label>صورة السند الموقَّع <span className="text-destructive">*</span></Label>
                <ImageUploader value={images} onChange={setImages} maxItems={1} singlePrimary={false} hint="إلزاميّ للسحب/الاستبدال — صورة السند بتوقيع المودِع." />
              </div>
            )}
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
