// أدوات مشتركة: تطبيع نتيجة execute الخام، تسمية طرق الدفع بالعربية، وتصنيف الأدوار الكاشيرية.
// داخلية للحزمة فقط — لا تُصدَّر من نقطة الدخول العامة.

function rowsOf(res: unknown): any[] {
  const data = (res as any)?.[0] ?? res;
  return Array.isArray(data) ? data : [];
}

const PAY_METHOD_AR: Record<string, string> = {
  CASH: "نقدي",
  CARD: "بطاقة",
  CHECK: "صك",
  TRANSFER: "تحويل",
  WALLET: "محفظة",
};

const isCashier = (role: string | null | undefined) => role === "cashier" || role === "warehouse" || role === "print_operator";


export { rowsOf, PAY_METHOD_AR, isCashier };
