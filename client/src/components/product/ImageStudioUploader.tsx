import { Check, Info, Sparkles, Wand2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  ImageUploader,
  type ImageUploaderProps,
} from "@/components/form/ImageUploader";
import { Button } from "@/components/ui/button";
import { normalizeAiStudioImage } from "@/lib/imageStudio/aiStudio";
import { applyStudioPreviews } from "@/lib/imageStudio/applyPreviews";
import { trpc } from "@/lib/trpc";

interface StudioPreview {
  id: string;
  before: string;
  after: string;
  sizeKB: number;
  /** لا يقبل سير مهمة التصوير إلا نتيجة الذكاء الموثّقة خادمياً. */
  mode: "AI";
  processingReceipt?: string;
}

/**
 * ImageStudioUploader — يلفّ `ImageUploader` ويضيف معالجة ذكاء اصطناعي **لكل صورة على حدة**:
 * استوديو أبيض احترافي مع معاينة أصل/نتيجة ثمّ **اعتماد صريح** (الأصل لا يُستبدَل إلا بموافقة).
 *
 * **الاستهداف الفرديّ (إصلاح ٢٣/٧):** الاستوديو كان يعالج **كل** صور المنتج دفعةً واحدة بلا اختيار،
 * فتعذّر تعديل صورةٍ بعينها (اختيار المستخدم بلا أثر، وبدا كأنّه يخلط/يكرّر). الآن: زرّ «استوديو» على
 * كل صورة يستهدفها وحدها، والمعالجة/المعاينة/الاعتماد تسري على **المستهدَف فقط** (بمطابقة المعرّف عبر
 * `applyStudioPreviews`). زرّ «تحديد كل الصور» يُبقي راحة الدفعة لمن أرادها. ⇒ تعديلٌ متعدّدٌ مستقلّ.
 *
 * عقد مهمة المصوّر مقصودٌ وبسيط: التقط ← عالج بالذكاء ← قارن ← اعتمد ← أرسل. لا نعرض مسارات
 * القص/التوسيط اليدوية هنا كي لا تنزلق النتيجة إلى بديل أقل جودة من خدمة الاستوديو الأساسية.
 */
interface ImageStudioUploaderProps extends ImageUploaderProps {
  onStudioModeChange?: (mode: "AI") => void;
  studioTaskId?: number;
  onProcessingReceiptChange?: (receipt: string | null) => void;
  onBusyChange?: (busy: boolean) => void;
  adminOverrideReason?: string;
  offline?: boolean;
}

