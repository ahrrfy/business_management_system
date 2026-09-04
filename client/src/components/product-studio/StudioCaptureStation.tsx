import { BarcodeSearchCue, barcodeSearchInputClass } from "@/components/scan/BarcodeSearchCue";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useBarcodeInput } from "@/hooks/useBarcodeInput";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { Camera, CheckCircle2, Loader2, ScanLine } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { StudioUnknownBarcodeResolver } from "./StudioUnknownBarcodeResolver";
import { isUnknownStudioBarcodeFailure, shouldSubmitManualBarcode } from "./studioUnknownBarcode";

const CameraScanner = lazy(() => import("@/components/scan/CameraScanner").then((module) => ({ default: module.CameraScanner })));

export interface ClaimedStudioProduct {
  taskId: number;
  productName: string;
  revision: number;
  approvedImages: number;
  requiredImages: number;
}

/**
 * محطّة التصوير — أوّل ما يراه المصوّر ونقطةُ بدء كل دورة عمل.
 *
 * **لماذا شاشةٌ مستقلّة:** لوحة الاستوديو مبنيّة حول «مهمّة يديرها مدير» — تبويبات
 * ومرشّحات وطوابير. والمصوّر لا يحتاج شيئاً من ذلك: يمسك المنتج بيده، يمسح باركوده،
 * يصوّر، يرفع. كل ما بينهما عائق. هنا الباركود أوّلاً وآخراً: بعد كل رفعٍ يعود
 * التركيز إلى الحقل جاهزاً للمنتج التالي، فتصير الدورة مسحاً وتصويراً بلا تنقّل.
 *
 * المسح يسحب المنتج إلى يد الماسح ذرّياً — ويُنشئ العمل فوراً إن كان ضمن حملةٍ نشطة
 * ولمّا يُولَّد طابورها، فلا يقف المصوّر بانتظار المدير.
 */
