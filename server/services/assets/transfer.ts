// مناقلة أصل ثابت بين فروع الشركة وتحديث الموقع والعهدة.
import { TRPCError } from "@trpc/server";
import { and, eq, isNull } from "drizzle-orm";
import { appErrorMessage } from "@shared/errors";
import {
  assetCustodyLog,
  branches,
  employees,
  fixedAssets,
} from "../../../drizzle/schema";
import { companyBranchScope } from "../companyBranchScope";
import { toDateStr } from "../money";
import type { Actor } from "../tx";
import { withTx } from "../tx";
import { loadForUpdate } from "./helpers";
import { getAsset } from "./queries";

export interface TransferAssetInput {
  assetId: number;
  targetBranchId: number;
  targetCustodianId?: number | null;
  location?: string | null;
  reason: string;
  transferDate?: string;
}

/**
 * مناقلة أصل ثابت من فرع إلى آخر مع تحديث العهدة وسجل تتبع الأصول.
 */
export async function transferAssetBranch(
  input: TransferAssetInput,
  actor: Actor,
) {
  const scope = companyBranchScope(actor);
  const today = input.transferDate ?? toDateStr();

  await withTx(async (tx) => {
    const a = await loadForUpdate(tx, input.assetId, scope);
    if (a.status === "disposed") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذرت مناقلة الأصل",
          why: "الأصل مُستبعَد أو خارج الخدمة نهائياً",
          doThis: "اختر أصلاً نشطاً لنقله بين الفروع",
        }),
      });
    }

    if (a.branchId != null && Number(a.branchId) === input.targetBranchId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذرت مناقلة الأصل",
          why: "الأصل مسجل بالفعل في هذا الفرع",
          doThis: "حدد فرعاً مستهدفاً مختلفاً عن الفرع الحالي للأصل",
        }),
      });
    }

    // التحقق من وجود الفرع الهدف
    const [targetBranch] = await tx
      .select({ id: branches.id, name: branches.name })
      .from(branches)
      .where(eq(branches.id, input.targetBranchId))
      .for("update")
      .limit(1);

    if (!targetBranch) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذر العثور على الفرع المستهدف",
          why: "الفرع المحدد غير موجود أو غير مفعل في النظام",
          doThis: "تحقق من قائمة الفروع النشطة واختر فرعاً صحيحاً",
        }),
      });
    }

    // التحقق من الموظف المستلم في الفرع الهدف إن وُجد
    let newCustodianId: number | null = null;
    if (input.targetCustodianId != null) {
      const [emp] = await tx
        .select({
          id: employees.id,
          status: employees.employmentStatus,
          branchId: employees.branchId,
        })
        .from(employees)
        .where(eq(employees.id, input.targetCustodianId))
        .for("update")
        .limit(1);

      if (!emp) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: appErrorMessage({
            what: "تعذر العثور على الموظف المستلم",
            why: "معرف الموظف المحدد للعهدة غير موجود في سجل الموظفين",
            doThis: "اختر موظفاً معتمداً من الفرع الهدف أو اترك العهدة فارغة",
          }),
        });
      }
      if (emp.status !== "active") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذر تسليم العهدة للموظف",
            why: "الموظف المحدد ليس على رأس العمل حالياً",
            doThis: "اختر موظفاً نشطاً على رأس عمله في الفرع الهدف",
          }),
        });
      }
      if (
        emp.branchId != null &&
        Number(emp.branchId) !== input.targetBranchId
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذر تسليم العهدة",
            why: "الموظف المستلم يتبع فرعاً إدارياً مختلفاً عن الفرع الهدف",
            doThis: "اختر موظفاً يتبع الفرع المستهدف للمناقلة",
          }),
        });
      }
      newCustodianId = Number(emp.id);
    }

    // إغلاق العهدة الحالية إن كان للأصل عهدة جارية
    await tx
      .update(assetCustodyLog)
      .set({
        toDate: today,
        note: `إغلاق العهدة بسبب مناقلة الأصل إلى فرع ${targetBranch.name}: ${input.reason}`,
      })
      .where(
        and(
          eq(assetCustodyLog.assetId, input.assetId),
          isNull(assetCustodyLog.toDate),
        ),
      );

    // إذا تم تحديد موظف مستلم جديد في الفرع الهدف: فتح سجل عهدة جديد
    if (newCustodianId != null) {
      await tx.insert(assetCustodyLog).values({
        assetId: input.assetId,
        employeeId: newCustodianId,
        fromDate: today,
        toDate: null,
        note: `استلام عهدة بموجب مناقلة إلى فرع ${targetBranch.name}: ${input.reason}`,
      });
    }

    // تحديث الفرع والموقع والعهدة على الأصل
    await tx
      .update(fixedAssets)
      .set({
        branchId: input.targetBranchId,
        location: input.location ?? a.location,
        custodianId: newCustodianId,
      })
      .where(eq(fixedAssets.id, input.assetId));
  });

  return getAsset(input.assetId, { branchId: null });
}
