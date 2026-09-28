import { z } from "zod";
import { nonNegMoneyString, positiveMoneyString } from "../lib/schemas";
import { protectedProcedure, requireModule, router } from "../trpc";
import type { MaybeScopedActor } from "../services/tx";
import * as docSvc from "../services/employeeDocumentService";
import * as penaltySvc from "../services/employeePenaltyService";
import * as contractSvc from "../services/employeeContractService";
import * as bonusSvc from "../services/employeeSpotBonusService";
import * as custodySvc from "../services/employeeCustodyService";
import * as transferSvc from "../services/employeeTransferService";
import * as loanSvc from "../services/employeeLoanService";
import { calculateLeaveEncashment } from "../services/leaveService";
import { getDb } from "../db";
import { employees } from "../../drizzle/schema";
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";

const hrRead = protectedProcedure.use(requireModule("hr", "READ"));
const hrWrite = protectedProcedure.use(requireModule("hr", "FULL"));

function toActor(ctx: { user: { id: number; branchId: number | null; role: string; isOwner?: boolean } }): MaybeScopedActor {
  return { userId: ctx.user.id, branchId: ctx.user.branchId, role: ctx.user.role, isOwner: ctx.user.isOwner };
}

export const hrEnterpriseRouter = router({
  // —— المستندات الرسمية وإقامات العمالة ——
  documents: router({
    list: hrRead
      .input(z.object({ employeeId: z.number().int().positive() }))
      .query(({ input }) => docSvc.listEmployeeDocuments(input.employeeId)),

    get: hrRead
      .input(z.object({ id: z.number().int().positive() }))
      .query(({ input }) => docSvc.getDocumentById(input.id)),

    add: hrWrite
      .input(
        z.object({
          employeeId: z.number().int().positive(),
          documentType: z.enum([
            "PASSPORT",
            "RESIDENCY_VISA",
            "WORK_PERMIT",
            "NATIONAL_ID",
            "HEALTH_CERTIFICATE",
            "EDUCATION_CERTIFICATE",
            "CONTRACT_SCAN",
            "OTHER",
          ]),
          title: z.string().trim().min(1).max(200),
          documentNumber: z.string().trim().max(100).nullish(),
          issueDate: z.string().nullish(),
          expiryDate: z.string().nullish(),
          fileUrl: z.string().nullish(),
          fileSize: z.number().int().nullish(),
          mimeType: z.string().max(100).nullish(),
          notes: z.string().nullish(),
          alertDaysBefore: z.number().int().min(1).max(365).optional(),
        }),
      )
      .mutation(({ input, ctx }) => docSvc.addEmployeeDocument(toActor(ctx), input)),

    update: hrWrite
      .input(
        z.object({
          id: z.number().int().positive(),
          documentType: z.enum([
            "PASSPORT",
            "RESIDENCY_VISA",
            "WORK_PERMIT",
            "NATIONAL_ID",
            "HEALTH_CERTIFICATE",
            "EDUCATION_CERTIFICATE",
            "CONTRACT_SCAN",
            "OTHER",
          ]).optional(),
          title: z.string().trim().min(1).max(200).optional(),
          documentNumber: z.string().trim().max(100).nullish(),
          issueDate: z.string().nullish(),
          expiryDate: z.string().nullish(),
          fileUrl: z.string().nullish(),
          fileSize: z.number().int().nullish(),
          mimeType: z.string().max(100).nullish(),
          notes: z.string().nullish(),
          alertDaysBefore: z.number().int().min(1).max(365).optional(),
        }),
      )
      .mutation(({ input, ctx }) => docSvc.updateEmployeeDocument(toActor(ctx), input)),

    delete: hrWrite
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(({ input, ctx }) => docSvc.deleteEmployeeDocument(toActor(ctx), input.id)),

    expiryAlerts: hrRead
      .input(z.object({ withinDays: z.number().int().min(1).max(365).optional() }).optional())
      .query(({ input }) => docSvc.getExpiringDocumentsAlerts(input?.withinDays ?? 30)),
  }),

  // —— العقوبات والانضباطيات وقانون العمل ——
  penalties: router({
    list: hrRead
      .input(z.object({ employeeId: z.number().int().positive() }))
      .query(({ input }) => penaltySvc.listEmployeePenalties(input.employeeId)),

    create: hrWrite
      .input(
        z.object({
          employeeId: z.number().int().positive(),
          penaltyType: z.enum(["ATTENTION", "WARNING", "SALARY_DEDUCTION", "SUSPENSION", "DISMISSAL"]),
          decisionNumber: z.string().trim().min(1).max(100),
          decisionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          reason: z.string().trim().min(1),
          deductionDays: z.number().min(0).max(3).optional(),
          deductionAmount: nonNegMoneyString.optional(),
        }),
      )
      .mutation(({ input, ctx }) => penaltySvc.createEmployeePenalty(toActor(ctx), input)),

    approve: hrWrite
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(({ input, ctx }) => penaltySvc.approveEmployeePenalty(toActor(ctx), input.id)),

    cancel: hrWrite
      .input(z.object({ id: z.number().int().positive(), reason: z.string().trim().min(1) }))
      .mutation(({ input, ctx }) => penaltySvc.cancelEmployeePenalty(toActor(ctx), input.id, input.reason)),
  }),

  // —— عقود العمل ومتابعة فترة التجربة ——
  contracts: router({
    list: hrRead
      .input(z.object({ employeeId: z.number().int().positive() }))
      .query(({ input }) => contractSvc.listEmployeeContracts(input.employeeId)),

    create: hrWrite
      .input(
        z.object({
          employeeId: z.number().int().positive(),
          contractType: z.enum(["FIXED_TERM", "INDEFINITE", "PROBATION", "SEASONAL"]),
          contractNumber: z.string().trim().max(100).nullish(),
          startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
          probationEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
          jobTitle: z.string().trim().max(150).nullish(),
          basicSalary: nonNegMoneyString.nullish(),
          allowances: nonNegMoneyString.nullish(),
          terms: z.string().nullish(),
          fileUrl: z.string().nullish(),
        }),
      )
      .mutation(({ input, ctx }) => contractSvc.createEmployeeContract(toActor(ctx), input)),

    approve: hrWrite
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(({ input, ctx }) => contractSvc.approveEmployeeContract(toActor(ctx), input.id)),

    probationAlerts: hrRead
      .input(z.object({ withinDays: z.number().int().min(1).max(90).optional() }).optional())
      .query(({ input }) => contractSvc.getProbationAlerts(input?.withinDays ?? 15)),
  }),

  // —— المكافآت الفورية الاستثنائية ——
  spotBonuses: router({
    list: hrRead
      .input(z.object({ employeeId: z.number().int().positive() }))
      .query(({ input }) => bonusSvc.listEmployeeSpotBonuses(input.employeeId)),

    create: hrWrite
      .input(
        z.object({
          employeeId: z.number().int().positive(),
          amount: positiveMoneyString,
          reason: z.string().trim().min(1).max(255),
          decisionNumber: z.string().trim().max(100).nullish(),
          disbursementType: z.enum(["CASH_TREASURY", "PAYROLL_ADDITION"]).optional(),
        }),
      )
      .mutation(({ input, ctx }) => bonusSvc.createSpotBonus(toActor(ctx), input)),

    approve: hrWrite
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(({ input, ctx }) => bonusSvc.approveSpotBonus(toActor(ctx), input.id)),
  }),

  // —— التنقلات الإدارية بين الفروع والأقسام ——
  transfers: router({
    list: hrRead
      .input(z.object({ employeeId: z.number().int().positive() }))
      .query(({ input }) => transferSvc.listEmployeeTransfers(input.employeeId)),

    request: hrWrite
      .input(
        z.object({
          employeeId: z.number().int().positive(),
          toBranchId: z.number().int().positive().nullish(),
          toDepartment: z.string().trim().max(100).nullish(),
          toPosition: z.string().trim().max(100).nullish(),
          decisionNumber: z.string().trim().min(1).max(100),
          transferDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          reason: z.string().trim().max(255).nullish(),
          notes: z.string().nullish(),
        }),
      )
      .mutation(({ input, ctx }) => transferSvc.requestEmployeeTransfer(toActor(ctx), input)),

    approve: hrWrite
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(({ input, ctx }) => transferSvc.approveEmployeeTransfer(toActor(ctx), input.id)),
  }),

  // —— طلبات السلف والقروض ——
  loans: router({
    list: hrRead
      .input(z.object({ employeeId: z.number().int().positive() }))
      .query(({ input }) => loanSvc.listEmployeeLoans(input.employeeId)),

    request: hrWrite
      .input(
        z.object({
          employeeId: z.number().int().positive(),
          amount: positiveMoneyString,
          installmentsCount: z.number().int().min(1).max(60).optional(),
          monthlyDeduction: positiveMoneyString.optional(),
          reason: z.string().trim().max(255).nullish(),
        }),
      )
      .mutation(({ input, ctx }) => loanSvc.requestEmployeeLoan(toActor(ctx), input)),

    review: hrWrite
      .input(
        z.object({
          id: z.number().int().positive(),
          action: z.enum(["APPROVE", "REJECT"]),
          rejectionReason: z.string().trim().max(255).optional(),
        }),
      )
      .mutation(({ input, ctx }) => loanSvc.reviewEmployeeLoanRequest(toActor(ctx), input)),

    disburse: hrWrite
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(({ input, ctx }) => loanSvc.disburseEmployeeLoan(toActor(ctx), input.id)),
  }),

  // —— سجل العهد العينية ومعدات العمل ——
  custody: router({
    list: hrRead
      .input(z.object({ employeeId: z.number().int().positive() }))
      .query(({ input }) => custodySvc.listEmployeeCustody(input.employeeId)),

    assign: hrWrite
      .input(
        z.object({
          employeeId: z.number().int().positive(),
          itemType: z.enum(["TOOL", "DEVICE", "VEHICLE", "KEY", "DOCUMENT", "UNIFORM", "OTHER"]),
          itemName: z.string().trim().min(1).max(200),
          itemCode: z.string().trim().max(100).nullish(),
          serialNumber: z.string().trim().max(100).nullish(),
          quantity: z.number().int().min(1).max(1000).optional(),
          conditionAtHandover: z.string().trim().max(100).nullish(),
          handoverDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          expectedReturnDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
          notes: z.string().nullish(),
        }),
      )
      .mutation(({ input, ctx }) => custodySvc.assignEmployeeCustody(toActor(ctx), input)),

    return: hrWrite
      .input(
        z.object({
          id: z.number().int().positive(),
          actualReturnDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          conditionAtReturn: z.string().trim().max(100).nullish(),
          returnNotes: z.string().nullish(),
          status: z.enum(["RETURNED", "DAMAGED", "LOST"]).optional(),
        }),
      )
      .mutation(({ input, ctx }) => custodySvc.returnEmployeeCustody(toActor(ctx), input)),
  }),

  // —— احتساب بدل الإجازات السنوية القانوني (المادة 77) ——
  leaveEncashment: router({
    preview: hrRead
      .input(z.object({ employeeId: z.number().int().positive() }))
      .query(async ({ input }) => {
        const db = getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });
        const [emp] = await db
          .select({
            salary: employees.salary,
            allowances: employees.allowances,
            annualLeaveBalance: employees.annualLeaveBalance,
          })
          .from(employees)
          .where(eq(employees.id, input.employeeId))
          .limit(1);

        if (!emp) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: appErrorMessage({
              what: "تعذّر احتساب تعويض الإجازات",
              why: "الموظف المطلوب غير مسجّل في قاعدة البيانات",
              doThis: "تحقّق من معرّف الموظف أو أعد فتح بطاقة الموظف من القائمة",
            }),
          });
        }

        const calc = calculateLeaveEncashment(emp);
        return {
          dailyWage: calc.dailyWage.toFixed(2),
          unusedDays: calc.unusedDays,
          encashmentAmount: calc.encashmentAmount.toFixed(2),
        };
      }),
  }),
});
