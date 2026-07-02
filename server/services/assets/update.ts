// تعديل بيانات أصل قائم (لا يشمل العهدة/الحالة/الاستبعاد — لها مساراتها).
import { eq } from "drizzle-orm";
import { fixedAssets } from "../../../drizzle/schema";
import { toDbMoney } from "../money";
import { withTx } from "../tx";
import { loadForUpdate } from "./helpers";
import { getAsset } from "./queries";

/** تعديل بيانات أصل قائم (لا يشمل العهدة/الحالة/الاستبعاد — لها مساراتها). */
export interface UpdateAssetInput {
  name: string;
  category: string;
  brand?: string | null;
  serial?: string | null;
  branchId?: number | null;
  location?: string | null;
  supplierId?: number | null;
  purchaseDate: string;
  purchaseValue: string;
  salvageValue?: string;
  usefulLifeYears: number;
  depreciationMethod?: "sl" | "db";
  condition?: string | null;
  warrantyEnd?: string | null;
}

export async function updateAsset(id: number, input: UpdateAssetInput) {
  if (!(input.usefulLifeYears > 0)) throw new Error("العمر الإنتاجي يجب أن يكون أكبر من صفر");
  await withTx(async (tx) => {
    const a = await loadForUpdate(tx, id);
    if (a.status === "disposed") throw new Error("لا يمكن تعديل أصل مُستبعَد");
    await tx
      .update(fixedAssets)
      .set({
        name: input.name,
        category: input.category as never,
        brand: input.brand ?? null,
        serial: input.serial ?? null,
        branchId: input.branchId ?? null,
        location: input.location ?? null,
        supplierId: input.supplierId ?? null,
        purchaseDate: input.purchaseDate,
        purchaseValue: toDbMoney(input.purchaseValue),
        salvageValue: toDbMoney(input.salvageValue ?? "0"),
        usefulLifeYears: input.usefulLifeYears,
        depreciationMethod: input.depreciationMethod ?? "sl",
        condition: input.condition ?? null,
        warrantyEnd: input.warrantyEnd ?? null,
      })
      .where(eq(fixedAssets.id, id));
  });
  return getAsset(id);
}
