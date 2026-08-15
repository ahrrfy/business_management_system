// إنشاء أصل: ترقيم AST-#### + قيد اقتناء (AP لمورّد أو نقد خزينة) + عهدة ابتدائية اختيارية.
import { desc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { assetCustodyLog, branches, employees, fixedAssets, kioskDevices, receipts } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { adjustSupplierBalance, postEntry } from "../ledgerService";
import { assertCashOutAvailable } from "../cash/cashAvailability";
import { money, toDateStr, toDbMoney } from "../money";
import { type Actor, withTx } from "../tx";
import { companyBranchScope, resolveTargetBranch } from "../companyBranchScope";
import { getAsset } from "./queries";

/** الرمز التالي AST-#### — قراءة مرتّبة تحت قفل FOR UPDATE تُضيّق السباق، وقيد UNIQUE هو الحارس النهائي. */
async function nextAssetCode(tx: Tx): Promise<string> {
  const rows = await tx
    .select({ code: fixedAssets.code })
    .from(fixedAssets)
    .orderBy(desc(fixedAssets.id))
    .for("update")
    .limit(1);
  const last = rows[0] ? parseInt(rows[0].code.replace(/\D/g, ""), 10) || 1000 : 1000;
  return "AST-" + (Math.max(1000, last) + 1);
}

export interface CreateAssetInput {
  name: string;
  category: string;
  brand?: string | null;
  serial?: string | null;
  branchId?: number | null;
  location?: string | null;
  custodianId?: number | null;
  supplierId?: number | null;
  purchaseDate: string;
  purchaseValue: string;
  salvageValue?: string;
  usefulLifeYears: number;
  depreciationMethod?: "sl" | "db";
  condition?: string | null;
  warrantyEnd?: string | null;
  linkedDeviceId?: number | null;
}

export async function createAsset(input: CreateAssetInput, actor: Actor) {
  const scope = companyBranchScope(actor);
  const targetBranchId = resolveTargetBranch(scope, input.branchId, { required: false });
  const id = await withTx(async (tx) => {
    if (targetBranchId != null) {
      const [branch] = await tx
        .select({ id: branches.id })
        .from(branches)
        .where(eq(branches.id, targetBranchId))
        .for("update")
        .limit(1);
      if (!branch) throw new TRPCError({ code: "BAD_REQUEST", message: "الفرع غير موجود" });
    }
    if (input.linkedDeviceId != null) {
      const [device] = await tx
        .select({ branchId: kioskDevices.branchId })
        .from(kioskDevices)
        .where(eq(kioskDevices.id, input.linkedDeviceId))
        .for("update")
        .limit(1);
      if (!device) throw new TRPCError({ code: "BAD_REQUEST", message: "جهاز البصمة غير موجود" });
      if (targetBranchId == null || Number(device.branchId) !== targetBranchId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "جهاز البصمة تابع لفرع مختلف" });
      }
    }
    const code = await nextAssetCode(tx);
    const [res] = await tx.insert(fixedAssets).values({
      code,
      name: input.name,
      category: input.category as never,
      brand: input.brand ?? null,
      serial: input.serial ?? null,
      branchId: targetBranchId,
      location: input.location ?? null,
      custodianId: input.custodianId ?? null,
      supplierId: input.supplierId ?? null,
      purchaseDate: input.purchaseDate,
      purchaseValue: toDbMoney(input.purchaseValue),
      salvageValue: toDbMoney(input.salvageValue ?? "0"),
      usefulLifeYears: input.usefulLifeYears,
      depreciationMethod: input.depreciationMethod ?? "sl",
      condition: input.condition ?? null,
      warrantyEnd: input.warrantyEnd ?? null,
      linkedDeviceId: input.linkedDeviceId ?? null,
    });
    const newId = extractInsertId(res);

    // FI-01/FA-01 (تدقيق ٢٠/٦، قرار المالك «كل إضافة = شراء جديد يُقيَّد»، ولا أصول قائمة سابقاً):
    // اقتناء الأصل يُرحَّل للدفتر فيُقابله التزام/نقد ⇒ لا تُنفَخ حقوق الملكية (أصل بلا مصدر تمويل).
    // مورّد ⇒ ذمم دائنة AP + قيد PURCHASE (يُسدَّد لاحقاً بسند). بلا مورّد ⇒ نقد PAYMENT_OUT من الخزينة.
    const value = money(input.purchaseValue);
    const acqBranch = targetBranchId;
    const acqDate = new Date(input.purchaseDate);
    if (value.gt(0)) {
      if (input.supplierId) {
        await postEntry(tx, {
          entryType: "PURCHASE", branchId: acqBranch, supplierId: input.supplierId,
          cost: value, amount: value, entryDate: acqDate,
          dedupeKey: `ASSET_ACQ:${newId}`, notes: `اقتناء أصل ${code} (آجل — مورّد)`,
        });
        await adjustSupplierBalance(tx, input.supplierId, value);
      } else {
        if (acqBranch == null) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "شراء أصل نقداً يتطلب فرعاً محدداً لخزينة الصرف",
          });
        }
        await assertCashOutAvailable(tx, {
          branchId: acqBranch,
          cashBucket: "TREASURY",
          amount: value,
          operation: "شراء الأصل نقداً",
        });
        const rRes = await tx.insert(receipts).values({
          branchId: acqBranch, cashBucket: "TREASURY", direction: "OUT",
          amount: toDbMoney(value), paymentMethod: "CASH", status: "COMPLETED", createdBy: actor.userId,
        });
        const receiptId = extractInsertId(rRes);
        await postEntry(tx, {
          entryType: "PAYMENT_OUT", branchId: acqBranch, receiptId, amount: value, entryDate: acqDate,
          dedupeKey: `ASSET_ACQ:${newId}`, notes: `اقتناء أصل ${code} (نقدي)`,
        });
      }
    }

    // إن سُلّم بعهدة عند الإنشاء، افتح سطر عهدة جارية من تاريخ الشراء.
    // حرّاس العهدة (تدقيق ١٧/٧): كان الإسناد يُدرَج بلا فحص، فيُمكن فتح عهدة على موظف منتهي الخدمة أو من
    // فرعٍ آخر — بينما handoverCustody يرفضهما. نطبّق نفس الحارسين هنا (نشط + توافق الفرع) لتوحيد الضمان.
    if (input.custodianId) {
      const [emp] = await tx
        .select({ status: employees.employmentStatus, branchId: employees.branchId })
        .from(employees)
        .where(eq(employees.id, input.custodianId))
        .for("update")
        .limit(1);
      if (!emp) throw new Error("الموظف (صاحب العهدة) غير موجود");
      if (emp.status !== "active") throw new Error("لا يمكن تسليم عهدة لموظف ليس على رأس العمل");
      const assetBranch = targetBranchId;
      if (assetBranch != null && (emp.branchId == null || Number(assetBranch) !== Number(emp.branchId))) {
        throw new Error("لا يمكن تسليم عهدة لموظف من فرع مختلف عن فرع الأصل");
      }
      await tx.insert(assetCustodyLog).values({
        assetId: newId,
        employeeId: input.custodianId,
        fromDate: input.purchaseDate || toDateStr(),
        toDate: null,
        note: "تسليم عند إضافة الأصل",
      });
    }
    return newId;
  });
  return getAsset(id, scope);
}
