import type { LucideIcon } from "lucide-react";
import {
  BarChart3, Boxes, Briefcase, Building2, ClipboardCheck, CreditCard, DollarSign,
  FileCheck2, Gift, Images, Landmark, ListChecks, Lock, Package, PackageCheck, Printer,
  Receipt, ScanLine, Server, Settings, ShoppingCart, Sparkles, Store, Truck, Users, Wallet,
  WalletCards,
} from "lucide-react";
import { INVOICE_LIST_GATE, type RoleGate } from "@/lib/navVisibility";

export type AppSectionId = 1 | 2 | 3 | 4 | 5;

/**
 * سجلّ الوحدات الظاهرة للمستخدم. إضافة وحدة هنا تكفي لإظهارها في التنقّل وبطاقة لوحة التحكم؛
 * الصلاحيات نفسها تُستهلك في الموضعين، فلا تنشأ شاشة متاحة في القائمة ومفقودة من الرئيسية.
 */
export type ApplicationModule = RoleGate & {
  id: string;
  href: string;
  label: string;
  description: string;
  section: AppSectionId;
  icon: LucideIcon;
};

export const APPLICATION_MODULES: readonly ApplicationModule[] = [
  { id: "pos", href: "/pos", label: "نقطة البيع", description: "مبيعات وورديات", section: 1, icon: ShoppingCart },
  { id: "priceChecker", href: "/price-checker", label: "قارئ الأسعار", description: "فحص السعر والرصيد بالباركود", section: 1, icon: ScanLine },
  { id: "workOrders", href: "/work-orders", label: "المطبعة والإنتاج", description: "أوامر الشغل والتخصيص", section: 4, icon: Printer, module: "workorders" },
  { id: "crm", href: "/crm", label: "CRM والعلاقات", description: "عملاء ومحادثات وعروض", section: 1, icon: Users, module: "crm" },
  { id: "myWork", href: "/my-work", label: "مطلوب مني الآن", description: "قرارات ومهام تنتظر الإجراء", section: 4, icon: ClipboardCheck },
  { id: "tasks", href: "/tasks", label: "المهام والتذاكر", description: "إسناد ومتابعة وSLA", section: 4, icon: ListChecks, module: "tasks" },
  { id: "sales", href: "/invoices", label: "المبيعات", description: "فواتير ومدفوعات", section: 1, icon: Receipt, ...INVOICE_LIST_GATE },
  { id: "treasury", href: "/treasury", label: "الخزينة والمدفوعات", description: "أرصدة وسندات وتحويلات", section: 3, icon: Wallet, roles: ["manager", "accountant", "cashier", "auditor"], module: "treasury" },
  { id: "cardAccount", href: "/card-account", label: "حساب البطاقة/البنك", description: "أرصدة وتسويات البطاقة", section: 3, icon: CreditCard, roles: ["admin", "manager", "accountant", "auditor"], module: "reports" },
  { id: "delivery", href: "/delivery", label: "التوصيل", description: "طلبات وشركات وتحصيل COD", section: 4, icon: Truck, roles: ["admin", "manager", "accountant", "cashier", "auditor"] },
  { id: "myDeliveries", href: "/my-deliveries", label: "توصيلاتي", description: "طلبات المندوب ومسار التسليم", section: 4, icon: PackageCheck, roles: ["courier"], module: "courier" },
  { id: "store", href: "/store-admin", label: "طلبات المتجر", description: "طلبات وبنرات وإعدادات", section: 4, icon: Store, roles: ["admin", "manager", "cashier", "sales_rep", "accountant", "auditor"], module: "store" },
  { id: "productStudio", href: "/catalog/image-studio", label: "استوديو المنتجات", description: "صور المنتجات والكتالوج", section: 4, icon: Images, roles: ["admin", "manager", "print_operator", "auditor"], module: "productStudio" },
  { id: "contentDrafts", href: "/products/content-drafts", label: "مسودّات المحتوى", description: "مراجعة المحتوى المولّد للمنتجات", section: 4, icon: Sparkles, roles: ["admin", "manager"], module: "products" },
  { id: "inventory", href: "/inventory", label: "المخزون والبضاعة", description: "الأرصدة والتسويات", section: 2, icon: Boxes },
  { id: "purchases", href: "/purchases", label: "المشتريات", description: "فواتير شراء تُضاف للمخزون عند الاعتماد", section: 2, icon: Package },
  { id: "suppliers", href: "/suppliers", label: "الموردون", description: "إدارة الموردين وذممهم", section: 2, icon: Building2 },
  { id: "gifts", href: "/gifts", label: "الهدايا والمجانيات", description: "الحوافز والهدايا المجانية", section: 2, icon: Gift, roles: ["admin", "manager", "accountant", "warehouse", "purchasing", "auditor"], module: "gifts" },
  { id: "digitalCards", href: "/digital-cards", label: "البطاقات الرقمية", description: "مخزون وتسليم البطاقات", section: 2, icon: WalletCards, roles: ["admin", "manager", "accountant", "auditor"], module: "digital_cards" },
  { id: "reports", href: "/reports", label: "التقارير والكشوفات", description: "مالية وتشغيلية ورقابية", section: 3, icon: BarChart3 },
  { id: "chartOfAccounts", href: "/chart-of-accounts", label: "شجرة الحسابات", description: "دليل الحسابات والهيكل المالي", section: 3, icon: Landmark, roles: ["admin", "manager", "accountant", "auditor"], module: "reports" },
  { id: "statutoryAccounting", href: "/statutory-accounting", label: "الدليل المحاسبي النظامي", description: "تقارير وخرائط الامتثال المحاسبي", section: 3, icon: FileCheck2, roles: ["admin", "manager", "accountant", "auditor"], module: "reports" },
  { id: "exchange", href: "/exchange", label: "الصيرفة", description: "صرف وتسوية العملات", section: 3, icon: DollarSign, roles: ["admin", "manager", "accountant"], module: "treasury" },
  { id: "assets", href: "/assets", label: "الأصول الثابتة", description: "سجلّ وإهلاك وعهدة", section: 5, icon: Server, managerOnly: true },
  { id: "hr", href: "/hr", label: "الموارد البشرية", description: "موظفون وحضور ورواتب", section: 5, icon: Briefcase, roles: ["admin", "manager", "accountant", "auditor"], module: "hr" },
  { id: "closing", href: "/closing", label: "الإقفال والرَقابة", description: "فترات واعتمادات وتوافق", section: 5, icon: Lock, roles: ["admin", "manager", "accountant", "auditor"], module: "reports" },
  { id: "settings", href: "/settings", label: "الإدارة والإعدادات", description: "فروع وأدوار وتكاملات", section: 5, icon: Settings, managerOnly: true },
] as const;

export const APPLICATION_MODULE_IDS = new Set(APPLICATION_MODULES.map((module) => module.id));
