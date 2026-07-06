// بند 12ب (٧/٧): التسعير التعاقدي الخاص بعميل (عقود الدوائر الحكومية) — شاشة إدارة بمدير.
// منتقي عميل → جدول أسعاره التعاقدية (نشطة/معطَّلة) → إضافة سطر: بحث منتج (وحدة قياس محدَّدة
// من نتيجة البحث نفسها — كل صف نتيجة = متغيّر×وحدة) ثم سعر MoneyInput. السعر التعاقدي النشط
// يتقدّم على سعر الفئة في POS وفي فرض الخادم معاً (resolveContractPrices واحدة للنقطتين).
import { useState } from "react";
import { FileSignature, Plus, X } from "lucide-react";
import CustomerPicker from "@/components/CustomerPicker";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, TableEmptyRow } from "@/components/PageState";
import { RowActions } from "@/components/list";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { MoneyInput } from "@/components/form/MoneyInput";
import { ProductSearchBar } from "@/components/invoice/ProductSearchBar";
import type { InvoiceLine, PriceTier } from "@/components/invoice/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { confirm } from "@/lib/confirm";
import { notify } from "@/lib/notify";
import { trpc, type RouterOutputs } from "@/lib/trpc";

type ContractRow = RouterOutputs["customers"]["contractPricesList"][number];

const TIER_LABEL: Record<PriceTier, string> = { RETAIL: "مفرد", WHOLESALE: "جملة", GOVERNMENT: "حكومي" };

const fmtMoney = (v: string) =>
  Number(v).toLocaleString("ar-IQ-u-nu-latn", { maximumFractionDigits: 2 });

function variantLabel(r: ContractRow): string {
  const extras = [r.variantName, r.color, r.size].filter(Boolean).join(" / ");
  return extras ? `${r.productName} — ${extras}` : r.productName;
}

