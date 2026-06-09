import { PASSWORD_MIN_LEN, PASSWORD_POLICY_MSG, isStrongPassword } from "@shared/const";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, like, ne, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { users } from "../../drizzle/schema";
import { getDb } from "../db";
import { hashPassword, verifyPassword } from "../auth/password";
import { withTx, type Actor } from "./tx";

export type Role = "user" | "admin" | "manager" | "cashier" | "warehouse";

export interface CreateUserInput {
  email: string;
  password: string;
  name: string;
  role?: Role;
  branchId?: number | null;
  // v3-add-screens: حقول HR + هاتف اتّصال + override صلاحيات.
  phone?: string | null;
  jobTitle?: string | null;
  hiredAt?: string | null; // YYYY-MM-DD
  permissionsOverride?: Record<string, "FULL" | "READ" | "NONE"> | null;
}

export interface UpdateUserInput {
  userId: number;
  name?: string;
  email?: string;
  role?: Role;
  branchId?: number | null;
  phone?: string | null;
  jobTitle?: string | null;
  hiredAt?: string | null;
  permissionsOverride?: Record<string, "FULL" | "READ" | "NONE"> | null;
}

export interface ListUsersInput {
  q?: string;
  role?: Role;
  includeInactive?: boolean;
  limit?: number;
  offset?: number;
}

/** الأعمدة الآمنة للعرض — **بلا passwordHash إطلاقاً**. */
const SAFE_COLUMNS = {
  id: users.id,
  name: users.name,
  email: users.email,
  phone: users.phone,
  role: users.role,
  branchId: users.branchId,
  isActive: users.isActive,
  jobTitle: users.jobTitle,
  hiredAt: users.hiredAt,
  permissionsOverride: users.permissionsOverride,
  lastSignedIn: users.lastSignedIn,
  createdAt: users.createdAt,
} as const;

function normEmail(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

function assertPasswordPolicy(pw: string) {
  if (!isStrongPassword(pw)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: PASSWORD_POLICY_MSG });
  }
}

/** يرفض ترك النظام بلا أيّ مدير (admin) نشط — يستثني المستخدم محلّ التعديل. */
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
  // Drizzle يغلّف خطأ السائق؛ رمز mysql2 (ER_DUP_ENTRY) قد يكون على e.code أو e.cause.code.
  const code = e?.code ?? e?.cause?.code ?? e?.cause?.cause?.code;
  if (code === "ER_DUP_ENTRY") {
    throw new TRPCError({ code: "CONFLICT", message: "البريد الإلكتروني مستخدم مسبقاً." });
  }
  throw e;
}

/** إنشاء مستخدم جديد (ذرّي + UNIQUE على البريد يمنع السباق المكرّر). */
export async function createUser(input: CreateUserInput, _actor: Actor) {
  return withTx(async (tx) => {
    const name = input.name?.trim();
    if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "اسم المستخدم مطلوب" });
    if (name.length > 255)
      throw new TRPCError({ code: "BAD_REQUEST", message: "اسم المستخدم طويل جداً" });

    const email = normEmail(input.email);
    if (!email) throw new TRPCError({ code: "BAD_REQUEST", message: "البريد الإلكتروني مطلوب" });
    assertPasswordPolicy(input.password);

    try {
      const res = await tx.insert(users).values({
        openId: `local_${nanoid()}`,
        email,
        name,
        passwordHash: hashPassword(input.password),
        role: input.role ?? "cashier",
        loginMethod: "local",
        branchId: input.branchId ?? null,
        isActive: true,
        // v3-add-screens.
        phone: input.phone?.trim() || null,
        jobTitle: input.jobTitle?.trim() || null,
        hiredAt: input.hiredAt ? new Date(input.hiredAt) : null,
        permissionsOverride: input.permissionsOverride ?? null,
      });
      const userId = Number((res as any)[0]?.insertId ?? (res as any).insertId);
      return { userId };
    } catch (e) {
      rethrowDup(e);
    }
  });
}

/** تعديل مستخدم — مع حواجز آخر مدير والحماية الذاتية. */
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
      if (name.length > 255)
        throw new TRPCError({ code: "BAD_REQUEST", message: "اسم المستخدم طويل جداً" });
      patch.name = name;
    }

    if (input.email !== undefined) {
      const email = normEmail(input.email);
      if (!email) throw new TRPCError({ code: "BAD_REQUEST", message: "البريد الإلكتروني مطلوب" });
      patch.email = email;
    }

    if (input.branchId !== undefined) patch.branchId = input.branchId ?? null;
    if (input.phone !== undefined) patch.phone = input.phone?.trim() || null;
    if (input.jobTitle !== undefined) patch.jobTitle = input.jobTitle?.trim() || null;
    if (input.hiredAt !== undefined) patch.hiredAt = input.hiredAt ? new Date(input.hiredAt) : null;
    if (input.permissionsOverride !== undefined) patch.permissionsOverride = input.permissionsOverride ?? null;

    if (input.role !== undefined && input.role !== existing.role) {
      // منع تخفيض الذات: المدير لا يسحب صلاحيّته من نفسه (يقفل نفسه خارج النظام).
      if (input.userId === actor.userId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكنك تغيير دور حسابك بنفسك." });
      }
      // منع تخفيض آخر مدير نشط.
      if (existing.role === "admin") {
        await assertNotLastActiveAdmin(tx, input.userId);
      }
      patch.role = input.role;
    }

    if (Object.keys(patch).length === 0) return { userId: input.userId, changed: false };

    try {
      await tx.update(users).set(patch).where(eq(users.id, input.userId));
    } catch (e) {
      rethrowDup(e);
    }
    return { userId: input.userId, changed: true };
  });
}

