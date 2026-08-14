import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { ROLES } from "@shared/permissions";
import { announcementsManagerProcedure, protectedProcedure, router } from "../trpc";
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

const roleKeys = ROLES.map((r) => r.key) as [string, ...string[]];

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
  });

export const announcementsRouter = router({
  // ─── إدارة (manager+ / announcements:FULL) ─────────────────────────────
  create: announcementsManagerProcedure.input(createInput).mutation(async ({ ctx, input }) => {
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

  list: announcementsManagerProcedure
    .input(z.object({ includeInactive: z.boolean().optional(), limit: z.number().int().min(1).max(200).optional() }).optional())
    .query(({ input }) => listAnnouncements(input)),

  get: announcementsManagerProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ input }) => {
      const r = await getAnnouncementWithReaders(input.id);
      if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "الإعلان غير موجود" });
      return r;
    }),

  setActive: announcementsManagerProcedure
    .input(z.object({ id: z.number().int().positive(), isActive: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await setAnnouncementActive(input.id, input.isActive);
      await logAudit(ctx, {
        action: "announcement.setActive",
        entityType: "announcement",
        entityId: input.id,
        newValue: { isActive: input.isActive },
      });
      return { ok: true };
    }),

  // ─── ذاتيّ (أيّ موظف مصادَق يرى إعلاناته المستهدَفة فقط) ─────────────────
  mine: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).optional() }).optional())
    .query(({ ctx, input }) =>
      myAnnouncements({ id: ctx.user.id, role: ctx.user.role, branchId: ctx.user.branchId ?? null }, input?.limit ?? 50),
    ),

  markRead: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    await markAnnouncementRead({ id: ctx.user.id, role: ctx.user.role, branchId: ctx.user.branchId ?? null }, input.id);
    return { ok: true };
  }),

  acknowledge: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    await acknowledgeAnnouncement({ id: ctx.user.id, role: ctx.user.role, branchId: ctx.user.branchId ?? null }, input.id);
    return { ok: true };
  }),
});
