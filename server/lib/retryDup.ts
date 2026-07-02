import { isDupEntry, isDeadlock } from "@shared/errorMap.ar";

/**
 * يعيد تنفيذ عملية ذرّية عند تصادم مفتاح فريد (ER_DUP_ENTRY) أو deadlock مؤقّت — الحارس الأخير
 * لأنماط الترقيم المعتمدة على GET_LOCK + قيد فريد (رقم الفاتورة/العرض/سند التسليم/التحويل).
 *
 * ⚠️ الشرط: يجب أن تكون `fn` **ذرّية بالكامل** (كل كتابتها داخل withTx واحد) كي تتراجع محاولةٌ فاشلة
 * تراجعاً كاملاً قبل إعادتها — وإلّا كرّرت الإعادة كتابةً جزئية. يعتمد الكشف على `isDupEntry` الذي يمشي
 * على سلسلة `cause` (Drizzle يلفّ خطأ mysql2) — الفحص العاري `e.code` لا يلتقط التصادم.
 */
export async function retryOnDup<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if ((isDupEntry(e) || isDeadlock(e)) && i < attempts - 1) continue;
      throw e;
    }
  }
  throw lastErr;
}
