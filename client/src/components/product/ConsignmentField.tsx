import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { Handshake, X } from "lucide-react";

/**
 * بضاعة الأمانة (٢٠/٧) — بطاقة وسم المنتج بأنه بضاعة أمانة وربطه بمودِعه.
 *
 * تُستعمل في شاشات المنتج (إضافة/سلعة بسيطة). عند التفعيل:
 *  - تصبح خانة «التكلفة» في الشاشة «حصة المودِع» (المبلغ الذي يستحقه عند البيع — المستدعي يعيد التسمية).
 *  - منتقي مودِع (بحث حيّ على مودِعي الأمانة فقط) إلزاميّ.
 * التحقّق النهائي خادميّ (assertConsignmentValid): تلازم أمانة⇔مودِع + المودِع CONSIGNOR نشِط + حصة > 0.
 */
export interface ConsignmentValue {
  isConsignment: boolean;
  consignorId: number | null;
  consignorName?: string | null;
}

export function ConsignmentField({
  value,
  onChange,
  disabled,
  disabledHint,
}: {
  value: ConsignmentValue;
  onChange: (next: ConsignmentValue) => void;
  /** يُقفل في التعديل بعد أول حركة/إيداع (مسار التعديل يمرّره). */
  disabled?: boolean;
  disabledHint?: string;
}) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const search = trpc.suppliers.search.useQuery(
    { q: debounced || undefined, kind: "CONSIGNOR", limit: 20 },
    { enabled: value.isConsignment && !value.consignorId, placeholderData: (p) => p },
  );
  const results = useMemo(() => search.data?.rows ?? [], [search.data]);

  function pick(id: number, name: string) {
    onChange({ isConsignment: true, consignorId: id, consignorName: name });
    setQ("");
    setOpen(false);
  }

  return (
    <Card className={cn("lg:col-span-2", value.isConsignment && "border-amber-200 bg-amber-50/30")}>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Handshake aria-hidden className="size-4 text-amber-600" />
          بضاعة أمانة (برسم البيع)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-start gap-3">
          <Switch
            checked={value.isConsignment}
            disabled={disabled}
            onCheckedChange={(on) =>
              onChange(on ? { isConsignment: true, consignorId: value.consignorId ?? null } : { isConsignment: false, consignorId: null })
            }
            aria-label="بضاعة أمانة"
          />
          <div className="space-y-0.5">
            <Label className="cursor-pointer">هذا الصنف بضاعة أمانة لطرف خارجي</Label>
            <p className="text-[11px] text-muted-foreground">
              البضاعة ملك المودِع؛ حصته تُسجَّل في خانة «حصة المودِع» ويستحقها عند البيع. لا دين عند الاستلام.
            </p>
            {disabled && disabledHint && <p className="text-[11px] text-amber-700">{disabledHint}</p>}
          </div>
        </div>

        {value.isConsignment && (
          <div className="space-y-1.5">
            <Label>المودِع <span className="text-destructive">*</span></Label>
            {value.consignorId ? (
              <div className="flex items-center justify-between rounded-md border border-amber-300 bg-amber-50 px-3 py-2">
                <span className="text-sm font-medium text-amber-900">{value.consignorName || `مودِع #${value.consignorId}`}</span>
                {!disabled && (
                  <button
                    type="button"
                    onClick={() => onChange({ isConsignment: true, consignorId: null })}
                    aria-label="إزالة المودِع"
                    className="text-amber-700 hover:text-amber-900"
                  >
                    <X aria-hidden className="size-4" />
                  </button>
                )}
              </div>
            ) : (
              <div className="relative">
                <Input
                  value={q}
                  disabled={disabled}
                  onChange={(e) => { setQ(e.target.value); setOpen(true); }}
                  onFocus={() => setOpen(true)}
                  placeholder="ابحث باسم المودِع أو هاتفه…"
                  aria-label="بحث عن مودِع"
                />
                {open && results.length > 0 && (
                  <div className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-md border bg-popover shadow-md">
                    {results.map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => pick(r.id, r.name)}
                        className="flex w-full items-center justify-between px-3 py-2 text-right text-sm hover:bg-muted"
                      >
                        <span>{r.name}</span>
                        {r.phone && <span dir="ltr" className="text-xs text-muted-foreground">{r.phone}</span>}
                      </button>
                    ))}
                  </div>
                )}
                {open && debounced && !search.isFetching && results.length === 0 && (
                  <p className="mt-1 text-[11px] text-muted-foreground">لا مودِع بهذا الاسم — أنشئه أولاً من الموردين.</p>
                )}
              </div>
            )}
            <Link href="/suppliers/new" className="inline-block text-xs text-primary underline">
              + مودِع جديد (يُفتح في الموردين)
            </Link>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
