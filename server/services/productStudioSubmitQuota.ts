/**
 * سقف الإرسال اليوميّ لكل منفّذ في استوديو المنتجات.
 *
 * لماذا وُجد أصلاً: `imageStudioUsageGuard` يحرس المزوّدين المدفوعين وحدهم، ومسار
 * `submitCandidate` المجّاني كان بلا سقف. كل إرسال يكتب حتى كائنَين معنونَين بمحتواهما
 * (لا يُستبدَل سابقٌ أبداً) والكنس معطَّلٌ افتراضياً (لا يُستردّ شيء) ⇒ الحدّ الوحيد كان
 * محدّد المعدّل العامّ للـIP.
 *
 * لماذا بالبايتات: الكلفة تخزينٌ لا استدعاء. منفّذٌ يرسل صوراً كبيرة يستهلك أضعاف من
 * يرسل صغيرة بالعدد نفسه، فالعدّ بالنداءات وحده يترك الباب مفتوحاً.
 *
 * لماذا حجزٌ لا محاسبةٌ بعدية: يُستدعى **قبل** الرفع إلى المخزن داخل معاملة الحجز نفسها،
 * فلا يُكتب بايتٌ واحد قبل أن يُثبَت أنّ له رصيداً. وحين يفشل ما بعده لا نُعيد الرصيد:
 * الكائن المعنون بمحتواه يكون قد كُتب فعلاً — الاستهلاك وقع.
 */
import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import { productStudioSubmitQuota } from "../../drizzle/schema";
import type { withTx } from "./tx";

type StudioTx = Parameters<Parameters<typeof withTx>[0]>[0];

function boundedEnvInt(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

/** حدودٌ متحفّظة تُضبَط من بيئة الخادم وحدها — لا من إدخال مستخدم ولا من الواجهة. */
export function studioSubmitDailyLimits() {
  return {
    submits: boundedEnvInt("PRODUCT_STUDIO_SUBMIT_DAILY_LIMIT", 200, 1, 100_000),
    bytes: boundedEnvInt("PRODUCT_STUDIO_SUBMIT_DAILY_MB", 200, 1, 1_000_000) * 1024 * 1024,
  };
}

/** حجم الحمولة المرفوعة تقريباً من نصّ data URL بلا فكّ ترميزٍ كامل (٤ محارف base64 = ٣ بايت). */
export function studioPayloadBytes(...dataUrls: (string | null | undefined)[]): number {
  let total = 0;
  for (const dataUrl of dataUrls) {
    if (!dataUrl) continue;
    const comma = dataUrl.indexOf(",");
    const payload = comma >= 0 ? dataUrl.length - comma - 1 : dataUrl.length;
    total += Math.max(0, Math.floor((payload * 3) / 4));
  }
  return total;
}

/**
 * يحجز إرسالاً واحداً بحجمه داخل معاملة القادم. يرمي `TOO_MANY_REQUESTS` عند التجاوز.
 * يوم UTC — نفس حدّ اليوم المعتمد في هذه الوحدة.
 */
export async function reserveStudioSubmitQuotaInTx(tx: StudioTx, userId: number, bytes: number, now = new Date()): Promise<{ submitCount: number; bytesWritten: number }> {
  const usageDate = now.toISOString().slice(0, 10);
  const limits = studioSubmitDailyLimits();
  await tx
    .insert(productStudioSubmitQuota)
    .values({ usageDate, userId, submitCount: 0, bytesWritten: 0, lastSubmittedAt: now })
    .onDuplicateKeyUpdate({ set: { lastSubmittedAt: sql`${productStudioSubmitQuota.lastSubmittedAt}` } });
  // القفل بعد ضمان وجود الصفّ: بدونه يمرّ إرسالان متزامنان من نفس المنفّذ على قراءةٍ واحدة.
  const [row] = await tx
    .select({ id: productStudioSubmitQuota.id, submitCount: productStudioSubmitQuota.submitCount, bytesWritten: productStudioSubmitQuota.bytesWritten })
    .from(productStudioSubmitQuota)
    .where(and(eq(productStudioSubmitQuota.usageDate, usageDate), eq(productStudioSubmitQuota.userId, userId)))
    .for("update");
  if (!row)
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "تعذّر حجز سقف الإرسال",
    });
  if (row.submitCount >= limits.submits)
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: `بلغتَ سقف الإرسال اليوميّ (${limits.submits} إرسالاً). راجع المدير أو أكمِل غداً.`,
    });
  if (row.bytesWritten + bytes > limits.bytes)
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: `بلغتَ سقف حجم الصور اليوميّ (${Math.round(limits.bytes / (1024 * 1024))} ميغابايت). صغّر الصورة أو أكمِل غداً.`,
    });
  const submitCount = row.submitCount + 1;
  const bytesWritten = row.bytesWritten + bytes;
  await tx
    .update(productStudioSubmitQuota)
    .set({ submitCount, bytesWritten, lastSubmittedAt: now })
    .where(eq(productStudioSubmitQuota.id, row.id));
  return { submitCount, bytesWritten };
}
