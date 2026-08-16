/**
 * حارس استهلاك مزوّدي استوديو الصور.
 *
 * لا يكتفي بحماية واجهة الاستوديو: كل نداء مدفوع يمرّ من هنا قبل الشبكة. السقف اليومي
 * محفوظ في MySQL (لا ينسى بعد إعادة تشغيل PM2)، أمّا التزامن ومعدل المستخدم فهما حارسان
 * لحظيّان لتفادي احتجاز event loop أو إطلاق عدد كبير من الاتصالات الخارجية.
 */
import { and, eq, sql } from "drizzle-orm";
import { imageStudioUsageDaily } from "../../drizzle/schema";
import { withTx } from "./tx";

export type ImageStudioService = "REMOVEBG" | "AI";

const MAX_CONCURRENT_CALLS = 2;
const USER_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_USER_WINDOW = 3;

function boundedEnvInt(name: string, fallback: number, maximum: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= 1 && value <= maximum ? value : fallback;
}

/** حدود متحفظة قابلة للضبط من بيئة الخادم فقط، وليست من إدخال مستخدم أو واجهة عمومية. */
export const IMAGE_STUDIO_DAILY_LIMITS: Record<ImageStudioService, number> = {
  REMOVEBG: boundedEnvInt("IMAGE_STUDIO_REMOVEBG_DAILY_LIMIT", 30, 1_000),
  AI: boundedEnvInt("IMAGE_STUDIO_AI_DAILY_LIMIT", 20, 1_000),
};

export type ImageStudioGuardErrorKind = "BUSY" | "RATE_LIMITED" | "DAILY_BUDGET_EXHAUSTED";

export class ImageStudioGuardError extends Error {
  constructor(public readonly kind: ImageStudioGuardErrorKind) {
    super(imageStudioGuardErrorMessageAr(kind));
    this.name = "ImageStudioGuardError";
  }
}

export function imageStudioGuardErrorMessageAr(kind: ImageStudioGuardErrorKind): string {
  switch (kind) {
    case "BUSY":
      return "الاستوديو مشغول حالياً. انتظر لحظة ثم أعد المحاولة.";
    case "RATE_LIMITED":
      return "أجريت عدداً كبيراً من محاولات الاستوديو خلال دقيقة. أعد المحاولة بعد قليل.";
    case "DAILY_BUDGET_EXHAUSTED":
      return "بلغ الاستوديو سقف الاستخدام اليومي المضبوط لحماية الميزانية. راجع المدير.";
  }
}

function baghdadDay(now = new Date()): string {
  const values = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Baghdad",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => values.find((value) => value.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

const recentCallsByUser = new Map<number, number[]>();
let activeCalls = 0;

function consumeUserRate(userId: number, now = Date.now()): void {
  const recent = (recentCallsByUser.get(userId) ?? []).filter((at) => now - at < USER_WINDOW_MS);
  if (recent.length >= MAX_REQUESTS_PER_USER_WINDOW) {
    recentCallsByUser.set(userId, recent);
    throw new ImageStudioGuardError("RATE_LIMITED");
  }
  recent.push(now);
  recentCallsByUser.set(userId, recent);
}

function acquireExecutionSlot(): () => void {
  if (activeCalls >= MAX_CONCURRENT_CALLS) throw new ImageStudioGuardError("BUSY");
  activeCalls += 1;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      activeCalls -= 1;
    }
  };
}

/**
 * يحجز نداءً واحداً بذرياً. لا توجد عملية «استرداد» بعد بدء الطريق الخارجي: انقطاع الشبكة
 * لا يثبت أبداً أن remove.bg/Gemini لم يتلقّ الطلب أو لم يقتطع الرصيد.
 */
export async function reserveDailyImageStudioUse(
  service: ImageStudioService,
  now = new Date(),
): Promise<{ usageDate: string; requestCount: number; dailyLimit: number }> {
  const usageDate = baghdadDay(now);
  const dailyLimit = IMAGE_STUDIO_DAILY_LIMITS[service];

  return withTx(async (tx) => {
    // يُنشئ الصف أو يقفل الموجود بلا زيادة؛ الزيادة لا تحدث إلا بعد فحص السقف تحت FOR UPDATE.
    await tx
      .insert(imageStudioUsageDaily)
      .values({ usageDate, service, requestCount: 0, lastRequestedAt: now })
      .onDuplicateKeyUpdate({ set: { lastRequestedAt: sql`${imageStudioUsageDaily.lastRequestedAt}` } });

    const [current] = await tx
      .select({ id: imageStudioUsageDaily.id, requestCount: imageStudioUsageDaily.requestCount })
      .from(imageStudioUsageDaily)
      .where(and(eq(imageStudioUsageDaily.usageDate, usageDate), eq(imageStudioUsageDaily.service, service)))
      .for("update");

    const requestCount = current?.requestCount ?? 0;
    if (!current || requestCount >= dailyLimit) throw new ImageStudioGuardError("DAILY_BUDGET_EXHAUSTED");

    const nextCount = requestCount + 1;
    await tx
      .update(imageStudioUsageDaily)
      .set({ requestCount: nextCount, lastRequestedAt: now })
      .where(eq(imageStudioUsageDaily.id, current.id));
    return { usageDate, requestCount: nextCount, dailyLimit };
  });
}

export async function runGuardedImageStudioCall<T>(args: {
  service: ImageStudioService;
  userId: number;
  run: () => Promise<T>;
}): Promise<T> {
  if (!Number.isSafeInteger(args.userId) || args.userId <= 0) {
    // لا ينبغي أن يحدث مع protectedProcedure؛ لا نسمح أبداً لمعرّف غير صالح بتجاوز حصة مستخدم.
    throw new ImageStudioGuardError("RATE_LIMITED");
  }

  const release = acquireExecutionSlot();
  try {
    consumeUserRate(args.userId);
    await reserveDailyImageStudioUse(args.service);
    return await args.run();
  } finally {
    release();
  }
}

/** معزول للاختبارات فقط؛ لا يستخدمه مسار الإنتاج. */
export function __resetImageStudioUsageGuardForTests(): void {
  activeCalls = 0;
  recentCallsByUser.clear();
}
