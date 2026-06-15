import type { Customer, Supplier, PurchaseOrderItem } from "../../drizzle/schema";

/** الأدوار المرفوعة التي تَرى كل الحقول الحسّاسة (تكلفة/مصرفية/أرصدة).
 *  متّسق مع canSeeCost في server/trpc.ts و@shared/permissions.
 */
const ELEVATED_ROLES = new Set(["admin", "manager"]);

const isElevated = (role: string | null | undefined): boolean =>
  !!role && ELEVATED_ROLES.has(role);

/** يحجب حقول التكلفة من بند شراء/استلام (unitPrice/unitCost/total/costTotal)
 *  باستبدالها بـnull بدلاً من حذفها — يَحفظ تَوقيع النوع للمستهلكين.
 */
export function maskCostFields<T extends Partial<PurchaseOrderItem> & Record<string, unknown>>(row: T, role: string | null | undefined): T;
export function maskCostFields<T extends Partial<PurchaseOrderItem> & Record<string, unknown>>(row: T | null, role: string | null | undefined): T | null;
export function maskCostFields<T extends Partial<PurchaseOrderItem> & Record<string, unknown>>(row: T | undefined, role: string | null | undefined): T | undefined;
export function maskCostFields<T extends Partial<PurchaseOrderItem> & Record<string, unknown>>(
  row: T | null | undefined,
  role: string | null | undefined,
): T | null | undefined {
  if (row == null) return row;
  if (isElevated(role)) return { ...row };
  return {
    ...row,
    unitPrice: null,
    unitCost: null,
    total: null,
    costTotal: null,
  } as unknown as T;
}

/** يحجب الحقول المصرفية من المورّد (iban/bankName/swiftCode) باستبدالها بـnull. */
export function maskBankFields<T extends Partial<Supplier> & Record<string, unknown>>(row: T, role: string | null | undefined): T;
export function maskBankFields<T extends Partial<Supplier> & Record<string, unknown>>(row: T | null, role: string | null | undefined): T | null;
export function maskBankFields<T extends Partial<Supplier> & Record<string, unknown>>(row: T | undefined, role: string | null | undefined): T | undefined;
export function maskBankFields<T extends Partial<Supplier> & Record<string, unknown>>(
  row: T | null | undefined,
  role: string | null | undefined,
): T | null | undefined {
  if (row == null) return row;
  if (isElevated(role)) return { ...row };
  return {
    ...row,
    iban: null,
    bankName: null,
    swiftCode: null,
  } as unknown as T;
}

/** يحجب الحقول الحسّاسة من قائمة عملاء (الرصيد + سقف الائتمان) لغير المدير/الإدمن. */
export function maskCustomerSensitive<T extends Partial<Customer> & Record<string, unknown>>(row: T, role: string | null | undefined): T;
export function maskCustomerSensitive<T extends Partial<Customer> & Record<string, unknown>>(row: T | null, role: string | null | undefined): T | null;
export function maskCustomerSensitive<T extends Partial<Customer> & Record<string, unknown>>(row: T | undefined, role: string | null | undefined): T | undefined;
export function maskCustomerSensitive<T extends Partial<Customer> & Record<string, unknown>>(
  row: T | null | undefined,
  role: string | null | undefined,
): T | null | undefined {
  if (row == null) return row;
  if (isElevated(role)) return { ...row };
  return {
    ...row,
    creditLimit: null,
    currentBalance: "0",
  } as unknown as T;
}

/** يحجب الحقول الحسّاسة من قائمة موردين (الرصيد + المصرفية) لغير المدير/الإدمن. */
export function maskSupplierSensitive<T extends Partial<Supplier> & Record<string, unknown>>(row: T, role: string | null | undefined): T;
export function maskSupplierSensitive<T extends Partial<Supplier> & Record<string, unknown>>(row: T | null, role: string | null | undefined): T | null;
export function maskSupplierSensitive<T extends Partial<Supplier> & Record<string, unknown>>(row: T | undefined, role: string | null | undefined): T | undefined;
export function maskSupplierSensitive<T extends Partial<Supplier> & Record<string, unknown>>(
  row: T | null | undefined,
  role: string | null | undefined,
): T | null | undefined {
  if (row == null) return row;
  if (isElevated(role)) return { ...row };
  return {
    ...row,
    currentBalance: "0",
    iban: null,
    bankName: null,
  } as unknown as T;
}
