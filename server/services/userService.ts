import {
  PASSWORD_MIN_LEN,
  PASSWORD_POLICY_MSG,
  USERNAME_MAX_LEN,
  USERNAME_MIN_LEN,
  USERNAME_POLICY_MSG,
  isStrongPassword,
  isValidUsername,
  normalizeUsername,
} from "@shared/const";
import { ALL_ROLES } from "@shared/permissions";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, like, ne, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { roles, users } from "../../drizzle/schema";
import { getDb, type Tx } from "../db";
import { hashPassword, verifyPassword } from "../auth/password";
import { escapeLike } from "../lib/sqlLike";
import { withTx, type Actor } from "./tx";
import { extractInsertId } from "../lib/insertId";
import { getUserUsage, isFkBlocked, usageBlockMessage } from "./entityUsage";

export type Role = typeof ALL_ROLES[number];

export interface CreateUserInput {
  /** البريد أو اسم المستخدم — يجب توفّر أحدهما على الأقل (معرّف الدخول). */
  email?: string | null;
  username?: string | null;
  password: string;
  name: string;
  role?: Role;
  /** دور مخصّص (من جدول roles) — إن وُجد يَجبّ `role` ويُحلّ إلى baseRole + يصفّر الـoverride. */
  customRoleId?: number | null;
  branchId?: number | null;
  phone?: string | null;
  jobTitle?: string | null;
  hiredAt?: string | null;
  permissionsOverride?: Record<string, "FULL" | "READ" | "NONE"> | null;
  mustChangePassword?: boolean;
}

export interface UpdateUserInput {
  userId: number;
  name?: string;
  /** null/"" ⇒ مسح المعرّف (ممنوع إن كان آخر معرّف دخول متبقٍّ). */
  email?: string | null;
  username?: string | null;
  role?: Role;
  /** رقم ⇒ إسناد دور مخصّص؛ null ⇒ مسحه (العودة لدور مبني عبر `role`)؛ undefined ⇒ بلا تغيير. */
  customRoleId?: number | null;
  branchId?: number | null;
  phone?: string | null;
  jobTitle?: string | null;
  hiredAt?: string | null;
  permissionsOverride?: Record<string, "FULL" | "READ" | "NONE"> | null;
}

export interface ListUsersInput {
  q?: string;
  role?: string;
  includeInactive?: boolean;
  limit?: number;
  offset?: number;
}

const SAFE_COLUMNS = {
  id: users.id,
  name: users.name,
  email: users.email,
  username: users.username,
  phone: users.phone,
  role: users.role,
  customRoleId: users.customRoleId,
  branchId: users.branchId,
  isActive: users.isActive,
  jobTitle: users.jobTitle,
  hiredAt: users.hiredAt,
  permissionsOverride: users.permissionsOverride,
  mustChangePassword: users.mustChangePassword,
  lastSignedIn: users.lastSignedIn,
  createdAt: users.createdAt,
} as const;

function normEmail(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

/** يطبّع اسم المستخدم ويتحقّق من صحّته. "" ⇒ غير موجود (null). يرمي عند صيغة غير صالحة. */
function normUsernameOrThrow(s: string | null | undefined): string | null {
  const v = normalizeUsername(s);
  if (!v) return null;
  if (!isValidUsername(v)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: USERNAME_POLICY_MSG });
  }
  return v;
}

function assertPasswordPolicy(pw: string) {
  if (!isStrongPassword(pw)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: PASSWORD_POLICY_MSG });
  }
}

async function assertNotLastActiveAdmin(tx: any, excludeUserId: number) {
  const other = (
    await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, "admin"), eq(users.isActive, true), ne(users.id, excludeUserId)))
      .limit(1)
  )[0];
  if (!other) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "لا يمكن تعطيل/تخفيض آخر مدير نشط في النظام — عيّن مديراً آخر أولاً.",
    });
  }
}

