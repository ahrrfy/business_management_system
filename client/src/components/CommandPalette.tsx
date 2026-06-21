// بحث شامل بـCtrl+K — وصول فوري لأي صفحة + بحث ذرّي عبر كل وحدات النظام
// (منتجات/فواتير/عروض أسعار/مشتريات/أوامر شغل/عملاء/موردين/مصاريف) بنقرة واحدة.
//
// النمط مكتشَف تلقائياً على الخادم (`globalSearch.search`):
//  - أرقام صرفة ٨-١٤ ⇒ باركود (تطابق دقيق على productUnits.barcode + أرقام وثائق)
//  - بادئة `INV-/QT-/PO-/WO-/SR-/PR-` ⇒ مُعرّف وثيقة
//  - رقم قصير «9164» ⇒ يطابق رقم وثيقة جزئياً
//  - هاتف بـ`+` ⇒ يبحث في customers.phone وأخواته
//  - نص ⇒ بحث جزئي ذكي بتطبيع عربي
//
// RBAC وعزل الفرع يجريان في الخادم: الكاشير لا يرى موردين/مشتريات/مصاريف،
// ولا يرى فواتير الفروع الأخرى. لا تسريب بيانات عبر العميل (بخلاف النسخة السابقة).
//
// يُركَّب مرّة في الجذر (main.tsx). يفتح بـCtrl+K أو ⌘K أو `/`، يُغلق بـEsc.

import { keepPreviousData } from "@tanstack/react-query";
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator,
} from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { SEARCH_OPEN_EVENT } from "@/lib/searchEvents";
import {
  Boxes, Contact, FileText, LayoutDashboard, Package, Receipt, RotateCcw, ScanLine, ShoppingCart, Truck, UserCog, Users, Wallet, Wrench,
} from "lucide-react";
import { CameraScanner } from "@/components/scan/CameraScanner";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";

type SearchResult = RouterOutputs["globalSearch"]["search"][number];
type EntityType = SearchResult["type"];

type PageItem = { label: string; href: string; icon: React.ComponentType<{ className?: string }>; keywords?: string };

const PAGES: PageItem[] = [
  { label: "لوحة التحكّم", href: "/", icon: LayoutDashboard, keywords: "dashboard home رئيسية" },
  { label: "نقطة البيع", href: "/pos", icon: ShoppingCart, keywords: "pos cashier كاشير بيع" },
  { label: "المنتجات", href: "/products", icon: Package, keywords: "products منتجات" },
  { label: "المبيعات / الفواتير", href: "/invoices", icon: FileText, keywords: "invoices sales" },
  { label: "المرتجعات", href: "/returns", icon: RotateCcw, keywords: "returns إرجاع" },
  { label: "المشتريات", href: "/purchases", icon: Truck, keywords: "purchases شراء" },
  { label: "أوامر الشغل", href: "/work-orders", icon: Wrench, keywords: "work orders مطبعة" },
  { label: "المخزون", href: "/inventory", icon: Boxes, keywords: "inventory stock حركات" },
  { label: "التحويلات", href: "/transfers", icon: Truck, keywords: "transfers نقل" },
  { label: "المصروفات", href: "/expenses", icon: Wallet, keywords: "expenses مصاريف" },
  { label: "أعمار الذمم (مدينة)", href: "/ar-aging", icon: Receipt, keywords: "ar aging ذمم تحصيل" },
  { label: "كشف حساب عميل", href: "/customers-statement", icon: Users, keywords: "customer statement كشف" },
  { label: "أعمار الذمم (دائنة)", href: "/ap-aging", icon: Receipt, keywords: "ap aging موردين" },
  { label: "كشف حساب مورد", href: "/suppliers-statement", icon: Users, keywords: "supplier statement" },
];

const ENTITY_LABELS: Record<EntityType, string> = {
  PRODUCT: "المنتجات",
  INVOICE: "الفواتير",
  QUOTATION: "عروض الأسعار",
  PURCHASE_ORDER: "أوامر الشراء",
  WORK_ORDER: "أوامر الشغل",
  CUSTOMER: "العملاء",
  SUPPLIER: "الموردون",
  EXPENSE: "المصاريف",
  EMPLOYEE: "الموظفون",
  USER: "المستخدمون",
};

const ENTITY_ICONS: Record<EntityType, React.ComponentType<{ className?: string }>> = {
  PRODUCT: Package,
  INVOICE: FileText,
  QUOTATION: Receipt,
  PURCHASE_ORDER: Truck,
  WORK_ORDER: Wrench,
  CUSTOMER: Users,
  SUPPLIER: Truck,
  EXPENSE: Wallet,
  EMPLOYEE: Contact,
  USER: UserCog,
};

const ENTITY_ORDER: EntityType[] = [
  "PRODUCT", "INVOICE", "QUOTATION", "WORK_ORDER",
  "CUSTOMER", "SUPPLIER", "PURCHASE_ORDER", "EXPENSE",
  "EMPLOYEE", "USER",
];

