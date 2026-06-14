// بوابة العدّ الخارجية (Stocktake Count Portal) — خدمة الهوية والعدّ والتسليم.
//
// عقد الشريحة §٥ (docs/stocktake-contract.md): الهوية عبر أحد طريقين:
//   ١) كوكي `count_token`: JWT (jose HS256 بسرّ JWT_SECRET) بحمولة { k:"stk", sid, aid }
//      وصلاحية 12 ساعة — يُصدَر بعد التحقق من PIN التكليف (يُخزَّن hash فقط، scrypt).
//   ٢) مستخدم النظام المسجَّل (ctx.user) المرتبط بتكليف method=USER في الجلسة.
//
// 🔒 قاعدة الجرد الأعمى (لا تساهل): getPortalState لا يُسرّب أبداً expectedQty ولا
// أسعاراً/تكاليف ولا كميات/أسماء عدّات الزملاء — فقط (اسم الصنف/المتغيّر/sku/الوحدات
// وباركوداتها/حالة «معدود» منزوعة الكمية). التوكن يبطل عملياً بانتهاء الجلسة لأن
// submit/finish يتحقّقان من status=COUNTING وتكليف ACTIVE داخل المعاملة.

import { TRPCError } from "@trpc/server";
import { mysqlCodeFrom } from "@shared/errorMap.ar";
import { parse as parseCookie } from "cookie";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { SignJWT, jwtVerify } from "jose";
import {
  branches,
  products,
  productUnits,
  productVariants,
  stocktakeAssignments,
  stocktakeCounts,
  stocktakeItems,
  stocktakeSessions,
  type StocktakeAssignment,
  type StocktakeSession,
  type User,
} from "../../drizzle/schema";
import { DUMMY_STORED, verifyPassword } from "../auth/password";
import type { TrpcContext } from "../context";
import { requireDb, withTx } from "./tx";

/* ============================ ثوابت ============================ */

/** اسم كوكي بوابة العدّ — منفصل عن كوكي جلسة النظام كي لا يتداخلا. */
export const COUNT_COOKIE_NAME = "count_token";

/** صلاحية توكن البوابة: 12 ساعة — تكفي يوم جرد كاملاً ولا تبقى مفتوحة للأبد. */
export const COUNT_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

// ملاحظة: قفل تكليفات PIN عند الفشل الجماعي أُزيل (كان DoS تشغيلي). الحماية من التخمين
// عبر حدّ معدّل IP لـcount.auth في server/index.ts (COUNT_RATE_LIMIT_MAX = 10/15د).
// lockedUntil يبقى مدعوماً للقفل اليدوي الإداري من إدارة الجرد.

// رسالة موحّدة لـ«غير موجودة/انتهت/أُلغيت» — حامل رابط قديم لا يستطيع استكشاف الجلسات.
const SESSION_UNAVAILABLE_MSG = "جلسة الجرد غير متاحة — انتهت أو أُغلقت. راجع مسؤول الجرد.";
const IDENTITY_EXPIRED_MSG =
  "انتهت صلاحية دخولك لبوابة العدّ — افتح الرابط وأدخل رمز الدخول (PIN) مجدداً.";
const COUNTING_ENDED_MSG = "انتهت مرحلة العدّ لهذه الجلسة — لا يمكن تسجيل عدّات جديدة.";

/* ============================ توكن البوابة (jose HS256) ============================ */

function getSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is required for count portal tokens");
  }
  return new TextEncoder().encode(secret);
}

/** حمولة توكن البوابة: k="stk" تمييزاً عن أي JWT آخر بنفس السرّ + جلسة وتكليف محدّدان. */
export type CountTokenPayload = { sid: number; aid: number };

/** يُصدر توكن بوابة عدّ لتكليف محدّد في جلسة محدّدة (صلاحية 12 ساعة). */
export async function signCountToken(sessionId: number, assignmentId: number): Promise<string> {
  const expirationSeconds = Math.floor((Date.now() + COUNT_TOKEN_TTL_MS) / 1000);
  return new SignJWT({ k: "stk", sid: sessionId, aid: assignmentId })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(expirationSeconds)
    .sign(getSecret());
}