/** تفعيل/تعطيل مستخدم — تعطيل يُبطل جلساته فوراً ويُحمى آخر مدير والذات. */
export async function setUserActive(userId: number, isActive: boolean, actor: Actor) {
  return withTx(async (tx) => {
    const u = (
      await tx.select().from(users).where(eq(users.id, userId)).for("update").limit(1)
    )[0];
    if (!u) throw new TRPCError({ code: "NOT_FOUND", message: "المستخدم غير موجود" });
    if (!!u.isActive === isActive) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: isActive ? "المستخدم مفعّل بالفعل" : "المستخدم معطّل بالفعل",
      });
    }

    if (!isActive) {
      if (userId === actor.userId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكنك تعطيل حسابك بنفسك." });
      }
      if (u.role === "admin") {
        await assertNotLastActiveAdmin(tx, userId);
      }
      // إبطال جلسات المستخدم المعطَّل فوراً (إلى جانب رفض !isActive في getUserFromRequest).
      await tx
        .update(users)
        .set({ isActive: false, sessionsValidFrom: new Date() })
        .where(eq(users.id, userId));
      return { userId, isActive: false };
    }

    await tx.update(users).set({ isActive: true }).where(eq(users.id, userId));
    return { userId, isActive: true };
  });
}

/** إعادة تعيين كلمة مرور مستخدم (بواسطة مدير) — يبطل جلساته (يجبره على دخول جديد). */
export async function resetUserPassword(userId: number, newPassword: string, _actor: Actor) {
  return withTx(async (tx) => {
    assertPasswordPolicy(newPassword);
    const u = (
      await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update").limit(1)
    )[0];
    if (!u) throw new TRPCError({ code: "NOT_FOUND", message: "المستخدم غير موجود" });
    await tx
      .update(users)
      .set({ passwordHash: hashPassword(newPassword), sessionsValidFrom: new Date() })
      .where(eq(users.id, userId));
    return { userId, success: true };
  });
}

/** تغيير المستخدم كلمةَ مروره بنفسه — يتحقّق من الحالية ويبطل بقية الجلسات. */
export async function changePassword(userId: number, oldPassword: string, newPassword: string) {
  return withTx(async (tx) => {
    const u = (
      await tx.select().from(users).where(eq(users.id, userId)).for("update").limit(1)
    )[0];
    if (!u) throw new TRPCError({ code: "NOT_FOUND", message: "المستخدم غير موجود" });
    if (!verifyPassword(oldPassword, u.passwordHash)) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "كلمة المرور الحالية غير صحيحة." });
    }
    assertPasswordPolicy(newPassword);
    if (oldPassword === newPassword) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "كلمة المرور الجديدة يجب أن تختلف عن الحالية.",
      });
    }
    await tx
      .update(users)
      .set({ passwordHash: hashPassword(newPassword), sessionsValidFrom: new Date() })
      .where(eq(users.id, userId));
    return { userId, success: true };
  });
}

/** قراءة بطاقة مستخدم واحد (بلا passwordHash). */
export async function getUser(userId: number) {
  const db = getDb();
  if (!db) return null;
  return (await db.select(SAFE_COLUMNS).from(users).where(eq(users.id, userId)).limit(1))[0] ?? null;
}

/** قائمة المستخدمين مع بحث وفلاتر وتقسيم صفحات (بلا passwordHash). */
export async function listUsers(input: ListUsersInput = {}) {
  const db = getDb();
  if (!db) return { rows: [], total: 0 };
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 500);
  const offset = Math.max(input.offset ?? 0, 0);

  const conds: any[] = [];
  if (!input.includeInactive) conds.push(eq(users.isActive, true));
  if (input.role) conds.push(eq(users.role, input.role));
  if (input.q?.trim()) {
    const q = `%${input.q.trim()}%`;
    conds.push(or(like(users.name, q), like(users.email, q), like(users.phone, q)));
  }
  const where = conds.length ? and(...conds) : undefined;

  const rows = await db
    .select(SAFE_COLUMNS)
    .from(users)
    .where(where as any)
    .orderBy(asc(users.name), desc(users.id))
    .limit(limit)
    .offset(offset);

  const totalRow = (
    await db.select({ n: sql<number>`COUNT(*)` }).from(users).where(where as any)
  )[0];

  return { rows, total: Number(totalRow?.n ?? 0) };
}

export const PASSWORD_MIN = PASSWORD_MIN_LEN;
