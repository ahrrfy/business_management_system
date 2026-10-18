import React, { useEffect, useId, useState } from "react";
import { ArrowUpLeft } from "lucide-react";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { trpc } from "@/lib/trpc";
import { fmtInt } from "@/lib/money";
import { normalizeArabicSearch } from "@shared/storefrontSearchNormalize";

type Scope = {
  categoryId: number | null;
  availability: "IN_STOCK" | "ALL";
  brand: string;
  priceFilter: "ALL" | "UNDER_5000" | "FROM_5000_TO_15000" | "OVER_15000";
  productIds?: number[] | null;
};
type Props = Scope & {
  value: string;
  onChange: (value: string) => void;
  onSearch: (query: string, categoryId?: number) => void;
  onSelectProduct: (id: number) => void;
};
export function StorefrontSearch({
  value,
  onChange,
  onSearch,
  onSelectProduct,
  ...scope
}: Props) {
  const [debounced, setDebounced] = useState("");
  const [focused, setFocused] = useState(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const id = useId();
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value.trim()), 220);
    return () => clearTimeout(timer);
  }, [value]);
  const scopeKey = JSON.stringify(scope);
  useEffect(() => setActiveKey(null), [value, scopeKey]);
  const suggestions = trpc.storefront.searchSuggestions.useQuery(
    { query: debounced, ...scope },
    {
      enabled: debounced.length >= 2,
      staleTime: 5_000,
      gcTime: 30_000,
      refetchOnWindowFocus: false,
      retry: false,
    },
  );
  // A cached response for the preceding keystroke/scope must never become the new option list.
  const current =
    normalizeArabicSearch(value) === normalizeArabicSearch(debounced);
  const data =
    current && !suggestions.isPlaceholderData ? suggestions.data : undefined;
  const submit = (query: string, categoryId?: number) => {
    setFocused(false);
    setActiveKey(null);
    onSearch(query, categoryId);
  };
  const chooseProduct = (productId: number) => {
    setFocused(false);
    setActiveKey(null);
    onSelectProduct(productId);
  };
  const options: {
    key: string;
    label: string;
    detail?: string;
    group: string;
    run: () => void;
  }[] = [];
  if (data) {
    data.queries.forEach((query) =>
      options.push({
        key: `query-${query}`,
        label: query,
        group: "عبارات مقترحة",
        run: () => submit(query),
      }),
    );
    data.categories.forEach((category) =>
      options.push({
        key: `category-${category.id}`,
        label: category.name,
        group: "أقسام ذات صلة",
        run: () => submit(value.trim(), category.id),
      }),
    );
    data.products.forEach((product) =>
      options.push({
        key: `product-${product.productId}`,
        label: product.productName,
        detail: `${(product.salePrice ?? product.price) ? `${fmtInt(product.salePrice ?? product.price!)} د.ع` : "اسأل الموظّف"} · ${product.inStock ? "متوفر" : "غير متوفر"}`,
        group: "منتجات مطابقة",
        run: () => chooseProduct(product.productId),
      }),
    );
    if (data.correction)
      options.push({
        key: "correction",
        label: `هل تقصد «${data.correction}»؟`,
        group: "تصحيح مقترح",
        run: () => submit(data.correction!),
      });
    data.similar.forEach((product) =>
      options.push({
        key: `similar-${product.productId}`,
        label: product.productName,
        group: "منتجات مشابهة للبحث",
        run: () => chooseProduct(product.productId),
      }),
    );
  }
  if (value.trim().length >= 2)
    options.push({
      key: "all",
      label: `عرض جميع النتائج لـ «${value.trim()}»`,
      group: "",
      run: () => submit(value.trim()),
    });
  // Keep explicit selection attached to its identity when asynchronous results insert/reorder rows.
  const active = options.findIndex((option) => option.key === activeKey);
  const open = focused && options.length > 0;
  useEffect(() => {
    if (open && active >= 0)
      document
        .getElementById(`${id}-option-${active}`)
        ?.scrollIntoView?.({ block: "nearest" });
  }, [active, open, id]);
  const inputId = `${id}-input`;
  return (
    <div
      className="relative order-4 w-full flex-none sm:order-none sm:min-w-0 sm:flex-1"
      dir="rtl"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setFocused(false);
      }}
    >
      <UnifiedSearchInput
        id={inputId}
        value={value}
        barcode={false}
        debounceMs={0}
        clearButtonLabel="مسح البحث"
        onChange={(raw) => {
          onChange(raw);
          setFocused(true);
          setActiveKey(null);
          if (!raw) submit("");
        }}
        onFocus={() => setFocused(true)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") {
            event.preventDefault();
            setFocused(false);
            setActiveKey(null);
          } else if (
            (event.key === "ArrowDown" || event.key === "ArrowUp") &&
            options.length
          ) {
            event.preventDefault();
            setFocused(true);
            const nextIndex =
              event.key === "ArrowDown"
                ? Math.min(active + 1, options.length - 1)
                : active <= 0
                  ? options.length - 1
                  : active - 1;
            setActiveKey(options[nextIndex].key);
          } else if (event.key === "Enter") {
            event.preventDefault();
            if (open && active >= 0 && options[active]) options[active].run();
            else submit(value.trim());
          }
        }}
        aria-label="البحث في منتجات مكتبة العربية"
        placeholder="ابحث بكلمة أو جزء منها: ملزمة، قلم، دفتر…"
        inputProps={{
          role: "combobox",
          maxLength: 64,
          "aria-autocomplete": "list",
          "aria-expanded": open,
          "aria-controls": `${id}-list`,
          "aria-activedescendant":
            open && active >= 0 && options[active]
              ? `${id}-option-${active}`
              : undefined,
        }}
        className="min-w-0 w-full"
        inputClassName="h-11 border-slate-200 bg-white pr-10 pl-11 text-sm font-semibold text-slate-900 placeholder:text-slate-400 focus:border-[var(--store-brand)] focus:ring-[var(--store-brand)]/10"
      />
      {open && (
        <div
          id={`${id}-list`}
          role="listbox"
          aria-label="اقتراحات البحث"
          className="absolute inset-x-0 top-[calc(100%+.5rem)] z-50 max-h-[min(65dvh,460px)] overflow-y-auto rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg"
        >
          {suggestions.isError && (
            <p role="status" className="px-3 py-2 text-xs text-slate-600">
              تعذّر تحميل المقترحات؛ يمكنك عرض جميع النتائج.
            </p>
          )}
          {options.map((option, index) => (
            <React.Fragment key={option.key}>
              {option.group && option.group !== options[index - 1]?.group && (
                <div
                  role="presentation"
                  className="px-3 pt-2 text-[10px] font-bold text-slate-500"
                >
                  {option.group}
                </div>
              )}
              <button
                id={`${id}-option-${index}`}
                type="button"
                role="option"
                aria-selected={index === active}
                tabIndex={-1}
                onPointerDown={(event) => event.preventDefault()}
                onClick={option.run}
                className={`flex min-h-11 w-full min-w-0 items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-right hover:bg-slate-50 ${index === active ? "bg-slate-100" : ""}`}
              >
                <span className="min-w-0">
                  <span className="line-clamp-2 text-xs font-bold text-slate-800">
                    {option.label}
                  </span>
                  {option.detail && (
                    <span className="mt-1 block text-[10px] text-slate-500">
                      {option.detail}
                    </span>
                  )}
                </span>
                <ArrowUpLeft
                  aria-hidden
                  className="size-3.5 shrink-0 text-slate-400"
                />
              </button>
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

/** The same cached procedure also makes zero-result recovery available after the menu closes. */
export function StorefrontSearchAlternatives({
  query,
  onSearch,
  onSelectProduct,
  ...scope
}: Scope & {
  query: string;
  onSearch: (query: string) => void;
  onSelectProduct: (id: number) => void;
}) {
  const result = trpc.storefront.searchSuggestions.useQuery(
    { query, ...scope },
    {
      enabled: query.trim().length >= 2,
      staleTime: 5_000,
      gcTime: 30_000,
      refetchOnWindowFocus: false,
      retry: false,
    },
  );
  const data = result.data;
  if (!data?.correction && !data?.similar.length) return null;
  return (
    <div
      className="mt-4 w-full max-w-lg px-3 text-right"
      aria-label="اقتراحات بديلة للبحث"
    >
      {data.correction && (
        <button
          type="button"
          onClick={() => onSearch(data.correction!)}
          className="font-bold text-[var(--store-brand)] underline"
        >
          هل تقصد «{data.correction}»؟
        </button>
      )}
      {data.similar.length > 0 && (
        <>
          <p className="mt-3 text-xs font-bold text-slate-600">
            منتجات مشابهة للبحث
          </p>
          <div className="mt-2 grid gap-2">
            {data.similar.map((product) => (
              <button
                type="button"
                key={product.productId}
                onClick={() => onSelectProduct(product.productId)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-right text-xs font-semibold text-[var(--store-brand)]"
              >
                {product.productName}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
