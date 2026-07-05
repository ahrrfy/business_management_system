import { Input } from "@/components/ui/input";
import { D, fmtAr } from "@/lib/money";
import { useEffect, useMemo, useState } from "react";

const DENOMINATIONS = [50000, 25000, 10000, 5000, 1000, 500, 250] as const;
const PER_BILL_CAP = 10_000;

interface CashCounterProps {
  value?: Record<number, number>;
  onChange: (counts: Record<number, number>, totalIQD: string) => void;
  disabled?: boolean;
}

export function CashCounter({ value, onChange, disabled }: CashCounterProps) {
  const [counts, setCounts] = useState<Record<number, number>>(value ?? {});

  useEffect(() => {
    if (value) setCounts(value);
  }, [value]);

  const total = useMemo(() => {
    let t = D(0);
    for (const denom of DENOMINATIONS) {
      const n = Math.max(0, Math.floor(counts[denom] ?? 0));
      t = t.plus(D(denom).times(n));
    }
    return t.toDecimalPlaces(2).toFixed(2);
  }, [counts]);

  useEffect(() => {
    onChange(counts, total);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [total]);

  const handleSet = (denom: number, raw: string) => {
    const num = raw === "" ? 0 : Math.max(0, Math.min(PER_BILL_CAP, Math.floor(Number(raw) || 0)));
    setCounts((prev) => ({ ...prev, [denom]: num }));
  };

  return (
    <div className="rounded-lg border bg-card">
      <div className="px-4 py-2.5 border-b flex items-center justify-between">
        <h4 className="text-sm font-semibold">عدّاد فئات العملة (د.ع)</h4>
        <span className="text-[11px] text-muted-foreground">اختياري</span>
      </div>
      <div className="p-3 space-y-1.5">
        {DENOMINATIONS.map((denom) => {
          const n = counts[denom] ?? 0;
          const subtotal = D(denom).times(n).toNumber();
          return (
            <div key={denom} className="grid grid-cols-12 items-center gap-2 text-sm">
              <div className="col-span-3 font-medium tabular-nums" dir="ltr">
                {denom.toLocaleString("en-US")}
              </div>
              <div className="col-span-1 text-center text-muted-foreground">×</div>
              <Input
                type="number"
                min={0}
                max={PER_BILL_CAP}
                step={1}
                inputMode="numeric"
                value={n || ""}
                disabled={disabled}
                onChange={(e) => handleSet(denom, e.target.value)}
                className="col-span-3 h-11 text-base text-center tabular-nums"
                placeholder="0"
              />
              <div className="col-span-1 text-center text-muted-foreground">=</div>
              <div className="col-span-4 text-end tabular-nums text-muted-foreground" dir="ltr">
                {subtotal > 0 ? fmtAr(subtotal) : "—"}
              </div>
            </div>
          );
        })}
      </div>
      <div className="px-4 py-3 border-t bg-muted/30 flex items-center justify-between">
        <span className="text-sm font-semibold">المجموع المعدود</span>
        <span className="text-lg font-bold tabular-nums text-primary" dir="ltr">
          {fmtAr(total)}
        </span>
      </div>
    </div>
  );
}
