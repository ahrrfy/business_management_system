/**
 * **ملفّ التصميم** — شبكةُ نسخٍ مرقّمة (ش٢، ١٩/٨).
 *
 * كان الخادم يُرسل `images` وشاشةُ التفاصيل **تُهملها كلّياً** — صفر استعمالٍ في ٦٨٣ سطراً —
 * فيقف الفنّيّ أمام أمرٍ لا يرى تصميمه، ويسأل الاستقبالَ هاتفياً عمّا هو مخزَّنٌ عنده.
 *
 * والنسخةُ العليا وحدها هي «الحاليّ»؛ وما دونها **يبقى معروضاً مطويّاً** لا محذوفاً: هو
 * المستند الذي يُحتجّ به إن قال الزبون «وافقتُ على غير هذا».
 */
import { useState } from "react";
import { ChevronDown, ImageIcon, Loader2, Pencil, X } from "lucide-react";
import { ACTION_LABELS } from "@shared/actionLabels";
import { ImageUploader, type ImageItem } from "@/components/form/ImageUploader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";

export interface DesignImage {
  id: number;
  url: string;
  caption: string | null;
  revision?: number | null;
}

/** يبني حمولة النسخة من حقول ملف التصميم وحدها؛ غياب customizationText هنا مقصود للحفاظ عليه. */
export function buildDesignSaveInput(workOrderId: number, draft: ImageItem[], note: string) {
  return {
    workOrderId,
    images: draft.map((item, index) => ({
      url: item.url || item.dataUrl,
      caption: item.name?.trim() || null,
      sortOrder: index,
    })),
    note: note.trim(),
  };
}