export default function ContractPrices() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const branchId = me.data?.branchId ?? 1;

  const [customerId, setCustomerId] = useState<number | null>(null);
  const customer = trpc.customers.get.useQuery(
    { customerId: customerId ?? 0 },
    { enabled: customerId != null, staleTime: 60_000 },
  );
  const tier = (customer.data?.defaultPriceTier ?? "RETAIL") as PriceTier;

  const list = trpc.customers.contractPricesList.useQuery(
    { customerId: customerId ?? 0 },
    { enabled: customerId != null },
  );
  const rows = list.data ?? [];

  // ── سطر الإضافة: وحدة مختارة من البحث + سعر تعاقدي + ملاحظة ──────────────────
  const [picked, setPicked] = useState<InvoiceLine | null>(null);
  const [price, setPrice] = useState("");
  const [note, setNote] = useState("");

  function resetForm() {
    setPicked(null);
    setPrice("");
    setNote("");
  }

  const invalidate = () => utils.customers.contractPricesList.invalidate();

  const upsert = trpc.customers.contractPriceUpsert.useMutation({
    onSuccess: (r) => {
      void invalidate();
      resetForm();
      notify.ok(r.updated ? "حُدّث السعر التعاقدي" : "أُضيف السعر التعاقدي");
    },
    onError: (e) => notify.err(e),
  });
  const setActive = trpc.customers.contractPriceSetActive.useMutation({
    onSuccess: () => void invalidate(),
    onError: (e) => notify.err(e),
  });
  const remove = trpc.customers.contractPriceRemove.useMutation({
    onSuccess: () => {
      void invalidate();
      notify.ok("حُذف السعر التعاقدي");
    },
    onError: (e) => notify.err(e),
  });

  function submit() {
    if (customerId == null) return notify.err("اختر عميلاً أولاً");
    if (!picked) return notify.err("اختر منتجاً (وحدة قياس) من البحث");
    if (!price || Number(price) <= 0) return notify.err("أدخل سعراً تعاقدياً أكبر من صفر");
    upsert.mutate({
      customerId,
      productUnitId: picked.productUnitId,
      price,
      note: note.trim() || null,
    });
  }

  async function onRemove(r: ContractRow) {
    if (
      !(await confirm({
        variant: "danger",
        title: "حذف السعر التعاقدي",
        description: `سيُحذف السعر التعاقدي لـ«${variantLabel(r)} (${r.unitName})» نهائياً ويعود العميل لسعر الفئة. متابعة؟`,
        confirmText: "حذف",
      }))
    )
      return;
    remove.mutate({ id: r.id });
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="التسعير التعاقدي"
        description="أسعار خاصة بعميل (عقود الدوائر الحكومية) تتقدّم على فئات التسعير في الكاشير والفواتير."
        icon={<FileSignature aria-hidden className="size-6" />}
      />

      <Card>
        <CardHeader className="pb-2">
          <div className="max-w-xl">
            <CustomerPicker
              customerId={customerId}
              onCustomerChange={(id) => {
                setCustomerId(id);
                resetForm();
              }}
              balance={customer.data?.currentBalance ?? null}
            />
          </div>
          {customerId != null && customer.data && (
            <p className="text-xs text-muted-foreground">
              فئة العميل الافتراضية: <span className="font-semibold">{TIER_LABEL[tier]}</span> — السعر
              التعاقدي النشط يتقدّم عليها لوحدة المنتج المحدَّدة.
            </p>
          )}
        </CardHeader>

        {customerId == null ? (
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            اختر عميلاً لعرض أسعاره التعاقدية وإدارتها.
          </CardContent>
        ) : (
          <CardContent className="space-y-4">
            {/* ── إضافة/تحديث سطر تعاقدي ── */}
            <div className="rounded-lg border bg-muted/20 p-3 space-y-3">
              <div className="text-sm font-bold">إضافة سعر تعاقدي</div>
              {picked == null ? (
                <ProductSearchBar
                  invoiceType="SALE"
                  branchId={branchId}
                  tier={tier}
                  onAddProduct={(line) => setPicked(line)}
                  onNotify={(msg, kind) => (kind === "error" ? notify.err(msg) : notify.ok(msg))}
                />
              ) : (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_12rem_1fr_auto] md:items-end">
                  <div className="space-y-1">
                    <Label className="text-xs">المنتج (وحدة القياس)</Label>
                    <div className="flex h-9 items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 text-sm">
                      <span className="truncate">
                        {picked.name} <span className="text-muted-foreground">({picked.unit})</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => setPicked(null)}
                        className="shrink-0 text-muted-foreground hover:text-destructive"
                        aria-label="إلغاء اختيار المنتج"
                      >
                        <X aria-hidden className="size-4" />
                      </button>
                    </div>
                    <p className="text-[11px] text-muted-foreground" dir="ltr">
                      {fmtMoney(picked.price || "0")} د.ع — سعر فئة {TIER_LABEL[tier]} الحالي
                    </p>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="cp-price" className="text-xs">السعر التعاقدي (د.ع) *</Label>
                    <MoneyInput id="cp-price" value={price} onChange={setPrice} placeholder="0" ariaLabel="السعر التعاقدي" />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="cp-note" className="text-xs">ملاحظة (رقم العقد مثلاً)</Label>
                    <Input id="cp-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={255} />
                  </div>
                  <Button type="button" onClick={submit} disabled={upsert.isPending}>
                    <Plus aria-hidden className="size-4" />
                    {upsert.isPending ? "جارٍ الحفظ…" : "حفظ السعر"}
                  </Button>
                </div>
              )}
              <p className="text-[11px] text-muted-foreground">
                إدخال سعر لوحدة لها سعر تعاقدي سابق يحدّثه (لا يُنشئ سطراً ثانياً) ويعيد تفعيله إن كان معطَّلاً.
              </p>
            </div>

            {/* ── جدول الأسعار التعاقدية ── */}
            {list.isLoading ? (
              <LoadingState />
            ) : (
              <ScrollTableShell>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-right">
                      <th className="px-3 py-2 font-semibold">المنتج</th>
                      <th className="px-3 py-2 font-semibold">SKU</th>
                      <th className="px-3 py-2 font-semibold">الوحدة</th>
                      <th className="px-3 py-2 font-semibold text-left">السعر التعاقدي</th>
                      <th className="px-3 py-2 font-semibold">الحالة</th>
                      <th className="px-3 py-2 font-semibold">ملاحظة</th>
                      <th className="px-3 py-2 font-semibold">إجراءات</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length === 0 && (
                      <TableEmptyRow colSpan={7} message="لا أسعار تعاقدية لهذا العميل — أضِف أول سطر أعلاه." />
                    )}
                    {rows.map((r) => (
                      <tr key={r.id} className={`border-t ${r.isActive ? "" : "opacity-60"}`}>
                        <td className="px-3 py-2">{variantLabel(r)}</td>
                        <td className="px-3 py-2 text-muted-foreground" dir="ltr">{r.sku}</td>
                        <td className="px-3 py-2">{r.unitName}</td>
                        <td className="px-3 py-2 text-left font-bold" dir="ltr">{fmtMoney(r.price)}</td>
                        <td className="px-3 py-2">
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs ${
                              r.isActive ? "bg-emerald-100 text-emerald-700" : "bg-muted text-muted-foreground"
                            }`}
                          >
                            {r.isActive ? "نشط" : "معطَّل"}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{r.note ?? "—"}</td>
                        <td className="px-3 py-2">
                          <RowActions
                            actions={[
                              {
                                key: "toggle",
                                label: r.isActive ? "تعطيل" : "تفعيل",
                                onSelect: () => setActive.mutate({ id: r.id, isActive: !r.isActive }),
                              },
                              { key: "remove", label: "حذف", variant: "destructive", onSelect: () => void onRemove(r) },
                            ]}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollTableShell>
            )}
          </CardContent>
        )}
      </Card>
    </div>
  );
}
