import { CopyInline } from "@/components/CopyButton";
import { AppSelect } from "@/components/ui/AppSelect";
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
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import type { PermissionMap } from "@shared/permissions";
import { Link2, Loader2, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { canManageStudioBarcodeAliases, linkStudioBarcodeAlias } from "./studioUnknownBarcode";

type Props = {
  barcode: string;
  error: string;
  linkAllowed: boolean;
  activeProduct?: { id: number; name: string };
  onLinked: (barcode: string) => void | Promise<void>;
};

/**
 * إغلاقٌ صريح لمسار باركود المورد المجهول في الاستوديو.
 * لا يستنتج المنتج من الرقم ولا يربط تلقائياً: المصوّر أو المدير يختار المنتج ثم المتغيّر ثم الوحدة،
 * ويرى ملخصاً نهائياً قبل استدعاء إجراء الربط المحروس بصلاحيات الاستوديو.
 */
export function StudioUnknownBarcodeResolver({ barcode, error, linkAllowed, activeProduct, onLinked }: Props) {
  const me = trpc.auth.me.useQuery();
  const canLink = canManageStudioBarcodeAliases(
    me.data?.role,
    (me.data?.permissionsOverride ?? null) as PermissionMap | null,
  );
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, 220).trim();
  const [selectedProductId, setSelectedProductId] = useState<number | null>(null);
  const [selectedProductName, setSelectedProductName] = useState("");
  const [selectedVariantId, setSelectedVariantId] = useState("");
  const [selectedUnitName, setSelectedUnitName] = useState("");
  const [actionError, setActionError] = useState("");
  const [resolvingUnit, setResolvingUnit] = useState(false);

  const productSearch = trpc.productStudio.products.useQuery(
    { search: debouncedSearch, includeInactive: false },
    { enabled: open && canLink && debouncedSearch.length >= 2 },
  );
  const productDetails = trpc.productStudio.productUnits.useQuery(
    { productId: selectedProductId ?? 0 },
    { enabled: open && canLink && selectedProductId != null },
  );
  const addAlias = trpc.productStudio.linkBarcode.useMutation();

  const variants = useMemo(
    () => (productDetails.data?.variants ?? []).filter((variant) => variant.isActive),
    [productDetails.data?.variants],
  );
  const selectedVariant = variants.find((variant) => String(variant.id) === selectedVariantId) ?? null;
  const units = productDetails.data?.unitTemplate ?? [];
  const selectedUnitPrimaryBarcode = selectedVariant && selectedUnitName
    ? selectedVariant.unitBarcodes[selectedUnitName] ?? ""
    : "";
  const ready = selectedProductId != null
    && selectedVariant != null
    && units.some((unit) => unit.unitName === selectedUnitName);
  const busy = resolvingUnit || addAlias.isPending;

  function resetDialog() {
    setOpen(false);
    setSearch("");
    setSelectedProductId(null);
    setSelectedProductName("");
    setSelectedVariantId("");
    setSelectedUnitName("");
    setActionError("");
  }

  function chooseProduct(productId: number, productName: string) {
    setSelectedProductId(productId);
    setSelectedProductName(productName);
    setSelectedVariantId("");
    setSelectedUnitName("");
    setActionError("");
  }

  async function linkBarcode() {
    if (!ready || !selectedVariantId || !selectedUnitName || !canLink) return;
    setActionError("");
    setResolvingUnit(true);
    try {
      const productUnitId = await linkStudioBarcodeAlias(
        {
          authorized: canLink,
          barcode,
          variantId: Number(selectedVariantId),
          unitName: selectedUnitName,
        },
        {
          resolveProductUnitId: (input) => utils.catalog.resolveProductUnitId.fetch(input),
          addAlias: (input) => addAlias.mutateAsync(input),
        },
      );
      // فشل إعادة جلب cache بعد نجاح الكتابة لا يعني أن alias فشل؛ لا نعرض نجاحاً
      // محفوظاً كأنه تعارض ونغري المستخدم بإرسال العملية مرة ثانية.
      await Promise.allSettled([
        utils.catalog.listUnitBarcodes.invalidate({ productUnitId }),
        utils.catalog.listUnitBarcodesMany.invalidate(),
        utils.catalog.adminList.invalidate(),
        utils.productStudio.products.invalidate(),
      ]);
      notify.ok(`رُبط الباركود بوحدة «${selectedUnitName}» في «${selectedProductName}»`);
      resetDialog();
      await onLinked(barcode);
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : "تعذّر ربط الباركود. راجع الاختيار ثم أعد المحاولة.");
    } finally {
      setResolvingUnit(false);
    }
  }

  return (
    <div className="space-y-2 rounded-md border border-destructive/35 bg-destructive/5 p-3">
      <p className="text-xs text-destructive" role="alert">{error}</p>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">القيمة المقروءة:</span>
        <span dir="ltr" className="whitespace-pre-wrap rounded border bg-background px-2 py-1 font-mono text-foreground">{barcode}</span>
        <CopyInline value={barcode} successMessage="نُسخ الباركود" />
      </div>
      {linkAllowed && canLink && (
        <div className="flex flex-wrap items-center gap-2">
          {activeProduct && (
            <Button
              type="button"
              size="sm"
              variant="default"
              onClick={() => {
                chooseProduct(activeProduct.id, activeProduct.name);
                setOpen(true);
              }}
            >
              <Link2 aria-hidden className="size-4" /> ربط بـ «{activeProduct.name}»
            </Button>
          )}
          <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
            <Link2 aria-hidden className="size-4" /> {activeProduct ? "ربط بمنتج آخر…" : "ربط الباركود بمنتج"}
          </Button>
        </div>
      )}
      {linkAllowed && !me.isLoading && !canLink && (
        <p className="text-xs text-muted-foreground">ربط باركود جديد يتطلب صلاحية استوديو المنتجات أو تعديل المنتجات.</p>
      )}

      <Dialog open={open} onOpenChange={(next) => { if (next) setOpen(true); else resetDialog(); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>ربط باركود مورد بمنتج</DialogTitle>
            <DialogDescription>
              اختر المنتج والمتغيّر والوحدة صراحةً. لن يُحفظ أي ربط قبل الضغط على زر التأكيد.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="rounded-md border bg-muted/20 p-3 text-sm">
              <span className="text-muted-foreground">الباركود المراد ربطه: </span>
              <span dir="ltr" className="whitespace-pre-wrap font-mono font-semibold">{barcode}</span>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="studio-unknown-product-search">ابحث باسم المنتج أو SKU</Label>
              <div className="relative">
                <Input
                  id="studio-unknown-product-search"
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setActionError("");
                  }}
                  autoComplete="off"
                  placeholder="اكتب اسم المنتج لتحديده"
                />
                <Search aria-hidden className="pointer-events-none absolute end-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              </div>
              {debouncedSearch.length >= 2 && (
                <div className="max-h-44 overflow-auto rounded-md border" role="listbox" aria-label="نتائج المنتجات">
                  {productSearch.isFetching && (
                    <p className="flex items-center justify-center gap-2 p-3 text-xs text-muted-foreground"><Loader2 aria-hidden className="size-4 animate-spin" /> جارٍ البحث…</p>
                  )}
                  {productSearch.isError && (
                    <p className="p-3 text-xs text-destructive">تعذّر بحث المنتجات: {productSearch.error.message}</p>
                  )}
                  {!productSearch.isFetching && !productSearch.isError && (productSearch.data?.rows.length ?? 0) === 0 && (
                    <p className="p-3 text-center text-xs text-muted-foreground">لا توجد منتجات مطابقة.</p>
                  )}
                  {(productSearch.data?.rows ?? []).map((product) => (
                    <button
                      key={product.productId}
                      type="button"
                      role="option"
                      aria-selected={selectedProductId === Number(product.productId)}
                      className="block w-full border-b px-3 py-2 text-start text-sm last:border-b-0 hover:bg-accent"
                      onClick={() => chooseProduct(Number(product.productId), product.productName)}
                    >
                      <span className="font-medium">{product.productName}</span>
                      <span dir="ltr" className="ms-2 font-mono text-xs text-muted-foreground">#{product.productId}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {selectedProductId != null && (
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-sm font-medium">المنتج المختار: {selectedProductName}</p>
                {productDetails.isLoading ? (
                  <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 aria-hidden className="size-4 animate-spin" /> جارٍ تحميل المتغيّرات والوحدات…</p>
                ) : productDetails.isError ? (
                  <div className="flex flex-wrap items-center gap-2 text-xs text-destructive">
                    <span>تعذّر تحميل تفاصيل المنتج: {productDetails.error.message}</span>
                    <Button type="button" size="sm" variant="outline" onClick={() => void productDetails.refetch()}>إعادة المحاولة</Button>
                  </div>
                ) : productDetails.data == null ? (
                  <p className="text-xs text-destructive">المنتج غير موجود أو لم يعد متاحاً للتعديل.</p>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="studio-unknown-variant">المتغيّر</Label>
                      <AppSelect
                        id="studio-unknown-variant"
                        value={selectedVariantId}
                        onValueChange={(value) => {
                          setSelectedVariantId(value);
                          setSelectedUnitName("");
                          setActionError("");
                        }}
                      >
                        <option value="">اختر المتغيّر…</option>
                        {variants.map((variant) => (
                          <option key={variant.id} value={String(variant.id)}>
                            {[variant.variantName, variant.color, variant.size, variant.sku].filter(Boolean).join(" / ") || `متغيّر #${variant.id}`}
                          </option>
                        ))}
                      </AppSelect>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="studio-unknown-unit">الوحدة</Label>
                      <AppSelect
                        id="studio-unknown-unit"
                        value={selectedUnitName}
                        onValueChange={(value) => {
                          setSelectedUnitName(value);
                          setActionError("");
                        }}
                        disabled={!selectedVariantId}
                      >
                        <option value="">اختر الوحدة…</option>
                        {units.map((unit) => (
                          <option key={unit.unitName} value={unit.unitName}>{unit.unitName}</option>
                        ))}
                      </AppSelect>
                    </div>
                  </div>
                )}
              </div>
            )}

            {ready && selectedVariant && (
              <div className="space-y-1 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-3 text-xs">
                <p className="font-medium">راجع الربط قبل الحفظ</p>
                <p>المنتج: {selectedProductName}</p>
                <p>المتغيّر: {[selectedVariant.variantName, selectedVariant.color, selectedVariant.size, selectedVariant.sku].filter(Boolean).join(" / ")}</p>
                <p>الوحدة: {selectedUnitName}</p>
                <p>باركودها الأساسي: <span dir="ltr" className="whitespace-pre-wrap font-mono">{selectedUnitPrimaryBarcode || "—"}</span></p>
                <p>البديل الجديد: <span dir="ltr" className="whitespace-pre-wrap font-mono font-semibold">{barcode}</span></p>
              </div>
            )}
            {actionError && <p className="text-sm text-destructive" role="alert">{actionError}</p>}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={resetDialog}>إلغاء</Button>
            <Button type="button" disabled={!ready || busy} onClick={() => void linkBarcode()}>
              {busy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Link2 aria-hidden className="size-4" />}
              {busy ? "جارٍ الربط…" : "تأكيد ربط الباركود"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
