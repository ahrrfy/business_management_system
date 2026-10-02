// استيراد جماعي للأصول الثابتة السابقة للنظام مع التدقيق المسبق الذري والقيد الافتتاحي المجمع (IAS 16).
import Decimal from "decimal.js";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { branches, employees, fixedAssets } from "../../../drizzle/schema";
import {
  ASSET_CATEGORY_KEYS,
  DEPRECIATION_METHOD_KEYS,
} from "../../../shared/assets";
import { extractInsertId } from "../../lib/insertId";
import {
  createPostingIntent,
  creditLine,
  debitLine,
} from "../accounting/postingEngine";
import type { CompanyBranchScope } from "../companyBranchScope";
import { postEntry } from "../ledgerService";
import { money, toDbMoney } from "../money";
import type { Actor } from "../tx";
import { requireDb, withTx } from "../tx";
import { nextAssetCode } from "./create";

export const assetImportRowSchema = z.object({
  rowNumber: z.number().int().positive(),
  name: z.string().trim().min(1, "اسم الأصل مطلوب").max(255),
  category: z.enum(ASSET_CATEGORY_KEYS),
  branchId: z.number().int().positive().optional().nullable(),
  location: z.string().trim().max(255).optional().nullable(),
  custodianId: z.number().int().positive().optional().nullable(),
  purchaseDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ الشراء يجب أن يكون بصيغة YYYY-MM-DD"),
  purchaseValue: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,2})?$/, "قيمة الشراء غير صالحة"),
  salvageValue: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,2})?$/)
    .optional()
    .nullable(),
  usefulLifeYears: z.number().int().min(0).max(100),
  depreciationMethod: z.enum(DEPRECIATION_METHOD_KEYS).default("sl"),
  accumulatedDepreciation: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,2})?$/)
    .optional()
    .nullable(),
  brand: z.string().trim().max(120).optional().nullable(),
  serial: z.string().trim().max(120).optional().nullable(),
  condition: z.string().trim().max(60).optional().nullable(),
  warrantyEnd: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .nullable(),
});

export type AssetImportRow = z.infer<typeof assetImportRowSchema>;

export interface AssetImportOptions {
  dryRun?: boolean;
  skipFailed?: boolean;
}

export interface AssetImportRowResult {
  rowNumber: number;
  status: "created" | "updated" | "skipped" | "failed";
  message?: string;
  assetCode?: string;
}

export interface AssetImportSummary {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  committed: boolean;
  totalCost: string;
  totalOpeningDepreciation: string;
  totalNetBookValue: string;
  rows: AssetImportRowResult[];
}

/**
 * استيراد جماعي للأصول الثابتة السابقة للنظام.
 * يتحقق أولاً من الفروع والموظفين والقيم المالية (dryRun يدعم الفحص المسبق بلا حفظ).
 * عند الاعتماد: ينشئ الأصول ويقيد قيداً افتتاحياً واحداً مجمعاً في الأستاذ العام
 * (مدين للأصول، ودائن لمجمع الإهلاك، ودائن لحقوق الملكية بالصافي).
 * صفر سندات صرف، صفر مساس بالخزينة.
 */
