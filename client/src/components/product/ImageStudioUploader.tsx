import { ArrowLeft, Check, Layers, Sparkles, SunMedium, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  ImageUploader,
  type ImageUploaderProps,
} from "@/components/form/ImageUploader";
import { Button } from "@/components/ui/button";
import { applyStudioPreviews } from "@/lib/imageStudio/applyPreviews";
import {
  finishCutFromCutout,
  runFreeStudio,
  type StudioPreset,
  type StudioResult,
} from "@/lib/imageStudio/freePipeline";
import { trpc } from "@/lib/trpc";

interface StudioPreview {
  id: string;
  before: string;
  after: string;
  sizeKB: number;
  mode: StudioResult["mode"];
  processingReceipt?: string;
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
 * مساران فقط: **FLATTEN** (توسيط على أبيض، دائماً متاح) و**Pro (remove.bg)** (قصّ احترافيّ).
 * لا يولّد الاستوديو صوراً بالذكاء الاصطناعي كي تبقى هوية المنتج وتفاصيله الفعلية كما صوّرها المصوّر.
 * راجع client/src/lib/imageStudio/README.md.
 */
interface ImageStudioUploaderProps extends ImageUploaderProps {
  onStudioModeChange?: (mode: "FLATTEN" | "CUT") => void;
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
  const [preset, setPreset] = useState<StudioPreset>("PURE_WHITE");
  // رمز التشغيل: يتزايد عند كلّ إعادة استهداف ⇒ نتيجةُ تشغيلٍ بطيء أُطلق على هدفٍ سابق
  // تُتجاهَل إن تغيّر الهدف قبل وصولها (وإلّا ظهرت/اعتُمدت معاينةٌ لصورةٍ غير المحدَّدة — سباق Codex P2).
  const runToken = useRef(0);

  const proConfig = trpc.imageStudio.proConfig.useQuery(undefined, {
    enabled: workflowTaskId != null && !offline,
    staleTime: 60_000,
  });
  const proCutout = trpc.imageStudio.proCutout.useMutation();
  const bindProcessingProof =
    trpc.productStudio.bindProcessingProof.useMutation();
  const proAvailable =
    !offline &&
    workflowTaskId != null &&
    (proConfig.data?.proAvailable ?? false);

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

