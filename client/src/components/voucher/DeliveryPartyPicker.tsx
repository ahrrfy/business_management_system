// DeliveryPartyPicker — منتقي جهات التوصيل (للسندات والتسويات).
// يتيح اختيار جهة توصيل نشطة، وعرض عهدتها الحالية ورقم الهاتف، مع إمكانية البحث والمسح.
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fmtAr } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import { useEffect, useMemo, useRef, useState } from "react";
import { Truck, X } from "lucide-react";

export interface DeliveryPartyPickerProps {
  partyId: number | null;
  onPartyChange: (id: number | null) => void;
  label?: string;
  branchId?: number | null;
}

export default function DeliveryPartyPicker({
  partyId,
  onPartyChange,
  label = "جهة التوصيل *",
  branchId,
}: DeliveryPartyPickerProps) {
  const partiesQuery = trpc.vouchers.deliveryParties.useQuery(
    { branchId: branchId ?? undefined },
    { staleTime: 60_000 },
  );

  const parties = partiesQuery.data ?? [];
  const selectedParty = useMemo(
    () => parties.find((p) => Number(p.id) === partyId),
    [parties, partyId],
  );

  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return parties.slice(0, 8);
    return parties
      .filter(
        (p) =>
          p.name.toLowerCase().includes(term) ||
          (p.phone && p.phone.includes(term)),
      )
      .slice(0, 8);
  }, [parties, q]);

  function pickParty(id: number) {
    onPartyChange(id);
    setQ("");
    setOpen(false);
  }

  function clearPick() {
    onPartyChange(null);
    setQ("");
  }

  const balanceNum = selectedParty?.currentBalance
    ? Number(selectedParty.currentBalance)
    : 0;

  return (
    <div className="space-y-1" ref={wrapRef}>
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        {selectedParty != null && (
          <Badge
            variant="outline"
            className="text-xs bg-emerald-500/10 text-emerald-600 border-emerald-500/20"
          >
            عهدة محصّلة: {fmtAr(balanceNum)} د.ع
          </Badge>
        )}
      </div>

      {selectedParty != null ? (
        <div className="flex gap-2">
          <div className="flex-1 flex items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 h-9 text-sm">
            <div className="flex items-center gap-2 truncate">
              <Truck aria-hidden className="size-4 text-muted-foreground shrink-0" />
              <span className="font-medium truncate">{selectedParty.name}</span>
              {selectedParty.phone && (
                <span className="text-xs text-muted-foreground font-mono" dir="ltr">
                  ({selectedParty.phone})
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={clearPick}
              className="text-xs text-muted-foreground hover:text-destructive shrink-0"
              aria-label="مسح اختيار جهة التوصيل"
            >
              <X aria-hidden className="size-4" />
            </button>
          </div>
        </div>
      ) : (
        <div className="relative">
          <Input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            placeholder="ابحث باسم جهة التوصيل أو الهاتف…"
            className="h-9 text-sm"
          />

          {open && (
            <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover text-popover-foreground shadow-md max-h-60 overflow-y-auto">
              {partiesQuery.isLoading ? (
                <div className="p-3 text-center text-xs text-muted-foreground">
                  جارٍ تحميل جهات التوصيل…
                </div>
              ) : filtered.length === 0 ? (
                <div className="p-3 text-center text-xs text-muted-foreground">
                  لا توجد جهة توصيل مطابقة
                </div>
              ) : (
                <ul className="py-1 text-sm">
                  {filtered.map((party) => {
                    const b = Number(party.currentBalance ?? 0);
                    return (
                      <li key={Number(party.id)}>
                        <button
                          type="button"
                          onClick={() => pickParty(Number(party.id))}
                          className="w-full text-right px-3 py-1.5 hover:bg-muted/60 flex items-center justify-between gap-2 text-xs"
                        >
                          <div className="flex items-center gap-2">
                            <Truck aria-hidden className="size-3.5 text-muted-foreground shrink-0" />
                            <span className="font-medium">{party.name}</span>
                            {party.phone && (
                              <span className="text-muted-foreground font-mono" dir="ltr">
                                {party.phone}
                              </span>
                            )}
                          </div>
                          {b > 0 && (
                            <span className="text-emerald-600 font-mono">
                              عهدة: {fmtAr(b)} د.ع
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