export function StudioCaptureStation({
  active,
  onClaimed,
  onClear,
  offline,
}: {
  active: ClaimedStudioProduct | null;
  onClaimed: (claimed: ClaimedStudioProduct) => void;
  onClear: () => void;
  offline: boolean;
}) {
  const [code, setCode] = useState("");
  const [scanError, setScanError] = useState("");
  const [linkAllowed, setLinkAllowed] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const claim = trpc.productStudio.claimByBarcode.useMutation({
    onSuccess: (result) => {
      setCode("");
      setScanError("");
      setLinkAllowed(false);
      onClaimed({
        taskId: result.taskId,
        productName: result.productName,
        revision: result.revision,
        approvedImages: result.approvedImages,
        requiredImages: result.requiredImages,
      });
      notify.ok(result.claimed ? `فُتح «${result.productName}» للتصوير` : `«${result.productName}» بين يديك أصلاً`);
    },
    onError: (error, variables) => {
      // أبقِ الرمز مرئياً كي يستطيع المصوّر والمدير مراجعته/نسخه وربطه، ولا نحوله
      // إلى لغز يختفي لحظة ظهور رسالة «لا يطابق».
      setCode(variables.barcode);
      setScanError(error.message);
      setLinkAllowed(isUnknownStudioBarcodeFailure(error.data?.code, error.message));
      notify.err(error);
      inputRef.current?.focus();
    },
  });

  const submitCode = (value: string) => {
    if (!value.trim() || claim.isPending || offline) return;
    // أبقِ القيمة الأصلية في الحقل؛ حدّ API وحده يطبّع الأطراف، أما مسافتا Code39
    // الداخليتان (مثل "1  0095") فتبقيان حرفين معنويين طوال التدفق.
    setCode(value);
    setScanError("");
    setLinkAllowed(false);
    claim.mutate({ barcode: value });
  };

  // ⚠️ `useBarcodeInput` يُعيد مُعالِجاً يُركَّب على الحقل — لا يُثبّت مستمعاً عامّاً.
  // إهمالُ قيمته كان يجعل الماسح السلكيّ بلا أثر إطلاقاً، خلافاً لما زعمتُه هنا سابقاً.
  const barcodeInput = useBarcodeInput((scanned) => submitCode(scanned), { enabled: !offline && !claim.isPending });

  // بعد كل إفراغٍ للمنتج يعود التركيز للحقل: الدورة التالية تبدأ بلا لمس الشاشة.
  useEffect(() => {
    if (!active) inputRef.current?.focus();
  }, [active]);

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-56 flex-1 space-y-1.5">
            <Label htmlFor="studio-capture-barcode" className="flex items-center gap-2">
              <ScanLine aria-hidden className="size-4" /> امسح باركود المنتج لبدء التصوير
            </Label>
            <div className="relative">
              <Input
                id="studio-capture-barcode"
                ref={inputRef}
                className={barcodeSearchInputClass}
                value={code}
                inputMode="text"
                autoComplete="off"
                disabled={offline || claim.isPending}
                placeholder="وجّه الماسح أو اكتب الباركود ثم Enter"
                onChange={(event) => {
                  setCode(event.target.value);
                  setScanError("");
                  setLinkAllowed(false);
                }}
                onKeyDown={(event) => {
                  barcodeInput.handleKeyDown(event, setCode);
                  // قارئ HID السريع يستهلك Enter ويستدعي submitCode من الـhook؛ لا نرسل
                  // قيمة state القديمة مرّةً ثانيةً بعده.
                  if (shouldSubmitManualBarcode(event.key, event.defaultPrevented)) {
                    event.preventDefault();
                    submitCode(code);
                  }
                }}
              />
              <BarcodeSearchCue />
            </div>
            {scanError && (
              <StudioUnknownBarcodeResolver
                barcode={code}
                error={scanError}
                linkAllowed={linkAllowed}
                onLinked={submitCode}
              />
            )}
          </div>
          <Button type="button" variant="outline" className="min-h-11" disabled={offline || claim.isPending} onClick={() => setCameraOpen(true)}>
            <Camera aria-hidden className="size-4" /> الكاميرا
          </Button>
          {claim.isPending && <Loader2 aria-hidden className="mb-2 size-5 animate-spin" />}
        </div>

        {active ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-3">
            <div className="min-w-0 text-sm">
              <p className="font-medium">{active.productName}</p>
              {/* التوجيه الإداريّ مرئيّ للمصوّر لا مضمرٌ في إعدادات الحملة. */}
              <p className="text-xs text-muted-foreground">
                الصورة {Math.min(active.approvedImages + 1, active.requiredImages)} من {active.requiredImages} المطلوبة
                {active.approvedImages > 0 ? ` · اعتُمدت ${active.approvedImages}` : ""}
              </p>
            </div>
            <Button type="button" variant="ghost" className="min-h-11" onClick={onClear}>
              إغلاق والانتقال لمنتج آخر
            </Button>
          </div>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 aria-hidden className="size-4" /> جاهز. امسح الباركود ليُفتح المنتج التالي.
          </p>
        )}
      </CardContent>

      {cameraOpen && (
        <Suspense fallback={null}>
          {/* keepOpen: عشرةُ منتجاتٍ = عشرة إعادات فتحٍ للكاميرا — سياقٌ يقاطع دورة المصوّر
              (طلبُ الإذن أوّل مرّة، ثمّ ثوانٍ لبدء الإطار، ثمّ إغلاقٌ فوريّ). الآن تبقى مفتوحةً
              مع تبريدٍ يمنع إعادة قراءة الباركود ذاته، ويُغلقها المصوّر يدوياً عند الفراغ. */}
          <CameraScanner
            open
            keepOpen
            onClose={() => setCameraOpen(false)}
            onDetect={(barcode) => {
              submitCode(barcode);
            }}
          />
        </Suspense>
      )}
    </Card>
  );
}
