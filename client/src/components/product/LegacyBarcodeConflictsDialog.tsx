import { AlertTriangle, CheckCircle2, ExternalLink, RefreshCw } from "lucide-react";
import { Link } from "wouter";
import { ACTION_LABELS } from "@shared/actionLabels";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";

export function LegacyBarcodeConflictsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const conflictsQ = trpc.catalog.legacyBarcodeConflicts.useQuery(undefined, {
    enabled: open,
  });
  const conflicts = conflictsQ.data ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-[var(--sem-warn)]" aria-hidden />
            <span>مراجعة تعارضات الباركود الإرثية بعد التطبيع</span>
          </DialogTitle>
          <DialogDescription>
            يعرض هذا الفحص القراءي أيّ باركودات تاريخية تتصادم بعد التطبيع المعياري (مثل تكافؤ UPC-A مع EAN-13 أو الفروقات الشكلية) بين أكثر من وحدة منتج، لتصحيحها من شاشة تعديل الصنف دون كسر العمليات القائمة.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-2.5 overflow-y-auto py-1">
          {conflictsQ.isLoading ? (
            <div className="rounded-md border px-3 py-6 text-center text-sm text-muted-foreground">
              {ACTION_LABELS.loading}
            </div>
          ) : conflictsQ.isError ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-3 text-sm text-destructive">
              {conflictsQ.error.message}
            </div>
          ) : conflicts.length === 0 ? (
            <div className="flex items-center gap-2 rounded-md border border-[var(--sem-pos)]/30 bg-[var(--sem-pos-bg)] px-3 py-3 text-sm text-[var(--sem-pos)]">
              <CheckCircle2 className="size-4 shrink-0" aria-hidden />
              <span>لا توجد أيّ تعارضات باركود إرثية في الكتالوج حالياً.</span>
            </div>
          ) : (
            conflicts.map((conflict) => (
              <div
                key={conflict.normalizedKey}
                className="space-y-2 rounded-md border border-[var(--sem-warn)]/35 bg-[var(--sem-warn-bg)]/40 p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="font-semibold text-foreground">
                    الهوية المطبّعة:{" "}
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono">
                      {conflict.normalizedKey}
                    </code>
                  </span>
                  <span className="text-muted-foreground">
                    {conflict.owners.length.toLocaleString("ar-IQ-u-nu-latn")} وحدات متشابكة
                  </span>
                </div>
                <div className="divide-y rounded border bg-background">
                  {conflict.owners.map((owner) => (
                    <div
                      key={`${owner.productUnitId}:${owner.source}:${owner.barcode}`}
                      className="flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5 text-xs"
                    >
                      <div className="space-y-0.5">
                        <div className="font-medium text-foreground">
                          {owner.productName}
                          {owner.sku ? ` — ${owner.sku}` : ""} ({owner.unitName})
                        </div>
                        <div className="text-muted-foreground">
                          الباركود المسجّل:{" "}
                          <span className="font-mono">{owner.barcode}</span> ·{" "}
                          {owner.source === "PRIMARY" ? "أساسي" : "بديل"}
                        </div>
                      </div>
                      <Button asChild variant="outline" size="sm" className="h-7 px-2 text-xs">
                        <Link href={`/products/${owner.productId}/edit`}>
                          <span>فتح الصنف</span>
                          <ExternalLink className="ms-1 size-3" aria-hidden />
                        </Link>
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={conflictsQ.isFetching}
            onClick={() => void conflictsQ.refetch()}
          >
            <RefreshCw className="me-1 size-3.5" aria-hidden />
            <span>{conflictsQ.isFetching ? ACTION_LABELS.refreshing : ACTION_LABELS.refresh}</span>
          </Button>
          <Button type="button" size="sm" onClick={() => onOpenChange(false)}>
            إغلاق
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
