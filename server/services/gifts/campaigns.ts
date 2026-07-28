// حملات الهدايا (G-م٧): تصنيف + ميزانيّة اختياريّة تُفرَض بقفل تسلسليّ عند كل هدية صادرة مرتبطة
// (انظر lockCampaignAndCheckBudget في outbound.ts). قراءة/إنشاء/إغلاق فقط — لا تعديل للحملات القائمة
// (نمط append-only للحوكمة: إغلاق نظيف بدل تحرير رجعيّ يُربك تتبّع الإنفاق التاريخيّ).
import { TRPCError } from "@trpc/server";
import { desc, eq, sql } from "drizzle-orm";
import { giftCampaigns, giftVouchers } from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { money, round2 } from "../money";
import { requireDb, withTx, type Actor } from "../tx";

export interface CreateCampaignInput {
  name: string;
  reason?: string | null;
  startDate?: string | null; // YYYY-MM-DD
  endDate?: string | null;
  budgetCost?: string | null; // ميزانيّة اختياريّة (د.ع) — تُفرَض عند الربط في outbound.ts
}
export interface CreateCampaignResult {
  campaignId: number;
}

/** حوكمة الحملة (تحديد ميزانية/إغلاق) قرارٌ سياسيّ لا عمليّاتيّ — مدير/أدمن فقط (تدقيق Codex P1):
 *  المخزن يملك gifts=FULL (عمليّاتيّ: استلام/منح) لكنه لا يُقرَّر بميزانيّات عامّة أو يُغلق حملات الغير. */
function assertCampaignGovernance(actor: Actor): void {
  if (actor.role !== "admin" && actor.role !== "manager") {
    throw new TRPCError({ code: "FORBIDDEN", message: "إدارة حملات الهدايا (إنشاء/إغلاق) من صلاحية المدير فقط" });
  }
}

export async function createGiftCampaign(input: CreateCampaignInput, actor: Actor): Promise<CreateCampaignResult> {
  assertCampaignGovernance(actor);
  const name = input.name?.trim();
  if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "اسم الحملة مطلوب" });
  if (input.startDate && input.endDate && input.endDate < input.startDate) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "تاريخ الانتهاء يجب أن يكون بعد تاريخ البدء" });
  }
  let budgetCost: string | null = null;
  if (input.budgetCost != null && input.budgetCost !== "") {
    const b = round2(money(input.budgetCost));
    if (b.lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "ميزانيّة الحملة يجب أن تكون موجبة" });
    budgetCost = b.toFixed(2);
  }

  return withTx(async (tx) => {
    const res = await tx.insert(giftCampaigns).values({
      name,
      reason: input.reason?.trim() || null,
      startDate: input.startDate ? new Date(input.startDate) : null,
      endDate: input.endDate ? new Date(input.endDate) : null,
      budgetCost,
      status: "ACTIVE",
      createdBy: actor.userId,
    });
    return { campaignId: extractInsertId(res) };
  });
}

export interface ListCampaignsFilter {
  status?: "ACTIVE" | "CLOSED";
}

/** يعيد الحملات + المُنفَق الفعليّ (SUM totalCost للصادر المُنجَز فقط) لعرض الاستهلاك مقابل الميزانيّة. */
export async function listGiftCampaigns(filter: ListCampaignsFilter = {}) {
  const db = requireDb();
  const spentExpr = sql<string>`COALESCE(SUM(CASE WHEN ${giftVouchers.status} = 'DELIVERED' THEN ${giftVouchers.totalCost} ELSE 0 END), 0)`;
  return db
    .select({
      id: giftCampaigns.id,
      name: giftCampaigns.name,
      reason: giftCampaigns.reason,
      startDate: giftCampaigns.startDate,
      endDate: giftCampaigns.endDate,
      budgetCost: giftCampaigns.budgetCost,
      status: giftCampaigns.status,
      createdAt: giftCampaigns.createdAt,
      spent: spentExpr,
    })
    .from(giftCampaigns)
    .leftJoin(giftVouchers, eq(giftVouchers.campaignId, giftCampaigns.id))
    .where(filter.status ? eq(giftCampaigns.status, filter.status) : undefined)
    .groupBy(giftCampaigns.id)
    .orderBy(desc(giftCampaigns.id));
}

/** إغلاق حملة (نهائيّ — لا إعادة فتح): بعده يرفض outbound.ts أيّ هدية جديدة تُربَط بها. */
export async function closeGiftCampaign(campaignId: number, actor: Actor): Promise<void> {
  assertCampaignGovernance(actor);
  return withTx(async (tx) => {
    const camp = (await tx.select({ status: giftCampaigns.status }).from(giftCampaigns).where(eq(giftCampaigns.id, campaignId)).for("update").limit(1))[0];
    if (!camp) throw new TRPCError({ code: "NOT_FOUND", message: "الحملة غير موجودة" });
    if (camp.status === "CLOSED") throw new TRPCError({ code: "BAD_REQUEST", message: "الحملة مغلقة مسبقاً" });
    await tx.update(giftCampaigns).set({ status: "CLOSED" }).where(eq(giftCampaigns.id, campaignId));
  });
}