function rethrowDup(e: any): never {
  const code = e?.code ?? e?.cause?.code ?? e?.cause?.cause?.code;
  if (code === "ER_DUP_ENTRY") {
    // رسالة MySQL تحمل اسم المفتاح المنتهَك ⇒ نميّز البريد عن اسم المستخدم لرسالة دقيقة.
    const msg = String(e?.sqlMessage ?? e?.cause?.sqlMessage ?? e?.message ?? "");
    if (/username/i.test(msg)) {
      throw new TRPCError({ code: "CONFLICT", message: "اسم المستخدم مستخدم مسبقاً." });
    }
    throw new TRPCError({ code: "CONFLICT", message: "البريد الإلكتروني مستخدم مسبقاً." });
  }
  throw e;
}

/** توليد كلمة مرور قوية عشوائية (للاستخدام الخادمي عند إعادة التعيين). */
export function generateStrongPassword(): string {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghjkmnpqrstuvwxyz";
  const digits = "23456789";
  const special = "@#$%!";
  const all = upper + lower + digits + special;
  // ضمان وجود كل فئة + طول عشوائي 10-14 حرف
  const pick = (s: string) => s[Math.floor(Math.random() * s.length)];
  const base = [pick(upper), pick(lower), pick(digits), pick(special)];
  const extra = Array.from({ length: 8 }, () => pick(all));
  return [...base, ...extra].sort(() => Math.random() - 0.5).join("");
}

/** إنشاء مستخدم جديد (غلاف ذرّي مستقلّ). */
export async function createUser(input: CreateUserInput, actor: Actor) {
  return withTx((tx) => createUserTx(tx, input, actor));
}

/**
 * إنشاء مستخدم داخل معاملة قائمة (tx مُمرَّر) — يسمح بتركيب الإنشاء مع عمليات أخرى
 * في معاملة ذرّية واحدة (مثل «أضف موظفاً + أنشئ حسابه» معاً ⇒ أي فشل يُرجِع الكل).
 * نفس منطق createUser تماماً لكن بلا withTx خاص.
 */
export async function createUserTx(tx: Tx, input: CreateUserInput, _actor: Actor) {
  {
    const name = input.name?.trim();
    if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "الاسم مطلوب" });
    if (name.length > 255) throw new TRPCError({ code: "BAD_REQUEST", message: "الاسم طويل جداً" });
    const email = normEmail(input.email);
    const username = normUsernameOrThrow(input.username);
    // معرّف دخول واحد على الأقل (طلب المالك: «اما بريد او اسم مستخدم»).
    if (!email && !username) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "أدخل بريداً إلكترونياً أو اسم مستخدم على الأقل." });
    }
    assertPasswordPolicy(input.password);
    const mustChange = input.mustChangePassword ?? false;
    const expiresAt = mustChange ? new Date(Date.now() + 72 * 60 * 60 * 1000) : null;
    // إسناد الدور: دور مخصّص (يَجبّ `role` ويُحلّ إلى baseRole + يصفّر الـoverride) أو دور مبني.
    let roleValue: Role = input.role ?? "cashier";
    let customRoleId: number | null = null;
    let permsOverride = input.permissionsOverride ?? null;
    if (input.customRoleId != null) {
      const r = (await tx.select({ id: roles.id, baseRole: roles.baseRole }).from(roles)
        .where(and(eq(roles.id, input.customRoleId), eq(roles.isActive, true))).limit(1))[0];
      if (!r) throw new TRPCError({ code: "BAD_REQUEST", message: "الدور المخصّص غير موجود أو معطّل." });
      roleValue = r.baseRole as Role;
      customRoleId = Number(r.id);
      permsOverride = null;
    }
    try {
      const res = await tx.insert(users).values({
        openId: `local_${nanoid()}`,
        email: email || null,
        username,
        name,
        passwordHash: hashPassword(input.password),
        role: roleValue,
        customRoleId,
        loginMethod: "local",
        branchId: input.branchId ?? null,
        isActive: true,
        phone: input.phone?.trim() || null,
        jobTitle: input.jobTitle?.trim() || null,
        hiredAt: input.hiredAt ? new Date(input.hiredAt) : null,
        permissionsOverride: permsOverride,
        mustChangePassword: mustChange,
        tempPasswordExpiresAt: expiresAt,
        // AUTH-02: حدّ الإبطال أقدم بثانيتين من الإنشاء كي لا تُرفَض أوّل جلسةٍ يُصدرها دخولٌ
        // يقع في نفس ثانية الإنشاء (الإبطال يرفض iat <= validFromSec). نطرح ٢٠٠٠ms (لا ١٠٠٠)
        // لأنّ عمود TIMESTAMP يُقرِّب لأقرب ثانية ⇒ قد يستردّ التقريب ~٥٠٠ms؛ ثانيتان تضمنان
        // بقاء الحدّ المخزَّن أصغرَ تماماً من ثانية الدخول اللاحق.
        sessionsValidFrom: new Date(Date.now() - 2000),
      });
      const userId = extractInsertId(res);
      return { userId };
    } catch (e) {
      rethrowDup(e);
    }
  }
}

