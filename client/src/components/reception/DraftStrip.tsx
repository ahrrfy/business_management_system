// ش٢ (§٨.٢) — شريط «طلباتي المحفوظة»: رقائق مسوّدات المستخدم المفتوحة (بحدّ ٥ مرئية).
// المسوّدة **مُرقّاة** لا افتراضية: السلّة محليّةٌ دائماً (الأوفلاين محفوظ — ح٤)، والحفظ فعلٌ
// صريح («احفظ الطلب») أو سببٌ حقيقيّ. فتحُ مسوّدة زميلٍ يتطلّب تأكيداً يسمّيه، والمموّلة
// (moneyLocked — ش٤) موسومةٌ ولا تُلغى إلا بمدير.
import { useEffect, useState } from "react";
import { Banknote, ChevronDown, Printer, Save, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  // مراجعة PR #495 — «تصفّح الطلبات المفتوحة»: الشريط وحده كان يثبّت `mine:true` بستّة صفوف،
  // فلا سبيل لموظّفٍ أن يجد طلب زميلٍ ليكمله (ومسار تأكيد «طلبُ زميل» أدناه كان ميّتاً)، ولا
  // لصاحب الطلب السابع أن يصل إليه. العقد الخادميّ يدعم `mine:false` والبحث والترقيم منذ ش٢
  // (draftList) — نكشفها هنا: مبدّل نطاق + بحث برقم الطلب/الاسم/الهاتف حتى ٢٠ صفاً.
  const [browseAll, setBrowseAll] = useState(false);
  const [search, setSearch] = useState("");
  const [searchDebounced, setSearchDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  const browseQ = trpc.reception.draftList.useQuery(
    {
      branchId,
      mine: !browseAll,
      status: "OPEN",
      q: searchDebounced || undefined,
      limit: 20,
    },
    { staleTime: 10_000, enabled: !offline && menuOpen },
  );
  const cancelM = trpc.reception.draftCancel.useMutation({
    onSuccess: () => {
      notify.ok("أُلغيت المسوّدة");
      void utils.reception.draftList.invalidate();
    },
    onError: (e) => notify.err(e),
  });

  const rows = q.data?.rows ?? [];
  // الترقية مستحيلة دون اتصال ⇒ يختفي الشريط. مع الاتصال يبقى ظاهراً دائماً لأنّ زرّ «تصفّح
  // الطلبات» هو المدخل الوحيد لطلب زميلٍ يحتاج إكمالاً (مراجعة PR #495) — لا يشترط أن يكون لك
  // طلبٌ محفوظ ولا سلّةٌ قابلة للحفظ.
  if (offline) return null;

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

  const browseRows = browseQ.data?.rows ?? [];
  /** لوحة التصفّح: نطاق (طلباتي / كل طلبات الفرع) + بحث + قائمة أطول (٢٠ صفاً). */
  const browsePanel = menuOpen && (
    <div className="absolute end-0 top-[calc(100%+4px)] z-40 flex w-80 flex-col gap-2 rounded-xl border bg-card p-2 shadow-xl">
      <div className="flex items-center gap-1" role="group" aria-label="نطاق الطلبات">
        <button
          type="button"
          onClick={() => setBrowseAll(false)}
          className={cn("h-7 flex-1 rounded-lg border text-[11px] font-bold", !browseAll && "border-primary bg-primary/10 text-primary")}
        >
          طلباتي
        </button>
        <button
          type="button"
          onClick={() => setBrowseAll(true)}
          className={cn("h-7 flex-1 rounded-lg border text-[11px] font-bold", browseAll && "border-primary bg-primary/10 text-primary")}
        >
          كل طلبات الفرع
        </button>
      </div>
      <div className="relative">
        <Search aria-hidden className="pointer-events-none absolute inset-y-0 start-2 my-auto size-3.5 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="بحث برقم الطلب أو الاسم أو الهاتف"
          className="h-8 ps-7 text-[11px]"
          aria-label="بحث في الطلبات المحفوظة"
        />
      </div>
      <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
        {browseQ.isLoading ? (
          <span className="p-2 text-center text-[11px] text-muted-foreground">جارٍ التحميل…</span>
        ) : browseRows.length === 0 ? (
          <span className="p-2 text-center text-[11px] text-muted-foreground">
            {searchDebounced ? "لا طلبات مطابقة" : browseAll ? "لا طلبات مفتوحة في الفرع" : "لا طلبات محفوظة لك"}
          </span>
        ) : (
          browseRows.map(chip)
        )}
        {browseQ.data?.hasMore && (
          <span className="p-1 text-center text-[10px] text-muted-foreground">
            تُعرض أحدث ٢٠ طلباً — ضيّق البحث للوصول إلى الأقدم
          </span>
        )}
      </div>
    </div>
  );

  const browseBtn = (
    <button
      type="button"
      onClick={() => setMenuOpen((v) => !v)}
      aria-expanded={menuOpen}
      className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border bg-card px-2 text-[11px] font-bold hover:bg-muted"
    >
      {compact && rows.length > 0 ? `${rows.length} طلبات محفوظة` : "تصفّح الطلبات"}
      <ChevronDown aria-hidden className="size-3" />
    </button>
  );

  if (compact) {
    return (
      <div className="relative flex items-center gap-1.5">
        {saveBtn}
        {browseBtn}
        {browsePanel}
      </div>
    );
  }
  return (
    // الرقائق وحدها هي المنطقة القابلة للتمرير — لوحة التصفّح خارجها كي لا يقصّها overflow.
    <div className="flex items-center gap-1.5" aria-label="الطلبات المحفوظة">
      {saveBtn}
      <div className="flex items-center gap-1.5 overflow-x-auto">{rows.map(chip)}</div>
      <div className="relative shrink-0">
        {browseBtn}
        {browsePanel}
      </div>
    </div>
  );
}
