import { ALL_ROLES, type RoleKey } from "@shared/permissions";
import { z } from "zod";
import { logAudit } from "../services/auditService";
import {
  builtinRoles,
  createRole,
  deleteRole,
  getRole,
  listCustomRoles,
  roleUserCounts,
  setRoleActive,
  updateRole,
} from "../services/roleService";
import { adminProcedure, router } from "../trpc";

const BASE_ROLE = z.enum(ALL_ROLES as [RoleKey, ...RoleKey[]]);
const ACCESS = z.enum(["FULL", "READ", "NONE"]);
const PERMISSIONS = z.record(z.string(), ACCESS);

export const roleRouter = router({
  /** الأدوار المبنية (للقراءة) + المخصّصة + عدد المستخدمين لكلٍّ. */
  list: adminProcedure
    .input(z.object({ includeInactive: z.boolean().default(false) }).optional())
    .query(async ({ input }) => {
      const [custom, counts] = await Promise.all([
        listCustomRoles(input?.includeInactive ?? false),
        roleUserCounts(),
      ]);
      return { builtin: builtinRoles(), custom, counts };
    }),

  get: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(({ input }) => getRole(input.id)),

  create: adminProcedure
    .input(
      z.object({
        label: z.string().min(1).max(120),
        key: z.string().max(64).optional(),
        description: z.string().max(2000).nullish(),
        baseRole: BASE_ROLE,
        permissions: PERMISSIONS,
      })
    )
    .mutation(async ({ input, ctx }) => {
      const res = await createRole(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, {
        action: "role.create",
        entityType: "role",
        entityId: res.id,
        // H5 (تدقيق ٢٣/٦/٢٦): سَجِّل خريطة الصلاحيات الأوّليّة كاملةً ⇒ يَكشف لاحقاً «من
        // أعطى أيّ صلاحية من البداية» (لا يَكفي label/baseRole — هما لا يُظهران FULL/READ/NONE).
        newValue: { key: res.key, label: input.label, baseRole: input.baseRole, permissions: input.permissions },
      });
      return res;
    }),

  update: adminProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        label: z.string().min(1).max(120).optional(),
        description: z.string().max(2000).nullish(),
        baseRole: BASE_ROLE.optional(),
        permissions: PERMISSIONS.optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // H5 (تدقيق ٢٣/٦/٢٦): توسعة دور خفيّة كانت بلا أَثَر forensic — لا oldValue ولا حتى
      // newValue لخريطة الصلاحيات. أَدمن مُخترَق يَمنح cashier صلاحية FULL على /reports لساعة
      // ثم يَعيدها، فالسجلّ يُظهر «تعديل عنوان» فقط. الآن نَلتقط لقطة كاملة قبل/بعد ⇒ نافذة
      // الإساءة كاشفة (audit log diff).
      const before = await getRole(input.id);
      const res = await updateRole(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, {
        action: "role.update",
        entityType: "role",
        entityId: input.id,
        oldValue: {
          label: before?.label ?? null,
          baseRole: before?.baseRole ?? null,
          permissions: (before as { permissions?: unknown })?.permissions ?? null,
        },
        newValue: {
          label: input.label,
          baseRole: input.baseRole,
          // input.permissions optional ⇒ undefined = «بلا تغيير» (لا نَكتب null بدل غير المعطى).
          permissions: input.permissions,
        },
      });
      return res;
    }),

  setActive: adminProcedure
    .input(z.object({ id: z.number().int().positive(), isActive: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const res = await setRoleActive(input.id, input.isActive, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, {
        action: input.isActive ? "role.activate" : "role.deactivate",
        entityType: "role",
        entityId: input.id,
      });
      return res;
    }),

  remove: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await deleteRole(input.id, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, { action: "role.delete", entityType: "role", entityId: input.id });
      return res;
    }),
});
