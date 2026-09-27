/**
 * shared/assets.ts — ثوابت وحدة الأصول الثابتة، مشتركة بين الخادم والعميل.
 *
 * مصدر حقيقة واحد لفئات الأصول وحالاتها وطرق الإهلاك + تسمياتها العربية،
 * يُستعمل في تحقّق zod بالخادم وفي عرض الواجهة (لا تكرار للقوائم).
 */

export const ASSET_CATEGORIES = [
  { key: "computers", label: "أجهزة حاسوب", defaultLife: 4 },
  { key: "display", label: "شاشات وعرض", defaultLife: 5 },
  { key: "furniture", label: "أثاث مكتبي", defaultLife: 10 },
  { key: "vehicles", label: "مركبات ونقل", defaultLife: 8 },
  { key: "printing", label: "معدّات الطباعة", defaultLife: 7 },
  { key: "devices", label: "أجهزة تقنية", defaultLife: 5 },
] as const;
export type AssetCategory = (typeof ASSET_CATEGORIES)[number]["key"];

export const ASSET_STATUSES = [
  { key: "active", label: "بالخدمة" },
  { key: "maintenance", label: "في الصيانة" },
  { key: "retired", label: "خارج الخدمة" },
  { key: "disposed", label: "مُستبعَد" },
] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number]["key"];

export const DEPRECIATION_METHODS = [
  { key: "sl", label: "القسط الثابت", short: "ثابت" },
  { key: "db", label: "القسط المتناقص", short: "متناقص" },
] as const;
export type DepreciationMethod = (typeof DEPRECIATION_METHODS)[number]["key"];

export const assetCategoryLabel = (k: string): string =>
  ASSET_CATEGORIES.find((c) => c.key === k)?.label ?? k;
export const assetStatusLabel = (k: string): string =>
  ASSET_STATUSES.find((s) => s.key === k)?.label ?? k;
export const depreciationMethodLabel = (k: string): string =>
  DEPRECIATION_METHODS.find((m) => m.key === k)?.label ?? k;
export const categoryDefaultLife = (k: string): number =>
  ASSET_CATEGORIES.find((c) => c.key === k)?.defaultLife ?? 5;

// مصفوفات المفاتيح كـ tuples لاستعمالها مع z.enum (يلزمها [string, ...string[]]).
export const ASSET_CATEGORY_KEYS = ASSET_CATEGORIES.map((c) => c.key) as [
  AssetCategory,
  ...AssetCategory[],
];
export const ASSET_STATUS_KEYS = ASSET_STATUSES.map((s) => s.key) as [
  AssetStatus,
  ...AssetStatus[],
];
export const DEPRECIATION_METHOD_KEYS = DEPRECIATION_METHODS.map((m) => m.key) as [
  DepreciationMethod,
  ...DepreciationMethod[],
];

export const ASSET_ACQUISITION_TYPES = [
  {
    key: "OPENING",
    label: "أصل سابق لبناء النظام (رصيد افتتاحي / ممول مسبقاً)",
    short: "أصل افتتاحي",
    description: "أصل تم شراؤه وسداده بالكامل قبل بدء العمل بالنظام؛ لا يتطلب أي صرف نقدي من الخزينة ولا يولد سندات صرف.",
  },
  {
    key: "NEW_PURCHASE_CASH",
    label: "شراء نقدي جديد (من الخزينة)",
    short: "شراء نقدي",
    description: "شراء أصل نقداً في الوقت الحالي؛ يُنشئ طلب صرف نقدي يخضع للاعتماد والصرف من الخزينة.",
  },
  {
    key: "NEW_PURCHASE_SUPPLIER",
    label: "شراء آجل جديد (على ذمة مورد)",
    short: "آجل من مورد",
    description: "شراء أصل بالآجل من مورّد مسجل؛ يُسجل ذمة دائنة للمورد في الحسابات وتُسدد بدفعات لاحقة.",
  },
] as const;
export type AssetAcquisitionType = (typeof ASSET_ACQUISITION_TYPES)[number]["key"];
export const ASSET_ACQUISITION_TYPE_KEYS = ASSET_ACQUISITION_TYPES.map((t) => t.key) as [
  AssetAcquisitionType,
  ...AssetAcquisitionType[],
];
export const assetAcquisitionTypeLabel = (k: string): string =>
  ASSET_ACQUISITION_TYPES.find((t) => t.key === k)?.label ?? k;

