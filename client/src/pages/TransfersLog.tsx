// سجلّ سندات التحويل بخطوتين + استلام بمطابقة فعلية (١٤/٧/٢٠٢٦).
// الوارد «بالطريق» يستلمه الفرع الوجهة سطراً بسطر: كمية مستلَمة (0..المرسَل) وملاحظة
// إلزامية عند أي فرق — العجز يبقى موثَّقاً على السند ويظهر هنا دائماً.
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { LoadingState } from "@/components/PageState";
import { confirm } from "@/lib/confirm";
import { fmtDateTime } from "@/lib/date";
import { fmtInt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { CheckCheck, PackageCheck, Undo2 } from "lucide-react";
import { useMemo, useState } from "react";

const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const REASON_LABELS: Record<string, string> = {
  REBALANCE: "إعادة توزيع المخزون",
  STOCKOUT: "نفاد في الفرع المستلم",
  BRANCH_REQ: "طلب من الفرع",
  SEASONAL: "تجهيز موسمي",
  RETURN_HQ: "إرجاع للمخزن الرئيسي",
  OTHER: "أخرى",
};

function StatusBadge({ status, sent, received }: { status: string; sent: number; received: number | null }) {
  if (status === "IN_TRANSIT") return <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30">بالطريق</Badge>;
  if (status === "CANCELLED") return <Badge variant="secondary">ملغى</Badge>;
  if (received != null && received < sent)
    return <Badge className="bg-orange-500/15 text-orange-700 dark:text-orange-400 border-orange-500/30">مستلَم بعجز {fmtInt(sent - received)}</Badge>;
  return <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30">مستلَم مطابق</Badge>;
}

export default function TransfersLog() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const elevated = me.data?.role === "admin" || me.data?.role === "manager";
  const myBranch = me.data?.branchId == null ? null : Number(me.data.branchId);

  const [status, setStatus] = useState<"all" | "IN_TRANSIT" | "RECEIVED" | "CANCELLED">("all");
  const [direction, setDirection] = useState<"all" | "in" | "out">("all");
  const [openId, setOpenId] = useState<number | null>(null);

  const list = trpc.inventory.transfersList.useInfiniteQuery(
    { status, dir: direction, limit: 30 },
    { getNextPageParam: (last) => last.nextCursor }
  );
  const rows = useMemo(() => (list.data?.pages ?? []).flatMap((p) => p.rows), [list.data]);

  const detail = trpc.inventory.transferGet.useQuery({ id: openId ?? 0 }, { enabled: openId != null });
  const doc = openId != null ? detail.data : undefined;

  // وضع الاستلام: كمية مستلَمة + ملاحظة لكل سطر (تُهيّأ عند فتح سند بالطريق بقيم المرسَل).
  const [recv, setRecv] = useState<Record<number, { qty: string; note: string }>>({});
  const [reqId, setReqId] = useState(() => crypto.randomUUID());

  function openDoc(id: number) {
    setRecv({});
    setReqId(crypto.randomUUID());
    setOpenId(id);
  }

  const canReceive = doc?.status === "IN_TRANSIT" && (elevated || (myBranch != null && myBranch === Number(doc.toBranchId)));
  const canCancel = doc?.status === "IN_TRANSIT" && (elevated || (myBranch != null && myBranch === Number(doc.fromBranchId)));

  const lineState = (lineId: number, sent: number) => recv[lineId] ?? { qty: String(sent), note: "" };
  // sent تُمرَّر هنا كي يبقى افتراضي الكمية «المرسَل» حتى لو كُتبت الملاحظة قبل لمس حقل الكمية.
  const setLine = (lineId: number, sent: number, patch: Partial<{ qty: string; note: string }>) =>
    setRecv((p) => ({ ...p, [lineId]: { ...(p[lineId] ?? { qty: String(sent), note: "" }), ...patch } }));

  const recvErrors = useMemo(() => {
    if (!doc || doc.status !== "IN_TRANSIT") return [];
    return doc.lines.map((l) => {
      const st = recv[Number(l.id)] ?? { qty: String(l.quantitySent), note: "" };
      const q = st.qty.trim() === "" ? NaN : Number(st.qty);
      if (!Number.isInteger(q) || q < 0) return "كمية غير صالحة";
      if (q > l.quantitySent) return `تتجاوز المرسَل (${l.quantitySent})`;
      if (q !== l.quantitySent && !st.note.trim()) return "الفرق يتطلّب ملاحظة";
      return "";
    });
  }, [doc, recv]);
  const recvValid = recvErrors.length > 0 && recvErrors.every((e) => !e);
  const totalDiscrepancy = useMemo(() => {
    if (!doc) return 0;
    return doc.lines.reduce((a, l) => {
      const st = recv[Number(l.id)] ?? { qty: String(l.quantitySent), note: "" };
      const q = Number(st.qty);
      return a + (Number.isInteger(q) && q >= 0 && q <= l.quantitySent ? l.quantitySent - q : 0);
    }, 0);
  }, [doc, recv]);

  const receive = trpc.inventory.transferReceive.useMutation({
    onSuccess: async (res) => {
      notify.ok(res.discrepancyUnits > 0 ? `تمّ الاستلام مع توثيق عجز ${fmtInt(res.discrepancyUnits)} وحدة` : "تمّ الاستلام مطابقاً");
      setOpenId(null);
      await Promise.all([
        utils.inventory.transfersList.invalidate(),
        utils.inventory.transfersPendingIncoming.invalidate(),
        utils.inventory.transferGet.invalidate(),
        utils.catalog.forPurchase.invalidate(),
        utils.inventory.movements?.invalidate?.(),
      ]);
    },
    onError: (e) => notify.err(e.message),
  });

  const cancel = trpc.inventory.transferCancel.useMutation({
    onSuccess: async () => {
      notify.ok("أُلغي السند وأُعيدت الكمية لرصيد الفرع المرسل");
      setOpenId(null);
      await Promise.all([
        utils.inventory.transfersList.invalidate(),
        utils.inventory.transfersPendingIncoming.invalidate(),
        utils.inventory.transferGet.invalidate(),
        utils.catalog.forPurchase.invalidate(),
      ]);
    },
    onError: (e) => notify.err(e.message),
  });

  async function submitReceive() {
    if (!doc || !recvValid) return;
    if (totalDiscrepancy > 0) {
      const ok = await confirm({
        variant: "danger",
        title: `استلام بعجز ${fmtInt(totalDiscrepancy)} وحدة`,
        description: "العجز سيُوثَّق نهائياً على السند ويُخصم من مخزون النظام (خسارة نقل). متابعة؟",
        confirmText: "استلام وتوثيق العجز",
      });
      if (!ok) return;
    }
    receive.mutate({
      transferId: Number(doc.id),
      lines: doc.lines.map((l) => {
        const st = recv[Number(l.id)] ?? { qty: String(l.quantitySent), note: "" };
        return { lineId: Number(l.id), quantityReceived: Number(st.qty), note: st.note.trim() || undefined };
      }),
      clientRequestId: reqId,
    });
  }

  async function submitCancel() {
    if (!doc) return;
    const ok = await confirm({
      variant: "danger",
      title: `إلغاء السند ${doc.transferNumber}`,
      description: "تُعاد الكمية كاملة لرصيد الفرع المرسل ويُغلق السند نهائياً. متابعة؟",
      confirmText: "إلغاء السند",
    });
    if (ok) cancel.mutate({ transferId: Number(doc.id) });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Label className="text-muted-foreground">الحالة</Label>
        <select className={selectCls} value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          <option value="all">الكل</option>
          <option value="IN_TRANSIT">بالطريق</option>
          <option value="RECEIVED">مستلَم</option>
          <option value="CANCELLED">ملغى</option>
        </select>
        <Label className="text-muted-foreground mr-2">الاتجاه</Label>
        <select className={selectCls} value={direction} onChange={(e) => setDirection(e.target.value as typeof direction)}>
          <option value="all">الكل</option>
          <option value="in">وارد لفرعي</option>
          <option value="out">صادر من فرعي</option>
        </select>
      </div>

      <Card>
        <CardContent className="p-0">
          {list.isLoading ? (
            <div className="p-6"><LoadingState /></div>
          ) : rows.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">لا سندات تحويل بعد.</p>
          ) : (
            <ScrollTableShell bordered={false}>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-right">السند</TableHead>
                    <TableHead className="text-right">من ← إلى</TableHead>
                    <TableHead className="text-center">الأصناف</TableHead>
                    <TableHead className="text-center">الوحدات (مرسَل/مستلَم)</TableHead>
                    <TableHead className="text-center">الحالة</TableHead>
                    <TableHead className="text-left">التاريخ</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.id} className="cursor-pointer hover:bg-accent/40" onClick={() => openDoc(Number(r.id))}>
                      <TableCell className="font-mono text-xs" dir="ltr">{r.transferNumber}</TableCell>
                      <TableCell>{r.fromBranchName} ← {r.toBranchName}</TableCell>
                      <TableCell className="text-center tabular-nums">{fmtInt(r.linesCount)}</TableCell>
                      <TableCell className="text-center tabular-nums" dir="ltr">
                        {fmtInt(r.totalSentBase)}{r.totalReceivedBase != null ? ` / ${fmtInt(r.totalReceivedBase)}` : ""}
                      </TableCell>
                      <TableCell className="text-center">
                        <StatusBadge status={r.status} sent={Number(r.totalSentBase)} received={r.totalReceivedBase == null ? null : Number(r.totalReceivedBase)} />
                      </TableCell>
                      <TableCell className="text-left tabular-nums text-xs" dir="ltr">{fmtDateTime(r.createdAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollTableShell>
          )}
          {list.hasNextPage && (
            <div className="p-3 text-center border-t">
              <Button variant="outline" size="sm" onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>
                {list.isFetchingNextPage ? "جارٍ التحميل…" : "تحميل المزيد"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={openId != null} onOpenChange={(o) => { if (!o) setOpenId(null); }}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 flex-wrap">
              <span>سند تحويل</span>
              <span className="font-mono text-sm text-muted-foreground" dir="ltr">{doc?.transferNumber ?? "…"}</span>
              {doc && <StatusBadge status={doc.status} sent={Number(doc.totalSentBase)} received={doc.totalReceivedBase == null ? null : Number(doc.totalReceivedBase)} />}
            </DialogTitle>
            <DialogDescription>
              {doc
                ? `${doc.fromBranchName} ← ${doc.toBranchName}${doc.reason ? ` · ${REASON_LABELS[doc.reason] ?? doc.reason}` : ""} · أنشأه ${doc.createdByName ?? "—"} في ${fmtDateTime(doc.createdAt)}`
                : "جارٍ التحميل…"}
            </DialogDescription>
          </DialogHeader>

          {detail.isLoading || !doc ? (
            <LoadingState />
          ) : (
            <div className="space-y-3">
              {doc.notes && <p className="text-sm text-muted-foreground">ملاحظات الإرسال: {doc.notes}</p>}
              {doc.status === "RECEIVED" && (
                <p className="text-sm">
                  استلمه <span className="font-medium">{doc.receivedByName ?? "—"}</span> في <span dir="ltr" className="tabular-nums">{fmtDateTime(doc.receivedAt)}</span>
                  {doc.receiveNotes ? ` — ${doc.receiveNotes}` : ""}
                </p>
              )}
              {doc.status === "CANCELLED" && (
                <p className="text-sm text-muted-foreground">ألغاه {doc.cancelledByName ?? "—"} في <span dir="ltr" className="tabular-nums">{fmtDateTime(doc.cancelledAt)}</span> — أُعيدت الكمية للفرع المرسل.</p>
              )}

              <div className="border rounded-md overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40">
                    <tr>
                      <th className="p-2 px-3 text-right">الصنف</th>
                      <th className="p-2 text-center w-24">المرسَل</th>
                      <th className="p-2 text-center w-32">{canReceive ? "المستلَم فعلياً" : "المستلَم"}</th>
                      <th className="p-2 text-center w-20">الفرق</th>
                      <th className="p-2 text-right">ملاحظة السطر</th>
                    </tr>
                  </thead>
                  <tbody>
                    {doc.lines.map((l, i) => {
                      const st = lineState(Number(l.id), l.quantitySent);
                      const q = Number(st.qty);
                      const diff = canReceive
                        ? (Number.isInteger(q) && q >= 0 && q <= l.quantitySent ? l.quantitySent - q : null)
                        : l.quantityReceived == null ? null : l.quantitySent - Number(l.quantityReceived);
                      return (
                        <tr key={Number(l.id)} className="border-t align-top">
                          <td className="p-2 px-3">
                            <div className="font-medium">{l.productName}{l.variantName ? ` — ${l.variantName}` : l.color ? ` — ${l.color}` : ""}</div>
                            <div className="text-[11px] text-muted-foreground font-mono" dir="ltr">{l.sku}</div>
                          </td>
                          <td className="p-2 text-center tabular-nums" dir="ltr">{fmtInt(l.quantitySent)}</td>
                          <td className="p-2 text-center">
                            {canReceive ? (
                              <>
                                <Input
                                  dir="ltr"
                                  inputMode="numeric"
                                  value={st.qty}
                                  onChange={(e) => setLine(Number(l.id), l.quantitySent, { qty: e.target.value.replace(/[^\d]/g, "") })}
                                  className={`h-8 text-center ${recvErrors[i] ? "border-destructive" : ""}`}
                                  aria-label={`الكمية المستلَمة — ${l.productName}`}
                                />
                                {recvErrors[i] && <p className="text-[10px] text-destructive mt-0.5">{recvErrors[i]}</p>}
                              </>
                            ) : (
                              <span className="tabular-nums" dir="ltr">{l.quantityReceived == null ? "—" : fmtInt(Number(l.quantityReceived))}</span>
                            )}
                          </td>
                          <td className="p-2 text-center tabular-nums" dir="ltr">
                            {diff == null ? "—" : diff === 0 ? <CheckCheck aria-hidden className="size-4 inline text-emerald-600" /> : <span className="text-destructive font-semibold">-{fmtInt(diff)}</span>}
                          </td>
                          <td className="p-2">
                            {canReceive ? (
                              <Input
                                value={st.note}
                                onChange={(e) => setLine(Number(l.id), l.quantitySent, { note: e.target.value })}
                                placeholder={diff != null && diff > 0 ? "إلزامية — ما سبب العجز؟" : "اختيارية"}
                                className="h-8"
                                aria-label={`ملاحظة السطر — ${l.productName}`}
                              />
                            ) : (
                              <span className="text-xs text-muted-foreground">{l.note ?? "—"}</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {canReceive && (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Button variant="outline" size="sm" onClick={() => { setRecv({}); }}>
                    <CheckCheck aria-hidden className="size-4" /> مطابقة الكل (استلام كامل)
                  </Button>
                  <div className="flex items-center gap-2">
                    {canCancel && (
                      <Button variant="ghost" className="text-destructive" onClick={submitCancel} disabled={cancel.isPending}>
                        <Undo2 aria-hidden className="size-4" /> إلغاء السند
                      </Button>
                    )}
                    <Button onClick={submitReceive} disabled={!recvValid || receive.isPending}>
                      <PackageCheck aria-hidden className="size-4" />
                      {receive.isPending ? "جارٍ الاستلام…" : totalDiscrepancy > 0 ? `استلام مع عجز ${fmtInt(totalDiscrepancy)}` : "تأكيد الاستلام مطابقاً"}
                    </Button>
                  </div>
                </div>
              )}
              {!canReceive && canCancel && (
                <div className="flex justify-start">
                  <Button variant="ghost" className="text-destructive" onClick={submitCancel} disabled={cancel.isPending}>
                    <Undo2 aria-hidden className="size-4" /> إلغاء السند (يعيد الكمية للمصدر)
                  </Button>
                </div>
              )}
              {doc.status === "IN_TRANSIT" && !canReceive && !canCancel && (
                <p className="text-xs text-muted-foreground">السند بالطريق — الاستلام يتمّ من الفرع الوجهة ({doc.toBranchName}).</p>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
