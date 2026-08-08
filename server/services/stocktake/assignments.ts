// إدارة عمّال الجرد أثناء الجلسة: إضافة/إزالة آمنة مع إبطال الوصول وحفظ العدّات والتدقيق.
import { TRPCError } from "@trpc/server";
import { randomInt } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import {
  stocktakeAssignments,
  stocktakeCounts,
  stocktakeItems,
  users,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { hashPassword, verifyPassword } from "../../auth/password";
import { withTx } from "../tx";
import { chunk, lockSession } from "./internal";
import type { StkActor } from "./types";

const MAX_ACTIVE_WORKERS = 20;

export type AddStocktakeWorkerInput = {
  sessionId: number;
  name: string;
  method: "PIN" | "USER";
  userId?: number;
  zone?: string;
};

export type RemoveStocktakeWorkerInput = {
  sessionId: number;
  assignmentId: number;
  reason: string;
};

/**
 * يعيد توزيع «اقتراحات التوجيه» للأصناف غير المعدودة فقط. القائمة في البوابة
 * تبقى مشتركة بالكامل؛ لا تتغيّر العدّات ولا أصحابها ولا أي صنف تم عدّه فعلياً.
 */
async function rebalanceUncountedRouting(tx: Tx, sessionId: number, activeAssignmentIds: number[]): Promise<number> {
  if (!activeAssignmentIds.length) return 0;
  const effectiveCount = alias(stocktakeCounts, "stk_rebalance_effective_count");
  const items = await tx
    .select({ id: stocktakeItems.id })
    .from(stocktakeItems)
    .leftJoin(
      effectiveCount,
      and(
        eq(effectiveCount.sessionId, stocktakeItems.sessionId),
        eq(effectiveCount.variantId, stocktakeItems.variantId),
        inArray(effectiveCount.kind, ["FIRST", "RECOUNT"]),
      ),
    )
    .where(and(eq(stocktakeItems.sessionId, sessionId), isNull(effectiveCount.id)))
    .orderBy(asc(stocktakeItems.id));

  const grouped = new Map<number, number[]>();
  activeAssignmentIds.forEach((id) => grouped.set(id, []));
  items.forEach((item, index) => grouped.get(activeAssignmentIds[index % activeAssignmentIds.length])!.push(Number(item.id)));

  for (const [assignmentId, itemIds] of Array.from(grouped.entries())) {
    for (const ids of chunk(itemIds)) {
      if (!ids.length) continue;
      await tx.update(stocktakeItems).set({ assignmentId }).where(inArray(stocktakeItems.id, ids));
    }
  }
  return items.length;
}

async function generateUniqueActivePin(
  siblings: Array<{ pinHash: string | null; status: "ACTIVE" | "SUBMITTED" | "REMOVED" }>,
): Promise<string> {
  const activeHashes = siblings.filter((a) => a.status === "ACTIVE" && a.pinHash).map((a) => a.pinHash!);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const pin = String(randomInt(0, 10_000)).padStart(4, "0");
    if (!activeHashes.some((stored) => verifyPassword(pin, stored))) return pin;
  }
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر توليد رمز PIN فريد" });
}

