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
const PriceWaves = lazy(() => import("@/pages/PriceWaves"));
const Offers = lazy(() => import("@/pages/Offers"));

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
  // labels (٨/٧/٢٦): طباعة ملصقات الباركود مع بوّابة صريحة على وحدة المنتجات — الكاشير الذي لا يملك
  // access للمنتجات لا ينبغي أن يطبع ملصقات (يمكن تسريب أسماء منتجات/باركود لجهة خارجية).
  { value: "barcodes", label: "ملصقات الباركود", gate: { module: "products", level: "READ" }, Component: BarcodeLabels },
  // gstack B10 (٧/٧/٢٦): موجات الأسعار كتبويب ضمن المخزون (managerOnly — تُعدّل أسعاراً جماعياً).
  { value: "price-waves", label: "موجات الأسعار", gate: { managerOnly: true }, Component: PriceWaves },
  // promotions v2 (٨/٧/٢٦): العروض والخصومات — تُطبَّق آلياً في POS على السعر المعروض.
  { value: "offers", label: "العروض والخصومات", gate: { managerOnly: true }, Component: Offers },
];

export default function InventoryHub() {
  return <PageTabs tabs={TABS} ariaLabel="أقسام المخزون" />;
}