/** تعديل مستخدم. */
export async function updateUser(input: UpdateUserInput, actor: Actor) {
  return withTx(async (tx) => {
    const existing = (
      await tx.select().from(users).where(eq(users.id, input.userId)).for("update").limit(1)
    )[0];
    if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "المستخدم غير موجود" });

    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "اسم المستخدم مطلوب" });
      if (name.length > 255) throw new TRPCError({ code: "BAD_REQUEST", message: "اسم المستخدم طويل جداً" });
      patch.name = name;
    }
    // معرّفا الدخول (بريد/اسم مستخدم): يُسمح بمسح أحدهما ما دام الآخر باقياً — لا يجوز ترك المستخدم
    // بلا أيّ معرّف دخول. نحسب القيمة النهائية لكلٍّ (التعديل إن وُرِد، وإلا القائمة) ثم نتحقّق.
    let finalEmail = existing.email ?? "";
    let finalUsername: string | null = existing.username ?? null;
    if (input.email !== undefined) {
      finalEmail = normEmail(input.email);
      patch.email = finalEmail || null;
    }
    if (input.username !== undefined) {
      finalUsername = normUsernameOrThrow(input.username);
      patch.username = finalUsername;
    }
    if (!finalEmail && !finalUsername) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "يجب إبقاء بريد إلكتروني أو اسم مستخدم واحد على الأقل." });
    }
    if (input.branchId !== undefined) patch.branchId = input.branchId ?? null;
    if (input.phone !== undefined) patch.phone = input.phone?.trim() || null;
    if (input.jobTitle !== undefined) patch.jobTitle = input.jobTitle?.trim() || null;
    if (input.hiredAt !== undefined) patch.hiredAt = input.hiredAt ? new Date(input.hiredAt) : null;
    if (input.permissionsOverride !== undefined) patch.permissionsOverride = input.permissionsOverride ?? null;

    // إسناد الدور (مبني أو مخصّص). نحسب الوجهة ثم نطبّق الحُرّاس إن تغيّر فعلاً.
    let nextRole: Role | undefined;
    let nextCustomRoleId: number | null | undefined;
    if (input.customRoleId != null) {
      const r = (await tx.select({ id: roles.id, baseRole: roles.baseRole }).from(roles)
        .where(and(eq(roles.id, input.customRoleId), eq(roles.isActive, true))).limit(1))[0];
      if (!r) throw new TRPCError({ code: "BAD_REQUEST", message: "الدور المخصّص غير موجود أو معطّل." });
      nextRole = r.baseRole as Role;
      nextCustomRoleId = Number(r.id);
    } else if (input.role !== undefined) {
      nextRole = input.role;              // اختيار دور مبني يمسح الدور المخصّص
      nextCustomRoleId = null;
    } else if (input.customRoleId === null) {
      nextRole = existing.role as Role;   // مسح الدور المخصّص مع إبقاء baseRole المخزَّن
      nextCustomRoleId = null;
    }
    if (nextRole !== undefined) {
      const roleChanged = nextRole !== existing.role;
      const customChanged = (nextCustomRoleId ?? null) !== (existing.customRoleId ?? null);
      if (roleChanged || customChanged) {
        if (input.userId === actor.userId) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكنك تغيير دور حسابك بنفسك." });
        }
        if (existing.role === "admin" && nextRole !== "admin") await assertNotLastActiveAdmin(tx, input.userId);
        patch.role = nextRole;
        patch.customRoleId = nextCustomRoleId ?? null;
        // الدور المخصّص يقود الصلاحيات ⇒ صفّر الـoverride الفردي عند إسناده.
        if (nextCustomRoleId != null) patch.permissionsOverride = null;
        // تغيير الدور يُبطل الجلسات (يُعاد تحميل السياق/الصلاحيات).
        patch.sessionsValidFrom = new Date();
      }
    }

    if (Object.keys(patch).length === 0) return { userId: input.userId, changed: false };
    try {
      await tx.update(users).set(patch).where(eq(users.id, input.userId));
    } catch (e) { rethrowDup(e); }
    return { userId: input.userId, changed: true };
  });
}

