import { ArrowLeft, Check, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { ImageUploader, type ImageUploaderProps } from "@/components/form/ImageUploader";
import { Button } from "@/components/ui/button";
import { finishCutFromCutout, runFreeStudio, type StudioResult } from "@/lib/imageStudio/freePipeline";
import { trpc } from "@/lib/trpc";

interface StudioPreview {
  id: string;
  before: string;
  after: string;
  sizeKB: number;
  mode: StudioResult["mode"];
}

/**
 * ImageStudioUploader — يلفّ `ImageUploader` ويضيف تحويل «استوديو»: خلفية بيضاء موحّدة + قالب موحّد
 * + ظلّ تماس، بمعاينة قبل/بعد ثمّ **اعتماد صريح** (الأصل لا يُستبدَل إلا بموافقة).
 *
 * منطق القصّ (بحسب الإعداد):
 *   - Pro مُتاح (remove.bg مُفعَّل بمفتاح): يجرّب قصّ الخادم ⇒ `finishCutFromCutout` (يُركّب القصّ الشفّاف
 *     على القالب بنفس أمان FLATTEN-عند-الشكّ). فشلٌ لأي سبب (نفاد رصيد/تعطّل) ⇒ **تدهور لـFLATTEN**.
 *   - Pro غير مُتاح: **FLATTEN** الآمن مباشرةً (canvas بحت، يستحيل أن يأكل بكسلة منتج).
 * أمانة صارمة: remove.bg قصٌّ لا توليد. راجع client/src/lib/imageStudio/README.md.
 */
export function ImageStudioUploader(props: ImageUploaderProps) {
  const { value, onChange } = props;
  const [busy, setBusy] = useState(false);
  const [previews, setPreviews] = useState<StudioPreview[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const proConfig = trpc.imageStudio.proConfig.useQuery(undefined, { staleTime: 60_000 });
  const proCutout = trpc.imageStudio.proCutout.useMutation();
  const proAvailable = proConfig.data?.proAvailable ?? false;

  const runStudio = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    let fellBackMsg = "";
    let lowResPreview = false;
    try {
      const results = await Promise.all(
        value.map(async (it): Promise<StudioPreview> => {
          let r: StudioResult;
          if (proAvailable) {
            try {
              const res = await proCutout.mutateAsync({ imageDataUrl: it.dataUrl });
              // نثق بقصّ remove.bg دائماً (خدمة مدفوعة) — لا نُخضعه لحدس FLATTEN-عند-الشكّ.
              r = await finishCutFromCutout(res.cutoutDataUrl, it.dataUrl, { trustCutout: true });
              if (res.isPreview) lowResPreview = true; // مفتاح مجاني ⇒ نتيجة معاينة منخفضة الدقّة.
            } catch (e) {
              // فشل Pro (مفتاح خاطئ/صورة غير صالحة/تعطّل) ⇒ تدهور آمن لـFLATTEN بلا كسر التجربة.
              fellBackMsg = String((e as { message?: string })?.message ?? "");
              r = await runFreeStudio(it.dataUrl, { safeOnly: true });
            }
          } else {
            r = await runFreeStudio(it.dataUrl, { safeOnly: true });
          }
          return { id: it.id, before: it.dataUrl, after: r.dataUrl, sizeKB: Math.round(r.sizeKB), mode: r.mode };
        }),
      );
      setPreviews(results);
      if (fellBackMsg) setNotice(`تعذّر القصّ الاحترافي (${fellBackMsg}) — استُعمل المسار المجاني الآمن.`);
      else if (lowResPreview) setNotice("قُصّت الخلفية بدقّة معاينة منخفضة (الباقة المجانيّة). للنتيجة الاحترافيّة كاملة الدقّة، اشحن رصيد remove.bg.");
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
    setNotice(null);
  };

  return (
    <div className="space-y-3">
      <ImageUploader {...props} />

      {value.length > 0 && !previews && (
        <div className="space-y-1">
          <Button type="button" variant="outline" size="sm" onClick={runStudio} disabled={busy}>
            <Sparkles aria-hidden className="size-4" />
            {busy
              ? "جارٍ التحويل…"
              : proAvailable
                ? "قصّ الخلفية (استوديو احترافي)"
                : "توسيط على خلفية بيضاء"}
          </Button>
          {!proAvailable && (
            <p className="text-[11px] text-muted-foreground">
              المسار المجانيّ يوسّط الصورة على أبيض فقط (لا يُزيل الخلفية). إزالة الخلفية الاحترافيّة تحتاج تفعيل remove.bg من الإعدادات.
            </p>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {previews && (
        <div className="space-y-3 rounded-md border p-3">
          <p className="text-sm font-medium">معاينة الاستوديو — خلفية بيضاء موحّدة بإطار وظلّ (الأصل يمينًا):</p>
          {notice && <p className="text-xs text-amber-600 dark:text-amber-500">{notice}</p>}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {previews.map((p) => (
              <div key={p.id} className="space-y-1 text-center">
                <div className="flex items-center justify-center gap-1">
                  <img src={p.after} alt="بعد" className="size-16 rounded border object-contain" style={{ background: "#ffffff" }} />
                  <ArrowLeft aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  <img src={p.before} alt="قبل" className="size-16 rounded border bg-muted object-contain" />
                </div>
                <span className="text-xs text-muted-foreground">
                  {p.sizeKB}KB · {p.mode === "CUT" ? "قصّ" : "آمن"}
                </span>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <Button type="button" size="sm" onClick={accept}>
              <Check aria-hidden className="size-4" /> اعتماد الكل
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => { setPreviews(null); setNotice(null); }}>
              <X aria-hidden className="size-4" /> إلغاء
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
