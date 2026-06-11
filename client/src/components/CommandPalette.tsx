// بحث عام بـCtrl+K — وصول فوري لأي صفحة/منتج/عميل/فاتورة بنقرة واحدة (§٢.٣).
// يُركَّب مرّة في الجذر (main.tsx). يفتح بـCtrl+K أو ⌘K، يُغلق بـEsc.
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator,
} from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import {
  Boxes, FileText, LayoutDashboard, Package, Receipt, RotateCcw, ShoppingCart, Truck, Users, Wallet, Wrench,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation } from "wouter";

type PageItem = { label: string; href: string; icon: React.ComponentType<{ className?: string }>; keywords?: string };

const PAGES: PageItem[] = [
  { label: "لوحة التحكّم", href: "/", icon: LayoutDashboard, keywords: "dashboard home رئيسية" },
  { label: "نقطة البيع", href: "/pos", icon: ShoppingCart, keywords: "pos cashier كاشير بيع" },
  { label: "المنتجات", href: "/products", icon: Package, keywords: "products أصناف" },
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

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [, navigate] = useLocation();

  // فتح/إغلاق بـCtrl+K (أو ⌘K على ماك).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const me = trpc.auth.me.useQuery();
  const branchId = me.data?.branchId ?? 1;
  const term = q.trim();

  // بحث منتجات حيّ (مفعَّل عند كتابة حرفين+).
  const products = trpc.catalog.posList.useQuery(
    { branchId, query: term, limit: 6 },
    { enabled: open && term.length >= 2 }
  );
  // العملاء والفواتير: نجلب القائمة ونفلتر محلياً (سريع، بلا نداء لكل ضغطة).
  const customers = trpc.customers.list.useQuery(undefined, { enabled: open });
  const invoices = trpc.sales.list.useQuery({ limit: 200 }, { enabled: open });

  const lc = term.toLowerCase();
  const custMatches = (customers.data ?? [])
    .filter((c) => !term || c.name.toLowerCase().includes(lc) || (c.phone ?? "").includes(term))
    .slice(0, 6);
  const invMatches = (invoices.data ?? [])
    .filter((i) => !term || String(i.invoiceNumber).toLowerCase().includes(lc))
    .slice(0, 6);

  function go(href: string) {
    setOpen(false);
    setQ("");
    navigate(href);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="overflow-hidden p-0" showCloseButton={false}>
        <DialogHeader className="sr-only">
          <DialogTitle>بحث عام</DialogTitle>
          <DialogDescription>ابحث عن صفحة أو منتج أو عميل أو فاتورة</DialogDescription>
        </DialogHeader>
        <Command shouldFilter={false} className="[&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-2.5">
          <CommandInput placeholder="ابحث عن صفحة أو منتج أو عميل أو فاتورة…  (Ctrl+K)" value={q} onValueChange={setQ} />
          <CommandList>
        <CommandEmpty>لا نتائج لـ«{term}».</CommandEmpty>

        <CommandGroup heading="الصفحات">
          {PAGES.filter((p) => !term || p.label.includes(term) || (p.keywords ?? "").toLowerCase().includes(lc)).map((p) => (
            <CommandItem key={p.href} value={p.href} onSelect={() => go(p.href)}>
              <p.icon className="size-4" /> {p.label}
            </CommandItem>
          ))}
        </CommandGroup>

        {custMatches.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="العملاء">
              {custMatches.map((c) => (
                <CommandItem key={`c${c.id}`} value={`cust-${c.id}`} onSelect={() => go(`/customers-statement?customerId=${c.id}`)}>
                  <Users className="size-4" /> {c.name}
                  {c.phone && <span className="ms-auto text-xs text-muted-foreground" dir="ltr">{c.phone}</span>}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {invMatches.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="الفواتير">
              {invMatches.map((i) => (
                <CommandItem key={`i${i.id}`} value={`inv-${i.id}`} onSelect={() => go(`/invoices/${i.id}`)}>
                  <FileText className="size-4" /> فاتورة #{i.invoiceNumber}
                  <span className="ms-auto text-xs text-muted-foreground" dir="ltr">{Number(i.total).toLocaleString("ar-IQ-u-nu-latn")}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {term.length >= 2 && (products.data?.length ?? 0) > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="المنتجات">
              {(products.data ?? []).map((p) => (
                <CommandItem key={`p${p.productUnitId}`} value={`prod-${p.productUnitId}`} onSelect={() => go(`/products/${p.productId}/edit`)}>
                  <Package className="size-4" /> {p.productName}
                  <span className="ms-auto text-xs text-muted-foreground">{p.unitName}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
