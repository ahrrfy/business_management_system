import { moduleAccessAllowed, type PermissionMap } from "@shared/permissions";

const UNKNOWN_BARCODE_MESSAGE_FRAGMENT = "لا يطابق باركود أيّ منتجٍ أو بديلٍ في الكتالوج";

export type ProductUnitResolutionState = "loading" | "error" | "missing" | "ready";

type StudioBarcodeLinkInput = {
  authorized: boolean;
  barcode: string;
  variantId: number;
  unitName: string;
};

type StudioBarcodeLinkDependencies = {
  resolveProductUnitId: (input: { variantId: number; unitName: string }) => Promise<number | null>;
  addAlias: (input: ReturnType<typeof buildStudioBarcodeAliasInput>) => Promise<unknown>;
};

export function isUnknownStudioBarcodeFailure(
  code: string | undefined,
  message: string,
): boolean {
  return code === "NOT_FOUND" && message.includes(UNKNOWN_BARCODE_MESSAGE_FRAGMENT);
}

export function shouldSubmitManualBarcode(key: string, defaultPrevented: boolean): boolean {
  return key === "Enter" && !defaultPrevented;
}

export function canManageStudioBarcodeAliases(
  role: string | undefined,
  permissionsOverride: PermissionMap | null | undefined,
): boolean {
  return (
    !!role &&
    (moduleAccessAllowed(
      role,
      permissionsOverride,
      "products",
      "FULL",
      ["admin", "manager"],
    ) ||
      moduleAccessAllowed(
        role,
        permissionsOverride,
        "productStudio",
        "FULL",
        ["admin", "manager", "print_operator"],
      ))
  );
}

export function getProductUnitResolutionState(input: {
  isLoading: boolean;
  isError: boolean;
  productUnitId: number | null;
}): ProductUnitResolutionState {
  if (input.isLoading) return "loading";
  if (input.isError) return "error";
  return input.productUnitId == null ? "missing" : "ready";
}

export function buildStudioBarcodeAliasInput(productUnitId: number, barcode: string) {
  return {
    productUnitId,
    // لا نقلّم هنا: مخطّط API هو حدّ التطبيع الحاكم، والمسافات الداخليّة في Code39 معنويّة.
    barcode,
    note: "رُبط من استوديو المنتجات",
  };
}

export async function linkStudioBarcodeAlias(
  input: StudioBarcodeLinkInput,
  dependencies: StudioBarcodeLinkDependencies,
): Promise<number> {
  if (!input.authorized) {
    throw new Error("ربط باركود جديد يتطلب صلاحية تعديل المنتجات أو استوديو المنتجات.");
  }
  if (!Number.isSafeInteger(input.variantId) || input.variantId <= 0 || input.unitName === "") {
    throw new Error("اختر المتغيّر والوحدة قبل ربط الباركود.");
  }

  // الحلّ الخادمي في لحظة الحفظ يمنع ربط alias إلى وحدة قديمة أو إلى وحدة تحمل
  // الاسم نفسه في متغيّر آخر. لا نستنتج productUnitId من ترتيب خيارات الواجهة.
  const productUnitId = await dependencies.resolveProductUnitId({
    variantId: input.variantId,
    unitName: input.unitName,
  });
  if (productUnitId == null) {
    throw new Error("تعذّر تحديد الوحدة المختارة. حدّث بيانات المنتج ثم أعد اختيار المتغيّر والوحدة.");
  }

  await dependencies.addAlias(buildStudioBarcodeAliasInput(productUnitId, input.barcode));
  return productUnitId;
}
