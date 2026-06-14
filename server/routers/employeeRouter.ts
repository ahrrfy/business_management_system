/* ============================================================================
 * موجّه tRPC للموظفين — وحدة الموارد البشرية (server/routers/employeeRouter.ts)
 * القراءة بصلاحية hr/READ والكتابة بـ hr/FULL (requireModule). كل كتابة تُدقَّق.
 * ========================================================================== */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { EMPLOYMENT_STATUS_KEYS, PAY_TYPE_KEYS } from "@shared/hr";
import { logAudit } from "../services/auditService";
import * as svc from "../services/employeeService";
import { protectedProcedure, requireModule, router } from "../trpc";

const hrRead = protectedProcedure.use(requireModule("hr", "READ"));
const hrWrite = protectedProcedure.use(requireModule("hr", "FULL"));

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
});
