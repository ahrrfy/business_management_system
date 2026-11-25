/** نطاق R2 ثابت للمنشأة الواحدة ("single") لضمان توافق 100% مع مفاتيح الصور الحالية وقواعد Bucket Lock. */
export function imageStoreTenantPrefix(): string {
  return "single";
}

/** جذر Studio هو أيضاً نطاق الاحتفاظ/المرآة. */
export function studioObjectRoot(): string {
  return `${imageStoreTenantPrefix()}/studio/`;
}

export function studioObjectPrefix(kind: "original" | "candidate"): string {
  return `${studioObjectRoot()}${kind}`;
}

/** لا يسمح مسار HTTP إلا بمشتق المرشّح المنشور داخل نطاق المنشأة. */
export function isCurrentTenantCandidateKey(key: string): boolean {
  return key.startsWith(`${studioObjectPrefix("candidate")}/`);
}

/** جذر مرفقات تخصيص طلبات المتجر (شعارات ومعاينات العملاء الخاصة — لا تُخدَم علناً). */
export function customizerObjectRoot(): string {
  return `${imageStoreTenantPrefix()}/storefront-customizer/`;
}

export function customizerObjectPrefix(kind: "logo" | "preview"): string {
  return `${customizerObjectRoot()}${kind}`;
}

/** يتحقّق أنّ مفتاح مرفق التخصيص يقع داخل نطاق المنشأة ومجلّد logo|preview حصراً. */
export function isCurrentTenantCustomizerKey(key: string): boolean {
  if (key.includes("..") || key.includes("\\")) return false;
  return (
    key.startsWith(`${customizerObjectPrefix("logo")}/`) ||
    key.startsWith(`${customizerObjectPrefix("preview")}/`)
  );
}