function useDebouncedValue<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (t.isContentEditable) return true;
  return false;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [q, setQ] = useState("");
  const debouncedQ = useDebouncedValue(q, 200);
  const [, navigate] = useLocation();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const cmdK = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k";
      const slashOpener = e.key === "/" && !isEditableTarget(e.target);
      if (cmdK || slashOpener) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    function onOpenEvent() { setOpen(true); }
    window.addEventListener("keydown", onKey);
    window.addEventListener(SEARCH_OPEN_EVENT, onOpenEvent);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(SEARCH_OPEN_EVENT, onOpenEvent);
    };
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 10);
    else setQ("");
  }, [open]);

  const term = debouncedQ.trim();
  const results = trpc.globalSearch.search.useQuery(
    { query: term, perEntityLimit: 6 },
    { enabled: open && term.length > 0, placeholderData: keepPreviousData, staleTime: 30_000 },
  );

  const grouped = useMemo(() => {
    const map = new Map<EntityType, SearchResult[]>();
    for (const r of results.data ?? []) {
      const arr = map.get(r.type) ?? [];
      arr.push(r);
      map.set(r.type, arr);
    }
    return ENTITY_ORDER
      .map((type) => ({ type, items: map.get(type) ?? [] }))
      .filter((g) => g.items.length);
  }, [results.data]);

  const lc = term.toLowerCase();
  const matchedPages = PAGES.filter((p) =>
    !term || p.label.includes(term) || (p.keywords ?? "").toLowerCase().includes(lc),
  );

  const go = useCallback((href: string) => {
    setOpen(false);
    setQ("");
    navigate(href);
  }, [navigate]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="overflow-hidden p-0" showCloseButton={false}>
        <DialogHeader className="sr-only">
          <DialogTitle>البحث الشامل</DialogTitle>
          <DialogDescription>
            ابحث في كل النظام: منتجات، فواتير، عملاء، أوامر شغل، باركود، أرقام وثائق…
          </DialogDescription>
        </DialogHeader>
        <Command
          shouldFilter={false}
          className="[&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-2.5"
        >
          <CommandInput
            ref={inputRef}
            placeholder="اكتب/امسح باركود/أدخل رقم وثيقة (INV-/QT-/PO-/WO-) أو كود موظف/مستخدم (EMP-/USER-)…"
            value={q}
            onValueChange={setQ}
          />
          <div className="flex items-center gap-2 px-3 py-1.5 border-b">
            <button
              type="button"
              onClick={() => setScanOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs text-foreground/80 hover:bg-accent"
            >
              <ScanLine className="size-3.5" /> مسح بالكاميرا
            </button>
            <span className="text-[11px] text-muted-foreground">أو امسح بماسح ليزري — يُكتب الكود ثم Enter</span>
          </div>
          <CommandList>
            {!term && (
              <CommandGroup heading="الصفحات">
                {PAGES.map((p) => (
                  <CommandItem key={p.href} value={p.href} onSelect={() => go(p.href)}>
                    <p.icon className="size-4" /> {p.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {term && results.isLoading && (
              <div className="px-4 py-6 text-center text-sm text-muted-foreground">جارٍ البحث…</div>
            )}

            {term && !results.isLoading && grouped.length === 0 && matchedPages.length === 0 && (
              <CommandEmpty>لا نتائج لـ«{term}» — جرّب رقم فاتورة أو اسم منتج/عميل.</CommandEmpty>
            )}

            {term && matchedPages.length > 0 && (
              <CommandGroup heading="الصفحات">
                {matchedPages.map((p) => (
                  <CommandItem key={p.href} value={`page:${p.href}`} onSelect={() => go(p.href)}>
                    <p.icon className="size-4" /> {p.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {grouped.map((g, gi) => {
              const Icon = ENTITY_ICONS[g.type];
              return (
                <div key={g.type}>
                  {(gi > 0 || (term && matchedPages.length > 0)) && <CommandSeparator />}
                  <CommandGroup heading={`${ENTITY_LABELS[g.type]} (${g.items.length})`}>
                    {g.items.map((r) => (
                      <CommandItem
                        key={`${r.type}:${r.id}`}
                        value={`${r.type}:${r.id}:${r.title}`}
                        onSelect={() => go(r.route)}
                        className="flex items-center gap-2"
                      >
                        <Icon className="size-4 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-semibold">{r.title}</div>
                          {r.subtitle && (
                            <div className="truncate text-[11px] text-muted-foreground">{r.subtitle}</div>
                          )}
                        </div>
                        {r.meta && (
                          <div dir="ltr" className="shrink-0 text-[11px] text-muted-foreground">
                            {r.meta}
                          </div>
                        )}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </div>
              );
            })}
          </CommandList>
        </Command>
        <CameraScanner
          open={scanOpen}
          onClose={() => setScanOpen(false)}
          onDetect={(code) => {
            setScanOpen(false);
            setQ(code);
            setTimeout(() => inputRef.current?.focus(), 10);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
