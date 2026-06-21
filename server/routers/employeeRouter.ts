/* ============================================================================
 * موجّه tRPC للموظفين — وحدة الموارد البشرية (server/routers/employeeRouter.ts)
 * القراءة بصلاحية hr/READ والكتابة بـ hr/FULL (requireModule). كل كتابة تُدقَّق.
 * ========================================================================== */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { EMPLOYMENT_STATUS_KEYS, PAY_TYPE_KEYS } from "@shared/hr";
import {
  NOT_ADMIN_ERR_MSG,
  PASSWORD_MIN_LEN,
  PASSWORD_POLICY_MSG,
  PASSWORD_REGEX,
  USERNAME_MAX_LEN,
} from "@shared/const";
import { ALL_ROLES, type RoleKey } from "@shared/permissions";
import { logAudit } from "../services/auditService";
import * as svc from "../services/employeeService";
import type { CreateUserInput } from "../services/userService";
import { getEmployeeUsage } from "../services/entityUsage";
import { adminProcedure, protectedProcedure, requireModule, router } from "../trpc";

const hrRead = protectedProcedure.use(requireModule("hr", "READ"));
const hrWrite = protectedProcedure.use(requireModule("hr", "FULL"));

// —— مخطّطات حساب النظام (مطابقة لمدخل userRouter.create) ——
const ROLE = z.enum(ALL_ROLES as [RoleKey, ...RoleKey[]]);
const ACCESS = z.enum(["FULL", "READ", "NONE"]);
const PERM_OVERRIDE = z.record(z.string(), ACCESS).nullish();

/** حقول إنشاء حساب جديد (يُعاد استخدامها في createWithAccount و createAccountFor). */
const newAccountShape = {
  email: z.string().email().max(320).optional(),
  username: z.string().max(USERNAME_MAX_LEN).optional(),
  password: z.string().min(PASSWORD_MIN_LEN, PASSWORD_POLICY_MSG).max(128).regex(PASSWORD_REGEX, PASSWORD_POLICY_MSG),
  name: z.string().min(1).max(255),
  role: ROLE.default("cashier"),
  customRoleId: z.number().int().positive().nullish(),
  branchId: z.number().int().positive().nullish(),
  permissionsOverride: PERM_OVERRIDE,
  mustChangePassword: z.boolean().default(true),
} as const;

/** اشتراط معرّف دخول واحد على الأقل تُنفّذه الخدمة (createUserTx) برسالة عربية واضحة. */
const accountInput = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }),
  z.object({ mode: z.literal("new"), ...newAccountShape }),
  z.object({ mode: z.literal("link"), userId: z.number().int().positive() }),
]);

/** يبني actor الموحّد من سياق الطلب. */
function toActor(ctx: { user: { id: number; branchId: number | null; role: string } }) {
  return { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role };
}

const moneyStrOpt = z.string().trim().regex(/^\d+(\.\d{1,2})?$/, "قيمة مالية غير صالحة").optional();
const educationItem = z.object({
  degree: z.string().trim().min(1),
  major: z.string().trim().optional(),
  school: z.string().trim().optional(),
  year: z.number().int().optional(),
  gpa: z.string().trim().optional(),
});

const employeeInput = z.object({
  firstName: z.string().trim().min(1, "الاسم الأول مطلوب"),
  fatherName: z.string().trim().optional(),
  grandfatherName: z.string().trim().optional(),
  lastName: z.string().trim().min(1, "اللقب مطلوب"),
  position: z.string().trim().optional(),
  department: z.string().trim().optional(),
  branchId: z.number().int().positive().nullish(),
  managerId: z.number().int().positive().nullish(),
  payType: z.enum(PAY_TYPE_KEYS).default("monthly"),
  salary: moneyStrOpt,
  allowances: moneyStrOpt,
  dayRates: z.record(z.string(), z.number()).nullish(),
  hireDate: z.string().optional(),
  gender: z.string().trim().optional(),
  birthDate: z.string().optional(),
  maritalStatus: z.string().trim().optional(),
  nationality: z.string().trim().optional(),
  phone: z.string().trim().optional(),
  email: z.string().trim().optional(),
  governorate: z.string().trim().optional(),
  district: z.string().trim().optional(),
  addressLandmark: z.string().trim().optional(),
  nationalId: z.string().trim().optional(),
  emergencyContactName: z.string().trim().optional(),
  emergencyContactPhone: z.string().trim().optional(),
  colorTag: z.string().trim().optional(),
  photoUrl: z.string().optional(),
  education: z.array(educationItem).nullish(),
  annualLeaveBalance: z.number().int().min(0).nullish(),
  sickLeaveBalance: z.number().int().min(0).nullish(),
});

