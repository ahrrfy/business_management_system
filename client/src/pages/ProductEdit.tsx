import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useParams } from "wouter";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState } from "@/components/PageState";
import { RecordForm } from "@/components/form/RecordForm";
import { ProductFormFields, type ProductModelPatch } from "@/components/form/product/ProductFormFields";
import {
  allBarcodes,
  buildUpdateProductPayload,
  emptyProductFormModel,
  productFormModelFromDocument,
  productFormSignature,
  validateProductForm,
  type ProductFormModel,
} from "@/components/form/product/productFormModel";
import SimpleProductEditForm from "@/components/product/SimpleProductEditForm";
import { BarcodeAliasDialog } from "@/components/product/BarcodeAliasDialog";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { exportRows } from "@/lib/export";
import { confirm } from "@/lib/confirm";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import {
  findForeignBarcodeUsages,
  findTakenEditableBarcodeCodes,
  type EditableBarcodeField,
  type StoredBarcodeUsage,
} from "@/lib/productBarcodeOwnership";

/**
 * تعديل منتج بنموذج المتغيّرات (م٦ ق٤ / D5):
 * يعتمد على المكوّن الموحّد ProductFormFields ونموذج ProductFormModel المشترك مع ProductNew،
 * مع RecordForm لإدارة اختصارات الحفظ وحارس المغادرة، وSimpleProductEditForm للمنتجات البسيطة.
 */
