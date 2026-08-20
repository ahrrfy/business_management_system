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

export default function DesignFileCard({
  images,
  workOrderId,
  /** يُخفي محرّر النسخة على أمرٍ مُسلَّم/ملغى أو لمن لا يملك التعديل. */
  canEdit = false,
}: {
  images: DesignImage[];
  workOrderId: number;
  canEdit?: boolean;
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
          ? `حُفظت النسخة ${r.revision}${r.taskNumber ? ` — فُتح طلب موافقة ${r.taskNumber}` : ""}`
          : "لا تغيير — النسخة كما هي",
      );
      setEditing(false);
      void utils.workOrders.get.invalidate({ workOrderId });
    },
    onError: (e) => notify.err(e),
  });

  const revs = images.map((i) => Number(i.revision ?? 1));
  const current = revs.length ? Math.max(...revs) : 1;
  const currentImages = images.filter((i) => Number(i.revision ?? 1) === current);
  const olderImages = images.filter((i) => Number(i.revision ?? 1) < current);

  return (
    <div className="rounded-lg border p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <ImageIcon aria-hidden className="size-4" />
        <span className="text-sm font-bold">ملفّ التصميم</span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-2xs font-bold text-muted-foreground">
          نسخة {current} من {current}
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
            النسخ السابقة ({current - 1})
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
            hint="عدّل الصور ثمّ احفظ — تُحفظ **نسخةً جديدة** والقديمة تبقى، ويُفتَح طلبُ موافقةٍ للعميل."
          />
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="سبب التعديل (يظهر في طلب الموافقة)"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={save.isPending}
              onClick={() =>
                save.mutate({
                  workOrderId,
                  images: draft.map((d, i) => ({
                    url: d.url || d.dataUrl,
                    caption: d.name?.trim() || null,
                    sortOrder: i,
                  })),
                  note: note.trim() || null,
                })
              }
            >
              {save.isPending ? (
                <><Loader2 aria-hidden className="size-3.5 me-1 animate-spin" /> جارٍ الحفظ…</>
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
        <Grid images={currentImages} onZoom={setZoom} />
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