export async function addStocktakeWorker(input: AddStocktakeWorkerInput, actor: StkActor) {
  return withTx(async (tx) => {
    const session = await lockSession(tx, input.sessionId);
    if (session.status !== "COUNTING") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "يمكن إضافة عامل أثناء مرحلة العدّ فقط" });
    }

    const siblings = await tx
      .select({
        id: stocktakeAssignments.id,
        name: stocktakeAssignments.name,
        method: stocktakeAssignments.method,
        userId: stocktakeAssignments.userId,
        pinHash: stocktakeAssignments.pinHash,
        status: stocktakeAssignments.status,
      })
      .from(stocktakeAssignments)
      .where(eq(stocktakeAssignments.sessionId, input.sessionId))
      .orderBy(asc(stocktakeAssignments.id))
      .for("update");
    const active = siblings.filter((a) => a.status === "ACTIVE");
    if (active.length >= MAX_ACTIVE_WORKERS) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `الحد الأعلى ${MAX_ACTIVE_WORKERS} عامل جرد نشط في الجلسة` });
    }

    const requestedName = input.name.trim();
    const requestedZone = input.zone?.trim() || null;
    let effectiveName = requestedName;
    let effectiveUserId: number | null = null;
    if (input.method === "USER") {
      if (!input.userId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "اختر حساب الموظف المراد تكليفه" });
      }
      if (active.some((a) => a.method === "USER" && Number(a.userId) === Number(input.userId))) {
        throw new TRPCError({ code: "CONFLICT", message: "هذا الموظف مضاف بالفعل إلى الجلسة" });
      }
      const [user] = await tx
        .select({ id: users.id, name: users.name, isActive: users.isActive })
        .from(users)
        .where(eq(users.id, input.userId))
        .limit(1);
      if (!user || user.isActive === false) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "الموظف غير موجود أو حسابه معطّل" });
      }
      effectiveUserId = Number(user.id);
      effectiveName = user.name?.trim() || requestedName || `مستخدم #${effectiveUserId}`;
    } else if (active.some((a) => a.name.trim() === requestedName)) {
      throw new TRPCError({ code: "CONFLICT", message: "يوجد عامل نشط بالاسم نفسه في الجلسة" });
    }

    const pin = input.method === "PIN" ? await generateUniqueActivePin(siblings) : undefined;
    const inserted = await tx.insert(stocktakeAssignments).values({
      sessionId: input.sessionId,
      name: effectiveName,
      method: input.method,
      userId: effectiveUserId,
      pinHash: pin ? hashPassword(pin) : null,
      zone: requestedZone,
      status: "ACTIVE",
      addedBy: actor.userId,
    });
    const assignmentId = extractInsertId(inserted);
    const activeIds = [...active.map((a) => Number(a.id)), assignmentId];
    const routedItemCount = await rebalanceUncountedRouting(tx, input.sessionId, activeIds);

    return {
      assignmentId,
      name: effectiveName,
      method: input.method,
      userId: effectiveUserId,
      zone: requestedZone,
      status: "ACTIVE" as const,
      pin,
      routedItemCount,
    };
  });
}

export async function removeStocktakeWorker(input: RemoveStocktakeWorkerInput, actor: StkActor) {
  return withTx(async (tx) => {
    const session = await lockSession(tx, input.sessionId);
    if (session.status !== "COUNTING") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "يمكن إزالة عامل أثناء مرحلة العدّ فقط" });
    }

    const siblings = await tx
      .select()
      .from(stocktakeAssignments)
      .where(eq(stocktakeAssignments.sessionId, input.sessionId))
      .orderBy(asc(stocktakeAssignments.id))
      .for("update");
    const target = siblings.find((a) => Number(a.id) === input.assignmentId);
    if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "عامل الجرد غير موجود في هذه الجلسة" });
    if (target.status === "REMOVED") {
      return { ok: true as const, alreadyRemoved: true, preservedCountRows: 0, routedItemCount: 0 };
    }

    const remainingActiveIds = siblings
      .filter((a) => a.status === "ACTIVE" && Number(a.id) !== input.assignmentId)
      .map((a) => Number(a.id));
    if (!remainingActiveIds.length) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "لا يمكن إزالة آخر عامل نشط — أضف العامل البديل أولاً لضمان استمرار الجرد",
      });
    }

    const [{ countRows = 0 } = { countRows: 0 }] = await tx
      .select({ countRows: sql<number>`COUNT(*)` })
      .from(stocktakeCounts)
      .where(and(eq(stocktakeCounts.sessionId, input.sessionId), eq(stocktakeCounts.assignmentId, input.assignmentId)));

    await tx
      .update(stocktakeAssignments)
      .set({
        status: "REMOVED",
        pinHash: null,
        failedPinAttempts: 0,
        lockedUntil: null,
        removedBy: actor.userId,
        removedAt: new Date(),
        removalReason: input.reason.trim(),
      })
      .where(eq(stocktakeAssignments.id, input.assignmentId));

    const routedItemCount = await rebalanceUncountedRouting(tx, input.sessionId, remainingActiveIds);
    return {
      ok: true as const,
      alreadyRemoved: false,
      preservedCountRows: Number(countRows),
      routedItemCount,
    };
  });
}
