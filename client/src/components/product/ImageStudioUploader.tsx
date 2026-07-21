import { ArrowLeft, Check, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { ImageUploader, type ImageUploaderProps } from "@/components/form/ImageUploader";
import { Button } from "@/components/ui/button";
import { runFreeStudio } from "@/lib/imageStudio/freePipeline";

interface StudioPreview {
  id: string;
  before: string;
  after: string;
  sizeKB: number;
}

/**
 * ImageStudioUploader — يلفّ `ImageUploader` ويضيف تحويل «استوديو»: خلفية بيضاء موحّدة + قالب موحّد
 * + ظلّ تماس. المسار الآمن **FLATTEN** (`safeOnly` — canvas بحت، يستحيل أن يأكل بكسلة منتج). معاينة
 * قبل/بعد ثمّ **اعتماد صريح** قبل التطبيق (الأصل لا يُستبدَل إلا بموافقة). مسار CUT (عزل الخلفية بـ@imgly)
 * يُفعَّل لاحقاً عند تهيئة النموذج. راجع client/src/lib/imageStudio/README.md.
 */
export function ImageStudioUploader(props: ImageUploaderProps) {
  const { value, onChange } = props;
  const [busy, setBusy] = useState(false);
  const [previews, setPreviews] = useState<StudioPreview[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runStudio = async () => {
    setBusy(true);
    setError(null);
    try {
      const results = await Promise.all(
        value.map(async (it) => {
          const r = await runFreeStudio(it.dataUrl, { safeOnly: true });
          return { id: it.id, before: it.dataUrl, after: r.dataUrl, sizeKB: Math.round(r.sizeKB) };
        }),
      );
      setPreviews(results);
    } catch (e) {
      setError("تعذّرت معالجة الاستوديو: " + String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const accept = () => {
    if (!previews) return;
    const byId = new Map(previews.map((p) => [p.id, p.after]));
    // نستبدل dataUrl بالنسخة الاستوديوية ونمسح url (الرابط القديم) ليُعاد الحفظ بالمعالَجة.
    onChange(value.map((it) => (byId.has(it.id) ? { ...it, dataUrl: byId.get(it.id) as string, url: undefined } : it)));
    setPreviews(null);
  };

  return (
    <div className="space-y-3">
      <ImageUploader {...props} />

      {value.length > 0 && !previews && (
        <Button type="button" variant="outline" size="sm" onClick={runStudio} disabled={busy}>
          <Sparkles aria-hidden className="size-4" />
          {busy ? "جارٍ التحويل…" : "تحويل لخلفية استوديو بيضاء"}
        </Button>
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {previews && (
        <div className="space-y-3 rounded-md border p-3">
          <p className="text-sm font-medium">معاينة الاستوديو — خلفية بيضاء موحّدة بإطار وظلّ (الأصل يمينًا):</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {previews.map((p) => (
              <div key={p.id} className="space-y-1 text-center">
                <div className="flex items-center justify-center gap-1">
                  <img src={p.after} alt="بعد" className="size-16 rounded border object-contain" style={{ background: "#ffffff" }} />
                  <ArrowLeft aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  <img src={p.before} alt="قبل" className="size-16 rounded border bg-muted object-contain" />
                </div>
                <span className="text-xs text-muted-foreground">{p.sizeKB}KB</span>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <Button type="button" size="sm" onClick={accept}>
              <Check aria-hidden className="size-4" /> اعتماد الكل
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setPreviews(null)}>
              <X aria-hidden className="size-4" /> إلغاء
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