export default function ProductEdit() {
  const params = useParams<{ id: string }>();
  const productId = Number(params.id);
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const branchesQ = trpc.branches.list.useQuery();
  const categoriesQ = trpc.catalog.categories.useQuery();
  const product = trpc.catalog.getForVariantEdit.useQuery(
    { productId },
    { enabled: Number.isFinite(productId) && productId > 0 },
  );

  const [advanced, setAdvanced] = useState(false);
  const [model, setModel] = useState<ProductFormModel>(() => emptyProductFormModel());
  const patch = (p: ProductModelPatch) => setModel((m) => ({ ...m, ...(typeof p === "function" ? p(m) : p) }));
  const modelRef = useRef(model);
  modelRef.current = model;

  const originalBarcodeCodes = useRef(new Map<string, string | null>());
  const [savedSignature, setSavedSignature] = useState<string>("");
  const isDirty = savedSignature ? productFormSignature(model) !== savedSignature : false;
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!product.data || hydrated) return;
    const initial = productFormModelFromDocument(product.data);
    setModel(initial);
    setSavedSignature(productFormSignature(initial));

    const initialCodes = new Map<string, string | null>();
    for (const v of product.data.variants) {
      for (const u of initial.units) {
        initialCodes.set(`${v.id}:${u.id}`, v.unitBarcodes[u.name] || null);
        initialCodes.set(`db:${v.id}:${u.id}`, v.unitBarcodes[u.name] || null);
      }
    }
    originalBarcodeCodes.current = initialCodes;
    setHydrated(true);
  }, [product.data, hydrated]);

  const branches = useMemo(() => (branchesQ.data ?? []).map((b) => ({ id: Number(b.id), name: b.name })), [branchesQ.data]);
  const myBranch = me.data?.branchId ?? 1;
  const [pickedBranch, setPickedBranch] = useState<number | null>(null);
  const branchId = pickedBranch ?? branches[0]?.id ?? myBranch;

  const [aliasDialog, setAliasDialog] = useState<{ variantId: number; unitName: string; label: string } | null>(null);

  // فحص تكرار الباركود ضدّ القاعدة (live)
  const barcodeFields = useMemo<EditableBarcodeField[]>(() => {
    const fields: EditableBarcodeField[] = [];
    for (const v of model.variants) {
      for (const u of model.units) {
        const code = (v.unitBarcodes[u.id] || "").trim();
        if (!code) continue;
        const fieldKey = `${v.id}:${u.id}`;
        fields.push({ fieldKey, code });
      }
    }
    return fields;
  }, [model.variants, model.units]);

  const allCodes = useMemo(() => Array.from(new Set(barcodeFields.map((field) => field.code))), [barcodeFields]);
  const debouncedKey = useDebouncedValue(allCodes.join("\n"), 450);
  const debouncedCodes = useMemo(() => (debouncedKey ? debouncedKey.split("\n") : []), [debouncedKey]);
  const checkQ = trpc.catalog.checkBarcodes.useQuery(
    { codes: debouncedCodes },
    { enabled: debouncedCodes.length > 0, staleTime: 10_000 },
  );
  const takenInDb = useMemo(
    () => findTakenEditableBarcodeCodes(checkQ.data ?? [], barcodeFields, originalBarcodeCodes.current),
    [checkQ.data, barcodeFields],
  );

  const facts = useMemo(() => {
    if (!product.data) return undefined;
    const totalStock = product.data.variants.reduce((acc, v) => {
      const variantTotal = Object.values(v.stockByBranch ?? {}).reduce((sum, q) => sum + (Number(q) || 0), 0);
      return acc + variantTotal;
    }, 0);
    return {
      isBundle: Boolean(product.data.isBundle),
      isConsignment: Boolean(product.data.isConsignment),
      bundleVariantId: product.data.variants?.[0]?.id ?? null,
      totalStock,
    };
  }, [product.data]);

  const update = trpc.catalog.updateProductVariants.useMutation({
    onSuccess: (res) => {
      const aliasWarnings = (res as { aliasWarnings?: string[] }).aliasWarnings ?? [];
      if (aliasWarnings.length) notify.warn(`تنبيه بدائل الباركود: ${aliasWarnings.join(" — ")}`);
    },
  });

  const blockedBy = useMemo(() => validateProductForm(model), [model]);

  async function save(): Promise<unknown> {
    if (allCodes.length) {
      let usages: StoredBarcodeUsage[] = [];
      try {
        usages = await utils.catalog.checkBarcodes.fetch({ codes: allCodes });
      } catch {
        // فشل الفحص المسبق لا يمنع الحفظ — قيد UNIQUE في القاعدة يبقى الحارس الأخير.
      }
      const taken = findForeignBarcodeUsages(usages, barcodeFields, originalBarcodeCodes.current);
      if (taken.length) {
        throw new Error(`الباركود ${taken[0].code} مُستخدَم في «${taken[0].takenBy}». غيّره قبل الحفظ.`);
      }
    }
    const submitted = productFormSignature(model);
    const res = await update.mutateAsync(buildUpdateProductPayload(model, productId));
    setSavedSignature(submitted);
    await Promise.all([
      utils.catalog.posList.invalidate(),
      utils.catalog.adminList.invalidate(),
      utils.catalog.getForVariantEdit.invalidate({ productId }),
    ]);
    return res;
  }

  async function saveAndClose() {
    const res = await save();
    navigate("/products");
    return res;
  }

  function exportExcel() {
    exportRows(model.variants, {
      filename: `منتج-${model.productName || "بمتغيرات"}`,
      sheetName: "المنتجات",
      columns: [
        { key: "name", header: "الاسم الكامل", map: (v) => [model.productName, v.color, v.size].filter(Boolean).join(" ") },
        { key: "color", header: "اللون", map: (v) => v.color },
        { key: "size", header: "القياس", map: (v) => v.size },
        { key: "sku", header: "SKU", map: (v) => v.sku },
      ],
    });
  }

  if (product.isLoading) return <LoadingState />;
  if (product.isError) return <div className="p-10 text-center text-destructive">تعذّر تحميل المنتج: {product.error.message}</div>;
  if (!product.data) return <div className="p-10 text-center text-muted-foreground">المنتج غير موجود.</div>;

  const isSimple =
    product.data.variants.length === 1 &&
    !product.data.variants[0].color &&
    !product.data.variants[0].size &&
    !product.data.isService;

  if (isSimple && !advanced) {
    return (
      <SimpleProductEditForm
        productId={productId}
        onAdvanced={() => {
          setHydrated(false);
          setAdvanced(true);
        }}
      />
    );
  }

  return (
    <div className="max-w-6xl mx-auto space-y-4 pb-28">
      <PageHeader
        title="تعديل منتج بمتغيّرات"
        breadcrumbs={[{ label: "المنتجات", href: "/products" }, { label: "تعديل المنتج" }]}
        backHref="/products"
        backLabel="رجوع للمنتجات"
        actions={
          isSimple ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={async () => {
                const ok = await confirm({
                  title: "التحويل إلى نموذج المتغيّرات المتقدّم",
                  description: "النموذج المتقدّم يسمح بإضافة ألوان/قياسات وقوالب وحدات متعددة وصور إضافية. هل تريد المتابعة؟",
                  confirmText: "نعم، افتح المتقدّم",
                });
                if (ok) {
                  setHydrated(false);
                  setAdvanced(true);
                }
              }}
            >
              النموذج المتقدّم
            </Button>
          ) : (
            <Button type="button" variant="outline" size="sm" onClick={exportExcel}>
              تصدير المتغيّرات (Excel)
            </Button>
          )
        }
      />

      <RecordForm
        mode="edit"
        isDirty={isDirty}
        blockedBy={blockedBy}
        onSave={save}
        onSaveAndClose={saveAndClose}
        onCancel={() => navigate("/products")}
        isPending={update.isPending}
        savedMessage="تم حفظ التعديلات بنجاح"
      >
        <ProductFormFields
          mode="edit"
          model={model}
          onChange={patch}
          productId={productId}
          facts={facts}
          branches={branches}
          branchId={branchId}
          onBranchChange={setPickedBranch}
          categories={categoriesQ.data ?? []}
          takenInDb={takenInDb}
          onOpenAliasDialog={setAliasDialog}
        />
      </RecordForm>

      {aliasDialog && (
        <BarcodeAliasDialog
          variantId={aliasDialog.variantId}
          unitName={aliasDialog.unitName}
          label={aliasDialog.label}
          onClose={() => setAliasDialog(null)}
        />
      )}
    </div>
  );
}
