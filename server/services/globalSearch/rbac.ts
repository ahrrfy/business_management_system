// RBAC البحث الشامل (يطابق trpc.ts): كل نوعٍ يُحكَم بوحدة الصلاحية المطابِقة لبوّابة راوتره
// عبر hasModuleAccess (نفس دلالة requireModule بالضبط) لا بنموذج أدوارٍ خشن — فيستحيل أن يُظهِر
// البحثُ ما تمنعه شاشةُ النوع. يُغلق تسريب PII/الوثائق حيث كان دورٌ سُحبت عنه الوحدة
// (crm/sales/products/...) يظلّ يراه في البحث الشامل رغم أن وحدته NONE.
import { hasModuleAccess, type AccessLevel } from "@shared/permissions";
import type { SearchEntityType } from "./types";

const MASTER_DATA_TYPES: ReadonlyArray<SearchEntityType> = ["PRODUCT", "CUSTOMER", "SUPPLIER"];

const BRANCH_SCOPED_TYPES: ReadonlyArray<SearchEntityType> = [
  "INVOICE",
  "QUOTATION",
  "PURCHASE_ORDER",
  "WORK_ORDER",
  "EXPENSE",
];

/** كيانات إدارية حسّاسة: الموظف (وحدة hr) والمستخدم (إدارة فقط). */
const ADMIN_TYPES: ReadonlyArray<SearchEntityType> = ["EMPLOYEE", "USER"];

/**
 * تقييدٌ إضافيّ **فوق** فحص الوحدة: أنواع المستندات المديرية تبقى مخفيّةً في البحث الشامل عن
 * الأدوار غير المرتفعة/المحاسب حتى لو أتاحتها وحدتها (سلوكٌ قائمٌ مقصود — لا يوسّع وصولاً أبداً،
 * إذ يُطبَّق بعد أن تكون الوحدة قد سمحت).
 */
const MANAGER_ONLY_TYPES: ReadonlyArray<SearchEntityType> = ["SUPPLIER", "PURCHASE_ORDER", "EXPENSE"];

/**
 * وحدة الصلاحية الحارِسة لكل نوع — **مصدر الحقيقة: بوّابات راوترات `server/trpc.ts`**:
 *  CUSTOMER→crm (customersReadProcedure=requireModule("crm"))، الفاتورة/العرض→sales،
 *  الشراء→purchases، المصروف→expenses، أمر الشغل→workorders، المنتج→products، المورّد→suppliers،
 *  الموظف→hr. USER: إدارة المستخدمين بلا وحدةٍ مستقلّة ⇒ للأدمن فقط (null).
 */
const TYPE_MODULE: Record<SearchEntityType, string | null> = {
  PRODUCT: "products",
  CUSTOMER: "crm",
  SUPPLIER: "suppliers",
  INVOICE: "sales",
  QUOTATION: "sales",
  PURCHASE_ORDER: "purchases",
  WORK_ORDER: "workorders",
  EXPENSE: "expenses",
  EMPLOYEE: "hr",
  USER: null,
};

function isElevated(role: string) {
  return role === "admin" || role === "manager";
}

/**
 * هل يرى هذا الدور هذا النوع في البحث الشامل؟ البوّابة الأساس = خريطة الصلاحيات المحلولة
 * (قالب الدور + permissionsOverride) تُحقّق READ على وحدة النوع — **نفس دلالة requireModule
 * على راوتر كلٍّ منها بالضبط** (عبر hasModuleAccess) ⇒ لا تسريبَ لدورٍ سُحبت عنه الوحدة، ولا
 * حجبَ خاطئ عن دورٍ مُنِحها صراحةً. ثم تقييدٌ إضافيّ يُبقي أنواع المستندات المديرية مخفيّةً عن
 * الأدوار الأدنى (لا يوسّع وصولاً).
 */
export function canSeeType(
  role: string,
  type: SearchEntityType,
  override?: Record<string, AccessLevel> | null,
): boolean {
  // الإدارة ترى كل شيء (يطابق اختصار requireModule للأدمن).
  if (role === "admin") return true;
  const moduleKey = TYPE_MODULE[type];
  // إدارة المستخدمين (USER) بلا «وحدة صلاحيات» مستقلّة ⇒ للأدمن فقط (يطابق adminProcedure في userRouter).
  if (moduleKey === null) return false;
  // البوّابة الأساس: يجب أن تُتيح خريطةُ الصلاحيات المحلولة قراءةَ الوحدة — يُغلق تسريب crm=NONE/sales=NONE...
  if (!hasModuleAccess(role, override ?? null, moduleKey, "READ")) return false;
  // تقييدٌ إضافيّ محفوظ: المورّد/الشراء/المصروف تبقى مديريةً في البحث الشامل للأدوار الأدنى.
  if (isElevated(role) || role === "accountant") return true;
  return !MANAGER_ONLY_TYPES.includes(type);
}

export { isElevated, MASTER_DATA_TYPES, BRANCH_SCOPED_TYPES, ADMIN_TYPES };
