/**
 * حارس التزامن التقني لنداءات مزوّدي استوديو الصور.
 *
 * لا يفرض حصصاً يومية ولا عدداً لكل مستخدم أو فرع؛ الميزانية يحكمها المزود نفسه. وظيفته
 * الوحيدة منع اندفاع اتصالات خارجية متوازية قد تخنق عامل الويب أو المزوّد. القفل موزّع عبر
 * MySQL، ولذلك تشترك فيه جميع عمال PM2 من دون عدادات استعمال تجارية داخل النظام.
 */
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { getPool } from "../db";
import { imageStoreTenantPrefix } from "../lib/imageStore/tenantNamespace";

export type ImageStudioService = "REMOVEBG" | "AI";

const MAX_CONCURRENT_CALLS = 2;

export type ImageStudioGuardErrorKind = "BUSY";

export class ImageStudioGuardError extends Error {
  constructor(public readonly kind: ImageStudioGuardErrorKind) {
    super(imageStudioGuardErrorMessageAr(kind));
    this.name = "ImageStudioGuardError";
  }
}

export function imageStudioGuardErrorMessageAr(_kind: ImageStudioGuardErrorKind): string {
  return "الاستوديو مشغول حالياً. انتظر لحظة ثم أعد المحاولة.";
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

export async function runGuardedImageStudioCall<T>(args: {
  service: ImageStudioService;
  userId: number;
  /** سياق تدقيقي للمستدعي؛ لا تُشتق منه أي حصة أو حد استخدام. */
  branchId?: number | null;
  run: () => Promise<T>;
}): Promise<T> {
  const slot = await acquireExecutionSlot();
  try {
    return await args.run();
  } finally {
    await releaseExecutionSlot(slot);
  }
}

/** معزول للاختبارات فقط؛ لا يستخدمه مسار الإنتاج. */
export function __resetImageStudioUsageGuardForTests(): void {}
