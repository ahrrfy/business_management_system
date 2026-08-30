import { randomInt } from "node:crypto";
import { isDupEntry, isDeadlock, mysqlCodeFrom } from "@shared/errorMap.ar";

/** تراجعٌ قصير عشوائيّ يكسر تناظر المعاملتين المتصادمتين (نفس نمط retryOnDeadlock). */
const jitterPause = () => new Promise((r) => setTimeout(r, 15 + randomInt(60)));

/**
 * يعيد تنفيذ عملية ذرّية عند تصادم مفتاح فريد (ER_DUP_ENTRY) أو deadlock مؤقّت — الحارس الأخير
 * لأنماط الترقيم المعتمدة على GET_LOCK + قيد فريد (رقم الفاتورة/العرض/سند التسليم/التحويل).
 *
 * ⚠️ الشرط: يجب أن تكون `fn` **ذرّية بالكامل** (كل كتابتها داخل withTx واحد) كي تتراجع محاولةٌ فاشلة
 * تراجعاً كاملاً قبل إعادتها — وإلّا كرّرت الإعادة كتابةً جزئية. يعتمد الكشف على `isDupEntry` الذي يمشي
 * على سلسلة `cause` (Drizzle يلفّ خطأ mysql2) — الفحص العاري `e.code` لا يلتقط التصادم.
 *
 * فحص الحمل ٣٠/٨/٢٦: تصادم المفتاح يُعاد فوراً (القيمة التالية متاحة فوراً)، أمّا الجمود/مهلة
 * القفل فتُكسَر بتراجعٍ عشوائيّ قصير يفكّ تناظر المعاملتين — نفس نمط `retryOnDeadlock`.
 */
/**
 * للحلقات اليدوية في الراوترات (تحمل logAudit داخلها فلا تلائم الغلاف أدناه):
 * يُرجع true إن كان الخطأ يستحقّ إعادة محاولة. الشرط ذاته: العملية المُعادة ذرّية
 * بالكامل (withTx واحد). قبله كانت حلقات sales.create/printPos.createSale/
 * purchases.receive/workOrders.deliver تفحص isDupEntry وحده ⇒ ضحيّة deadlock تصل
 * الكاشير 500 بدل محاولة صامتة (فحص ٣٠/٨/٢٦).
 *
 * الدلالات بحسب الخطأ (مراجعة عدائية ٣٠/٨):
 * - تكرار مفتاح (1062): إعادة فورية بلا تراجع — القيمة التالية متاحة فوراً.
 * - deadlock (1213): إعادة بعد تراجع قصير — الضحيّة تُدحرَج فوراً والإعادة شبه مضمونة.
 * - مهلة قفل (1205): **محاولة إضافية واحدة فقط** — المهلة تعني أن الحاجز صمد
 *   innodb_lock_wait_timeout كاملة (10ث على هذا النشر) والغالب أنه ما زال قائماً؛
 *   الإصرار الثلاثي كان يحوّل كل طلبٍ محجوب إلى ~30ث من اتصالٍ محجوز وعاصفة
 *   إعادةٍ متزامنة على الصفّ المتنازَع — عكس أهداف حملة الحمل نفسها.
 */
export async function pauseIfRetryableDbError(e: unknown, attempt = 0): Promise<boolean> {
  const code = mysqlCodeFrom(e);
  if (code === "ER_DUP_ENTRY") return true;
  if (code === "ER_LOCK_DEADLOCK") {
    await jitterPause();
    return true;
  }
  if (code === "ER_LOCK_WAIT_TIMEOUT" && attempt === 0) {
    await jitterPause();
    return true;
  }
  return false;
}

export async function retryOnDup<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const dup = isDupEntry(e);
      if ((dup || isDeadlock(e)) && i < attempts - 1) {
        if (!dup) await new Promise((r) => setTimeout(r, 15 + randomInt(60)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}
