/**
 * حارس استهلاك مزوّدي استوديو الصور.
 *
 * لا يكتفي بحماية واجهة الاستوديو: كل نداء مدفوع يمرّ من هنا قبل الشبكة. السقف اليومي
 * محفوظ في MySQL (لا ينسى بعد إعادة تشغيل PM2). التزامن محميّ بقفلَي MySQL advisory على
 * اتصالين مخصصين، ومعدل المستخدم صف ثابت مقفول؛ لذلك الحدود مشتركة بين جميع عمال PM2
 * المتصلة بخادم MySQL نفسه، لا عدادات ذاكرة منفصلة.
 */
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import * as schema from "../../drizzle/schema";
import { imageStudioUsageDaily, imageStudioUserRateState } from "../../drizzle/schema";
import { getPool } from "../db";
import { reserveBranchBudgetInTx } from "./imageStudioBranchBudget";
import { imageStoreTenantPrefix } from "../lib/imageStore/tenantNamespace";
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

/** يوم الاستهلاك بتوقيت بغداد — مُصدَّرٌ ليقرأ الإعدادُ نفسَ حدّ اليوم الذي يُحاسِب عليه الحارس. */
export function baghdadDay(now = new Date()): string {
  const values = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Baghdad",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => values.find((value) => value.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/**
 * أسماء `GET_LOCK` منطاقُها **خادم MySQL** لا المخطّط، فاسمٌ ثابت يجعل فتحتَي التنفيذ
 * مشتركةً بين كل قواعد الخادم الواحد: في وضع تعدّد الشركات (أو أيّ نشرٍ يتشارك المثيل)
 * تحجب شركةٌ الأخرى بالكامل، وتنتظر الثانية حتى مهلة المزوّد قبل أن تُردّ بـBUSY.
 * التنطيق بالمستأجر يجعل السقف لكل شركة كما هو مقصود.
 */
function slotNames(): string[] {
  const tenant = imageStoreTenantPrefix();
  return Array.from({ length: MAX_CONCURRENT_CALLS }, (_, index) => `alroya:${tenant}:image-studio:slot:${index + 1}`);
}

type LockResult = RowDataPacket & { acquired: number | null };
type ReleaseResult = RowDataPacket & { released: number | null };

async function acquireExecutionSlot(): Promise<{ connection: PoolConnection; name: string }> {
  const connection = await getPool().getConnection();
  try {
    for (const name of slotNames()) {
      // الاسم من قائمة ثابتة والمهلة صفر: لا query مبني نصياً ولا عامل ينتظر اتصالاً محجوزاً.
      const [rows] = await connection.execute<LockResult[]>("SELECT GET_LOCK(?, 0) AS acquired", [name]);
      if (Number(rows[0]?.acquired) === 1) return { connection, name };
    }
    connection.release();
    throw new ImageStudioGuardError("BUSY");
  } catch (error) {
    if (!(error instanceof ImageStudioGuardError)) connection.destroy();
    throw error;
  }
}

async function releaseExecutionSlot(slot: { connection: PoolConnection; name: string }): Promise<void> {
  try {
    const [rows] = await slot.connection.execute<ReleaseResult[]>("SELECT RELEASE_LOCK(?) AS released", [slot.name]);
    if (Number(rows[0]?.released) !== 1) {
      slot.connection.destroy();
      return;
    }
    slot.connection.release();
  } catch {
    // قتل الاتصال هو مسار التحرير الآمن: MySQL يسقط named locks تلقائياً عند غلق مالكها.
    slot.connection.destroy();
  }
}

async function reserveSharedBudgets(
  connection: PoolConnection,
  service: ImageStudioService,
  userId: number,
  branchId: number | null,
  now = new Date(),
): Promise<void> {
  const usageDate = baghdadDay(now);
  const dailyLimit = IMAGE_STUDIO_DAILY_LIMITS[service];
  const connectionDb = drizzle(connection, { schema, mode: "default" });

  // نفس الاتصال الذي يملك named lock: لا نطلب اتصالاً ثانياً من pool فنسبب starvation عند ضغط العاملين.
  await connectionDb.transaction(async (tx) => {
    await tx.insert(imageStudioUserRateState).values({
      userId,
      windowStartedAt: now,
      requestCount: 0,
      lastRequestedAt: now,
    }).onDuplicateKeyUpdate({
      set: { lastRequestedAt: sql`${imageStudioUserRateState.lastRequestedAt}` },
    });
    const [rate] = await tx.select().from(imageStudioUserRateState)
      .where(eq(imageStudioUserRateState.userId, userId)).for("update");
    if (!rate) throw new ImageStudioGuardError("RATE_LIMITED");
    const withinWindow = now.getTime() - rate.windowStartedAt.getTime() < USER_WINDOW_MS;
    if (withinWindow && rate.requestCount >= MAX_REQUESTS_PER_USER_WINDOW) {
      throw new ImageStudioGuardError("RATE_LIMITED");
    }
    await tx.update(imageStudioUserRateState).set({
      windowStartedAt: withinWindow ? rate.windowStartedAt : now,
      requestCount: withinWindow ? rate.requestCount + 1 : 1,
      lastRequestedAt: now,
    }).where(eq(imageStudioUserRateState.userId, userId));

    await tx.insert(imageStudioUsageDaily)
      .values({ usageDate, service, requestCount: 0, lastRequestedAt: now })
      .onDuplicateKeyUpdate({ set: { lastRequestedAt: sql`${imageStudioUsageDaily.lastRequestedAt}` } });
    const [daily] = await tx.select({ id: imageStudioUsageDaily.id, requestCount: imageStudioUsageDaily.requestCount })
      .from(imageStudioUsageDaily)
      .where(and(eq(imageStudioUsageDaily.usageDate, usageDate), eq(imageStudioUsageDaily.service, service)))
      .for("update");
    if (!daily || daily.requestCount >= dailyLimit) {
      throw new ImageStudioGuardError("DAILY_BUDGET_EXHAUSTED");
    }
    await tx.update(imageStudioUsageDaily).set({
      requestCount: daily.requestCount + 1,
      lastRequestedAt: now,
    }).where(eq(imageStudioUsageDaily.id, daily.id));

    // حصّة الفرع **داخل المعاملة نفسها**: لو حُجز الشركيّ ثمّ رُفض الفرعيّ خارجها لبقي
    // النداء محسوباً على الشركة بلا مقابل — عدّادٌ ينزف على كل رفضٍ فرعيّ. والرفض هنا
    // يُرجِع الحجز الشركيّ معه. غياب الإعداد = بلا حدٍّ فرعيّ (صفر أثر).
    await reserveBranchBudgetInTx(tx, service, branchId, usageDate, now);
  });
}

export async function runGuardedImageStudioCall<T>(args: {
  service: ImageStudioService;
  userId: number;
  /** فرع المستدعي — `null` لمستخدمٍ بلا فرع: السقف الشركيّ وحده، بلا اختراع فرعٍ افتراضيّ. */
  branchId?: number | null;
  run: () => Promise<T>;
}): Promise<T> {
  if (!Number.isSafeInteger(args.userId) || args.userId <= 0) {
    // لا ينبغي أن يحدث مع protectedProcedure؛ لا نسمح أبداً لمعرّف غير صالح بتجاوز حصة مستخدم.
    throw new ImageStudioGuardError("RATE_LIMITED");
  }

  const slot = await acquireExecutionSlot();
  try {
    await reserveSharedBudgets(slot.connection, args.service, args.userId, args.branchId ?? null);
    return await args.run();
  } finally {
    await releaseExecutionSlot(slot);
  }
}

/** معزول للاختبارات فقط؛ لا يستخدمه مسار الإنتاج. */
export function __resetImageStudioUsageGuardForTests(): void {}
