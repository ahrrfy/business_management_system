import { ArrowLeft, Check, Info, Sparkles, Wand2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { ImageUploader, type ImageUploaderProps } from "@/components/form/ImageUploader";
import { Button } from "@/components/ui/button";
import { normalizeAiStudioImage } from "@/lib/imageStudio/aiStudio";
import { applyStudioPreviews } from "@/lib/imageStudio/applyPreviews";
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
 * ImageStudioUploader — يلفّ `ImageUploader` ويضيف تحويل «استوديو» **لكل صورة على حدة**: خلفية بيضاء
 * موحّدة + قالب موحّد + ظلّ تماس، بمعاينة قبل/بعد ثمّ **اعتماد صريح** (الأصل لا يُستبدَل إلا بموافقة).
 *
 * **الاستهداف الفرديّ (إصلاح ٢٣/٧):** الاستوديو كان يعالج **كل** صور المنتج دفعةً واحدة بلا اختيار،
 * فتعذّر تعديل صورةٍ بعينها (اختيار المستخدم بلا أثر، وبدا كأنّه يخلط/يكرّر). الآن: زرّ «استوديو» على
 * كل صورة يستهدفها وحدها، والمعالجة/المعاينة/الاعتماد تسري على **المستهدَف فقط** (بمطابقة المعرّف عبر
 * `applyStudioPreviews`). زرّ «تحديد كل الصور» يُبقي راحة الدفعة لمن أرادها. ⇒ تعديلٌ متعدّدٌ مستقلّ.
 *
 * ثلاثة مسارات (بحسب الإعداد): **FLATTEN** (توسيط على أبيض، دائماً متاح) · **Pro (remove.bg)** (قصّ
 * احترافيّ) · **الذكاء الاصطناعي** (توليديّ يُعيد التصميم — مراجعة بشرية إلزامية والأصل محفوظ).
 * راجع client/src/lib/imageStudio/README.md.
 */
export function ImageStudioUploader(props: ImageUploaderProps) {
  const { value, onChange } = props;
  const [busy, setBusy] = useState(false);
  // الاستهداف: أيّ الصور تُعدَّل الآن. «استوديو» على صورة ⇒ [تلك]، «تحديد الكل» ⇒ كلّها.
  const [targetIds, setTargetIds] = useState<string[]>([]);
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

  // الصور المستهدَفة فعلياً (تقاطع مع القائمة الحالية — تُصان عند حذف صورة).
  const targetSet = new Set(targetIds);
  const targets = value.filter((it) => targetSet.has(it.id));

  // صورة مستهدَفة حُذِفت من القائمة ⇒ نظّف الاستهداف (وأغلق المعاينة إن فرغ).
  useEffect(() => {
    if (!targetIds.length) return;
    const alive = targetIds.filter((id) => value.some((v) => v.id === id));
    if (alive.length !== targetIds.length) {
      setTargetIds(alive);
      if (!alive.length) {
        setPreviews(null);
        setNotice(null);
      }
    }
  }, [value, targetIds]);

  const selectOne = (id: string) => {
    setTargetIds([id]);
    setPreviews(null);
    setError(null);
    setNotice(null);
  };
  const selectAll = () => {
    setTargetIds(value.map((v) => v.id));
    setPreviews(null);
    setError(null);
    setNotice(null);
  };
  const clearTargets = () => {
    setTargetIds([]);
    setPreviews(null);
    setNotice(null);
  };

  const runStudio = async () => {
    if (!targets.length) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    let fellBackMsg = "";
    let lowResPreview = false;
    try {
      const results = await Promise.all(
        targets.map(async (it): Promise<StudioPreview> => {
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
    if (!targets.length) return;
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
      for (const it of targets) {
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
        setNotice(`تعذّر تحويل ${failedCount} من ${targets.length} صورة (${firstErr}).`);
      }
    } catch (e) {
      setError("تعذّر إنشاء استوديو الذكاء الاصطناعي: " + String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const accept = () => {
    if (!previews) return;
    // نطبّق كلّ ناتجٍ على صورته بالمعرّف حصراً (لا خلط/تكرار على غير المستهدَف) — راجع applyStudioPreviews.
    onChange(applyStudioPreviews(value, previews));
    setPreviews(null);
    setNotice(null);
    setTargetIds([]);
  };

  const modeLabel = (m: StudioPreview["mode"]) => (m === "AI" ? "ذكاء اصطناعي" : m === "CUT" ? "قصّ" : "آمن");

  const targetLabel =
    targets.length === 1
      ? `الصورة المحدّدة${targets[0].name ? ` — ${targets[0].name}` : ""}`
      : `${targets.length} صور`;

  return (
    <div className="space-y-3">
      <ImageUploader {...props} onEditImage={selectOne} activeEditIds={targetSet} />

      {value.length > 0 && !previews && (
        <div className="space-y-3">
          {targets.length === 0 ? (
            // لا استهداف بعد: إرشادٌ لاختيار صورة + راحة «تحديد الكل».
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed bg-muted/20 px-3 py-2.5 text-sm text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Sparkles aria-hidden className="size-4 text-violet-500" />
                لتعديل صورةٍ في الاستوديو: مرّر فوقها ثمّ انقر <b className="text-foreground">«استوديو»</b> — لكل صورة تعديلها المستقل.
              </span>
              {value.length > 1 && (
                <Button type="button" variant="outline" size="sm" onClick={selectAll}>
                  تحديد كل الصور
                </Button>
              )}
            </div>
          ) : (
            // صورةٌ (أو أكثر) مستهدَفة: لوحة الاستوديو تعمل عليها وحدها.
            <div className="space-y-3 rounded-md border border-violet-500/30 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-medium">
                  الاستوديو يعمل على: <span className="text-violet-700 dark:text-violet-300">{targetLabel}</span>
                </div>
                <div className="flex items-center gap-2">
                  {value.length > 1 && targets.length < value.length && (
                    <Button type="button" variant="ghost" size="sm" onClick={selectAll}>
                      تحديد الكل
                    </Button>
                  )}
                  <Button type="button" variant="ghost" size="sm" onClick={clearTargets}>
                    <X aria-hidden className="size-4" /> إلغاء التحديد
                  </Button>
                </div>
              </div>

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
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {previews && (
        <div className="space-y-3 rounded-md border p-3">
          <p className="text-sm font-medium">
            معاينة الاستوديو — خلفية بيضاء موحّدة بإطار وظلّ (الأصل يمينًا):
          </p>
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
              <Check aria-hidden className="size-4" /> اعتماد {previews.length > 1 ? "الكل" : ""}
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
