// لوحة فصل البدائل المدمجة (م٤) — يستهلكها Stocktakes.tsx.
//
// تسرد الوحدات التي تحمل باركوداً بديلاً، ويقرّر المدير لكلّ باركود: «دفعة — يبقى» (لا شيء)،
// أو «بديل حقيقي — يُفصل» (يُخرجه متغيّراً مستقلاً). بعد الفصل يذكّر بجردٍ يدويّ لفصل الرصيد.
import { useState } from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/form/MoneyInput";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Split, ChevronDown } from "lucide-react";

type Target = { productUnitId: number; aliasBarcode: string; productName: string };

export function SplitCandidatesPanel({ canManage }: { canManage: boolean }) {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const candidates = trpc.stocktakes.splitCandidates.useQuery(undefined, { enabled: open });
  const [target, setTarget] = useState<Target | null>(null);
  const [name, setName] = useState("");
  const [cost, setCost] = useState("");
  const [lastSplit, setLastSplit] = useState<{ source: number; created: number } | null>(null);

  const split = trpc.stocktakes.splitAlternative.useMutation({
    onSuccess: async (res) => {
      setTarget(null);
      setName("");
      setCost("");
      setLastSplit({ source: res.sourceVariantId, created: res.newVariantId });
      notify.ok(
        "أُنشئ البديل المستقلّ",
        `SKU ${res.sku} — افصل الرصيد المدمج بجردٍ يدويّ على الصنفين (زرّ أدناه).`,
      );
      await utils.stocktakes.splitCandidates.invalidate();
    },
    onError: (e) => notify.err(e),
  });

  const rows = candidates.data ?? [];

  return (
    <Card>
      <CardHeader className="cursor-pointer p-4" onClick={() => setOpen((v) => !v)}>
        <CardTitle className="flex items-center justify-between text-base">
          <span className="inline-flex items-center gap-2">
            <Split aria-hidden className="size-4" /> فصل البدائل المدمجة
            {open && rows.length > 0 && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">
                {rows.length} وحدة مرشّحة
              </span>
            )}
          </span>
          <ChevronDown
            aria-hidden
            className={`size-4 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </CardTitle>
      </CardHeader>
      {open && (
        <CardContent className="space-y-3 p-4 pt-0">
          <p className="text-xs text-muted-foreground">
            الباركود البديل قد يُخفي منتجاً حقيقياً مختلفاً تحت اسمٍ واحد. إن كان «دفعة بترميز آخر»
            فاتركه؛ وإن كان «ماركة/منشأ مختلف» فافصله بديلاً مستقلاً له مخزونه وتكلفته وباركوده.
          </p>
          {lastSplit && (
            <div className="rounded-lg border p-3 text-sm badge-status-done">
              أُنشئ البديل. لفصل الرصيد المدمج فعلياً:{" "}
              <Link
                href={`/stocktakes/new?variants=${lastSplit.source},${lastSplit.created}`}
                className="font-bold underline"
              >
                أنشئ جرداً يدوياً على الصنفين ←
              </Link>
            </div>
          )}
          {candidates.isLoading && (
            <p className="py-4 text-center text-sm text-muted-foreground">جارٍ التحميل…</p>
          )}
          {!candidates.isLoading && rows.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">
              لا وحدات بباركودات بديلة — لا شيء للفصل.
            </p>
          )}
          {rows.map((c) => (
            <div key={c.productUnitId} className="rounded-lg border p-3">
              <p className="text-sm font-bold">{c.productName}</p>
              <p className="mb-2 text-xs text-muted-foreground" dir="ltr">
                {c.sku} · {c.unitName}
              </p>
              <div className="space-y-1.5">
                {c.aliases.map((a) => (
                  <div
                    key={a.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/40 px-2.5 py-1.5"
                  >
                    <span className="font-mono text-xs" dir="ltr">
                      {a.barcode}
                      {a.note ? (
                        <span className="ms-2 font-sans text-muted-foreground">{a.note}</span>
                      ) : null}
                    </span>
                    {canManage && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1 text-xs"
                        onClick={() => {
                          setTarget({
                            productUnitId: c.productUnitId,
                            aliasBarcode: a.barcode,
                            productName: c.productName,
                          });
                          setName("");
                          setCost("");
                        }}
                      >
                        <Split aria-hidden className="size-3.5" /> فصل بديلاً
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </CardContent>
      )}

      <Dialog open={target != null} onOpenChange={(o) => !o && setTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-right">فصل بديل مستقلّ</DialogTitle>
          </DialogHeader>
          {target && (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                من «{target.productName}» — الباركود{" "}
                <span className="font-mono" dir="ltr">
                  {target.aliasBarcode}
                </span>
                . يُنشأ متغيّرٌ مستقلّ يحمل هذا الباركود، برصيدٍ يبدأ صفراً وسعرٍ منسوخٍ من الأصل.
              </p>
              <label className="block text-sm font-semibold">
                اسم البديل (الماركة/المنشأ)
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="مثال: ماركة النسر"
                  className="mt-1 h-9"
                />
              </label>
              <label className="block text-sm font-semibold">
                تكلفة الوحدة (اختياريّ — الافتراض تكلفة الأصل)
                <MoneyInput value={cost} onChange={setCost} className="mt-1 h-9" />
              </label>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setTarget(null)} disabled={split.isPending}>
              إلغاء
            </Button>
            <Button
              disabled={!name.trim() || split.isPending}
              onClick={() => {
                if (!target) return;
                split.mutate({
                  productUnitId: target.productUnitId,
                  aliasBarcode: target.aliasBarcode,
                  name: name.trim(),
                  cost: cost.trim() || undefined,
                });
              }}
            >
              {split.isPending ? "جارٍ الفصل…" : "افصل"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