/**
 * حذف مستخدم نهائياً — مسموح فقط للحساب «النظيف» (لا إشارة في أيّ جدول أعمال/ربط/تدقيق).
 * الحُرّاس: لا حذف للذات، ولا حذف لآخر مدير نشط، وفحص النظافة، وقيد FK كحارس نهائي.
 */
export async function deleteUser(userId: number, actor: Actor) {
  if (userId === actor.userId) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكنك حذف حسابك بنفسك." });
  }
  return withTx(async (tx) => {
    const u = (await tx.select().from(users).where(eq(users.id, userId)).for("update").limit(1))[0];
    if (!u) throw new TRPCError({ code: "NOT_FOUND", message: "المستخدم غير موجود" });
    if (u.role === "admin") await assertNotLastActiveAdmin(tx, userId);
    const usage = await getUserUsage(userId, tx);
    if (!usage.clean) {
      throw new TRPCError({ code: "BAD_REQUEST", message: usageBlockMessage("هذا المستخدم", usage) });
    }
    try {
      await tx.delete(users).where(eq(users.id, userId));
    } catch (e) {
      if (isFkBlocked(e)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "تعذّر الحذف: المستخدم مرتبط بسجلّات في النظام — عطّله بدل حذفه.",
        });
      }
      throw e;
    }
    return { userId, deleted: true };
  });
}

/** تفعيل/تعطيل مستخدم. */
export async function setUserActive(userId: number, isActive: boolean, actor: Actor) {
  return withTx(async (tx) => {
    const u = (await tx.select().from(users).where(eq(users.id, userId)).for("update").limit(1))[0];
    if (!u) throw new TRPCError({ code: "NOT_FOUND", message: "المستخدم غير موجود" });
    if (!!u.isActive === isActive) {
      throw new TRPCError({ code: "BAD_REQUEST", message: isActive ? "المستخدم مفعّل بالفعل" : "المستخدم معطّل بالفعل" });
    }
    if (!isActive) {
      if (userId === actor.userId) throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكنك تعطيل حسابك بنفسك." });
      if (u.role === "admin") await assertNotLastActiveAdmin(tx, userId);
      await tx.update(users).set({ isActive: false, sessionsValidFrom: new Date() }).where(eq(users.id, userId));
      return { userId, isActive: false };
    }
    await tx.update(users).set({ isActive: true }).where(eq(users.id, userId));
    return { userId, isActive: true };
  });
}

