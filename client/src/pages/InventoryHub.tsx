// InventoryHub — صفحة وحدة «المخزون والبضاعة» بتبويبات ثانوية.
// يُوحِّد ٧ مَداخل كانت مَجموعة قابلة للطيّ (أرصدة + منتجات + حركات + تحويلات + جرد + فئات +
// باركود) في صفحة واحدة. التبويب الافتراضي = الأرصدة (يَحفظ مَعنى /inventory السابق).
// «الفئات» managerOnly (كان /categories محصوراً بـ admin/manager في App.tsx).
// مَسارات الإنشاء/التفصيل (‎/products/new، ‎/stocktakes/:id/*) تَبقى مُستقلّة خارج الـ hub.
import { lazyWithRetry as lazy } from "@/lib/lazyWithRetry";
import { PageTabs, type HubTab } from "@/components/PageTabs";

const Inventory = lazy(() => import("@/pages/Inventory"));
const Products = lazy(() => import("@/pages/Products"));
const InventoryMovements = lazy(() => import("@/pages/InventoryMovements"));
const Transfers = lazy(() => import("@/pages/Transfers"));
const Stocktakes = lazy(() => import("@/pages/Stocktakes"));
const ReorderAlerts = lazy(() => import("@/pages/ReorderAlerts"));
const Categories = lazy(() => import("@/pages/Categories"));
const BarcodeLabels = lazy(() => import("@/pages/BarcodeLabels"));

const TABS: HubTab[] = [
  { value: "stock", label: "الأرصدة", Component: Inventory },
  { value: "products", label: "المنتجات", Component: Products },
  { value: "movements", label: "الحركات", Component: InventoryMovements },
  // التحويلات كتابة بحتة — بوّابة مرآة راوترها inventoryWarehouseProcedure (مخزن/مدير + منح inventory صريح بمستوى FULL)؛
  // أدوار قراءة المخزون كانت تهبط على نموذج كل نداءاته FORBIDDEN (بحث المتغيّرات والإرسال معاً).
  { value: "transfers", label: "التحويلات", gate: { roles: ["warehouse", "manager"], module: "inventory", level: "FULL" }, Component: Transfers },
  { value: "stocktakes", label: "الجرد والتسوية", Component: Stocktakes },
  { value: "reorder", label: "إعادة الطلب", Component: ReorderAlerts },
  { value: "categories", label: "الفئات", gate: { managerOnly: true }, Component: Categories },
  { value: "barcodes", label: "ملصقات الباركود", Component: BarcodeLabels },
];

export default function InventoryHub() {
  return <PageTabs tabs={TABS} ariaLabel="أقسام المخزون" />;
}