/** يتحقّق من توكن البوابة. null عند أي فشل (مفقود/تالف/منتهٍ/ليس توكن جرد). */
export async function verifyCountToken(
  token: string | undefined | null
): Promise<CountTokenPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ["HS256"] });
    // k="stk" يمنع قبول توكن جلسة النظام (أو أي JWT آخر بنفس السرّ) في البوابة.
    if (payload.k !== "stk") return null;
    const sid = Number(payload.sid);
    const aid = Number(payload.aid);
    if (!Number.isInteger(sid) || sid <= 0) return null;
    if (!Number.isInteger(aid) || aid <= 0) return null;
    return { sid, aid };
  } catch {
    return null;
  }
}

/* ============================ الهوية ============================ */

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

/* ============================ حالة البوابة (جرد أعمى) ============================ */

export type PortalUnit = {
  unitName: string;
  /** عدد الوحدات الأساس في هذه الوحدة — معامل تحويل وليس مالاً (Number مشروع هنا). */
  factor: number;
  barcode: string | null;
};

export type PortalItem = {
  variantId: number;
  productName: string;
  variantName: string | null;
  sku: string;
  isMine: boolean;
  /** معدود من أي أحد (عدّ فعّال FIRST/RECOUNT) — بلا كمية لغير صاحب العدّ. */
  counted: boolean;
  /** آخر عدّة سجّلتُها أنا على هذا الصنف (إن وُجدت) — كميتي أراها وأعدّلها. */
  myCount: { qty: number; at: Date; unitBreakdown: string | null } | null;
  /** عدّه زميل (بلا كمية ولا اسم — جرد أعمى). */
  colleagueCounted: boolean;
  units: PortalUnit[];
};

/**
 * حالة بوابة العدّ (العقد §٥ — `state`).
 * 🔒 يُمنع منعاً باتاً تضمين: expectedQty، الأسعار/التكاليف، كميات أو أسماء عدّات الزملاء.
 */
