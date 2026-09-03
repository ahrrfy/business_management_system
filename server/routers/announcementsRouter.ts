import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { z } from "zod";
import { ROLES } from "@shared/permissions";
import {
  announcementsManagerProcedure,
  announcementsReadProcedure,
  selfServiceProcedure,
  router,
} from "../trpc";
import { logAudit } from "../services/auditService";
import {
  acknowledgeAnnouncement,
  createAnnouncement,
  getAnnouncementWithReaders,
  listAnnouncements,
  markAnnouncementRead,
  myAnnouncements,
  setAnnouncementActive,
} from "../services/announcementService";
import type { AnnouncementManagementScope } from "../services/announcementService";

const roleKeys = ROLES.map((r) => r.key) as [string, ...string[]];

function managementScope(user: {
  role: string;
  branchId?: number | null;
}): AnnouncementManagementScope {
  const canCrossBranches = user.role === "admin";
  if (!canCrossBranches && user.branchId == null) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذّر فتح إدارة الإعلانات",
        why: "الإعلان يُدار بنطاق فرع، وحسابُك بلا فرعٍ مُسنَد فلا يُعرَف نطاقُك",
        doThis: "اطلب من المدير إسناد فرعٍ لحسابك من شاشة المستخدمين، ثمّ أعد المحاولة",
      }),
    });
  }
  return {
    branchId: user.branchId == null ? null : Number(user.branchId),
    canCrossBranches,
  };
}

const createInput = z
  .object({
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(5000),
    priority: z.enum(["NORMAL", "IMPORTANT", "CRITICAL"]).optional(),
    audienceType: z.enum(["ALL", "BRANCH", "ROLE"]),
    audienceBranchId: z.number().int().positive().nullish(),
    audienceRole: z.enum(roleKeys).nullish(),
    requiresAck: z.boolean().optional(),
    expiresAt: z.string().datetime().nullish(),
  })
  .refine((v) => v.audienceType !== "BRANCH" || v.audienceBranchId != null, {
    message: "اختر الفرع المستهدَف",
    path: ["audienceBranchId"],
  })
  .refine((v) => v.audienceType !== "ROLE" || v.audienceRole != null, {
    message: "اختر الدور المستهدَف",
    path: ["audienceRole"],
  })
  .refine((v) => !v.expiresAt || new Date(v.expiresAt).getTime() > Date.now(), {
    message: "تاريخ انتهاء الإعلان يجب أن يكون في المستقبل",
    path: ["expiresAt"],
  });

export const announcementsRouter = router({
  // ─── إدارة ───────────────────────────────────────────────────────────
  // الإنشاء: manager+ / announcements:FULL. حوكمة الفرع: مدير الفرع (غير admin/owner) يبثّ لفرعه فقط.
  create: announcementsManagerProcedure.input(createInput).mutation(async ({ ctx, input }) => {
    const crossBranch = ctx.user.role === "admin" || ctx.user.isOwner === true;
    if (!crossBranch) {
      if (ctx.user.branchId == null) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: appErrorMessage({
            what: "تعذّر نشر الإعلان",
            why: "غيرُ المدير العامّ يبثّ إلى فرعه وحده، وحسابُك بلا فرعٍ مُسنَد فلا يُعرَف من يصله",
            doThis: "اطلب من المدير إسناد فرعٍ لحسابك، أو اطلب منه نشرَ الإعلان لكلّ الفروع",
          }),
        });
      }
      if (input.audienceType !== "BRANCH" || Number(input.audienceBranchId) !== Number(ctx.user.branchId)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "مدير الفرع يبثّ لفرعه فقط — اختر جمهور «الفرع» بفرعك (البثّ عبر الفروع للأدمن).",
        });
      }
    }
    const result = await createAnnouncement(
      {
        title: input.title,
        body: input.body,
        priority: input.priority,
        audienceType: input.audienceType,
        audienceBranchId: input.audienceBranchId ?? null,
        audienceRole: input.audienceRole ?? null,
        requiresAck: input.requiresAck,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      },
      ctx.user.id,
    );
    await logAudit(ctx, {
      action: "announcement.create",
      entityType: "announcement",
      entityId: result.id,
      newValue: { audienceType: input.audienceType, recipientCount: result.recipientCount },
    });
    return result;
  }),

  // القراءة الإدارية: announcements≥READ (يشمل المدقّق).
  list: announcementsReadProcedure
    .input(z.object({ includeInactive: z.boolean().optional(), limit: z.number().int().min(1).max(200).optional() }).optional())
    .query(({ ctx, input }) => listAnnouncements(managementScope(ctx.user), input)),

  get: announcementsReadProcedure.input(z.object({ id: z.number().int().positive() })).query(async ({ ctx, input }) => {
    const r = await getAnnouncementWithReaders(input.id, managementScope(ctx.user));
    if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "الإعلان غير موجود" });
    return r;
  }),

  setActive: announcementsManagerProcedure
    .input(z.object({ id: z.number().int().positive(), isActive: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const found = await setAnnouncementActive(input.id, input.isActive, managementScope(ctx.user));
      if (!found) throw new TRPCError({ code: "NOT_FOUND", message: "الإعلان غير موجود" });
      await logAudit(ctx, {
        action: "announcement.setActive",
        entityType: "announcement",
        entityId: input.id,
        newValue: { isActive: input.isActive },
      });
      return { ok: true };
    }),

  // ─── ذاتيّ (أيّ موظف مصادَق يرى إعلاناته المستهدَفة فقط) ─────────────────
  mine: selfServiceProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).optional() }).optional())
    .query(({ ctx, input }) =>
      myAnnouncements({ id: ctx.user.id, role: ctx.user.role, branchId: ctx.user.branchId ?? null }, input?.limit ?? 50),
    ),

  markRead: selfServiceProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    await markAnnouncementRead({ id: ctx.user.id, role: ctx.user.role, branchId: ctx.user.branchId ?? null }, input.id);
    return { ok: true };
  }),

  acknowledge: selfServiceProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    await acknowledgeAnnouncement({ id: ctx.user.id, role: ctx.user.role, branchId: ctx.user.branchId ?? null }, input.id);
    return { ok: true };
  }),
});