export async function importAssets(
  rows: AssetImportRow[],
  options: AssetImportOptions,
  actor: Actor,
  scope: CompanyBranchScope,
): Promise<AssetImportSummary> {
  const db = requireDb();

  // فحص الفروع والموظفين المرجعيين
  const branchIds = Array.from(
    new Set(
      rows
        .map((r) => r.branchId ?? actor.branchId ?? null)
        .filter((b): b is number => b != null),
    ),
  );
  const custodianIds = Array.from(
    new Set(rows.map((r) => r.custodianId).filter((c): c is number => c != null)),
  );

  const [existingBranches, existingEmployees] = await Promise.all([
    branchIds.length > 0
      ? db
          .select({ id: branches.id })
          .from(branches)
          .where(inArray(branches.id, branchIds))
      : [],
    custodianIds.length > 0
      ? db
          .select({
            id: employees.id,
            status: employees.employmentStatus,
            branchId: employees.branchId,
          })
          .from(employees)
          .where(inArray(employees.id, custodianIds))
      : [],
  ]);

  const validBranchSet = new Set(existingBranches.map((b) => Number(b.id)));
  const employeeMap = new Map(existingEmployees.map((e) => [Number(e.id), e]));

  const rowResults: AssetImportRowResult[] = [];
  const validRows: Array<{
    input: AssetImportRow;
    targetBranchId: number | null;
    initialDepreciation: Decimal;
    cost: Decimal;
    salvage: Decimal;
    netBookValue: Decimal;
  }> = [];

  let batchCost = new Decimal(0);
  let batchOpeningDep = new Decimal(0);
  let batchNbv = new Decimal(0);

  for (const r of rows) {
    const targetBranchId =
      scope.branchId != null
        ? scope.branchId
        : (r.branchId ?? actor.branchId ?? null);

    if (targetBranchId != null && !validBranchSet.has(targetBranchId)) {
      rowResults.push({
        rowNumber: r.rowNumber,
        status: "failed",
        message: `الفرع رقم ${targetBranchId} غير موجود في النظام`,
      });
      continue;
    }

    if (r.custodianId != null) {
      const emp = employeeMap.get(r.custodianId);
      if (!emp) {
        rowResults.push({
          rowNumber: r.rowNumber,
          status: "failed",
          message: `الموظف رقم ${r.custodianId} غير موجود`,
        });
        continue;
      }
      if (emp.status !== "active") {
        rowResults.push({
          rowNumber: r.rowNumber,
          status: "failed",
          message: `الموظف صاحب العهدة ليس على رأس العمل (حالته: ${emp.status})`,
        });
        continue;
      }
      if (
        targetBranchId != null &&
        emp.branchId != null &&
        Number(emp.branchId) !== targetBranchId
      ) {
        rowResults.push({
          rowNumber: r.rowNumber,
          status: "failed",
          message: "فرع الموظف لا يطابق فرع الأصل",
        });
        continue;
      }
    }

    const cost = money(r.purchaseValue);
    const initialDep = money(r.accumulatedDepreciation ?? "0");
    const salvage = money(r.salvageValue ?? "0");

    if (cost.lte(0)) {
      rowResults.push({
        rowNumber: r.rowNumber,
        status: "failed",
        message: "قيمة الشراء يجب أن تكون أكبر من صفر",
      });
      continue;
    }

    if (initialDep.gt(cost)) {
      rowResults.push({
        rowNumber: r.rowNumber,
        status: "failed",
        message: `مجمع الإهلاك السابق (${initialDep.toFixed(2)}) يتجاوز قيمة الشراء (${cost.toFixed(2)})`,
      });
      continue;
    }

    if (r.category === "land" && r.usefulLifeYears > 0) {
      rowResults.push({
        rowNumber: r.rowNumber,
        status: "failed",
        message: "الأراضي لا تخضع للإهلاك ويجب أن يكون عمرها الإنتاجي 0",
      });
      continue;
    }

    const nbv = cost.sub(initialDep);
    batchCost = batchCost.plus(cost);
    batchOpeningDep = batchOpeningDep.plus(initialDep);
    batchNbv = batchNbv.plus(nbv);

    validRows.push({
      input: r,
      targetBranchId,
      initialDepreciation: initialDep,
      cost,
      salvage,
      netBookValue: nbv,
    });
  }

  const failedCount = rows.length - validRows.length;

  // في حالة dryRun أو وجود أخطاء مع عدم تفعيل skipFailed: نرجع التقرير دون كتابة
  if (options.dryRun || (failedCount > 0 && !options.skipFailed)) {
    return {
      total: rows.length,
      created: 0,
      updated: 0,
      skipped: 0,
      failed: failedCount,
      committed: false,
      totalCost: toDbMoney(batchCost),
      totalOpeningDepreciation: toDbMoney(batchOpeningDep),
      totalNetBookValue: toDbMoney(batchNbv),
      rows: [
        ...validRows.map((v) => ({
          rowNumber: v.input.rowNumber,
          status: "created" as const,
          message: "سليم وجاهز للاستيراد",
        })),
        ...rowResults.filter((r) => r.status === "failed"),
      ].sort((a, b) => a.rowNumber - b.rowNumber),
    };
  }

  // التنفيذ الذري داخل معاملة واحدة
  const batchId = `IMPORT-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

  await withTx(async (tx) => {
    for (const v of validRows) {
      const code = await nextAssetCode(tx);
      const [res] = await tx.insert(fixedAssets).values({
        code,
        name: v.input.name,
        category: v.input.category as never,
        brand: v.input.brand ?? null,
        serial: v.input.serial ?? null,
        branchId: v.targetBranchId,
        location: v.input.location ?? null,
        custodianId: v.input.custodianId ?? null,
        purchaseDate: v.input.purchaseDate,
        purchaseValue: toDbMoney(v.cost),
        salvageValue: toDbMoney(v.input.category === "land" ? "0" : v.salvage),
        usefulLifeYears:
          v.input.category === "land" ? 0 : v.input.usefulLifeYears,
        depreciationMethod: v.input.depreciationMethod ?? "sl",
        accumulatedDepreciation: toDbMoney(v.initialDepreciation),
        openingDepreciation: toDbMoney(v.initialDepreciation),
        condition: v.input.condition ?? null,
        warrantyEnd: v.input.warrantyEnd ?? null,
        clientRequestId: `asset-import-${batchId}-${v.input.rowNumber}`,
        recognitionStatus: "ACTIVE",
        isActive: true,
      });

      const newId = extractInsertId(res);
      rowResults.push({
        rowNumber: v.input.rowNumber,
        status: "created",
        assetCode: code,
        message: `تم إنشاء الأصل بنجاح (${code})`,
      });
    }

    // إثبات القيد الافتتاحي المجمع لدفعة الأصول في الأستاذ العام
    if (batchCost.gt(0)) {
      const lines = [debitLine("FIXED_ASSETS", batchCost)];
      const roleCredits: Record<string, Decimal> = {
        OPENING_EQUITY: batchNbv,
      };
      if (batchOpeningDep.gt(0)) {
        lines.push(creditLine("ACCUMULATED_DEPRECIATION", batchOpeningDep));
        roleCredits.ACCUMULATED_DEPRECIATION = batchOpeningDep;
      }
      lines.push(creditLine("OPENING_EQUITY", batchNbv));

      const sourceComponents = {
        roleDebits: { FIXED_ASSETS: batchCost },
        roleCredits,
        requireRoleComponents: [
          "FIXED_ASSETS",
          "OPENING_EQUITY",
          "ACCUMULATED_DEPRECIATION",
        ] as const,
      };

      const entryBranchId =
        scope.branchId != null
          ? scope.branchId
          : (actor.branchId ?? validRows[0]?.targetBranchId ?? null);

      await postEntry(tx, {
        entryType: "OPENING",
        branchId: entryBranchId ? Number(entryBranchId) : null,
        amount: batchCost,
        entryDate: new Date(),
        postingIntent: createPostingIntent(
          "OPENING_FIXED_ASSET",
          "OPENING",
          lines,
          sourceComponents,
        ),
        postingSourceComponents: sourceComponents,
        dedupeKey: `ASSET:BATCH_OPENING:${batchId}`,
        notes: `قيد استيراد دفعة أصول ثابتة سابقة للنظام (${validRows.length} أصل)`,
        createdBy: actor.userId,
      });
    }
  });

  return {
    total: rows.length,
    created: validRows.length,
    updated: 0,
    skipped: 0,
    failed: failedCount,
    committed: true,
    totalCost: toDbMoney(batchCost),
    totalOpeningDepreciation: toDbMoney(batchOpeningDep),
    totalNetBookValue: toDbMoney(batchNbv),
    rows: rowResults.sort((a, b) => a.rowNumber - b.rowNumber),
  };
}