export async function getPortalState(identity: PortalIdentity) {
  const db = requireDb();
  const { session, assignment } = identity;
  const myAssignmentId = Number(assignment.id);

  const branchRows = await db
    .select({ name: branches.name })
    .from(branches)
    .where(eq(branches.id, session.branchId))
    .limit(1);

  // أصناف الجلسة كلها (أصناف الزملاء تلزم للبحث/العدّ التحقّقي) — بلا expectedQty/unitCost.
  const itemRows = await db
    .select({
      variantId: stocktakeItems.variantId,
      assignmentId: stocktakeItems.assignmentId,
      recountStatus: stocktakeItems.recountStatus,
      recountReason: stocktakeItems.recountReason,
      productName: products.name,
      variantName: productVariants.variantName,
      sku: productVariants.sku,
    })
    .from(stocktakeItems)
    .innerJoin(productVariants, eq(stocktakeItems.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(eq(stocktakeItems.sessionId, session.id))
    .orderBy(asc(stocktakeItems.id));

  const countRows = await db
    .select({
      id: stocktakeCounts.id,
      variantId: stocktakeCounts.variantId,
      assignmentId: stocktakeCounts.assignmentId,
      kind: stocktakeCounts.kind,
      qty: stocktakeCounts.qty,
      unitBreakdown: stocktakeCounts.unitBreakdown,
      countedAt: stocktakeCounts.countedAt,
    })
    .from(stocktakeCounts)
    .where(eq(stocktakeCounts.sessionId, session.id))
    .orderBy(asc(stocktakeCounts.id));

  const countsByVariant = new Map<number, typeof countRows>();
  for (const c of countRows) {
    const vid = Number(c.variantId);
    const arr = countsByVariant.get(vid);
    if (arr) arr.push(c);
    else countsByVariant.set(vid, [c]);
  }

  // وحدات القياس النشطة لكل متغيّر (قطعة/درزن/كرتون + باركود مستقل لكل وحدة).
  const variantIds = itemRows.map((r) => Number(r.variantId));
  const unitRows = variantIds.length
    ? await db
        .select({
          variantId: productUnits.variantId,
          unitName: productUnits.unitName,
          conversionFactor: productUnits.conversionFactor,
          barcode: productUnits.barcode,
          isActive: productUnits.isActive,
        })
        .from(productUnits)
        .where(inArray(productUnits.variantId, variantIds))
        .orderBy(asc(productUnits.id))
    : [];
  const unitsByVariant = new Map<number, PortalUnit[]>();
  for (const u of unitRows) {
    if (u.isActive === false) continue;
    const vid = Number(u.variantId);
    const arr = unitsByVariant.get(vid) ?? [];
    arr.push({ unitName: u.unitName, factor: Number(u.conversionFactor), barcode: u.barcode ?? null });
    unitsByVariant.set(vid, arr);
  }
  // الوحدات الكبرى أولاً (كرتون ثم درزن ثم قطعة) — كما في نموذج التصميم jrd-count.
  for (const arr of Array.from(unitsByVariant.values())) arr.sort((a, b) => b.factor - a.factor);

  let mineTotal = 0;
  let mineCounted = 0;
  let sessionCounted = 0;

  const items: PortalItem[] = itemRows.map((it) => {
    const vid = Number(it.variantId);
    const counts = countsByVariant.get(vid) ?? [];
    // «معدود» = يوجد عدّ فعّال (FIRST/RECOUNT) من أي أحد — VERIFY وحده لا يقع إلا بعد FIRST.
    const counted = counts.some((c) => c.kind === "FIRST" || c.kind === "RECOUNT");
    const isMine = Number(it.assignmentId) === myAssignmentId;
    const myCounts = counts.filter((c) => Number(c.assignmentId) === myAssignmentId);
    const myLast = myCounts.length ? myCounts[myCounts.length - 1] : null;
    const colleagueCounted = counts.some(
      (c) => (c.kind === "FIRST" || c.kind === "RECOUNT") && Number(c.assignmentId) !== myAssignmentId
    );
    if (counted) sessionCounted++;
    if (isMine) {
      mineTotal++;
      if (counted) mineCounted++;
    }
    return {
      variantId: vid,
      productName: it.productName,
      variantName: it.variantName,
      sku: it.sku,
      isMine,
      counted,
      myCount: myLast
        ? { qty: myLast.qty, at: myLast.countedAt, unitBreakdown: myLast.unitBreakdown ?? null }
        : null,
      colleagueCounted,
      units: unitsByVariant.get(vid) ?? [],
    };
  });
  // منطقتي أولاً ثم أصناف الزملاء (sort مستقر يحفظ ترتيب الإدراج داخل كل مجموعة).
  items.sort((a, b) => Number(b.isMine) - Number(a.isMine));

  // مهام إعادة العدّ المعلّقة على أصنافي — تظهر أعلى شاشة العامل.
  const recountTasks = itemRows
    .filter((it) => Number(it.assignmentId) === myAssignmentId && it.recountStatus === "PENDING")
    .map((it) => ({
      variantId: Number(it.variantId),
      productName: it.productName,
      variantName: it.variantName,
      reason: it.recountReason ?? "",
    }));

  return {
    session: {
      code: session.code,
      name: session.name,
      branchName: branchRows[0]?.name ?? "",
      status: session.status,
      dupPolicy: session.dupPolicy,
      blind: session.blind,
    },
    assignment: {
      id: myAssignmentId,
      name: assignment.name,
      zone: assignment.zone,
      status: assignment.status,
    },
    progress: {
      mine: { counted: mineCounted, total: mineTotal },
      session: { counted: sessionCounted, total: itemRows.length },
    },
    recountTasks,
    items,
  };
}

/* ============================ تسجيل عدّة ============================ */

export type SubmitCountInput = {
  variantId: number;
  /** الكمية المعدودة بالوحدة الأساس (عدد صحيح ≥ 0). */
  qty: number;
  /** تفصيل الإدخال متعدد الوحدات (JSON نصي ≤ 500 حرف) — للتدقيق فقط. */
  unitBreakdown?: string | null;
  /** مفتاح idempotency لمزامنة طابور الأوفلاين (uuid). */
  clientRequestId: string;
};

export type SubmitCountResult = {
  ok: true;
  kind: "FIRST" | "RECOUNT" | "VERIFY";
  /** للعدّ التحقّقي: هل طابق العدّ الفعّال؟ (null لغير VERIFY) — للتوست في الواجهة. */
  verifyMatch: boolean | null;
  /** true عند إعادة إرسال نفس clientRequestId (مزامنة أوفلاين مكرّرة) — نجاح بلا أثر. */
  idempotent: boolean;
};

/**
 * تسجيل عدّة (العقد §٥ — `submit`) داخل withTx واحدة:
 * - تحقّق: الجلسة COUNTING، التكليف ACTIVE، الصنف ضمن أصناف الجلسة — تحت قفل صفّي.
 * - منطقتي: recountStatus=PENDING ⇒ عدّ RECOUNT (يُنجز الطلب ويمسح أي تعارض —
 *   «العدّ الثالث يحسم»). وإلا: لي عدّ فعّال سابق ⇒ أحدّثه؛ لا عدّ فعّالاً ⇒ FIRST باسمي.
 * - منطقة زميل: BLOCK ⇒ رفض واضح. VERIFY: لا FIRST بعد ⇒ FIRST باسمي؛ يوجد عدّ
 *   فعّال لغيري ⇒ أدرج/أحدّث VERIFY باسمي مع isConflict عند الاختلاف — لا أحد يطمس عدّ أحد.
 * - idempotency: UNIQUE(sessionId, clientRequestId) — تكرار ⇒ نجاح بلا أثر.
 */
export async function submitCount(
  identity: PortalIdentity,
  input: SubmitCountInput
): Promise<SubmitCountResult> {
  // حراسة دفاعية (zod في الراوتر يضمنها أيضاً).
  if (!Number.isInteger(input.qty) || input.qty < 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الكمية يجب أن تكون عدداً صحيحاً غير سالب." });
  }
  if (input.unitBreakdown && input.unitBreakdown.length > 500) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "تفصيل الوحدات أطول من المسموح." });
  }

  try {
    return await withTx(async (tx) => {
      // (٠) idempotency: نفس clientRequestId داخل الجلسة ⇒ أعد نتيجة العدّة الأولى بلا أثر.
      const dupRows = await tx
        .select()
        .from(stocktakeCounts)
        .where(
          and(
            eq(stocktakeCounts.sessionId, identity.session.id),
            eq(stocktakeCounts.clientRequestId, input.clientRequestId)
          )
        )
        .limit(1);
      const dup = dupRows[0];
      if (dup) {
        return {
          ok: true as const,
          kind: dup.kind,
          verifyMatch: dup.kind === "VERIFY" ? !dup.isConflict : null,
          idempotent: true,
        };
      }

      // (١) الجلسة تحت قفل — يمنع السباق مع approve/forceReview/cancel.
      const sessionRows = await tx
        .select()
        .from(stocktakeSessions)
        .where(eq(stocktakeSessions.id, identity.session.id))
        .for("update")
        .limit(1);
      const session = sessionRows[0];
      if (!session) throw new TRPCError({ code: "NOT_FOUND", message: SESSION_UNAVAILABLE_MSG });
      if (session.status !== "COUNTING") {
        throw new TRPCError({ code: "BAD_REQUEST", message: COUNTING_ENDED_MSG });
      }

      // (٢) التكليف ACTIVE تحت قفل.
      const asgRows = await tx
        .select()
        .from(stocktakeAssignments)
        .where(eq(stocktakeAssignments.id, identity.assignment.id))
        .for("update")
        .limit(1);
      const asg = asgRows[0];
      if (!asg || Number(asg.sessionId) !== Number(session.id)) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: IDENTITY_EXPIRED_MSG });
      }
      if (asg.status !== "ACTIVE") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "سلّمت عدّك مسبقاً — لا يمكن تسجيل أو تعديل عدّات بعد التسليم.",
        });
      }
      const myAssignmentId = Number(asg.id);

      // (٣) الصنف ضمن نطاق الجلسة (تحقّق خادمي — لا ثقة بالواجهة).
      const itemRows = await tx
        .select()
        .from(stocktakeItems)
        .where(
          and(
            eq(stocktakeItems.sessionId, session.id),
            eq(stocktakeItems.variantId, input.variantId)
          )
        )
        .for("update")
        .limit(1);
      const item = itemRows[0];
      if (!item) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "هذا الصنف خارج نطاق جلسة الجرد — راجع مسؤول الجرد.",
        });
      }

      // (٤) عدّات الصنف الحالية تحت قفل (تمنع سباق عدَّين متزامنين على نفس الصنف).
      const counts = await tx
        .select()
        .from(stocktakeCounts)
        .where(
          and(
            eq(stocktakeCounts.sessionId, session.id),
            eq(stocktakeCounts.variantId, input.variantId)
          )
        )
        .for("update");
      counts.sort((a, b) => Number(a.id) - Number(b.id));

      const first = counts.find((c) => c.kind === "FIRST") ?? null;
      const recounts = counts.filter((c) => c.kind === "RECOUNT");
      const latestRecount = recounts.length ? recounts[recounts.length - 1] : null;
      // العدّ الفعّال = آخر RECOUNT إن وُجد وإلا FIRST (نفس قاعدة rawCount في المراجعة).
      const effectiveRow = latestRecount ?? first;

      const isMine = Number(item.assignmentId) === myAssignmentId;
      const now = new Date();

      let kind: "FIRST" | "RECOUNT" | "VERIFY";
      let verifyMatch: boolean | null = null;

      if (isMine && item.recountStatus === "PENDING") {
        // إعادة عدّ مطلوبة على صنفي ⇒ عدّ RECOUNT يحسم: يُنجز الطلب ويمسح أي تعارض.
        kind = "RECOUNT";
        await tx.insert(stocktakeCounts).values({
          sessionId: session.id,
          variantId: input.variantId,
          assignmentId: asg.id,
          kind: "RECOUNT",
          qty: input.qty,
          unitBreakdown: input.unitBreakdown ?? null,
          countedByName: identity.countedByName,
          countedByUserId: identity.countedByUserId,
          countedAt: now,
          clientRequestId: input.clientRequestId,
        });
        await tx
          .update(stocktakeItems)
          .set({ recountStatus: "DONE" })
          .where(eq(stocktakeItems.id, item.id));
        // «التعارض يُحل بالعدّ الثالث» — امسح أعلام التعارض على هذا الصنف.
        await tx
          .update(stocktakeCounts)
          .set({ isConflict: false })
          .where(
            and(
              eq(stocktakeCounts.sessionId, session.id),
              eq(stocktakeCounts.variantId, input.variantId),
              eq(stocktakeCounts.isConflict, true)
            )
          );
      } else {
        if (!isMine && session.dupPolicy === "BLOCK") {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "هذا الصنف من منطقة زميلك — سياسة هذه الجلسة تمنع العدّ المكرر. اطلب من مسؤول الجرد إسناده إليك إن لزم.",
          });
        }

        // آخر عدّ فعّال سجّلتُه أنا (RECOUNT إن وُجد وإلا FIRST) — «يمكنك تعديل العدّ قبل التسليم».
        const myOwn =
          [...counts]
            .reverse()
            .find(
              (c) =>
                Number(c.assignmentId) === myAssignmentId &&
                (c.kind === "FIRST" || c.kind === "RECOUNT")
            ) ?? null;

        if (myOwn) {
          // تحديث عدّي الذاتي (qty/at/breakdown) — clientRequestId الجديد يلتقط إعادة إرسال التعديل.
          kind = myOwn.kind as "FIRST" | "RECOUNT";
          await tx
            .update(stocktakeCounts)
            .set({
              qty: input.qty,
              unitBreakdown: input.unitBreakdown ?? null,
              countedAt: now,
              clientRequestId: input.clientRequestId,
            })
            .where(eq(stocktakeCounts.id, myOwn.id));

          // إن كان عدّي هو العدّ الفعّال للصنف، أعد تقييم تعارض العدّات التحقّقية
          // غير المحسومة (تصحيحي لرقم الزميل المطابق يجب أن يُسقط التعارض، والعكس).
          const effectiveAfter =
            effectiveRow && Number(effectiveRow.id) === Number(myOwn.id)
              ? input.qty
              : (effectiveRow?.qty ?? input.qty);
          for (const v of counts) {
            if (v.kind !== "VERIFY" || v.resolvedPick) continue;
            const conflictNow = v.qty !== effectiveAfter;
            if (conflictNow !== v.isConflict) {
              await tx
                .update(stocktakeCounts)
                .set({ isConflict: conflictNow })
                .where(eq(stocktakeCounts.id, v.id));
            }
          }
        } else if (!effectiveRow) {
          // لا عدّ فعّالاً بعد ⇒ FIRST باسمي (في منطقتي، أو منطقة زميل بسياسة VERIFY).
          kind = "FIRST";
          await tx.insert(stocktakeCounts).values({
            sessionId: session.id,
            variantId: input.variantId,
            assignmentId: asg.id,
            kind: "FIRST",
            qty: input.qty,
            unitBreakdown: input.unitBreakdown ?? null,
            countedByName: identity.countedByName,
            countedByUserId: identity.countedByUserId,
            countedAt: now,
            clientRequestId: input.clientRequestId,
          });
        } else {
          // يوجد عدّ فعّال سجّله غيري ⇒ عدّ تحقّقي باسمي — العدّان يبقيان في السجل دائماً.
          // المقارنة ضد العدّ الفعّال (آخر RECOUNT وإلا FIRST) كما في نموذج jrd-count —
          // تمنع تعارضاً زائفاً ضد FIRST قديم حلّ محله RECOUNT.
          kind = "VERIFY";
          const match = input.qty === effectiveRow.qty;
          const myVerify =
            counts.find(
              (c) => c.kind === "VERIFY" && Number(c.assignmentId) === myAssignmentId
            ) ?? null;
          // سدّ أوراكل الاستنتاج (مراجعة أمنية): نتيجة التطابق تُكشف لأول إرسال فقط —
          // تكرار تعديل التحقّقي مع رؤية match/لا-match يتيح استنتاج كمية الزميل بالتقريب.
          verifyMatch = myVerify ? null : match;
          if (myVerify) {
            await tx
              .update(stocktakeCounts)
              .set({
                qty: input.qty,
                unitBreakdown: input.unitBreakdown ?? null,
                countedAt: now,
                clientRequestId: input.clientRequestId,
                isConflict: !match,
                // تعديل العدّ التحقّقي يُلغي حسماً سابقاً مبنياً على قيمة قديمة.
                resolvedBy: null,
                resolvedPick: null,
                resolvedAt: null,
              })
              .where(eq(stocktakeCounts.id, myVerify.id));
          } else {
            await tx.insert(stocktakeCounts).values({
              sessionId: session.id,
              variantId: input.variantId,
              assignmentId: asg.id,
              kind: "VERIFY",
              qty: input.qty,
              unitBreakdown: input.unitBreakdown ?? null,
              countedByName: identity.countedByName,
              countedByUserId: identity.countedByUserId,
              countedAt: now,
              isConflict: !match,
              clientRequestId: input.clientRequestId,
            });
          }
        }
      }

      // (٥) آخر نشاط للتكليف — يغذّي شاشة المتابعة الحية.
      await tx
        .update(stocktakeAssignments)
        .set({ lastActivityAt: now })
        .where(eq(stocktakeAssignments.id, asg.id));

      return { ok: true as const, kind, verifyMatch, idempotent: false };
    });
  } catch (e) {
    // سباق طلبين متزامنين بنفس clientRequestId: الثاني يصطدم بالقيد الفريد
    // UNIQUE(sessionId, clientRequestId) فتُلغى معاملته — نعيد نتيجة العدّة الأولى.
    if (mysqlCodeFrom(e) === "ER_DUP_ENTRY") {
      const db = requireDb();
      const rows = await db
        .select()
        .from(stocktakeCounts)
        .where(
          and(
            eq(stocktakeCounts.sessionId, identity.session.id),
            eq(stocktakeCounts.clientRequestId, input.clientRequestId)
          )
        )
        .limit(1);
      const dup = rows[0];
      if (dup) {
        return {
          ok: true,
          kind: dup.kind,
          verifyMatch: dup.kind === "VERIFY" ? !dup.isConflict : null,
          idempotent: true,
        };
      }
    }
    throw e;
  }
}

