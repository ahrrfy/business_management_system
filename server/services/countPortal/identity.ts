// هوية عامل بوابة العدّ: مصادقة PIN/USER وحلّ الهوية من الكوكي أو مستخدم النظام.
//
// ملاحظة: قفل تكليفات PIN عند الفشل الجماعي أُزيل (كان DoS تشغيلي). الحماية من التخمين
// عبر حدّ معدّل IP لـcount.auth في server/index.ts (COUNT_RATE_LIMIT_MAX = 10/15د).
// lockedUntil يبقى مدعوماً للقفل اليدوي الإداري من إدارة الجرد.
import { TRPCError } from "@trpc/server";
import { parse as parseCookie } from "cookie";
import { and, eq } from "drizzle-orm";
import {
  stocktakeAssignments,
  stocktakeSessions,
  type StocktakeAssignment,
  type StocktakeSession,
  type User,
} from "../../../drizzle/schema";
import { DUMMY_STORED, verifyPassword } from "../../auth/password";
import type { TrpcContext } from "../../context";
import { requireDb } from "../tx";
import { COUNT_COOKIE_NAME, signCountToken, verifyCountToken } from "./token";
import { SESSION_UNAVAILABLE_MSG, IDENTITY_EXPIRED_MSG } from "./shared";

/** هوية عامل العدّ المُحلَّلة — تُمرَّر لكل إجراءات البوابة. */
export type PortalIdentity = {
  session: StocktakeSession;
  assignment: StocktakeAssignment;
  /** اسم العدّاد كما يُسجَّل على كل عدّة (countedByName). */
  countedByName: string;
  /** معرّف مستخدم النظام إن كانت الهوية تكليف USER، وإلا null للعامل الخارجي. */
  countedByUserId: number | null;
  mode: "PIN" | "USER";
};

async function findSessionByCode(code: string): Promise<StocktakeSession | null> {
  const db = requireDb();
  const normalized = code.trim().toUpperCase();
  if (!normalized) return null;
  const rows = await db
    .select()
    .from(stocktakeSessions)
    .where(eq(stocktakeSessions.code, normalized))
    .limit(1);
  return rows[0] ?? null;
}

export type PortalAuthResult = {
  session: StocktakeSession;
  assignment: StocktakeAssignment;
  mode: "PIN" | "USER";
  /** يُصدَر لوضع PIN فقط — يضعه الراوتر في كوكي count_token. null لوضع USER. */
  token: string | null;
};

/**
 * مصادقة بوابة العدّ (العقد §٥ — `auth`): جلسة COUNTING فقط.
 * - PIN: تجربة كل تكليفات PIN غير المقفلة بالجلسة (`verifyPassword` — scrypt timing-safe).
 *   فشل ⇒ زيادة `failedPinAttempts` على كل التكليفات غير المقفلة، وعند بلوغ 5 ⇒
 *   `lockedUntil = +15 دقيقة` وتصفير العدّاد (نمط registerFailedLogin في authRouter).
 *   نجاح ⇒ تصفير العدّاد والقفل + إصدار توكن JWT للكوكي.
 * - بلا PIN: مستخدم نظام مسجَّل له تكليف method=USER مطابق في الجلسة.
 */
