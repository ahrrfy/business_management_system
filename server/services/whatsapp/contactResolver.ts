/**
 * ربط تلقائي بين مُرسِل واتساب (رقم wa_id خام مِن الـwebhook) وسجلّ عميل موجود — شريحة #١ (نواة
 * Cloud API). يُستدعى من webhookProcessor عند استقبال رسالة IN لمحادثة بلا customerId بعد.
 *
 * المطابقة: لاحقة آخر ١٠ أرقام (`phoneMatchSuffix` من `server/lib/similarMatch.ts` — نفس النواة
 * المستعملة في كاشف تشابه الأطراف) على الأعمدة الأربعة (phone/phone2/phone3/whatsapp)، عملاء
 * نشطين (isActive) فقط.
 *
 * ⚠️ **الحل العملي المُلزَم (قرار تصميم موثَّق):** مطابقة دقيقة بصيغة `RIGHT(REGEXP_REPLACE(col,
 * '[^0-9]',''),10) = suffix` تصحّ لكل صيغة كتابة لكنها تفرض دالة على كل صفّ ⇒ مسح كامل الجدول بلا
 * فهرس عند كل رسالة واردة. الأرقام في `customers` مخزَّنة E.164 غالباً (اتفاقية v3-add-screens)
 * و`idx_customer_phone` قائم على `phone` فقط ⇒ استعلام `LIKE '%<suffix>'` (suffix أرقام لاتينية
 * فقط من phoneMatchSuffix، لا حاجة لتفلية LIKE) عمليٌّ بما يكفي لحجم البيانات الحالي. أرقامٌ مخزَّنة
 * بصيغ شاذة (فراغات/بادئة غير قياسية) قد تُفلت من هذه المطابقة — نقصٌ مقبول موثَّق هنا، لا يُعالَج
 * في هذه الشريحة.
 *
 * **قاعدة صلبة:** أكثر من عميل مطابق للاحقة نفسها ⇒ **لا ربط أبداً** (الخطر ٤ في وثيقة التصميم —
 * ربطٌ أعمى بعميل خاطئ يُسرّب سياق حساب/ذمم لطرف مختلف).
 */
import { and, eq, like, or } from "drizzle-orm";
import { customers } from "../../../drizzle/schema";
import { phoneMatchSuffix } from "../../lib/similarMatch";
import { requireDb } from "../tx";

export type WaSenderResolution =
  | { kind: "single"; customerId: number }
  | { kind: "multiple"; count: number }
  | { kind: "none" };

/** يحاول ربط رقم واتساب (wa_id خام، بلا "+") بعميل واحد لا لبس فيه. */
export async function resolveWaSender(waId: string): Promise<WaSenderResolution> {
  const suffix = phoneMatchSuffix(waId);
  if (!suffix) return { kind: "none" };
  const db = requireDb();
  const pattern = `%${suffix}`;
  const rows = await db
    .select({ id: customers.id })
    .from(customers)
    .where(
      and(
        eq(customers.isActive, true),
        or(
          like(customers.phone, pattern),
          like(customers.phone2, pattern),
          like(customers.phone3, pattern),
          like(customers.whatsapp, pattern),
        ),
      ),
    );
  if (rows.length === 0) return { kind: "none" };
  if (rows.length > 1) return { kind: "multiple", count: rows.length };
  return { kind: "single", customerId: Number(rows[0].id) };
}
