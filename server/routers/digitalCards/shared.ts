// أدوات مشتركة بين كل راوترات وحدة البطاقات الرقمية والاشتراكات — انظر digitalCardsRouter.ts.
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getDb } from "../../db";
import type { DB } from "../../db";
import type { Actor } from "../../services/tx";

export function requireDb(): DB {
  const db = getDb();
  if (!db) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير مهيّأة" });
  }
  return db;
}

export type Ctx = { user: { id: number; role: string; branchId?: number | null; isOwner?: boolean } };

export function actorOf(ctx: Ctx): Actor {
  return {
    userId: ctx.user.id,
    branchId: Number(ctx.user.branchId ?? 0),
    role: ctx.user.role,
    isOwner: Boolean(ctx.user.isOwner),
  };
}

/** عزل مدير الفرع (قرار المالك ١٢/٨): المالك/الأدمن فقط يعبُران الفروع (owner مُطبَّع ⇒ admin)؛
 *  مدير الفرع وغيره محبوسون بفرعهم. محسوبٌ محلياً لأن `moduleProcedure` لا تحقن scopedBranchId. */
export function scopedBranchOf(ctx: Ctx): number | null {
  const elevated = ctx.user.role === "admin";
  return elevated ? null : Number(ctx.user.branchId);
}

export const idInput = z.object({ id: z.number().int().positive() });