export async function authenticatePin(
  user: User | null,
  input: { sessionCode: string; pin?: string }
): Promise<PortalAuthResult> {
  const db = requireDb();
  const session = await findSessionByCode(input.sessionCode);

  if (!session || session.status !== "COUNTING") {
    // توحيد التوقيت مع مسار PIN الفاشل: scrypt على تجزئة وهمية كي لا يكشف زمنُ
    // الردّ وجودَ الجلسة من عدمه لمن يخمّن رموز الجلسات.
    if (input.pin) verifyPassword(input.pin, DUMMY_STORED);
    throw new TRPCError({ code: "NOT_FOUND", message: SESSION_UNAVAILABLE_MSG });
  }

  if (input.pin) {
    const pin = input.pin;
    const pinAssignments = await db
      .select()
      .from(stocktakeAssignments)
      .where(
        and(
          eq(stocktakeAssignments.sessionId, session.id),
          eq(stocktakeAssignments.method, "PIN")
        )
      );

    const nowMs = Date.now();
    const unlocked = pinAssignments.filter(
      (a) => !a.lockedUntil || new Date(a.lockedUntil).getTime() <= nowMs
    );

    // كل تكليفات PIN مقفلة ⇒ رسالة قفل صريحة (لا نجرّب ولا نزيد العدّادات).
    if (pinAssignments.length > 0 && unlocked.length === 0) {
      verifyPassword(pin, DUMMY_STORED); // توحيد التوقيت مع مسار التجربة
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: "أُوقف الدخول مؤقتاً بعد محاولات خاطئة متكررة — حاول بعد 15 دقيقة أو راجع مسؤول الجرد.",
      });
    }

    // جرّب التكليفات غير المقفلة — كل مقارنة scrypt timing-safe.
    const matched =
      unlocked.find((a) => a.pinHash != null && verifyPassword(pin, a.pinHash)) ?? null;

    if (!matched) {
      // غياب أي مرشّح للمقارنة (جلسة بلا تكليفات PIN) ⇒ scrypt وهمي لتوحيد التوقيت.
      if (unlocked.length === 0) verifyPassword(pin, DUMMY_STORED);
      // ⚠️ كنّا نزيد العدّاد على كل تكليفات PIN غير المقفلة ⇒ ٥ محاولات خاطئة (من أيّ طرف،
      // داخلي أو خارجي يخمّن رمز الجلسة CNT-YYYY-NNNN) تقفل كل عمّال العدّ الميدانيين ١٥ دقيقة
      // فتشلّ يوم الجرد كلّه — DoS تشغيلي. الحماية من التخمين موكولة الآن لحدّ المعدّل على IP
      // (COUNT_RATE_LIMIT_MAX=10/15د في server/index.ts) — لا قفل صفوف جماعي على PIN خاطئ
      // غير منسوب لتكليف بعينه. القفل اليدوي (lockedUntil) يبقى متاحاً لحالات إدارية صريحة.
      throw new TRPCError({ code: "UNAUTHORIZED", message: "رمز الدخول غير صحيح — حاول مجدداً." });
    }

    // نجاح ⇒ صفّر العدّاد والقفل (دون إفشال الدخول إن تعثّر التحديث) وأصدر التوكن.
    await db
      .update(stocktakeAssignments)
      .set({ failedPinAttempts: 0, lockedUntil: null })
      .where(eq(stocktakeAssignments.id, matched.id))
      .catch(() => {});

    const token = await signCountToken(Number(session.id), Number(matched.id));
    return { session, assignment: matched, mode: "PIN", token };
  }

  // بلا PIN: مستخدم نظام مسجَّل له تكليف USER في هذه الجلسة.
  if (!user) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "أدخل رمز الدخول (PIN) الذي زوّدك به مسؤول الجرد، أو سجّل الدخول بحسابك إن كان التكليف باسم حسابك.",
    });
  }
  const rows = await db
    .select()
    .from(stocktakeAssignments)
    .where(
      and(
        eq(stocktakeAssignments.sessionId, session.id),
        eq(stocktakeAssignments.method, "USER"),
        eq(stocktakeAssignments.userId, user.id)
      )
    )
    .limit(1);
  const assignment = rows[0];
  if (!assignment) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "لا يوجد تكليف عدّ باسم حسابك في هذه الجلسة — راجع مسؤول الجرد.",
    });
  }
  return { session, assignment, mode: "USER", token: null };
}

/**
 * يحلّ هوية عامل البوّابة: كوكي count_token (وضع PIN) أولاً، ثم مستخدم النظام
 * المسجَّل بتكليف USER. لا يقيّد حالة الجلسة (state يعمل بعد REVIEW ليعرض
 * «سلّمت العدّ») — أمّا submit/finish فيتحقّقان من COUNTING/ACTIVE داخل المعاملة.
 */
export async function resolvePortalIdentity(
  ctx: Pick<TrpcContext, "req" | "user">,
  sessionCode: string
): Promise<PortalIdentity> {
  const db = requireDb();
  const session = await findSessionByCode(sessionCode);
  if (!session) throw new TRPCError({ code: "NOT_FOUND", message: SESSION_UNAVAILABLE_MSG });

  // ١) كوكي بوابة العدّ (وضع PIN) — يجب أن يطابق sid جلسةَ الرابط نفسها.
  const cookies = parseCookie(ctx.req.headers.cookie ?? "");
  const payload = await verifyCountToken(cookies[COUNT_COOKIE_NAME]);
  if (payload && payload.sid === Number(session.id)) {
    const rows = await db
      .select()
      .from(stocktakeAssignments)
      .where(
        and(
          eq(stocktakeAssignments.id, payload.aid),
          eq(stocktakeAssignments.sessionId, session.id)
        )
      )
      .limit(1);
    const assignment = rows[0];
    if (assignment) {
      return {
        session,
        assignment,
        countedByName: assignment.name,
        countedByUserId: null,
        mode: "PIN",
      };
    }
  }

  // ٢) مستخدم النظام المسجَّل بتكليف USER مطابق.
  if (ctx.user) {
    const rows = await db
      .select()
      .from(stocktakeAssignments)
      .where(
        and(
          eq(stocktakeAssignments.sessionId, session.id),
          eq(stocktakeAssignments.method, "USER"),
          eq(stocktakeAssignments.userId, ctx.user.id)
        )
      )
      .limit(1);
    const assignment = rows[0];
    if (assignment) {
      return {
        session,
        assignment,
        countedByName: assignment.name,
        countedByUserId: ctx.user.id,
        mode: "USER",
      };
    }
  }

  throw new TRPCError({ code: "UNAUTHORIZED", message: IDENTITY_EXPIRED_MSG });
}
