/**
 * BannerSubjectPicker — الخطوة (1) البصرية المبسّطة لتحديد مادة البنر ووجهته.
 *
 * يتيح اختيار:
 * - منتج واحد أو باقة منتجات (1–4) مباشرةً من بطاقات مصوّرة تعرض الصورة والاسم والفئة والسعر.
 * - فئة كاملة من المتجر (يسحب الذكاء تلقائياً أبرز منتجاتها وصورها).
 * - عرض ترويجي فعّال أو تخفيضات المتجر العامة.
 * - رفع تصميم خارجي جاهز مع ربطه بوجهة آمنة.
 */

import { useState } from "react";
import {
  BadgePercent,
  Check,
  FolderTree,
  Image as ImageIcon,
  Loader2,
  Package,
  Upload,
  X,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { AppSelect } from "@/components/ui/AppSelect";
import { Input } from "@/components/ui/input";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { buildSafeBannerDestinationUrl } from "@shared/imageStudio/bannerStudioContract";

export type BannerComposerMode = "PRODUCTS" | "CATEGORY" | "PROMOTION" | "UPLOAD";

export interface SelectedSubjectProduct {
  productId: number;
  name: string;
  categoryName?: string | null;
  priceText?: string | null;
  imageUrl?: string | null;
}

export interface BannerSubjectState {
  mode: BannerComposerMode;
  products: SelectedSubjectProduct[];
  categoryId: number | null;
  promotionId: number | null;
  specialTarget: "NONE" | "DEALS" | "QUOTE";
  ctaUrl: string;
}

export function inferSubjectStateFromBanner(input: {
  ctaUrl?: string | null;
  hasUploadedImages?: boolean;
}): BannerSubjectState {
  const clean = (input.ctaUrl ?? "").trim();
  const baseMode: BannerComposerMode = input.hasUploadedImages ? "UPLOAD" : "PRODUCTS";

  if (!clean) {
    return {
      mode: baseMode,
      products: [],
      categoryId: null,
      promotionId: null,
      specialTarget: "DEALS",
      ctaUrl: "/store?deals=1",
    };
  }
  const catMatch = clean.match(/^\/store\/category\/(\d+)/);
  if (catMatch) {
    const cid = Number(catMatch[1]);
    return {
      mode: input.hasUploadedImages ? "UPLOAD" : "CATEGORY",
      products: [],
      categoryId: cid,
      promotionId: null,
      specialTarget: "NONE",
      ctaUrl: clean,
    };
  }
  const prodMatch = clean.match(/^\/store\/product\/(\d+)/);
  if (prodMatch) {
    const pid = Number(prodMatch[1]);
    return {
      mode: input.hasUploadedImages ? "UPLOAD" : "PRODUCTS",
      products: [{ productId: pid, name: `منتج #${pid}` }],
      categoryId: null,
      promotionId: null,
      specialTarget: "NONE",
      ctaUrl: clean,
    };
  }
  try {
    const parsed = new URL(clean, "https://alarabiya.online");
    const promo = Number(parsed.searchParams.get("promo"));
    if (Number.isInteger(promo) && promo > 0) {
      return {
        mode: input.hasUploadedImages ? "UPLOAD" : "PROMOTION",
        products: [],
        categoryId: null,
        promotionId: promo,
        specialTarget: "NONE",
        ctaUrl: clean,
      };
    }
    const prodsParam = parsed.searchParams.get("products");
    if (prodsParam) {
      const ids = prodsParam
        .split(",")
        .map((n) => Number(n.trim()))
        .filter((n) => Number.isInteger(n) && n > 0)
        .slice(0, 5);
      if (ids.length > 0) {
        return {
          mode: input.hasUploadedImages ? "UPLOAD" : "PRODUCTS",
          products: ids.map((id) => ({ productId: id, name: `منتج #${id}` })),
          categoryId: null,
          promotionId: null,
          specialTarget: "NONE",
          ctaUrl: clean,
        };
      }
    }
    if (parsed.searchParams.get("quote") === "1") {
      return {
        mode: input.hasUploadedImages ? "UPLOAD" : "PROMOTION",
        products: [],
        categoryId: null,
        promotionId: null,
        specialTarget: "QUOTE",
        ctaUrl: "/store?quote=1",
      };
    }
  } catch {
    // ignore malformed URL
  }
  return {
    mode: baseMode,
    products: [],
    categoryId: null,
    promotionId: null,
    specialTarget: clean === "/store?deals=1" ? "DEALS" : "NONE",
    ctaUrl: clean,
  };
}

interface BannerSubjectPickerProps {
  value: BannerSubjectState;
  onChange: (next: BannerSubjectState) => void;
}

const MODE_TABS: Array<{
  id: BannerComposerMode;
  label: string;
  hint: string;
  Icon: typeof Package;
}> = [
  { id: "PRODUCTS", label: "منتج أو باقة", hint: "ادمج 1–5 منتجات بالصور", Icon: Package },
  { id: "CATEGORY", label: "فئة كاملة", hint: "يسحب منتجات الفئة تلقائياً", Icon: FolderTree },
  { id: "PROMOTION", label: "عرض ترويجي", hint: "يربط الخصم والمنتجات", Icon: BadgePercent },
  { id: "UPLOAD", label: "رفع تصميم جاهز", hint: "لصورة مصمّمة خارجياً", Icon: Upload },
];

export function BannerSubjectPicker({ value, onChange }: BannerSubjectPickerProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [filterCatId, setFilterCatId] = useState<number | null>(null);

  const catsQ = trpc.storeAdmin.categories.list.useQuery();
  const promosQ = trpc.storeAdmin.promotions.list.useQuery({ includeInactive: false });
  const productsQ = trpc.storeAdmin.banners.products.useQuery(
    {
      q: searchQuery.trim() || undefined,
      categoryId: filterCatId ?? undefined,
      limit: 12,
    },
    { enabled: value.mode === "PRODUCTS" },
  );

  function switchMode(mode: BannerComposerMode) {
    if (mode === value.mode) return;
    if (mode === "PRODUCTS") {
      const ctaUrl = value.products.length
        ? buildSafeBannerDestinationUrl({ kind: "PRODUCTS", productIds: value.products.map((p) => p.productId) })
        : "/store";
      onChange({ ...value, mode, specialTarget: "NONE", ctaUrl });
    } else if (mode === "CATEGORY") {
      const firstCat = value.categoryId ?? catsQ.data?.[0]?.id ?? null;
      onChange({
        ...value,
        mode,
        categoryId: firstCat,
        specialTarget: "NONE",
        ctaUrl: firstCat ? buildSafeBannerDestinationUrl({ kind: "CATEGORY", categoryId: firstCat }) : "/store",
      });
    } else if (mode === "PROMOTION") {
      const firstPromo = value.promotionId ?? promosQ.data?.[0]?.id ?? null;
      onChange({
        ...value,
        mode,
        promotionId: firstPromo,
        specialTarget: firstPromo ? "NONE" : "DEALS",
        ctaUrl: firstPromo
          ? buildSafeBannerDestinationUrl({ kind: "PROMOTION", promotionId: firstPromo })
          : "/store?deals=1",
      });
    } else {
      onChange({ ...value, mode, ctaUrl: value.ctaUrl || "/store?deals=1" });
    }
  }

  function toggleProduct(item: SelectedSubjectProduct) {
    const exists = value.products.some((p) => p.productId === item.productId);
    const nextProducts = exists
      ? value.products.filter((p) => p.productId !== item.productId)
      : [...value.products.slice(0, 4), item];
    const ctaUrl = nextProducts.length
      ? buildSafeBannerDestinationUrl({ kind: "PRODUCTS", productIds: nextProducts.map((p) => p.productId) })
      : "/store";
    onChange({ ...value, mode: "PRODUCTS", products: nextProducts, specialTarget: "NONE", ctaUrl });
  }

  return (
    <div className="space-y-3">
      {/* أزرار تحديد نوع مادة البنر الأربعة */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {MODE_TABS.map(({ id, label, hint, Icon }) => {
          const active = value.mode === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => switchMode(id)}
              className={`flex flex-col items-start rounded-xl border p-2.5 text-right transition ${
                active
                  ? "border-primary bg-primary/10 text-foreground shadow-xs"
                  : "border-border bg-background text-muted-foreground hover:bg-accent"
              }`}
            >
              <span className="flex items-center gap-1.5 text-xs font-bold text-foreground">
                <Icon aria-hidden className={`size-4 shrink-0 ${active ? "text-primary" : "text-muted-foreground"}`} />
                {label}
              </span>
              <span className="mt-0.5 text-[11px] text-muted-foreground">{hint}</span>
            </button>
          );
        })}
      </div>

      {/* 1. وضع اختيار منتج أو عدة منتجات بالصور */}
      {value.mode === "PRODUCTS" && (
        <div className="space-y-2.5">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-12">
            <div className="sm:col-span-7">
              <UnifiedSearchInput
                value={searchQuery}
                onChange={setSearchQuery}
                placeholder="ابحث باسم المنتج أو الماركة…"
                aria-label="بحث في منتجات المتجر"
              />
            </div>
            <div className="sm:col-span-5">
              <AppSelect
                value={filterCatId ? String(filterCatId) : ""}
                onValueChange={(v) => setFilterCatId(v ? Number(v) : null)}
                aria-label="تصفية حسب الفئة"
              >
                <option value="">كل الفئات</option>
                {(catsQ.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </AppSelect>
            </div>
          </div>

          {productsQ.isLoading ? (
            <div className="flex justify-center py-6 text-muted-foreground">
              <Loader2 aria-hidden className="size-5 animate-spin" />
            </div>
          ) : (
            <div className="grid max-h-56 grid-cols-1 gap-2 overflow-y-auto pr-0.5 sm:grid-cols-2">
              {(productsQ.data ?? []).map((prod) => {
                const selected = value.products.some((p) => p.productId === prod.productId);
                return (
                  <button
                    key={prod.productId}
                    type="button"
                    onClick={() => toggleProduct(prod)}
                    className={`flex items-center gap-2.5 rounded-xl border p-2 text-right transition ${
                      selected
                        ? "border-primary bg-primary/10 ring-1 ring-primary/30"
                        : "border-border bg-background hover:bg-accent/60"
                    }`}
                  >
                    <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-white p-1">
                      {prod.imageUrl ? (
                        <img src={prod.imageUrl} alt={prod.name} className="size-full object-contain" />
                      ) : (
                        <ImageIcon aria-hidden className="size-5 text-muted-foreground/40" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-bold text-foreground">{prod.name}</div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        {prod.categoryName && <span className="truncate">{prod.categoryName}</span>}
                        {prod.priceText && (
                          <span className="shrink-0 font-semibold text-primary tabular-nums">
                            · {prod.priceText}
                          </span>
                        )}
                      </div>
                    </div>
                    <div
                      className={`flex size-5 shrink-0 items-center justify-center rounded-full border ${
                        selected
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border bg-muted/40"
                      }`}
                    >
                      {selected && <Check aria-hidden className="size-3" />}
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {value.products.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              <span className="text-[11px] font-semibold text-muted-foreground">
                المحدد للبنر ({value.products.length}/5):
              </span>
              {value.products.map((p) => (
                <span
                  key={p.productId}
                  className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-xs font-bold text-primary"
                >
                  <span className="max-w-[170px] truncate">{p.name}</span>
                  <button
                    type="button"
                    onClick={() => toggleProduct(p)}
                    aria-label={`إزالة ${p.name}`}
                    className="rounded-full p-0.5 hover:bg-primary/20"
                  >
                    <X aria-hidden className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 2. وضع اختيار فئة كاملة */}
      {value.mode === "CATEGORY" && (
        <div className="flex flex-wrap gap-1.5 max-h-44 overflow-y-auto">
          {(catsQ.data ?? []).map((cat) => {
            const active = value.categoryId === cat.id;
            return (
              <button
                key={cat.id}
                type="button"
                onClick={() =>
                  onChange({
                    ...value,
                    mode: "CATEGORY",
                    categoryId: cat.id,
                    specialTarget: "NONE",
                    ctaUrl: buildSafeBannerDestinationUrl({ kind: "CATEGORY", categoryId: cat.id }),
                  })
                }
                className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-bold transition ${
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background text-foreground hover:bg-accent"
                }`}
              >
                <FolderTree aria-hidden className="size-3.5" />
                {cat.name}
              </button>
            );
          })}
        </div>
      )}

      {/* 3. وضع اختيار عرض ترويجي */}
      {value.mode === "PROMOTION" && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {(promosQ.data ?? []).map((promo) => {
            const active = value.promotionId === promo.id && value.specialTarget === "NONE";
            return (
              <button
                key={promo.id}
                type="button"
                onClick={() =>
                  onChange({
                    ...value,
                    mode: "PROMOTION",
                    promotionId: promo.id,
                    specialTarget: "NONE",
                    ctaUrl: buildSafeBannerDestinationUrl({ kind: "PROMOTION", promotionId: promo.id }),
                  })
                }
                className={`flex items-start justify-between gap-2 rounded-xl border p-2.5 text-right transition ${
                  active
                    ? "border-primary bg-primary/10 ring-1 ring-primary/30"
                    : "border-border bg-background hover:bg-accent"
                }`}
              >
                <div className="min-w-0">
                  <div className="truncate text-xs font-bold text-foreground">{promo.name}</div>
                  <div className="mt-0.5 truncate text-[11px] font-semibold text-primary">{promo.summary}</div>
                </div>
                {active && <Check aria-hidden className="size-4 shrink-0 text-primary" />}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() =>
              onChange({
                ...value,
                mode: "PROMOTION",
                promotionId: null,
                specialTarget: "DEALS",
                ctaUrl: "/store?deals=1",
              })
            }
            className={`flex items-center justify-between gap-2 rounded-xl border p-2.5 text-right transition ${
              value.specialTarget === "DEALS"
                ? "border-primary bg-primary/10 ring-1 ring-primary/30"
                : "border-border bg-background hover:bg-accent"
            }`}
          >
            <span className="flex items-center gap-1.5 text-xs font-bold">
              <BadgePercent aria-hidden className="size-3.5 text-primary" />
              كل التخفيضات المباشرة في المتجر
            </span>
            {value.specialTarget === "DEALS" && <Check aria-hidden className="size-4 text-primary" />}
          </button>
        </div>
      )}

      {/* 4. وضع التصميم المرفوع جاهزاً: تحديد الوجهة ببساطة */}
      {value.mode === "UPLOAD" && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="text-xs font-semibold text-muted-foreground">
            <span className="mb-1 block">إلى أين يذهب الزبون عند النقر؟</span>
            <AppSelect
              value={
                value.promotionId
                  ? `promo:${value.promotionId}`
                  : value.categoryId
                    ? `cat:${value.categoryId}`
                    : value.ctaUrl === "/store?quote=1"
                      ? "quote"
                      : value.ctaUrl === "/store?deals=1"
                        ? "deals"
                        : "custom"
              }
              onValueChange={(v) => {
                if (v === "deals") {
                  onChange({ ...value, promotionId: null, categoryId: null, ctaUrl: "/store?deals=1" });
                } else if (v === "quote") {
                  onChange({ ...value, promotionId: null, categoryId: null, ctaUrl: "/store?quote=1" });
                } else if (v.startsWith("promo:")) {
                  const id = Number(v.slice(6));
                  onChange({
                    ...value,
                    promotionId: id,
                    categoryId: null,
                    ctaUrl: buildSafeBannerDestinationUrl({ kind: "PROMOTION", promotionId: id }),
                  });
                } else if (v.startsWith("cat:")) {
                  const id = Number(v.slice(4));
                  onChange({
                    ...value,
                    categoryId: id,
                    promotionId: null,
                    ctaUrl: buildSafeBannerDestinationUrl({ kind: "CATEGORY", categoryId: id }),
                  });
                }
              }}
              aria-label="وجهة التصميم الجاهز"
            >
              <option value="deals">جميع التخفيضات والعروض (/store?deals=1)</option>
              <option value="quote">طلب عرض سعر للشركات (/store?quote=1)</option>
              {(promosQ.data ?? []).map((p) => (
                <option key={`promo:${p.id}`} value={`promo:${p.id}`}>
                  عرض: {p.name}
                </option>
              ))}
              {(catsQ.data ?? []).map((c) => (
                <option key={`cat:${c.id}`} value={`cat:${c.id}`}>
                  فئة: {c.name}
                </option>
              ))}
              <option value="custom">مسار داخلي مخصص</option>
            </AppSelect>
          </label>
          <label className="text-xs font-semibold text-muted-foreground">
            <span className="mb-1 block">المسار الداخلي المربوط</span>
            <Input
              dir="ltr"
              value={value.ctaUrl}
              onChange={(e) => onChange({ ...value, ctaUrl: e.target.value })}
              placeholder="/store?deals=1"
              className="text-left text-xs"
            />
          </label>
        </div>
      )}
    </div>
  );
}
