import { useState } from "react";
import { Search as SearchIcon, TriangleAlert } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { errMsg } from "@/lib/notify";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SectionCard } from "./ContactSection";
import type { PartyKind } from "./types";
export function DuplicatesCard({
  kind,
  id,
  canRead,
  onOpenContact,
}: {
  kind: PartyKind;
  id: number;
  canRead: boolean;
  onOpenContact: (kind: PartyKind, id: number) => void;
}) {
  const [checked, setChecked] = useState(false);
  const dup = trpc.contacts.findDuplicates.useQuery(
    { kind, id },
    { enabled: false },
  );
  const rows = canRead && !dup.isError ? (dup.data ?? []) : [];
  if (!canRead) return null;

  return (
    <SectionCard
      icon={SearchIcon}
      title="كشف الازدواج"
      action={
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            setChecked(true);
            dup.refetch();
          }}
          disabled={dup.isFetching}
        >
          {dup.isFetching ? "جارٍ البحث…" : "بحث عن مكرر"}
        </Button>
      }
    >
      {dup.isError && (
        <p className="text-xs text-destructive">{errMsg(dup.error)}</p>
      )}
      {checked && !dup.isFetching && !dup.isError && rows.length === 0 && (
        <p className="text-xs text-muted-foreground">لا نظائر مشابهة.</p>
      )}
      {rows.length > 0 && (
        <div className="rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-3 space-y-1.5">
          <p className="flex items-center gap-1.5 text-xs font-bold text-[var(--sem-warn)]">
            <TriangleAlert aria-hidden className="size-3.5" /> نظائر مرشّحة —
            للمراجعة اليدوية فقط (بلا دمج تلقائي)
          </p>
          {rows.map((m) => (
            <div
              key={m.id}
              className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm"
            >
              <span className="font-medium">{m.name}</span>
              {m.phone && (
                <span dir="ltr" className="text-xs text-muted-foreground">
                  {m.phone}
                </span>
              )}
              <Badge variant="neutral" className="text-[10px]">
                {m.matchedOn === "phone"
                  ? "تطابق هاتف"
                  : m.matchedOn === "both"
                    ? "تطابق اسم وهاتف"
                    : "تشابه اسم"}
              </Badge>
              {!m.isActive && (
                <Badge variant="neutral" className="text-[10px]">
                  معطَّل
                </Badge>
              )}
              <button
                type="button"
                className="text-xs text-primary underline"
                onClick={() => onOpenContact(kind, Number(m.id))}
              >
                فتح البطاقة
              </button>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}