export function ImageStudioUploader(props: ImageStudioUploaderProps) {
  const { value, onChange } = props;
  const workflowTaskId = props.studioTaskId;
  const offline = props.offline === true;
  const [busy, setBusy] = useState(false);
  // الاستهداف: أيّ الصور تُعدَّل الآن. «استوديو» على صورة ⇒ [تلك]، «تحديد الكل» ⇒ كلّها.
  const [targetIds, setTargetIds] = useState<string[]>([]);
  const [previews, setPreviews] = useState<StudioPreview[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // رمز التشغيل: يتزايد عند كلّ إعادة استهداف ⇒ نتيجةُ تشغيل AI بطيء أُطلق على هدفٍ سابق
  // تُتجاهَل إن تغيّر الهدف قبل وصولها (وإلّا ظهرت/اعتُمدت معاينةٌ لصورةٍ غير المحدَّدة — سباق Codex P2).
  const runToken = useRef(0);

  const bindProcessingProof =
    trpc.productStudio.bindProcessingProof.useMutation();
  const aiConfig = trpc.imageStudio.aiConfig.useQuery(undefined, {
    enabled: workflowTaskId != null && !offline,
    staleTime: 60_000,
  });
  const aiTransform = trpc.imageStudio.aiStudioTransform.useMutation();
  const aiAvailable = !offline && workflowTaskId != null && aiConfig.data?.aiAvailable === true;
  const aiUnavailableMessage = offline
    ? "المعالجة بالذكاء تحتاج اتصالاً؛ احتفِظ باللقطة ثم أكملها عند عودة الشبكة."
    : workflowTaskId == null
      ? "المعالجة بالذكاء متاحة من مهمة استوديو مسندة فقط."
      : aiConfig.isLoading
        ? "يجري التحقق من جاهزية معالجة الذكاء الاصطناعي…"
        : aiConfig.data?.aiEnabled === false
          ? "معالجة الذكاء الاصطناعي غير مفعّلة. يفعّلها المدير من إعدادات الاستوديو."
          : aiConfig.data?.hasAiKey === false
            ? "مفتاح مزوّد الذكاء الاصطناعي غير مضبوط. راجع إعدادات الاستوديو."
            : aiConfig.data?.cryptoReady === false
              ? "تشفير إعدادات الاستوديو غير جاهز؛ لا يمكن استخدام مفتاح الذكاء بأمان."
              : "معالجة الذكاء الاصطناعي غير متاحة الآن؛ حدّث الصفحة أو راجع إعدادات الاستوديو.";

  useEffect(() => {
    props.onBusyChange?.(busy);
    return () => props.onBusyChange?.(false);
  }, [busy, props.onBusyChange]);

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
    runToken.current++; // يُبطل أيّ تشغيلٍ لهدفٍ سابق ما زال جارياً
    setTargetIds([id]);
    setPreviews(null);
    setError(null);
    setNotice(null);
  };
  const selectAll = () => {
    runToken.current++;
    setTargetIds(value.map((v) => v.id));
    setPreviews(null);
    setError(null);
    setNotice(null);
  };
  const clearTargets = () => {
    runToken.current++;
    setTargetIds([]);
    setPreviews(null);
    setNotice(null);
  };

  const runAiStudio = async () => {
    if (!targets.length || workflowTaskId == null || !aiAvailable) return;
    const myToken = runToken.current; // لقطة الهدف؛ توليد الذكاء الاصطناعي بطيء ⇒ الحارس أهمّ هنا
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      // تسلسليّ لا متوازٍ: httpBatchLink يجمع النداءات المتزامنة في طلبٍ HTTP واحد، فعدّة صور data-URL
      // (~٧٠٠ك لكلٍّ) تتجاوز حدّ جسم 4mb ⇒ 413 قبل بلوغ الراوتر. الإرسال واحداً-تلو-آخر يجعل كلّ صورة
      // طلباً مستقلّاً (والتوليد بطيء أصلاً ⇒ لا فائدة من التوازي). فشلٌ جزئيّ ⇒ نُظهر ما نجح وننبّه.
      const ok: StudioPreview[] = [];
      let firstErr = "";
      let failedCount = 0;
      for (const it of targets) {
        try {
          const res = await aiTransform.mutateAsync({
            imageDataUrl: it.dataUrl,
            taskId: workflowTaskId,
            adminOverrideReason: props.adminOverrideReason,
          });
          const norm = await normalizeAiStudioImage(res.imageDataUrl);
          ok.push({
            id: it.id,
            before: it.dataUrl,
            after: norm.dataUrl,
            sizeKB: Math.round(norm.sizeKB),
            mode: "AI",
            processingReceipt: res.processingReceipt,
          });
        } catch (e) {
          failedCount++;
          if (!firstErr)
            firstErr = String((e as { message?: string })?.message ?? e ?? "");
        }
      }
      if (myToken !== runToken.current) return; // أُعيد الاستهداف أثناء التوليد ⇒ تجاهُل النتيجة القديمة
      if (ok.length === 0) {
        setError("تعذّر إنشاء استوديو الذكاء الاصطناعي: " + firstErr);
        return;
      }
      setPreviews(ok);
      if (failedCount > 0) {
        setNotice(
          `تعذّر تحويل ${failedCount} من ${targets.length} صورة (${firstErr}).`,
        );
      }
    } catch (e) {
      if (myToken === runToken.current)
        setError(
          "تعذّر إنشاء استوديو الذكاء الاصطناعي: " +
            String((e as Error)?.message ?? e),
        );
    } finally {
      setBusy(false);
    }
  };

  const accept = async () => {
    if (!previews) return;
    const providerPreview = previews.find((preview) => preview.processingReceipt);
    setBusy(true);
    setError(null);
    try {
      // لا نبدّل proof الخادمي عند مجرد عرض المعاينة: الإلغاء أو فشل معاينة جديدة يجب ألّا
      // يبطل نتيجةً سبق أن اعتمدها المصوّر. الربط يحدث لحظة الاعتماد فقط وبالبايتات المعروضة.
      if (props.studioTaskId && providerPreview?.processingReceipt) {
        await bindProcessingProof.mutateAsync({
          taskId: props.studioTaskId,
          processingReceipt: providerPreview.processingReceipt,
          candidateDataUrl: providerPreview.after,
          adminOverrideReason: props.adminOverrideReason,
        });
      }
      // نطبّق كلّ ناتجٍ على صورته بالمعرّف حصراً (لا خلط/تكرار على غير المستهدَف) — راجع applyStudioPreviews.
      onChange(applyStudioPreviews(value, previews));
      props.onStudioModeChange?.("AI");
      props.onProcessingReceiptChange?.(providerPreview?.processingReceipt ?? null);
      setPreviews(null);
      setNotice(null);
      setTargetIds([]);
    } catch (e) {
      setError("تعذّر اعتماد معاينة الاستوديو: " + String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const targetLabel =
    targets.length === 1
      ? `الصورة المحدّدة${targets[0].name ? ` — ${targets[0].name}` : ""}`
      : `${targets.length} صور`;

  return (
    <div className="space-y-3">
      <ImageUploader
        {...props}
        onEditImage={selectOne}
        activeEditIds={targetSet}
      />

      {value.length > 0 && !previews && (
        <div className="space-y-3">
          {targets.length === 0 ? (
            // لا استهداف بعد: منتقي صورٍ **ظاهرٌ دائماً** (يعمل باللمس بلا hover — الأجهزة اللوحية، حيث زرّ
            // «استوديو» المخفيّ في طبقة التمرير لا يُدرَك). النقر على مصغّرةٍ يستهدفها. يشمل حالة الصورة الواحدة.
            <div className="space-y-2 rounded-md border border-dashed bg-muted/20 p-3">
              <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Sparkles aria-hidden className="size-4 text-violet-500" />
                اختر صورةً لمعالجتها بالذكاء الاصطناعي — كل صورة تُراجع وحدها.
              </div>
              <div className="flex flex-wrap gap-2">
                {value.map((it) => (
                  <button
                    key={it.id}
                    type="button"
                    onClick={() => selectOne(it.id)}
                    className="size-14 shrink-0 overflow-hidden rounded-md border bg-card transition hover:ring-2 hover:ring-violet-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
                    title={`معالجة ${it.name || "الصورة"} بالذكاء الاصطناعي`}
                    aria-label={`معالجة ${it.name || "الصورة"} بالذكاء الاصطناعي`}
                  >
                    <img
                      src={it.dataUrl || it.url}
                      alt={it.name || "صورة"}
                      className="h-full w-full object-cover"
                    />
                  </button>
                ))}
                {workflowTaskId == null && value.length > 1 && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={selectAll}
                    className="h-14"
                  >
                    تحديد الكل
                  </Button>
                )}
              </div>
            </div>
          ) : (
            // صورةٌ (أو أكثر) مستهدَفة: لوحة الاستوديو تعمل عليها وحدها.
            <div className="space-y-3 rounded-md border border-violet-500/30 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-medium">
                  الاستوديو يعمل على:{" "}
                  <span className="text-violet-700 dark:text-violet-300">
                    {targetLabel}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {workflowTaskId == null && value.length > 1 && targets.length < value.length && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={selectAll}
                    >
                      تحديد الكل
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={clearTargets}
                  >
                    <X aria-hidden className="size-4" /> إلغاء التحديد
                  </Button>
                </div>
              </div>

              <div className="space-y-2 rounded-md border border-violet-500/30 bg-violet-500/[0.03] p-3">
                <div className="flex items-center gap-1.5 text-sm font-medium text-violet-700 dark:text-violet-300">
                  <Wand2 aria-hidden className="size-4" /> معالجة بالذكاء الاصطناعي
                </div>
                <p className="text-[11px] text-muted-foreground">
                  خلفية بيضاء نقيّة، إضاءة ومنتج بارز بظلّ طبيعي، تأطير تسويقي قريب
                  في الوسط، مع حفظ تفاصيل المنتج وكتابته. البرومت الاحترافي يُطبّق
                  تلقائياً ولا يحتاج المصوّر إلى تحريره.
                </p>
                <Button
                  type="button"
                  size="sm"
                  onClick={runAiStudio}
                  disabled={busy || !aiAvailable}
                  className="bg-violet-600 text-white hover:bg-violet-700"
                >
                  <Wand2 aria-hidden className="size-4" />
                  {busy ? "جارٍ إنشاء النتيجة…" : "عالج بالذكاء الاصطناعي"}
                </Button>
                {!aiAvailable && <p role="status" className="text-xs text-muted-foreground">{aiUnavailableMessage}</p>}
              </div>
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
            مقارنة قبل الاعتماد — الأصل الملتقط مقابل نتيجة الذكاء الاصطناعي
          </p>
          <div className="flex items-start gap-2 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-2.5 text-xs text-[var(--sem-warn)]">
            <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span>
              راجِع تطابق تفاصيل المنتج وكتابته (الأرقام والحروف) مع الأصل قبل
              الاعتماد. <b>الأصل محفوظ ولا يُستبدَل إلا باعتمادك.</b>
            </span>
          </div>
          {notice && (
            <p className="text-xs text-[var(--sem-warn)]">
              {notice}
            </p>
          )}
          <div className="grid gap-4">
            {previews.map((p) => (
              <div key={p.id} className="grid gap-3 md:grid-cols-2">
                <figure className="space-y-2 rounded-md border bg-muted/20 p-2">
                  <figcaption className="text-sm font-medium">الصورة الأصلية الملتقطة</figcaption>
                  <img src={p.before} alt="الصورة الأصلية الملتقطة" className="h-64 w-full rounded object-contain sm:h-80" />
                </figure>
                <figure className="space-y-2 rounded-md border border-violet-500/40 bg-white p-2">
                  <figcaption className="text-sm font-medium text-violet-800">نتيجة الذكاء الاصطناعي</figcaption>
                  <img src={p.after} alt="نتيجة معالجة الذكاء الاصطناعي" className="h-64 w-full rounded object-contain sm:h-80" />
                  <p className="text-xs text-muted-foreground">{p.sizeKB}KB · نسخة خفيفة للعرض السريع</p>
                </figure>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={busy || bindProcessingProof.isPending} onClick={() => void accept()}>
              <Check aria-hidden className="size-4" /> اعتماد{" "}
              {previews.length > 1 ? "الكل" : ""}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy || bindProcessingProof.isPending}
              onClick={() => {
                setPreviews(null);
                setNotice(null);
              }}
            >
              <X aria-hidden className="size-4" /> إلغاء
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
