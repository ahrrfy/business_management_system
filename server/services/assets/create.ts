// إنشاء أصل: ترقيم AST-#### + قيد اقتناء (AP لمورّد أو نقد خزينة) + عهدة ابتدائية اختيارية.
import { desc } from "drizzle-orm";
import { assetCustodyLog, fixedAssets, receipts } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { adjustSupplierBalance, postEntry } from "../ledgerService";
import { money, toDateStr, toDbMoney } from "../money";
import { type Actor, withTx } from "../tx";
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
  const id = await withTx(async (tx) => {
    const code = await nextAssetCode(tx);
    const [res] = await tx.insert(fixedAssets).values({
      code,
      name: input.name,
      category: input.category as never,
      brand: input.brand ?? null,
      serial: input.serial ?? null,
      branchId: input.branchId ?? null,
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
    const acqBranch = input.branchId ?? actor.branchId ?? null;
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
    if (input.custodianId) {
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
  return getAsset(id);
}
