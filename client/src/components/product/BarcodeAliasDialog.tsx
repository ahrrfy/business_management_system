/**
 * حوار إدارة بدائل الباركود لوحدةٍ واحدة — يحلّ (variantId + unitName) إلى productUnitId عبر
 * `resolveProductUnitId` ثمّ يقرأ/يكتب مباشرةً عبر `listUnitBarcodes`/`addUnitBarcodeAlias`/
 * `removeUnitBarcodeAlias` (نفس الإجراءات المستقلّة القائمة أصلاً في catalogRouter.ts — تفحص
 * التفرّد وتكتب فوراً، ذرّيّةٌ بذاتها). مستقلٌّ تماماً عن نموذج التعديل الرئيسيّ وزرّ حفظه.
 *
 * (م٦: كان مكوّناً مساعداً داخل `pages/ProductEdit.tsx`؛ نُقل حرفياً كي تصغر الصفحة.)
 */
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { ACTION_LABELS } from "@shared/actionLabels";

export function BarcodeAliasDialog({
  variantId, unitName, label, onClose,
}: { variantId: number; unitName: string; label: string; onClose: () => void }) {
  const utils = trpc.useUtils();
  const unitIdQ = trpc.catalog.resolveProductUnitId.useQuery({ variantId, unitName }, { enabled: variantId > 0 });
  const productUnitId = unitIdQ.data ?? null;
  const listQ = trpc.catalog.listUnitBarcodes.useQuery(
    { productUnitId: productUnitId ?? 0 },
    { enabled: productUnitId != null },
  );
  const [code, setCode] = useState("");
  const [note, setNote] = useState("");
  const add = trpc.catalog.addUnitBarcodeAlias.useMutation({
    onSuccess: () => { setCode(""); setNote(""); void listQ.refetch(); void utils.catalog.listUnitBarcodesMany.invalidate(); notify.ok("أُضيف الباركود البديل"); },
    onError: (e) => notify.err(e),
  });
  const remove = trpc.catalog.removeUnitBarcodeAlias.useMutation({
    onSuccess: () => { void listQ.refetch(); void utils.catalog.listUnitBarcodesMany.invalidate(); },
    onError: (e) => notify.err(e),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>بدائل الباركود — {label}</DialogTitle>
          <DialogDescription>باركودات إضافية تُشير لنفس السلعة/الوحدة (نفس السعر والمخزون). تُحفظ فوراً بلا حاجة لزرّ «حفظ التعديلات».</DialogDescription>
        </DialogHeader>
        {productUnitId == null ? (
          // `productUnitId = unitIdQ.data ?? null` ⇒ هذا الفرع يغطّي انتظارَ الاستعلام **وفشلَه**
          // معاً، فالنصّ يبقى معروضاً أبداً إن تعذّر حلّ الوحدة. بابٌ مسدود **قائمٌ قبل التوحيد**
          // (كان يقول «جارٍ التحديد…» ويبقى كذلك) — يلزمه حالةُ خطأ صريحة في شريحةٍ لاحقة.
          <p className="text-sm text-muted-foreground">{ACTION_LABELS.loading}</p>
        ) : (
          <div className="space-y-3">
            <div className="text-xs text-muted-foreground">
              الباركود الأساسيّ: <span className="font-mono" dir="ltr">{listQ.data?.primary ?? "—"}</span>
            </div>
            <div className="space-y-1.5">
              {listQ.isLoading ? (
                <p className="text-xs text-muted-foreground">{ACTION_LABELS.loading}</p>
              ) : (listQ.data?.aliases ?? []).length === 0 ? (
                <p className="text-xs text-muted-foreground">لا بدائل بعد.</p>
              ) : (
                (listQ.data?.aliases ?? []).map((a) => (
                  <div key={a.id} className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-sm">
                    <span className="font-mono" dir="ltr">{a.barcode}</span>
                    <span className="flex-1 truncate text-xs text-muted-foreground">{a.note ?? ""}</span>
                    <Button type="button" size="sm" variant="ghost" className="text-destructive" disabled={remove.isPending} onClick={() => remove.mutate({ id: a.id })}>
                      حذف
                    </Button>
                  </div>
                ))
              )}
            </div>
            <div className="flex items-end gap-2">
              <div className="flex-1 space-y-1">
                <Label>باركود بديل جديد</Label>
                <Input value={code} onChange={(e) => setCode(e.target.value)} dir="ltr" placeholder="مثال: 6212442744532" />
              </div>
              <div className="flex-1 space-y-1">
                <Label>ملاحظة (اختياري)</Label>
                <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="مثال: باركود المصنّع القديم" />
              </div>
              <Button
                type="button"
                disabled={!code.trim() || add.isPending}
                onClick={() => productUnitId && add.mutate({ productUnitId, barcode: code.trim(), note: note.trim() || undefined })}
              >
                {add.isPending ? "جارٍ الإضافة…" : "إضافة"}
              </Button>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>إغلاق</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