  const runStudio = async () => {
    if (!targets.length) return;
    const myToken = runToken.current; // لقطة الهدف؛ إن تغيّر قبل الوصول تُهمَل النتيجة
    setBusy(true);
    setError(null);
    setNotice(null);
    let fellBackMsg = "";
    let lowResPreview = false;
    try {
      // تسلسليّ لا متوازٍ كي لا يجمع httpBatchLink صور data-URL كبيرة في طلب واحد.
      // httpBatchLink يجمع النداءات المتزامنة في طلبٍ HTTP واحد، فعدّة صور data-URL
      // (~٧٠٠ك لكلٍّ) تتجاوز حدّ جسم 4mb ⇒ 413 قبل بلوغ الراوتر، برسالةٍ لا يفهمها المستخدم.
      // ولا فائدة من التوازي أصلاً: للمزوّد فتحتا تنفيذ تقنيتان. التسلسل يُخلي الخيط بين الصور.
      const processOne = async (it: (typeof targets)[number]): Promise<StudioPreview> => {
        let r: StudioResult;
        let processingReceipt: string | undefined;
        if (proAvailable) {
          try {
            const res = await proCutout.mutateAsync({
              imageDataUrl: it.dataUrl,
              taskId: workflowTaskId!,
              adminOverrideReason: props.adminOverrideReason,
            });
            // نثق بقصّ remove.bg دائماً (خدمة مدفوعة) — لا نُخضعه لحدس FLATTEN-عند-الشكّ.
            r = await finishCutFromCutout(res.cutoutDataUrl, it.dataUrl, {
              trustCutout: true,
              preset,
            });
            processingReceipt = res.processingReceipt;
            if (res.isPreview) lowResPreview = true; // مفتاح مجاني ⇒ نتيجة معاينة منخفضة الدقّة.
          } catch (e) {
            // فشل Pro (مفتاح خاطئ/صورة غير صالحة/تعطّل) ⇒ تدهور آمن لـFLATTEN بلا كسر التجربة.
            fellBackMsg = String((e as { message?: string })?.message ?? "");
            r = await runFreeStudio(it.dataUrl, { safeOnly: false, preset });
          }
        } else {
          r = await runFreeStudio(it.dataUrl, { safeOnly: false, preset });
        }
        return {
          id: it.id,
          before: it.dataUrl,
          after: r.dataUrl,
          sizeKB: Math.round(r.sizeKB),
          mode: r.mode,
          processingReceipt,
        };
      };

      const results: StudioPreview[] = [];
      for (const it of targets) {
        results.push(await processOne(it));
        if (myToken !== runToken.current) return; // أُعيد الاستهداف ⇒ توقّف فوراً بلا إتمام الباقي
        // إخلاء الخيط بين الصور كي تبقى الصفحة مستجيبة أثناء دفعةٍ طويلة.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (myToken !== runToken.current) return; // أُعيد الاستهداف أثناء المعالجة ⇒ تجاهُل نتيجةٍ لهدفٍ قديم
      setPreviews(results);
      if (fellBackMsg)
        setNotice(
          `تعذّر القصّ الاحترافي (${fellBackMsg}) — استُعمل المسار المجاني الآمن.`,
        );
      else if (lowResPreview)
        setNotice(
          "قُصّت الخلفية بدقّة معاينة منخفضة (الباقة المجانيّة). للنتيجة الاحترافيّة كاملة الدقّة، اشحن رصيد remove.bg.",
        );
    } catch (e) {
      if (myToken === runToken.current)
        setError(
          "تعذّرت معالجة الاستوديو: " + String((e as Error)?.message ?? e),
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
      const acceptedMode = previews.some((preview) => preview.mode === "CUT") ? "CUT" : "FLATTEN";
      props.onStudioModeChange?.(acceptedMode);
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

  const modeLabel = (m: StudioPreview["mode"]) => m === "CUT" ? "قصّ" : "آمن";

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
                اختر صورةً لتعديلها في الاستوديو — لكل صورة تعديلها المستقل.
              </div>
              <div className="flex flex-wrap gap-2">
                {value.map((it) => (
                  <button
                    key={it.id}
                    type="button"
                    onClick={() => selectOne(it.id)}
                    className="size-14 shrink-0 overflow-hidden rounded-md border bg-card transition hover:ring-2 hover:ring-violet-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
                    title={`تعديل ${it.name || "الصورة"} في الاستوديو`}
                    aria-label={`تعديل ${it.name || "الصورة"} في الاستوديو`}
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

              {/* نمط الاستوديو */}
              <div className="space-y-1.5">
                <div className="text-xs font-medium text-muted-foreground">
                  نمط الاستوديو المعياري:
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Button
                    type="button"
                    size="sm"
                    variant={preset === "PURE_WHITE" ? "default" : "outline"}
                    className="h-8 text-xs gap-1.5"
                    onClick={() => setPreset("PURE_WHITE")}
                  >
                    <SunMedium aria-hidden className="size-3.5" />
                    أبيض استوديو نقي
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={preset === "LUXURY_MIRROR" ? "default" : "outline"}
                    className="h-8 text-xs gap-1.5"
                    onClick={() => setPreset("LUXURY_MIRROR")}
                  >
                    <Layers aria-hidden className="size-3.5" />
                    مرآة فاخرة وانعكاس
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={preset === "VIBRANT_COMMERCIAL" ? "default" : "outline"}
                    className="h-8 text-xs gap-1.5"
                    onClick={() => setPreset("VIBRANT_COMMERCIAL")}
                  >
                    <Sparkles aria-hidden className="size-3.5" />
                    ألوان تجارية حيوية
                  </Button>
                </div>
              </div>

              {/* المعالجة تحافظ على الصورة الحقيقية ولا تنشئ بديلاً توليدياً. */}
              <div className="space-y-2 pt-1">
                <div className="space-y-1">
                  <Button type="button" variant="outline" size="sm" onClick={runStudio} disabled={busy}>
                    <Sparkles aria-hidden className="size-4" />
                    {busy ? "جارٍ التحويل…" : proAvailable ? "قصّ الخلفية (استوديو احترافي)" : "توسيط وظل استوديو على أبيض"}
                  </Button>
                  {!proAvailable && (
                    <p className="text-[11px] text-muted-foreground">
                      المسار المجاني يوسّط الصورة على خلفية بيضاء نقية مع ظل احترافي. لإزالة الخلفيات المعقدة بدقة متقدمة فعّل remove.bg من الإعدادات.
                    </p>
                  )}
                </div>
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
            معاينة الاستوديو — خلفية بيضاء موحّدة بإطار وظلّ (الأصل يمينًا):
          </p>
          {notice && (
            <p className="text-xs text-[var(--sem-warn)]">
              {notice}
            </p>
          )}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {previews.map((p) => (
              <div key={p.id} className="space-y-1 text-center">
                <div className="flex items-center justify-center gap-1">
                  <img
                    src={p.after}
                    alt="بعد"
                    className="size-16 rounded border object-contain"
                    style={{ background: "#ffffff" }}
                  />
                  <ArrowLeft
                    aria-hidden
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                  <img
                    src={p.before}
                    alt="قبل"
                    className="size-16 rounded border bg-muted object-contain"
                  />
                </div>
                <span className="text-xs text-muted-foreground">
                  {p.sizeKB}KB · {modeLabel(p.mode)}
                </span>
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
