// مسار تنقّل (breadcrumbs) على الشاشات العميقة + اختصار رجوع Alt+→ (RTL).
// الاستعمال:
//   <Breadcrumbs items={[{ label: "المنتجات", href: "/products" }, { label: "تعديل" }]} />
import {
  Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { useEffect } from "react";
import { Link, useLocation } from "wouter";

export type Crumb = { label: string; href?: string };

export function Breadcrumbs({ items, home = true }: { items: Crumb[]; home?: boolean }) {
  const [, navigate] = useLocation();

  // اختصار الرجوع: Alt+→ (في RTL السهم الأيمن هو «السابق»). يعود لآخر عنصر له رابط.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.altKey && e.key === "ArrowRight") {
        const back = [...items].reverse().find((c) => c.href);
        if (back?.href) {
          e.preventDefault();
          navigate(back.href);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, navigate]);

  const all: Crumb[] = home ? [{ label: "الرئيسية", href: "/" }, ...items] : items;

  return (
    <Breadcrumb>
      <BreadcrumbList>
        {all.map((c, i) => {
          const last = i === all.length - 1;
          return (
            <BreadcrumbItem key={i}>
              {last || !c.href ? (
                <BreadcrumbPage>{c.label}</BreadcrumbPage>
              ) : (
                <>
                  <BreadcrumbLink asChild><Link href={c.href}>{c.label}</Link></BreadcrumbLink>
                  <BreadcrumbSeparator />
                </>
              )}
            </BreadcrumbItem>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