export const employeeRouter = router({
  list: hrRead
    .input(
      z
        .object({
          q: z.string().optional(),
          department: z.string().optional(),
          branchId: z.number().int().positive().optional(),
          status: z.enum(EMPLOYMENT_STATUS_KEYS).optional(),
          includeInactive: z.boolean().optional(),
          limit: z.number().int().positive().max(200).optional(),
          offset: z.number().int().min(0).optional(),
        })
        .optional(),
    )
    .query(({ input }) => svc.listEmployees(input)),

  get: hrRead.input(z.object({ id: z.number().int().positive() })).query(({ input }) => svc.getEmployee(input.id)),

  formOptions: hrRead.query(() => svc.formOptions()),

  create: hrWrite.input(employeeInput).mutation(async ({ input, ctx }) => {
    try {
      const e = await svc.createEmployee(input as svc.EmployeeInput);
      await logAudit(ctx, { action: "employee.create", entityType: "employee", entityId: e?.id, newValue: { name: e?.fullName, department: input.department ?? null } });
      return e;
    } catch (err: any) {
      if (err?.code === "ER_DUP_ENTRY") throw new TRPCError({ code: "CONFLICT", message: "البريد الإلكتروني مستخدم لموظف آخر" });
      throw err;
    }
  }),

  /**
   * إنشاء موظف مع (اختياراً) حساب نظام مرتبط — ذرّياً. أوضاع: none/new/link.
   * الإنشاء/الربط (mode ≠ none) **محصور بـ admin** (منع تصعيد الامتياز)؛ القاعدة hr/FULL تكفي لـ none.
   */
  createWithAccount: hrWrite
    .input(employeeInput.extend({ account: accountInput.default({ mode: "none" }) }))
    .mutation(async ({ input, ctx }) => {
      const { account, ...emp } = input;
      if (account.mode !== "none" && ctx.user.role !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
      }
      try {
        let spec: svc.AccountSpec;
        if (account.mode === "new") {
          const { mode, ...u } = account;
          spec = { mode: "new", user: u as CreateUserInput };
        } else {
          spec = account;
        }
        const { employeeId, userId } = await svc.createEmployeeWithAccount(emp as svc.EmployeeInput, spec, toActor(ctx));
        const e = await svc.getEmployee(employeeId);
        if (account.mode === "new") {
          await logAudit(ctx, { action: "user.create", entityType: "user", entityId: userId, newValue: { email: account.email ?? null, username: account.username ?? null, role: account.role } });
        }
        await logAudit(ctx, { action: "employee.create", entityType: "employee", entityId: employeeId, newValue: { name: e?.fullName, accountMode: account.mode, linkedUserId: userId } });
        if (account.mode === "link") {
          await logAudit(ctx, { action: "employee.linkAccount", entityType: "employee", entityId: employeeId, newValue: { userId } });
        }
        const credentials = account.mode === "new"
          ? { userId, email: account.email ?? null, username: account.username ?? null, password: account.password, role: account.role, customRoleId: account.customRoleId ?? null, mustChangePassword: account.mustChangePassword }
          : null;
        return { employee: e, credentials };
      } catch (err: any) {
        if (err?.code === "ER_DUP_ENTRY") throw new TRPCError({ code: "CONFLICT", message: "البريد الإلكتروني مستخدم لموظف آخر" });
        throw err;
      }
    }),

  /** ربط حساب قائم بموظف قائم (وضع التعديل) — admin فقط. */
  linkAccount: adminProcedure
    .input(z.object({ employeeId: z.number().int().positive(), userId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const e = await svc.linkEmployeeAccount(input.employeeId, input.userId);
      await logAudit(ctx, { action: "employee.linkAccount", entityType: "employee", entityId: input.employeeId, newValue: { userId: input.userId } });
      return e;
    }),

  /** فكّ ربط الحساب عن الموظف (يفصل فقط، لا يحذف المستخدم) — admin فقط. */
  unlinkAccount: adminProcedure
    .input(z.object({ employeeId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const e = await svc.unlinkEmployeeAccount(input.employeeId);
      await logAudit(ctx, { action: "employee.unlinkAccount", entityType: "employee", entityId: input.employeeId });
      return e;
    }),

  /** إنشاء حساب نظام جديد لموظف قائم وربطه — ذرّياً (وضع التعديل) — admin فقط. */
  createAccountFor: adminProcedure
    .input(z.object({ employeeId: z.number().int().positive(), ...newAccountShape }))
    .mutation(async ({ input, ctx }) => {
      const { employeeId, ...u } = input;
      try {
        const { employee, userId } = await svc.createAccountForEmployee(employeeId, u as CreateUserInput, toActor(ctx));
        await logAudit(ctx, { action: "user.create", entityType: "user", entityId: userId, newValue: { email: input.email ?? null, username: input.username ?? null, role: input.role } });
        await logAudit(ctx, { action: "employee.linkAccount", entityType: "employee", entityId: employeeId, newValue: { userId } });
        const credentials = { userId, email: input.email ?? null, username: input.username ?? null, password: input.password, role: input.role, customRoleId: input.customRoleId ?? null, mustChangePassword: input.mustChangePassword };
        return { employee, credentials };
      } catch (err: any) {
        if (err?.code === "ER_DUP_ENTRY") throw new TRPCError({ code: "CONFLICT", message: "البريد الإلكتروني مستخدم لموظف آخر" });
        throw err;
      }
    }),

  /** الحسابات القابلة للربط (نشطة وغير مرتبطة) — admin فقط. */
  linkableUsers: adminProcedure
    .input(z.object({ q: z.string().optional(), limit: z.number().int().positive().max(50).optional(), employeeId: z.number().int().positive().optional() }))
    .query(({ input }) => svc.listLinkableUsers(input)),

  update: hrWrite
    .input(employeeInput.extend({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const { id, ...rest } = input;
      try {
        const e = await svc.updateEmployee(id, rest as svc.EmployeeInput);
        await logAudit(ctx, { action: "employee.update", entityType: "employee", entityId: id, newValue: { name: e?.fullName } });
        return e;
      } catch (err: any) {
        if (err?.code === "ER_DUP_ENTRY") throw new TRPCError({ code: "CONFLICT", message: "البريد الإلكتروني مستخدم لموظف آخر" });
        throw err;
      }
    }),

  setStatus: hrWrite
    .input(
      z.object({
        id: z.number().int().positive(),
        status: z.enum(EMPLOYMENT_STATUS_KEYS),
        terminationDate: z.string().optional(),
        terminationReason: z.string().trim().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const e = await svc.setEmploymentStatus(input.id, input.status, { terminationDate: input.terminationDate, terminationReason: input.terminationReason });
      await logAudit(ctx, { action: "employee.setStatus", entityType: "employee", entityId: input.id, newValue: { status: input.status } });
      return e;
    }),

  /** ملخّص ارتباطات الموظف (نشاط + سبب منع الحذف + بيانات الكود عند المسح). */
  usage: hrRead.input(z.object({ id: z.number().int().positive() })).query(({ input }) => getEmployeeUsage(input.id)),

  /** حذف نهائي — للنظيف فقط (يُمنع مع رسالة عربية إن وُجد ارتباط). */
  delete: hrWrite
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await svc.deleteEmployee(input.id);
      await logAudit(ctx, { action: "employee.delete", entityType: "employee", entityId: input.id });
      return res;
    }),
});
