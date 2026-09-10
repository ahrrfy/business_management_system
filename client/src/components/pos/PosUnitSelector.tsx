import { trpc } from "@/lib/trpc";
import type { Tier, PosRow, PosColors } from "./posShared";

export interface PosUnitSelectorProps {
  branchId: number;
  variantId: number;
  currentUnitId: number;
  currentUnitName: string;
  tier?: Tier;
  disabled?: boolean;
  C: PosColors;
  onUnitChange?: (newRow: PosRow) => void;
}

export function PosUnitSelector({
  branchId,
  variantId,
  currentUnitId,
  currentUnitName,
  tier = "RETAIL",
  disabled,
  C,
  onUnitChange,
}: PosUnitSelectorProps) {
  const unitsQ = trpc.catalog.variantUnits.useQuery(
    { variantId, branchId, tier },
    { enabled: variantId > 0 && !!onUnitChange, staleTime: 60_000 },
  );

  const units = unitsQ.data ?? [];

  if (!onUnitChange || units.length <= 1) {
    return <span>{currentUnitName}</span>;
  }

  return (
    <select
      value={currentUnitId}
      disabled={disabled}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => {
        const id = Number(e.target.value);
        const match = units.find((u) => u.productUnitId === id);
        if (match) onUnitChange(match);
      }}
      style={{
        height: 24,
        maxWidth: 90,
        borderRadius: 4,
        border: `1px solid ${C.border}`,
        background: C.card,
        color: C.fg,
        padding: "0 4px",
        fontSize: 11.5,
        fontWeight: 800,
        outline: "none",
        cursor: "pointer",
      }}
      title="تبديل وحدة القياس للصنف مع رفع السعر والمخزون تلقائياً"
    >
      {units.map((u) => (
        <option key={u.productUnitId} value={u.productUnitId}>
          {u.unitName} ({u.conversionFactor}x)
        </option>
      ))}
    </select>
  );
}
