import { TRPCError } from "@trpc/server";

export const LEGACY_PURCHASE_WRITE_REPLACEMENTS = {
  "purchases.receive": "/purchases/goods-receipts",
  "purchases.pay": "/purchases/supplier-payments",
  "purchaseReturns.create": "/purchases/returns-governance",
} as const;

export type LegacyPurchaseWritePath = keyof typeof LEGACY_PURCHASE_WRITE_REPLACEMENTS;

/**
 * بوابة cutover نهائية على حد API: الخدمات القديمة تبقى للقراءة/اختبارات الترحيل التاريخية،
 * لكن لا يُسمح لأي قناة إنتاجية أن تنشئ بها مخزوناً أو نقداً أو ذمماً بعد تفعيل GRN/Supplier Invoice.
 */
export function assertLegacyPurchaseWritePathDisabled(path: LegacyPurchaseWritePath): never {
  const replacement = LEGACY_PURCHASE_WRITE_REPLACEMENTS[path];
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message: `أُغلق المسار القديم ${path} بعد تفعيل حوكمة المشتريات؛ استخدم المسار المحكوم ${replacement}`,
  });
}
