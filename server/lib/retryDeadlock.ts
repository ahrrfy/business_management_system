// إعادة محاولة على deadlock/قفلٍ منتهي المهلة — لعمليات idempotent فقط.
//
// مراجعة ش٤ العدائية: القراءة القافلة على نطاقٍ فارغ (heldNetOfDraft/refunded FOR UPDATE)
// تمنح معاملتين متزامنتين قفلَ **الفجوة نفسها** (أقفال الفجوات متوافقة بينها في InnoDB)،
// ثم إدراجُ كلٍّ في الفجوة ينتظر الآخر ⇒ ER_LOCK_DEADLOCK حتميّ لأوّل قبضَين متزامنين على
// مسوّدتين مختلفتين — لا تنافس ماليّاً بينهما أصلاً. الإعادة آمنة حتماً: مفتاح idempotency
// يُكتب داخل المعاملة المُدحرَجة فلا يبقى أثر، والمحاولة التالية إمّا تمرّ طازجةً أو تعيد replay.
// (نمط RETRYABLE في stocktake/create.ts — مرفوعٌ هنا موضعاً مشتركاً.)
import { randomInt } from "node:crypto";
import { mysqlCodeFrom } from "@shared/errorMap.ar";

const RETRYABLE = new Set(["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"]);
const MAX_ATTEMPTS = 3;

export async function retryOnDeadlock<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (e: unknown) {
      const code = mysqlCodeFrom(e);
      if (code && RETRYABLE.has(code) && attempt < MAX_ATTEMPTS - 1) {
        // تراجعٌ قصير عشوائيّ يكسر تناظر الـdeadlock بين المعاملتين.
        await new Promise((r) => setTimeout(r, 15 + randomInt(60)));
        lastErr = e;
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}
