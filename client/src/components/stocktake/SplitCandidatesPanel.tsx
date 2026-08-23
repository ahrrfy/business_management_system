// لوحة فصل البدائل المدمجة (م٤) — يستهلكها Stocktakes.tsx.
//
// تسرد الوحدات التي تحمل باركوداً بديلاً، ويقرّر المدير لكلّ باركود: «دفعة — يبقى» (لا شيء)،
// أو «بديل حقيقي — يُفصل» (يُخرجه متغيّراً مستقلاً). بعد الفصل يذكّر بجردٍ يدويّ لفصل الرصيد.
import { useState } from "react";
import { Link, useLocation } from "wouter";
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
import { Split, ChevronDown, ClipboardCheck } from "lucide-react";

type Target = { productUnitId: number; aliasBarcode: string; productName: string };

export function SplitCandidatesPanel({ canManage }: { canManage: boolean }) {
  const utils = trpc.useUtils();
  const [, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  const candidates = trpc.stocktakes.splitCandidates.useQuery(undefined, { enabled: open });
  // نطاق جرد التحقّق لفصل رصيد البدائل المنشأة (الأصل + البدائل لكل منتج له بديل).
  const reconScope = trpc.stocktakes.alternativeReconciliationScope.useQuery(undefined, { enabled: open });

  /** يُنشئ جرد تحقّق يدويّاً يغطّي كل متغيّرات المنتجات ذات البدائل — يُمرَّر عبر sessionStorage (قد يكبر). */
  function createReconciliationStocktake() {
    const ids = reconScope.data?.variantIds ?? [];
    if (!ids.length) return;
    const key = `stkReconPrefill:${ids.length}:${ids[0]}:${ids[ids.length - 1]}`;
    try {
      sessionStorage.setItem(key, JSON.stringify(ids));
    } catch {
      notify.err(new Error("تعذّر تحضير النطاق — أعد المحاولة."));
      return;
    }
    const name = "جرد تحقّق — فصل رصيد البدائل المدمج";
    navigate(`/stocktakes/new?prefillKey=${encodeURIComponent(key)}&name=${encodeURIComponent(name)}`);
  }
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
      await Promise.all([
        utils.stocktakes.splitCandidates.invalidate(),
        // بعد الفصل يتغيّر نطاق التحقّق (بديلٌ جديد) — حدِّثه وإلّا بقي زرّ «أنشئ جرد تحقّق» على IDs قديمة
        // أو معطَّلاً إن كان هذا أوّل بديل (مراجعة Codex P2).
        utils.stocktakes.alternativeReconciliationScope.invalidate(),
        // وتقرير توزيع المخزون يعرض بديلاً جديداً ⇒ حدِّثه كي لا يبقى ناقصاً بعد الفصل (Codex P2).
        utils.stocktakes.alternativeStockBreakdown.invalidate(),
      ]);
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

          {/* جرد تحقّق يجمع كل المنتجات ذات البدائل (الأصل + البدائل) لتوزيع الرصيد المدمج ميدانياً. */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
            <div className="min-w-0">
              <p className="text-sm font-bold">فصل الرصيد المدمج للبدائل المنشأة</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {reconScope.isLoading
                  ? "جارٍ الحساب…"
                  : (reconScope.data?.alternativeCount ?? 0) > 0
                    ? `${reconScope.data!.alternativeCount} بديلاً منشأً في ${reconScope.data!.productCount} منتجاً — أنشئ جرد تحقّقٍ يعدّ الأصل وبدائله معاً فيوزّع الرصيد الماديّ عليها.${reconScope.data!.truncated ? ` (النطاق كبير: يُنشأ لأوّل ${reconScope.data!.variantCount} صنف؛ كرّر للباقي.)` : ""}`
                    : "لا بدائل منشأة بعد — افصل بديلاً أولاً، ثم أنشئ جرد التحقّق."}
              </p>
            </div>
            {canManage && (
              <Button
                type="button"
                size="sm"
                className="shrink-0 gap-1.5"
                disabled={reconScope.isLoading || (reconScope.data?.variantCount ?? 0) === 0}
                onClick={createReconciliationStocktake}
              >
                <ClipboardCheck aria-hidden className="size-4" /> أنشئ جرد تحقّق
                {(reconScope.data?.variantCount ?? 0) > 0 ? ` (${reconScope.data!.variantCount} صنف)` : ""}
              </Button>
            )}
          </div>

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