/** إعادة تعيين كلمة مرور (بواسطة مدير) — يضبط إلزام التغيير + انتهاء 72 ساعة. */
export async function resetUserPassword(
  userId: number,
  newPassword: string,
  _actor: Actor,
  options?: { mustChange?: boolean }
) {
  return withTx(async (tx) => {
    assertPasswordPolicy(newPassword);
    const u = (await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update").limit(1))[0];
    if (!u) throw new TRPCError({ code: "NOT_FOUND", message: "المستخدم غير موجود" });
    const mustChange = options?.mustChange ?? true;
    const expiresAt = mustChange ? new Date(Date.now() + 72 * 60 * 60 * 1000) : null;
    await tx.update(users).set({
      passwordHash: hashPassword(newPassword),
      sessionsValidFrom: new Date(),
      mustChangePassword: mustChange,
      tempPasswordExpiresAt: expiresAt,
    }).where(eq(users.id, userId));
    return { userId, success: true };
  });
}

/**
 * تغيير كلمة مرور المستخدم بنفسه — يصفّر إلزام التغيير وانتهاء الصلاحية.
 * يُعيد `validFrom` (لحظة إبطال الجلسات) كي يُعيد الراوتر إصدار كوكي صاحب الجلسة
 * بـ`iat` أكبر تماماً منها فلا يُطرَد (انظر getUserFromRequest: `iat <= validFromSec` يُرفض).
 */
export async function changePassword(userId: number, oldPassword: string, newPassword: string) {
  return withTx(async (tx) => {
    const u = (await tx.select().from(users).where(eq(users.id, userId)).for("update").limit(1))[0];
    if (!u) throw new TRPCError({ code: "NOT_FOUND", message: "المستخدم غير موجود" });
    if (!verifyPassword(oldPassword, u.passwordHash)) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "كلمة المرور الحالية غير صحيحة." });
    }
    assertPasswordPolicy(newPassword);
    if (oldPassword === newPassword) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "كلمة المرور الجديدة يجب أن تختلف عن الحالية." });
    }
    const validFrom = new Date();
    await tx.update(users).set({
      passwordHash: hashPassword(newPassword),
      sessionsValidFrom: validFrom,
      mustChangePassword: false,
      tempPasswordExpiresAt: null,
    }).where(eq(users.id, userId));
    return { userId, success: true, validFrom };
  });
}

/**
 * إبطال كل جلسات مستخدم فوراً بلا مساس بكلمة مروره (مكمِّل لـresetUserPassword الذي يُبطل
 * الجلسات كأثر جانبي لتغيير الكلمة — هذا الإجراء مستقلّ: إبطال فقط، لا تغيير كلمة مرور).
 * يُستعمَل عند الشكّ بتسريب جلسة (جهاز مفقود/موظف مطرود) بلا الحاجة لتوليد كلمة مرور جديدة.
 */
