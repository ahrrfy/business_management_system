import React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { AppSelect } from "@/components/ui/AppSelect";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import {
  PRODUCT_RELATION_LABELS,
  type ProductRelationType,
} from "@shared/terms";
import { Check, GripVertical, Plus, Trash2 } from "lucide-react";
import {
  useRelatedProductsEditor,
  validRelationOrder,
} from "./related-products/useRelatedProductsEditor";

export function ProductRelatedProductsEditor({
  productId,
}: {
  productId: number;
}) {
  return <RelatedProductsSession key={productId} productId={productId} />;
}

function RelatedProductsSession({ productId }: { productId: number }) {
  const model = useRelatedProductsEditor(productId);
  const idPrefix = React.useId();
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <GripVertical className="size-4 text-primary" aria-hidden /> «أكمل
          تجهيزك» في السلة
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          اربط المنتجات المكملة يدوياً. يعرض المتجر المتاح منها فقط، دون تغيير
          السعر أو المخزون تلقائياً.
        </p>
      </CardHeader>
      <CardContent className="min-w-0 space-y-3">
        {!model.canRead ? (
          <p role="alert" className="text-sm">
            لا تملك صلاحية عرض العلاقات.
          </p>
        ) : (
          <>
            {model.relationsQ.isLoading && (
              <p role="status" className="text-sm">
                جارٍ تحميل العلاقات…
              </p>
            )}
            {model.relationsQ.isError && (
              <div
                role="alert"
                className="flex flex-wrap items-center gap-2 text-sm text-destructive"
              >
                تعذر تحميل العلاقات.{" "}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => model.relationsQ.refetch()}
                >
                  إعادة المحاولة
                </Button>
              </div>
            )}
            <UnifiedSearchInput
              value={model.query}
              onChange={model.setQuery}
              disabled={
                !model.editable ||
                !model.canSearch ||
                model.relations.length >= 30
              }
              maxLength={120}
              placeholder="ابحث باسم المنتج أو SKU أو امسح الباركود… (F2)"
              aria-label="بحث عن منتج مكمل"
              debounceMs={200}
              barcode={true}
              size="default"
            />
            {model.query.trim() && model.canSearch && (
              <div className="max-h-48 overflow-y-auto rounded-md border bg-card">
                {model.searchQ.isError ? (
                  <div role="alert" className="p-3 text-xs">
                    تعذر البحث.{" "}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => model.searchQ.refetch()}
                    >
                      إعادة المحاولة
                    </Button>
                  </div>
                ) : model.searchQ.isLoading || model.searchQ.isFetching ? (
                  <p
                    role="status"
                    className="p-3 text-xs text-muted-foreground"
                  >
                    جارٍ البحث…
                  </p>
                ) : model.results.length ? (
                  model.results.map((item) => (
                    <button
                      key={item.productId}
                      type="button"
                      disabled={!model.editable}
                      onClick={() => model.add(item)}
                      className="flex w-full min-w-0 items-center justify-between gap-2 border-b px-3 py-2 text-start text-xs last:border-0 hover:bg-muted"
                    >
                      <span className="min-w-0 break-words">
                        <b>{item.productName}</b>
                        <span className="ms-2 text-muted-foreground">
                          {item.sku}
                        </span>
                      </span>
                      <Plus
                        className="size-4 shrink-0 text-primary"
                        aria-hidden
                      />
                    </button>
                  ))
                ) : (
                  <p className="p-3 text-xs text-muted-foreground">
                    لا توجد منتجات مؤهلة جديدة.
                  </p>
                )}
              </div>
            )}
            {model.relations.length ? (
              <div className="space-y-2">
                {model.relations.map((relation, index) => (
                  <div
                    key={relation.relatedProductId}
                    className="grid min-w-0 gap-2 rounded-md border p-2 sm:grid-cols-[minmax(0,1fr)_10rem_4rem_auto] sm:items-center"
                  >
                    <div className="flex min-w-0 items-center gap-2 text-sm">
                      <span className="text-muted-foreground">{index + 1}</span>
                      <span className="min-w-0 break-words font-medium">
                        {relation.productName}
                      </span>
                    </div>
                    <div className="min-w-0 space-y-1">
                      <Label
                        htmlFor={`${idPrefix}-type-${relation.relatedProductId}`}
                        className="text-xs"
                      >
                        نوع العلاقة
                      </Label>
                      <AppSelect
                        id={`${idPrefix}-type-${relation.relatedProductId}`}
                        value={relation.relationType}
                        onValueChange={(value) =>
                          model.update((rows) =>
                            rows.map((row) =>
                              row.relatedProductId === relation.relatedProductId
                                ? {
                                    ...row,
                                    relationType: value as ProductRelationType,
                                  }
                                : row,
                            ),
                          )
                        }
                        disabled={!model.editable}
                        aria-label={`نوع العلاقة ${relation.productName}`}
                        className="h-9 w-full min-w-0 text-xs"
                      >
                        {Object.entries(PRODUCT_RELATION_LABELS).map(
                          ([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ),
                        )}
                      </AppSelect>
                    </div>
                    <div className="min-w-0 space-y-1">
                      <Label
                        htmlFor={`${idPrefix}-order-${relation.relatedProductId}`}
                        className="text-xs"
                      >
                        الترتيب
                      </Label>
                      <Input
                        id={`${idPrefix}-order-${relation.relatedProductId}`}
                        type="number"
                        min={0}
                        max={999}
                        step={1}
                        value={relation.sortOrder}
                        disabled={!model.editable}
                        aria-invalid={!validRelationOrder(relation.sortOrder)}
                        onChange={(event) =>
                          model.update((rows) =>
                            rows.map((row) =>
                              row.relatedProductId === relation.relatedProductId
                                ? {
                                    ...row,
                                    sortOrder: Number(event.target.value) || 0,
                                  }
                                : row,
                            ),
                          )
                        }
                        className="h-9 text-xs"
                        aria-label={`ترتيب ${relation.productName}`}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={!model.editable}
                      onClick={() =>
                        model.update((rows) =>
                          rows.filter(
                            (row) =>
                              row.relatedProductId !==
                              relation.relatedProductId,
                          ),
                        )
                      }
                      aria-label={`حذف علاقة ${relation.productName}`}
                    >
                      <Trash2 className="size-4 text-destructive" aria-hidden />
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              !model.relationsQ.isLoading &&
              !model.relationsQ.isError && (
                <div className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
                  لم تتم إضافة علاقات يدوية بعد. سيستخدم المتجر بدائل محدودة من
                  الفئة نفسها.
                </div>
              )
            )}
            {model.relations.length >= 30 && (
              <p className="text-xs text-muted-foreground">
                وصلت إلى حد العلاقات: 30 منتجاً.
              </p>
            )}
            {!model.valid && (
              <p role="alert" className="text-xs text-destructive">
                الترتيب عدد صحيح بين 0 و999، والحد الأقصى 30 علاقة.
              </p>
            )}
          </>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[11px] text-muted-foreground">
            تظهر التوصيات في السلة بعنوان «أكمل تجهيزك» وبحد أقصى 4 منتجات
            متاحة.
          </p>
          <Button
            type="button"
            size="sm"
            onClick={model.save}
            disabled={!model.editable || !model.valid}
          >
            {model.saving ? (
              "جارٍ الحفظ…"
            ) : (
              <>
                <Check className="size-4" aria-hidden /> حفظ العلاقات
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
