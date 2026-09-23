import React from "react";

export interface ColorSwatchItem {
  name: string;
  hex: string;
  inStock: boolean;
}

interface StorefrontColorSwatchesProps {
  colors?: ColorSwatchItem[];
  max?: number;
  size?: number;
}

export function StorefrontColorSwatches({
  colors,
  max = 6,
  size = 12,
}: StorefrontColorSwatchesProps) {
  if (!colors || colors.length === 0) return null;
  const shown = colors.slice(0, max);
  const extra = colors.length - shown.length;
  return (
    <div
      className="flex items-center gap-1"
      title={`ألوان المنتج: ${colors.map((c) => (c.inStock ? c.name : `${c.name} (نافد)`)).join("، ")}`}
    >
      {shown.map((c) => {
        const label = c.inStock ? c.name : `${c.name} — نافد`;
        return (
          <span
            key={`${c.hex}-${c.name}`}
            role="img"
            className={`inline-block shrink-0 rounded-full ring-1 ring-black/20 dark:ring-white/25${c.inStock ? "" : " opacity-30 grayscale"}`}
            style={{ width: size, height: size, background: c.hex }}
            title={label}
            aria-label={label}
          />
        );
      })}
      {extra > 0 && <span className="text-[9px] font-bold text-slate-400">+{extra}</span>}
    </div>
  );
}
