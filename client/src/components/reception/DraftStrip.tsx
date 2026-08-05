// ش٢ (§٨.٢) — شريط «طلباتي المحفوظة»: رقائق مسوّدات المستخدم المفتوحة (بحدّ ٥ مرئية).
// المسوّدة **مُرقّاة** لا افتراضية: السلّة محليّةٌ دائماً (الأوفلاين محفوظ — ح٤)، والحفظ فعلٌ
// صريح («احفظ الطلب») أو سببٌ حقيقيّ. فتحُ مسوّدة زميلٍ يتطلّب تأكيداً يسمّيه، والمموّلة
// (moneyLocked — ش٤) موسومةٌ ولا تُلغى إلا بمدير.
import { useState } from "react";
import { Banknote, ChevronDown, Printer, Save, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { confirm } from "@/lib/confirm";
import { fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";

export type DraftRow = RouterOutputs["reception"]["draftList"]["rows"][number];

export function DraftStrip({
  branchId,
  meUserId,
  activeDraftId,
  offline,
  compact,
  canSave,
  onSave,
  onResume,
  onPrintTicket,
}: {
  branchId: number;
  meUserId: number;
  activeDraftId: number | null;
  /** الترقية مستحيلة دون اتصال (§٨.٢) — الشريط يقرأ فقط والحفظ مُعطَّل. */
  offline: boolean;
  /** تحت compactHeader ينكمش الشريط إلى زرٍّ منسدلٍ واحد (§٨.١ سُلَّم الاحتواء). */
  compact: boolean;
  canSave: boolean;
  onSave: () => void;
  onResume: (draftId: number) => void;
  onPrintTicket: (draftId: number) => void;
}) {
  const utils = trpc.useUtils();
  const [menuOpen, setMenuOpen] = useState(false);
  const q = trpc.reception.draftList.useQuery(
    { branchId, mine: true, status: "OPEN", limit: 6 },
    { staleTime: 15_000, refetchInterval: 45_000, enabled: !offline },
  );
  const cancelM = trpc.reception.draftCancel.useMutation({
    onSuccess: () => {
      notify.ok("أُلغيت المسوّدة");
      void utils.reception.draftList.invalidate();
    },
    onError: (e) => notify.err(e),
  });

  const rows = q.data?.rows ?? [];
  if (offline || (rows.length === 0 && !canSave)) return null;

  async function resume(row: DraftRow) {
    if (Number(row.createdBy) !== meUserId) {
      const ok = await confirm({
        variant: "warning",
        title: "طلبُ زميل",
        description: `هذا الطلب أنشأه ${row.ownerName ?? "زميل آخر"} — هل تكمله أنت؟ (سيُسجَّل تعديلك باسمك)`,
        confirmText: "أكمل الطلب",
      });
      if (!ok) return;
    }
    onResume(Number(row.id));
    setMenuOpen(false);
  }

  async function cancelRow(row: DraftRow) {
    if (!(await confirm({
      variant: "warning",
      title: `إلغاء المسوّدة ${row.draftNumber}`,
      description: row.moneyLocked
        ? "عليها مبلغٌ مقبوض — الإلغاء يتطلّب مديراً ويُردّ المبلغ بمساره الموثَّق."
        : "ستُلغى نهائياً (لا مالَ عليها).",
      confirmText: "إلغاء المسوّدة",
    }))) return;
    cancelM.mutate({ draftId: Number(row.id), version: Number(row.version), reason: "أُلغيت من شريط المحطة" });
  }

  const chip = (row: DraftRow) => (
    <span
      key={String(row.id)}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border px-2 text-[11px] font-bold",
        Number(row.id) === activeDraftId ? "border-primary bg-primary/10 text-primary" : "bg-card",
        row.moneyLocked && "border-[var(--sem-warn)]",
      )}
    >
      <button type="button" onClick={() => void resume(row)} className="inline-flex items-center gap-1 hover:underline" title={`فتح ${row.draftNumber}`}>
        {row.moneyLocked && <Banknote aria-hidden className="size-3 text-[var(--sem-warn)]" />}
        <span dir="ltr">…{row.draftNumber.slice(-5)}</span>
        <span className="max-w-24 truncate text-muted-foreground">{row.contactName ?? "عميل نقدي"}</span>
        <span className="tabular-nums text-muted-foreground" dir="ltr">{fmt(row.total)}</span>
        {/* ش٤: المقبوض فعلاً على الطلب — يميّز المموّلة بمبلغها لا بأيقونةٍ فقط */}
        {Number((row as { heldTotal?: string }).heldTotal ?? 0) > 0 && (
          <span className="tabular-nums font-extrabold text-[var(--sem-warn)]">
            مقبوض <span dir="ltr">{fmt(Number((row as { heldTotal?: string }).heldTotal))}</span>
          </span>
        )}
      </button>
      <button type="button" onClick={() => onPrintTicket(Number(row.id))} aria-label={`طباعة تذكرة ${row.draftNumber}`} className="text-muted-foreground hover:text-foreground">
        <Printer aria-hidden className="size-3" />
      </button>
      <button type="button" onClick={() => void cancelRow(row)} aria-label={`إلغاء ${row.draftNumber}`} className="text-muted-foreground hover:text-destructive">
        <X aria-hidden className="size-3" />
      </button>
    </span>
  );

  const saveBtn = canSave && (
    <Button size="sm" variant="outline" className="h-8 shrink-0 text-[11px] font-extrabold" onClick={onSave} disabled={activeDraftId != null}>
      <Save aria-hidden className="size-3.5 me-1" />
      {activeDraftId != null ? "محفوظ — يُزامَن تلقائياً" : "احفظ الطلب"}
    </Button>
  );

  if (compact) {
    return (
      <div className="relative flex items-center gap-1.5">
        {saveBtn}
        {rows.length > 0 && (
          <>
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              className="inline-flex h-8 items-center gap-1 rounded-lg border bg-card px-2 text-[11px] font-bold hover:bg-muted"
            >
              {rows.length} طلبات محفوظة <ChevronDown aria-hidden className="size-3" />
            </button>
            {menuOpen && (
              <div className="absolute end-0 top-[calc(100%+4px)] z-40 flex w-72 flex-col gap-1 rounded-xl border bg-card p-2 shadow-xl">
                {rows.map(chip)}
              </div>
            )}
          </>
        )}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto" aria-label="الطلبات المحفوظة">
      {saveBtn}
      {rows.map(chip)}
    </div>
  );
}
