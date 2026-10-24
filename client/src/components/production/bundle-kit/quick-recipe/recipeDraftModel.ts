import { D, moneyInput, round2 } from "@/lib/money";
import { requiredBatchMultiple } from "@shared/batchDivisibility";

export interface EditableRecipeLine {
  inputVariantId: number;
  inputProductUnitId?: number | null;
  inputProductName: string;
  inputSku: string;
  inputCostPrice: string;
  qtyPerOutputBase: string;
  unitName?: string;
  notes?: string | null;
}

export function calculateRecipeDraftCosts(
  lines: EditableRecipeLine[],
  laborPerOutputBase: string,
  wasteStdPct: string,
) {
  let materialsTotal = D(0);
  for (const line of lines) {
    const quantity = moneyInput(line.qtyPerOutputBase);
    const unitCost = moneyInput(line.inputCostPrice);
    if (quantity.gt(0))
      materialsTotal = materialsTotal.plus(quantity.mul(unitCost));
  }
  materialsTotal = round2(materialsTotal);
  const labor = round2(moneyInput(laborPerOutputBase));
  const wasteFraction = moneyInput(wasteStdPct).div(100);
  const directTotal = materialsTotal.plus(labor);
  const wasteFactor =
    wasteFraction.gt(0) && wasteFraction.lt(1)
      ? D(1).minus(wasteFraction)
      : D(1);
  const unitCostWithWaste = wasteFactor.gt(0)
    ? round2(directTotal.div(wasteFactor))
    : directTotal;
  const batchMultiple = requiredBatchMultiple(
    lines.map((line) => line.qtyPerOutputBase || "1"),
  );
  return { materialsTotal, labor, unitCostWithWaste, batchMultiple };
}
