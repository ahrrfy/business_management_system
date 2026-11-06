// أدوات مشتركة بين كل راوترات وحدة البطاقات الرقمية والاشتراكات — انظر digitalCardsRouter.ts.
import { appErrorMessage } from "../../../shared/errors";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getDb } from "../../db";
import type { DB } from "../../db";
import type { Actor } from "../../services/tx";
import type { DigitalCardRefundControl, DigitalRefundTender } from "../../../shared/digitalPaymentSettlement";
import { nonNegMoneyString } from "../../lib/schemas";

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

const executionRefundSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("CASH") }).strict(),
  z.object({ method: z.literal("CARD"), reference: z.string().trim().min(1).max(100), confirmed: z.literal(true) }).strict(),
]);
const refundRequestSchema = z.union([executionRefundSchema, z.object({ method: z.literal("CARD") }).strict()]);
export const digitalRefundActionFields = {
  stage: z.enum(["RESERVE", "RELEASE", "EVIDENCE", "EXECUTE"]).default("EXECUTE"),
  refund: refundRequestSchema.default({ method: "CASH" }),
  expectedRefundAmount: nonNegMoneyString.optional(),
  refundGrantToken: z.string().trim().min(1).max(64).optional(),
  noRefundConfirmed: z.literal(true).optional(),
  releaseReason: z.string().trim().min(5).max(300).optional(),
};
export function digitalRefundTender(value: z.infer<typeof refundRequestSchema>): DigitalRefundTender {
  const parsed = executionRefundSchema.safeParse(value);
  if (!parsed.success) throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({"what":"تعذّر توثيق رد البطاقة","why":"أدخل مرجع نجاح الرد وأكّد تنفيذه على البطاقة الأصلية بعد حجز المبلغ","doThis":"طابق المرجع مع سجل الجهاز ثم احفظ الإثبات دون تكرار الرد"}) });
  return parsed.data;
}
export function digitalRefundControl(input: {
  stage: string; refund: z.infer<typeof refundRequestSchema>; expectedRefundAmount?: string; noRefundConfirmed?: true; releaseReason?: string; refundGrantToken?: string;
}): DigitalCardRefundControl {
  if (input.refund.method !== "CARD") throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({"what":"تعذّر طلب إثبات الرد","why":"حجز الرد وإثبات الجهاز يخصّان البطاقة؛ النقد يصرف داخل الاعتماد","doThis":"اختر الاعتماد النقدي أو استعد حجز رد البطاقة الأصلي"}) });
  if (input.stage === "RESERVE" && input.expectedRefundAmount) return { stage: "RESERVE", expectedAmount: input.expectedRefundAmount };
  if (input.stage === "RELEASE" && input.noRefundConfirmed && input.releaseReason) return { stage: "RELEASE", noRefundConfirmed: true, reason: input.releaseReason, grantToken: input.refundGrantToken };
  if (input.stage === "EVIDENCE") return { stage: "EVIDENCE", tender: digitalRefundTender(input.refund) };
  throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({"what":"تعذّر معالجة حجز الرد","why":"حدد مبلغ الحجز المطابق للخادم، أو أكّد عدم تنفيذ الرد وسبب تحريره","doThis":"حدّث تفاصيل العملية ثم أكمل مرحلة الحجز أو التحرير المطلوبة"}) });
}
