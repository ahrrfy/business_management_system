import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { Link, useLocation } from "wouter";

const NAV: { href: string; label: string; adminOnly?: boolean }[] = [
  { href: "/", label: "لوحة التحكم" },
  { href: "/pos", label: "نقطة البيع" },
  { href: "/products", label: "المنتجات" },
  { href: "/barcode-labels", label: "ملصقات الباركود" },
  { href: "/invoices", label: "المبيعات" },
  { href: "/quotations", label: "عروض الأسعار" },
  { href: "/customers", label: "العملاء" },
  { href: "/returns", label: "المرتجعات" },
  { href: "/purchases", label: "المشتريات" },
  { href: "/work-orders", label: "أوامر الشغل/المطبعة" },
  { href: "/transfers", label: "تحويل بين الفروع" },
  { href: "/inventory", label: "حركات المخزون" },
  { href: "/expenses", label: "المصروفات اليومية" },
  { href: "/ar-aging", label: "أعمار الذمم" },
  { href: "/customers-statement", label: "كشف حساب عميل" },
  { href: "/ap-aging", label: "أعمار الذمم الدائنة" },
  { href: "/suppliers-statement", label: "كشف حساب مورد" },
  { href: "/users", label: "المستخدمون", adminOnly: true },
];

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [loc, navigate] = useLocation();
  const me = trpc.auth.me.useQuery();
  const utils = trpc.useUtils();
  const logout = trpc.auth.logout.useMutation({
    onSuccess: async () => {
      await utils.auth.me.invalidate();
      navigate("/login");
    },
  });

  return (
    <div className="min-h-screen flex bg-muted/30" dir="rtl">
      <aside className="w-56 shrink-0 border-l bg-card flex flex-col">
        <div className="px-4 py-4 font-semibold text-lg border-b">الرؤية العربية</div>
        <nav className="flex-1 p-2 space-y-1">
          {NAV.filter((n) => !n.adminOnly || me.data?.role === "admin").map((n) => {
            const active = loc === n.href;
            return (
              <Link
                key={n.href}
                href={n.href}
                className={`block rounded-md px-3 py-2 text-sm transition ${active ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
              >
                {n.label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t p-3 text-xs text-muted-foreground">
          <Link href="/account" className={`mb-1 block rounded px-1 hover:underline ${loc === "/account" ? "text-primary" : ""}`}>
            {me.data?.name ?? me.data?.email} <span className="opacity-70">({me.data?.role})</span>
          </Link>
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => logout.mutate()} disabled={logout.isPending}>
            تسجيل الخروج
          </Button>
        </div>
      </aside>
      <main className="flex-1 p-6 overflow-auto">{children}</main>
    </div>
  );
}
