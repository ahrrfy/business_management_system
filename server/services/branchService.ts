/**
 * branchService.ts — إدارة الفروع (CRUD).
 *
 * الفرع وحدة تنظيمية مرجعية لكل حركة مخزون/بيع/شراء (branchId بلا ON DELETE في عشرات الجداول)،
 * لذا لا حذف صلب — فقط تعطيل منطقي (isActive=false) يُخفيه من منتقيات العمليات الجديدة بينما
 * يبقى مرجعاً تاريخياً صالحاً للفواتير والحركات القديمة (يطابق نمط customers/suppliers/categories).
 *
 * التعطيل محروس بشرطين: (١) لا يجوز تصفير الفروع النشطة إلى صفر — النظام يحتاج فرعاً نشطاً واحداً
 * على الأقل ليعمل، (٢) لا يجوز تعطيل فرع لا يزال يحمل مخزوناً فعلياً — سيصبح غير قابل للاختيار في
 * أي عملية جديدة رغم أنّ بضاعته حقيقية وقائمة.
 */
import { TRPCError } from "@trpc/server";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { branches, branchStock } from "../../drizzle/schema";
import { getDb } from "../db";
import { extractInsertId } from "../lib/insertId";
import { withTx, type Actor } from "./tx";

export type BranchType = "MAIN" | "SALES";
const CODE_RE = /^[A-Z0-9_-]{2,30}$/;

export interface BranchAdminRow {
  id: number;
  name: string;
  code: string;
  type: BranchType;
  address: string | null;
  phone: string | null;
  isActive: boolean;
  createdAt: Date;
}

/** قائمة كاملة (نشطة+معطّلة) لشاشة الإدارة — بخلاف branchRouter.list (نشطة فقط، لمنتقيات العمليات). */
export async function listBranchesAdmin(): Promise<BranchAdminRow[]> {
  const db = getDb();
  if (!db) return [];
  const rows = await db.select().from(branches).orderBy(asc(branches.id));
  return rows.map((b) => ({
    id: Number(b.id),
    name: b.name,
    code: b.code,
    type: b.type as BranchType,
    address: b.address ?? null,
    phone: b.phone ?? null,
    isActive: b.isActive == null ? true : !!b.isActive,
    createdAt: b.createdAt,
  }));
}

function normalizeCode(raw: string): string {
  const code = raw.trim().toUpperCase();
  if (!CODE_RE.test(code)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "رمز الفرع يجب أن يتكوّن من أحرف/أرقام إنجليزية أو (-/_) فقط، بلا مسافات (٢-٣٠ محرفاً).",
    });
  }
  return code;
}

async function assertCodeFree(code: string, excludeId?: number) {
  const db = getDb();
  if (!db) return;
  const clash = (
    await db
      .select({ id: branches.id })
      .from(branches)
      .where(excludeId != null ? and(eq(branches.code, code), ne(branches.id, excludeId)) : eq(branches.code, code))
      .limit(1)
  )[0];
  if (clash) throw new TRPCError({ code: "CONFLICT", message: `رمز الفرع «${code}» مستخدَم مسبقاً.` });
}

export async function createBranch(
  input: { name: string; code: string; type: BranchType; address?: string | null; phone?: string | null },
  _actor: Actor,
) {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
  const name = input.name.trim();
  if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "اسم الفرع مطلوب." });
  const code = normalizeCode(input.code);
  await assertCodeFree(code);
  const res = await db.insert(branches).values({
    name,
    code,
    type: input.type,
    address: input.address?.trim() || null,
    phone: input.phone?.trim() || null,
  });
  return { id: extractInsertId(res), name, code };
}

export async function updateBranch(
  input: {
    id: number;
    name?: string;
    code?: string;
    type?: BranchType;
    address?: string | null;
    phone?: string | null;
  },
  _actor: Actor,
) {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
  const cur = (await db.select().from(branches).where(eq(branches.id, input.id)).limit(1))[0];
  if (!cur) throw new TRPCError({ code: "NOT_FOUND", message: "الفرع غير موجود." });

  const patch: Partial<typeof branches.$inferInsert> = {};
  if (input.name != null) {
    const name = input.name.trim();
    if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "اسم الفرع مطلوب." });
    patch.name = name;
  }
  if (input.code != null) {
    const code = normalizeCode(input.code);
    if (code !== cur.code) {
      await assertCodeFree(code, input.id);
      patch.code = code;
    }
  }
  if (input.type != null) patch.type = input.type;
  if (input.address !== undefined) patch.address = input.address?.trim() || null;
  if (input.phone !== undefined) patch.phone = input.phone?.trim() || null;

  if (Object.keys(patch).length) await db.update(branches).set(patch).where(eq(branches.id, input.id));
  return { id: input.id };
}

/**
 * تعطيل/تفعيل فرع. راجع تعليق الملف للشرطين الحارسين عند التعطيل. القفل (`for("update")`) يمنع
 * سباقاً بين تعطيلين متزامنين لآخر فرعين نشطين معاً.
 */
export async function setBranchActive(id: number, isActive: boolean, _actor: Actor) {
  return withTx(async (tx) => {
    const b = (await tx.select().from(branches).where(eq(branches.id, id)).for("update").limit(1))[0];
    if (!b) throw new TRPCError({ code: "NOT_FOUND", message: "الفرع غير موجود." });
    const currentlyActive = b.isActive == null ? true : !!b.isActive;
    if (currentlyActive === isActive) return { id, isActive };

    if (!isActive) {
      const others = Number(
        (
          await tx
            .select({ n: sql<number>`COUNT(*)` })
            .from(branches)
            .where(and(eq(branches.isActive, true), ne(branches.id, id)))
        )[0]?.n ?? 0,
      );
      if (others === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "لا يمكن تعطيل آخر فرع نشط — يجب أن يبقى فرع واحد نشط على الأقل.",
        });
      }

      const stockQty = Number(
        (
          await tx
            .select({ n: sql<number>`COALESCE(SUM(${branchStock.quantity}), 0)` })
            .from(branchStock)
            .where(eq(branchStock.branchId, id))
        )[0]?.n ?? 0,
      );
      if (stockQty !== 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "لا يمكن تعطيل فرع لا يزال يحمل مخزوناً — صفِّر رصيده أو انقله لفرع آخر أولاً.",
        });
      }
    }

    await tx.update(branches).set({ isActive }).where(eq(branches.id, id));
    return { id, isActive };
  });
}