/* ============================ تسليم التكليف ============================ */

export type FinishAssignmentResult = {
  ok: true;
  /** true إن كان هذا آخر تكليف ⇒ الجلسة انتقلت آلياً إلى REVIEW. */
  sessionMovedToReview: boolean;
  /** true إن كان التكليف مسلَّماً مسبقاً (إعادة استدعاء — نجاح بلا أثر). */
  alreadySubmitted: boolean;
};

/**
 * تسليم العدّ (العقد §٥ — `finish`): التكليف ⇒ SUBMITTED، وعند تسليم آخر تكليف
 * تنتقل الجلسة آلياً إلى REVIEW مع submittedAt. idempotent عند إعادة الاستدعاء.
 */
export async function finishAssignment(identity: PortalIdentity): Promise<FinishAssignmentResult> {
  return withTx(async (tx) => {
    // قفل الجلسة أولاً ثم تكليفاتها — نفس ترتيب الأقفال في approve لتجنّب deadlock.
    const sessionRows = await tx
      .select()
      .from(stocktakeSessions)
      .where(eq(stocktakeSessions.id, identity.session.id))
      .for("update")
      .limit(1);
    const session = sessionRows[0];
    if (!session) throw new TRPCError({ code: "NOT_FOUND", message: SESSION_UNAVAILABLE_MSG });

    const assignments = await tx
      .select()
      .from(stocktakeAssignments)
      .where(eq(stocktakeAssignments.sessionId, session.id))
      .for("update");
    const me = assignments.find((a) => Number(a.id) === Number(identity.assignment.id));
    if (!me) throw new TRPCError({ code: "UNAUTHORIZED", message: IDENTITY_EXPIRED_MSG });

    // مسلَّم مسبقاً (أو عبر forceReview) ⇒ نجاح بلا أثر.
    if (me.status === "SUBMITTED") {
      return { ok: true as const, sessionMovedToReview: false, alreadySubmitted: true };
    }
    if (session.status !== "COUNTING") {
      throw new TRPCError({ code: "BAD_REQUEST", message: COUNTING_ENDED_MSG });
    }

    const now = new Date();
    await tx
      .update(stocktakeAssignments)
      .set({ status: "SUBMITTED", submittedAt: now, lastActivityAt: now })
      .where(eq(stocktakeAssignments.id, me.id));

    // آخر تكليف يُسلَّم ⇒ الجلسة تنتقل آلياً لقيد المراجعة.
    const allSubmitted = assignments.every(
      (a) => Number(a.id) === Number(me.id) || a.status === "SUBMITTED"
    );
    if (allSubmitted) {
      await tx
        .update(stocktakeSessions)
        .set({ status: "REVIEW", submittedAt: now })
        .where(eq(stocktakeSessions.id, session.id));
    }

    return { ok: true as const, sessionMovedToReview: allSubmitted, alreadySubmitted: false };
  });
}
