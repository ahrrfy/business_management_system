import { ArrowLeft, Check, Info, Sparkles, Wand2, X } from "lucide-react";
import { useState } from "react";
import { ImageUploader, type ImageUploaderProps } from "@/components/form/ImageUploader";
import { Button } from "@/components/ui/button";
import { normalizeAiStudioImage } from "@/lib/imageStudio/aiStudio";
import { finishCutFromCutout, runFreeStudio, type StudioResult } from "@/lib/imageStudio/freePipeline";
import { trpc } from "@/lib/trpc";

interface StudioPreview {
  id: string;
  before: string;
  after: string;
  sizeKB: number;
  mode: StudioResult["mode"] | "AI";
}

/**
 * ImageStudioUploader — يلفّ `ImageUploader` ويضيف تحويل «استوديو»: خلفية بيضاء موحّدة + قالب موحّد
 * + ظلّ تماس، بمعاينة قبل/بعد ثمّ **اعتماد صريح** (الأصل لا يُستبدَل إلا بموافقة).
 *
 * ثلاثة مسارات (بحسب الإعداد):
 *   - **المجانيّ (FLATTEN)**: توسيط على أبيض (canvas بحت ⇒ يستحيل أكل بكسلة منتج). دائماً متاح.
 *   - **Pro (remove.bg)**: قصّ خلفية احترافيّ (segmentation — بكسلات المنتج تبقى). فشلٌ ⇒ تدهور FLATTEN.
 *   - **الذكاء الاصطناعي (توليديّ)**: يُعيد تصميم الصورة كاستوديو موحّد من برومت جاهز. ⚠️ توليديّ ⇒
 *     يعيد رسم البكسلات، فقد يغيّر تفاصيل دقيقة/كتابة — لذا **مراجعة بشرية إلزامية** والأصل محفوظ.
 * راجع client/src/lib/imageStudio/README.md.
 */
export function ImageStudioUploader(props: ImageUploaderProps) {
  const { value, onChange } = props;
  const [busy, setBusy] = useState(false);
  const [previews, setPreviews] = useState<StudioPreview[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [aiPromptText, setAiPromptText] = useState("");

  const proConfig = trpc.imageStudio.proConfig.useQuery(undefined, { staleTime: 60_000 });
  const proCutout = trpc.imageStudio.proCutout.useMutation();
  const proAvailable = proConfig.data?.proAvailable ?? false;

  const aiConfig = trpc.imageStudio.aiConfig.useQuery(undefined, { staleTime: 60_000 });
  const aiTransform = trpc.imageStudio.aiStudioTransform.useMutation();
  const aiAvailable = aiConfig.data?.aiAvailable ?? false;

  const aiInPreview = !!previews?.some((p) => p.mode === "AI");

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

  const runAiStudio = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    const userPrompt = aiPromptText.trim() || undefined;
    try {
      // تسلسليّ لا متوازٍ: httpBatchLink يجمع النداءات المتزامنة في طلبٍ HTTP واحد، فعدّة صور data-URL
      // (~٧٠٠ك لكلٍّ) تتجاوز حدّ جسم 4mb ⇒ 413 قبل بلوغ الراوتر. الإرسال واحداً-تلو-آخر يجعل كلّ صورة
      // طلباً مستقلّاً (والتوليد بطيء أصلاً ⇒ لا فائدة من التوازي). فشلٌ جزئيّ ⇒ نُظهر ما نجح وننبّه.
      const ok: StudioPreview[] = [];
      let firstErr = "";
      let failedCount = 0;
      for (const it of value) {
        try {
          const res = await aiTransform.mutateAsync({ imageDataUrl: it.dataUrl, userPrompt, mode: "EDIT" });
          const norm = await normalizeAiStudioImage(res.imageDataUrl);
          ok.push({ id: it.id, before: it.dataUrl, after: norm.dataUrl, sizeKB: Math.round(norm.sizeKB), mode: "AI" });
        } catch (e) {
          failedCount++;
          if (!firstErr) firstErr = String((e as { message?: string })?.message ?? e ?? "");
        }
      }
      if (ok.length === 0) {
        setError("تعذّر إنشاء استوديو الذكاء الاصطناعي: " + firstErr);
        return;
      }
      setPreviews(ok);
      if (failedCount > 0) {
        setNotice(`تعذّر تحويل ${failedCount} من ${value.length} صورة (${firstErr}).`);
      }
    } catch (e) {
      setError("تعذّر إنشاء استوديو الذكاء الاصطناعي: " + String((e as Error)?.message ?? e));
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

  const modeLabel = (m: StudioPreview["mode"]) => (m === "AI" ? "ذكاء اصطناعي" : m === "CUT" ? "قصّ" : "آمن");

  return (
    <div className="space-y-3">
      <ImageUploader {...props} />

      {value.length > 0 && !previews && (
        <div className="space-y-3">
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

          {aiAvailable && (
            <div className="space-y-2 rounded-md border border-violet-500/30 bg-violet-500/[0.03] p-2.5">
              <div className="flex items-center gap-1.5 text-sm font-medium text-violet-700 dark:text-violet-300">
                <Wand2 aria-hidden className="size-4" /> استوديو الذكاء الاصطناعي (استوديو موحّد)
              </div>
              <p className="text-[11px] text-muted-foreground">
                يُعيد تصميم الصورة كتصوير استوديو موحّد (خلفية بيضاء + إضاءة + ظلّ) بحفظ المنتج. برومت
                الاستوديو الجاهز مُطبَّق تلقائياً — أضِف تعليمات اختيارية للخلفية/الإطار فقط.
              </p>
              <textarea
                value={aiPromptText}
                onChange={(e) => setAiPromptText(e.target.value)}
                placeholder="تعليمات إضافية اختيارية (للخلفية/الإطار فقط) — مثلاً: أظهر المنتج من الأمام على أرضية بيضاء ناعمة"
                rows={2}
                maxLength={2000}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <Button type="button" size="sm" onClick={runAiStudio} disabled={busy} className="bg-violet-600 hover:bg-violet-700 text-white">
                <Wand2 aria-hidden className="size-4" />
                {busy ? "جارٍ الإنشاء…" : "إنشاء استوديو بالذكاء الاصطناعي"}
              </Button>
            </div>
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
          {aiInPreview && (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5 text-xs text-amber-700 dark:text-amber-400">
              <Info aria-hidden className="size-4 shrink-0 mt-0.5" />
              <span>
                صورة مُولَّدة بالذكاء الاصطناعي. راجِع تطابق تفاصيل المنتج وكتابته (الأرقام/الحروف) مع الأصل قبل
                الاعتماد — قد يغيّر الذكاء الاصطناعي تفاصيل دقيقة. <b>الأصل محفوظ ولا يُستبدَل إلا باعتمادك.</b>
              </span>
            </div>
          )}
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
                  {p.sizeKB}KB · {modeLabel(p.mode)}
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