export default function DesignFileCard({
  images,
  workOrderId,
  /** يُخفي محرّر النسخة على أمرٍ مُسلَّم/ملغى أو لمن لا يملك التعديل. */
  canEdit = false,
  /**
   * **رقمُ النسخة المثبَّتة فعلاً** من سجلّ النسخ (`workOrderDesignRevisions`)، أو `null` إن
   * لم تُثبَّت بعد.
   *
   * ⚠️ كانت البطاقة تشتقّ الرقم من الصور وحدها وتسقط على `1` عند غيابها، فتُعلن «نسخة ١ من ١»
   * على أمرٍ **بلا رأس نسخةٍ إطلاقاً** — بينما بطاقةُ الاعتماد فوقها تقول «لا توجد نسخة مثبتة
   * بعد». بطاقتان على شاشةٍ واحدة تتناقضان في الحقيقة نفسها (بلاغ المالك ١/٩/٢٦).
   */
  pinnedRevision = null,
}: {
  images: DesignImage[];
  workOrderId: number;
  canEdit?: boolean;
  pinnedRevision?: number | null;
}) {
  const [zoom, setZoom] = useState<DesignImage | null>(null);
  const [showOld, setShowOld] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ImageItem[]>([]);
  const [note, setNote] = useState("");
  const utils = trpc.useUtils();

  const save = trpc.workOrders.setDesign.useMutation({
    onSuccess: (r) => {
      notify.ok(
        r.changed
          ? `حُفظت النسخة ${r.revision} — اطلب اعتمادها من بطاقة الحوكمة`
          : "لا تغيير — النسخة كما هي",
      );
      setEditing(false);
      void utils.workOrders.get.invalidate({ workOrderId });
      void utils.workOrderDesignApproval.getCurrent.invalidate({ workOrderId });
    },
    onError: (e) => notify.err(e),
  });

  const revs = images.map((i) => Number(i.revision ?? 1));
  // سجلُّ النسخ هو المرجع؛ الصورُ تُكمله (نسخةٌ أحدث بصورٍ ولمّا يصل رأسُها بعد).
  const highest = Math.max(...revs, pinnedRevision ?? 0, 0);
  /** `null` = لا نسخةَ مثبَّتة ولا صورة — فلا نَدّعي «نسخة ١». */
  const current: number | null = highest > 0 ? highest : null;
  const currentImages = images.filter((i) => Number(i.revision ?? 1) === highest);
  const olderImages = images.filter((i) => Number(i.revision ?? 1) < highest);
  const validReason = note.trim().length >= 3;

  return (
    <div className="rounded-lg border p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <ImageIcon aria-hidden className="size-4" />
        <span className="text-sm font-bold">ملفّ التصميم</span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-2xs font-bold text-muted-foreground">
          {current == null ? "لم تُثبَّت نسخة بعد" : `نسخة ${current} من ${current}`}
        </span>
        {canEdit && !editing && (
          <Button
            size="sm"
            variant="outline"
            className="ms-auto"
            onClick={() => {
              // النسخة الحاليّة تُحمَّل مسوّدةً — التعديل يبدأ ممّا هو قائم لا من فراغ.
              setDraft(currentImages.map((im, i) => ({
                id: String(im.id), dataUrl: im.url, url: im.url,
                isPrimary: i === 0, name: im.caption ?? undefined,
              } as ImageItem)));
              setNote("");
              setEditing(true);
            }}
          >
            <Pencil aria-hidden className="size-3.5 me-1" /> نسخة جديدة
          </Button>
        )}
        {olderImages.length > 0 && (
          <button
            type="button"
            onClick={() => setShowOld((v) => !v)}
            aria-expanded={showOld}
            className="ms-auto inline-flex items-center gap-1 text-2xs font-bold text-muted-foreground hover:text-foreground"
          >
            النسخ السابقة ({highest - 1})
            <ChevronDown aria-hidden className={`size-3.5 transition-transform ${showOld ? "rotate-180" : ""}`} />
          </button>
        )}
      </div>

      {editing ? (
        <div className="space-y-3">
          <ImageUploader
            value={draft}
            onChange={setDraft}
            maxItems={10}
            hint="عدّل الصور ثمّ احفظ — تُحفظ نسخة جديدة والقديمة تبقى. أي طلب معلق يصبح قديماً، ثم تطلب اعتماد النسخة الجديدة صراحةً."
          />
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="سبب إنشاء النسخة الجديدة (3 محارف على الأقل)"
            aria-invalid={note.length > 0 && !validReason}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={save.isPending || !validReason}
              onClick={() =>
                // لا نرسل customizationText إطلاقاً: undefined يعني «حافظ على النص الحالي»،
                // أما null فيعني مسحه صراحةً وفق عقد الخدمة.
                save.mutate(buildDesignSaveInput(workOrderId, draft, note))
              }
            >
              {save.isPending ? (
                <><Loader2 aria-hidden className="size-3.5 me-1 animate-spin" /> {ACTION_LABELS.saving}</>
              ) : (
                "احفظ نسخةً جديدة"
              )}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={save.isPending}>
              تراجع
            </Button>
          </div>
        </div>
      ) : (
        currentImages.length > 0 ? (
          <Grid images={currentImages} onZoom={setZoom} />
        ) : (
          <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
            رفعُ ملفّ التصميم اختياريّ — نصّ التخصيص وحده يكفي مستنداً قابلاً للاعتماد. أضِف صوراً
            فقط حين يحتاجها التنفيذ فعلاً.
          </div>
        )
      )}

      {showOld && olderImages.length > 0 && (
        <div className="mt-4 border-t pt-3">
          <p className="mb-2 text-2xs text-muted-foreground">
            نسخٌ أُبطلت بتعديلٍ لاحق — تُحفظ ولا تُحذف، فهي المستند عند الاختلاف.
          </p>
          <Grid images={olderImages} onZoom={setZoom} dimmed />
        </div>
      )}

      {zoom && (
        <div
          role="dialog"
          aria-label="عرض التصميم"
          className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-6"
          onClick={() => setZoom(null)}
        >
          <button
            type="button"
            aria-label="إغلاق"
            className="absolute end-4 top-4 grid size-9 place-items-center rounded-full bg-background text-foreground"
            onClick={() => setZoom(null)}
          >
            <X aria-hidden className="size-4" />
          </button>
          <img
            src={zoom.url}
            alt={zoom.caption ?? "تصميم"}
            className="max-h-full max-w-full rounded-lg object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}

function Grid({
  images,
  onZoom,
  dimmed = false,
}: {
  images: DesignImage[];
  onZoom: (i: DesignImage) => void;
  dimmed?: boolean;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
      {images.map((im) => (
        <button
          key={im.id}
          type="button"
          onClick={() => onZoom(im)}
          className={`group relative overflow-hidden rounded-lg border bg-muted/40 ${dimmed ? "opacity-60" : ""}`}
          title={im.caption ?? "تكبير"}
        >
          <img src={im.url} alt={im.caption ?? "تصميم"} className="aspect-square w-full object-cover" />
          {im.caption && (
            <span className="absolute inset-x-0 bottom-0 truncate bg-black/60 px-1.5 py-0.5 text-2xs text-white">
              {im.caption}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
