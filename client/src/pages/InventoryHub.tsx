// InventoryHub — صفحة وحدة «المخزون والبضاعة» بتبويبات ثانوية.
// يُوحِّد ٧ مَداخل كانت مَجموعة قابلة للطيّ (أرصدة + منتجات + حركات + تحويلات + جرد + فئات +
// باركود) في صفحة واحدة. التبويب الافتراضي = الأرصدة (يَحفظ مَعنى /inventory السابق).
// «الفئات» managerOnly (كان /categories محصوراً بـ admin/manager في App.tsx).
// مَسارات الإنشاء/التفصيل (‎/products/new، ‎/stocktakes/:id/*) تَبقى مُستقلّة خارج الـ hub.
import { lazyWithRetry as lazy } from "@/lib/lazyWithRetry";
import { PageTabs, type HubTab } from "@/components/PageTabs";
import { fmtInt } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import { AlertTriangle, GraduationCap } from "lucide-react";
import { Link, useLocation } from "wouter";

const Inventory = lazy(() => import("@/pages/Inventory"));
const Products = lazy(() => import("@/pages/Products"));
const InventoryMovements = lazy(() => import("@/pages/InventoryMovements"));
const Transfers = lazy(() => import("@/pages/Transfers"));
const Stocktakes = lazy(() => import("@/pages/Stocktakes"));
const ReorderAlerts = lazy(() => import("@/pages/ReorderAlerts"));
const SeasonPlanning = lazy(() => import("@/pages/SeasonPlanning"));
const Categories = lazy(() => import("@/pages/Categories"));
const BarcodeLabels = lazy(() => import("@/pages/BarcodeLabels"));
const PriceWaves = lazy(() => import("@/pages/PriceWaves"));

const TABS: HubTab[] = [
  { value: "stock", label: "الأرصدة", Component: Inventory },
  { value: "products", label: "المنتجات", Component: Products },
  { value: "movements", label: "الحركات", Component: InventoryMovements },
  // التحويلات كتابة بحتة — بوّابة مرآة راوترها inventoryWarehouseProcedure (مخزن/مدير + منح inventory صريح بمستوى FULL)؛
  // أدوار قراءة المخزون كانت تهبط على نموذج كل نداءاته FORBIDDEN (بحث المتغيّرات والإرسال معاً).
  { value: "transfers", label: "التحويلات", gate: { roles: ["warehouse", "manager"], module: "inventory", level: "FULL" }, Component: Transfers },
  { value: "stocktakes", label: "الجرد والتسوية", Component: Stocktakes },
  { value: "reorder", label: "إعادة الطلب", Component: ReorderAlerts },
  // تخطيط الموسم: أداة تجهيزٍ على مستوى العمل (seasonPlan/setSeasonTarget على inventoryWarehouseProcedure) —
  // بوّابة مرآة التحويلات تُخفيه عن الكاشير (كل نداءاته FORBIDDEN له).
  { value: "season", label: "تخطيط الموسم", gate: { roles: ["warehouse", "manager"], module: "inventory", level: "FULL" }, Component: SeasonPlanning },
  { value: "categories", label: "الفئات", gate: { managerOnly: true }, Component: Categories },
  // labels (٨/٧/٢٦): طباعة ملصقات الباركود مع بوّابة صريحة على وحدة المنتجات — الكاشير الذي لا يملك
  // access للمنتجات لا ينبغي أن يطبع ملصقات (يمكن تسريب أسماء منتجات/باركود لجهة خارجية).
  { value: "barcodes", label: "ملصقات الباركود", gate: { module: "products", level: "READ" }, Component: BarcodeLabels },
  // gstack B10 (٧/٧/٢٦): موجات الأسعار كتبويب ضمن المخزون (managerOnly — تُعدّل أسعاراً جماعياً).
  { value: "price-waves", label: "موجات الأسعار", gate: { managerOnly: true }, Component: PriceWaves },
];

/**
 * مؤشّر التخطيط الحيّ (استباقيّ) — رقاقتان تظهران فقط عند وجود ما يحتاج فعلاً (لا ضجيج): عدد صفوف
 * إعادة الطلب (بنطاق فرع المستخدم) + عدد الأصناف الموسمية تحت الهدف. كل رقاقة رابطٌ لتبويبها.
 * محصورٌ بالمدير/المخزن (planningSummary على inventoryWarehouseProcedure) — الكاشير لا يستعلم أصلاً.
 */
function PlanningIndicator() {
  const [loc] = useLocation();
  const me = trpc.auth.me.useQuery();
  const role = me.data?.role ?? "";
  const canSee = role === "admin" || role === "manager" || role === "warehouse";
  const summary = trpc.inventory.planningSummary.useQuery(undefined, { enabled: canSee });
  if (!canSee || !summary.data) return null;
  const { reorderCount, seasonBelowTargetCount } = summary.data;
  if (reorderCount === 0 && seasonBelowTargetCount === 0) return null;

  const chip =
    "inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 " +
    "text-xs font-semibold text-amber-800 transition-colors hover:bg-amber-100";
  return (
    <div className="flex items-center gap-2">
      {reorderCount > 0 && (
        <Link href={`${loc}?tab=reorder`} className={chip}>
          <AlertTriangle aria-hidden className="size-3.5" />
          إعادة الطلب: {fmtInt(reorderCount)}
        </Link>
      )}
      {seasonBelowTargetCount > 0 && (
        <Link href={`${loc}?tab=season`} className={chip}>
          <GraduationCap aria-hidden className="size-3.5" />
          تجهيز الموسم: {fmtInt(seasonBelowTargetCount)}
        </Link>
      )}
    </div>
  );
}

export default function InventoryHub() {
  return <PageTabs tabs={TABS} ariaLabel="أقسام المخزون" actions={<PlanningIndicator />} />;
}