export async function revokeUserSessions(userId: number, _actor: Actor) {
  return withTx(async (tx) => {
    const u = (await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update").limit(1))[0];
    if (!u) throw new TRPCError({ code: "NOT_FOUND", message: "المستخدم غير موجود" });
    const revokedAt = new Date();
    await tx.update(users).set({ sessionsValidFrom: revokedAt }).where(eq(users.id, userId));
    return { userId, revokedAt };
  });
}

/** فحص توفّر البريد الإلكتروني (لحظياً عند الكتابة). */
export async function checkEmailAvailable(email: string, excludeUserId?: number): Promise<boolean> {
  const db = getDb();
  if (!db) return true;
  const norm = normEmail(email);
  if (!norm) return false;
  const conds = excludeUserId
    ? and(eq(users.email, norm), ne(users.id, excludeUserId))
    : eq(users.email, norm);
  const found = await db.select({ id: users.id }).from(users).where(conds).limit(1);
  return found.length === 0;
}

/** فحص توفّر اسم المستخدم (لحظياً عند الكتابة). يعيد false للصيغة غير الصالحة. */
export async function checkUsernameAvailable(username: string, excludeUserId?: number): Promise<boolean> {
  const db = getDb();
  if (!db) return true;
  const norm = normalizeUsername(username);
  if (!norm || !isValidUsername(norm)) return false;
  const conds = excludeUserId
    ? and(eq(users.username, norm), ne(users.id, excludeUserId))
    : eq(users.username, norm);
  const found = await db.select({ id: users.id }).from(users).where(conds).limit(1);
  return found.length === 0;
}

/** خريطة تحويل الأحرف العربية إلى لاتينية لاشتقاق اسم مستخدم/بريد من الاسم. */
const AR_TO_LATIN: Record<string, string> = {
  ا: "a", أ: "a", إ: "a", آ: "a", ب: "b", ت: "t", ث: "th", ج: "j", ح: "h", خ: "kh",
  د: "d", ذ: "z", ر: "r", ز: "z", س: "s", ش: "sh", ص: "s", ض: "d", ط: "t", ظ: "z",
  ع: "a", غ: "g", ف: "f", ق: "q", ك: "k", ل: "l", م: "m", ن: "n", ه: "h", و: "w",
  ي: "y", ى: "a", ة: "a", ء: "", ئ: "y", ؤ: "w",
};

/** يشتقّ جذر اسم مستخدم لاتيني صالح من الاسم (أوّل كلمتين). قد يعيد "" إن تعذّر. */
function deriveUsernameBase(name: string): string {
  const words = (name ?? "").trim().split(/\s+/).slice(0, 2);
  let slug = words
    .map((w) =>
      w.split("").map((c) => AR_TO_LATIN[c] ?? (/[a-z0-9]/i.test(c) ? c.toLowerCase() : "")).join(""),
    )
    .filter(Boolean)
    .join(".");
  // اقتطاع، إزالة فواصل البداية/النهاية، وضمان بداية بحرف (القاعدة: يبدأ بحرف).
  slug = slug.slice(0, USERNAME_MAX_LEN).replace(/^[._-]+|[._-]+$/g, "");
  if (slug && !/^[a-z]/.test(slug)) slug = `u${slug}`.slice(0, USERNAME_MAX_LEN);
  return slug;
}

/**
 * يقترح اسم مستخدم متاحاً مشتقّاً من الاسم: يحوّل العربية إلى لاتينية، ثم يضمن التفرّد
 * بإلحاق رقم (ali.mohammed → ali.mohammed2 …). يعيد "" إن تعذّر الاشتقاق.
 */
export async function suggestUsername(name: string): Promise<string> {
  let base = deriveUsernameBase(name);
  if (base.length < USERNAME_MIN_LEN) base = base ? `${base}.user`.slice(0, USERNAME_MAX_LEN) : "";
  if (!base || !isValidUsername(base)) return "";
  if (await checkUsernameAvailable(base)) return base;
  for (let i = 2; i <= 99; i++) {
    const suffix = String(i);
    const candidate = `${base.slice(0, USERNAME_MAX_LEN - suffix.length)}${suffix}`;
    if (isValidUsername(candidate) && (await checkUsernameAvailable(candidate))) return candidate;
  }
  return "";
}

export async function getUser(userId: number) {
  const db = getDb();
  if (!db) return null;
  return (await db.select(SAFE_COLUMNS).from(users).where(eq(users.id, userId)).limit(1))[0] ?? null;
}

export async function listUsers(input: ListUsersInput = {}) {
  const db = getDb();
  if (!db) return { rows: [], total: 0 };
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 500);
  const offset = Math.max(input.offset ?? 0, 0);
  const conds: any[] = [];
  if (!input.includeInactive) conds.push(eq(users.isActive, true));
  if (input.role) conds.push(eq(users.role, input.role as any));
  if (input.q?.trim()) {
    const q = `%${escapeLike(input.q.trim())}%`;
    conds.push(or(like(users.name, q), like(users.email, q), like(users.username, q), like(users.phone, q)));
  }
  const where = conds.length ? and(...conds) : undefined;
  const rows = await db
    .select(SAFE_COLUMNS).from(users).where(where as any)
    .orderBy(asc(users.name), desc(users.id)).limit(limit).offset(offset);
  const totalRow = (await db.select({ n: sql<number>`COUNT(*)` }).from(users).where(where as any))[0];
  return { rows, total: Number(totalRow?.n ?? 0) };
}

export const PASSWORD_MIN = PASSWORD_MIN_LEN;
