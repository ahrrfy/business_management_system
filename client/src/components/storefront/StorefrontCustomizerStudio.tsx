import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  Type,
  Image as ImageIcon,
  Download,
  Sparkles,
  RefreshCw,
  Eye,
  Sliders,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

interface StorefrontCustomizerStudioProps {
  productName: string;
  baseImageUrl?: string | null;
  onApplyCustomization?: (data: {
    customText: string;
    fontFamily: string;
    textColor: string;
    hasLogo: boolean;
    previewDataUrl?: string;
  }) => void;
  className?: string;
}

const ARABIC_FONTS = [
  { id: "cairo", name: "خط الرؤية المعاصر", css: "'Cairo', 'Segoe UI', Tahoma, sans-serif" },
  { id: "tajawal", name: "خط تجوال الأنيق", css: "'Tajawal', 'Segoe UI', Tahoma, sans-serif" },
  { id: "amiri", name: "خط أميري الكلاسيكي", css: "'Amiri', serif" },
  { id: "scheherazade", name: "خط النسخ الشريف", css: "'Scheherazade New', 'Amiri', serif" },
];

const PRESET_COLORS = [
  { id: "gold", name: "ذهبي ملكي", hex: "#D4AF37" },
  { id: "silver", name: "فضي مصقول", hex: "#E2E8F0" },
  { id: "black", name: "أسود داكن", hex: "#0F172A" },
  { id: "white", name: "أبيض ناصع", hex: "#FFFFFF" },
  { id: "navy", name: "كحلي فاخر", hex: "#1E3A8A" },
  { id: "emerald", name: "أخضر زمردي", hex: "#0E806A" },
];

export function StorefrontCustomizerStudio({
  productName,
  baseImageUrl,
  onApplyCustomization,
  className = "",
}: StorefrontCustomizerStudioProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [customText, setCustomText] = useState("");
  const [secondaryText, setSecondaryText] = useState("");
  const [selectedFont, setSelectedFont] = useState(ARABIC_FONTS[0].id);
  const [selectedColor, setSelectedColor] = useState(PRESET_COLORS[0].hex);
  const [fontSize, setFontSize] = useState(36);
  const [verticalPosition, setVerticalPosition] = useState(55); // percentage
  const [logoImage, setLogoImage] = useState<HTMLImageElement | null>(null);
  const [logoPreviewUrl, setLogoPreviewUrl] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);

  // Handle uploaded logo
  const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        setLogoImage(img);
        setLogoPreviewUrl(event.target?.result as string);
      };
      img.src = event.target?.result as string;
    };
    reader.readAsDataURL(file);
  };

  const removeLogo = () => {
    setLogoImage(null);
    setLogoPreviewUrl(null);
  };

  // Render on Canvas
  const redrawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = 600;
    const height = 480;
    canvas.width = width;
    canvas.height = height;

    // Draw background or placeholder
    ctx.clearRect(0, 0, width, height);

    const renderMockup = (bgImg?: HTMLImageElement) => {
      if (bgImg) {
        // Draw background image scaled nicely
        const hRatio = width / bgImg.width;
        const vRatio = height / bgImg.height;
        const ratio = Math.min(hRatio, vRatio);
        const centerShiftX = (width - bgImg.width * ratio) / 2;
        const centerShiftY = (height - bgImg.height * ratio) / 2;
        ctx.fillStyle = "#F8FAFC";
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(
          bgImg,
          0,
          0,
          bgImg.width,
          bgImg.height,
          centerShiftX,
          centerShiftY,
          bgImg.width * ratio,
          bgImg.height * ratio
        );
      } else {
        // High-end stylized gradient mockup canvas
        const gradient = ctx.createLinearGradient(0, 0, width, height);
        gradient.addColorStop(0, "#1E293B");
        gradient.addColorStop(0.5, "#0F172A");
        gradient.addColorStop(1, "#020617");
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width, height);

        // Elegant framing grid lines
        ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
        ctx.lineWidth = 1;
        ctx.strokeRect(20, 20, width - 40, height - 40);

        // Mockup badge frame
        ctx.strokeStyle = "rgba(212, 175, 55, 0.35)";
        ctx.lineWidth = 2;
        ctx.strokeRect(35, 35, width - 70, height - 70);

        // Watermark subtle product name
        ctx.font = "bold 14px 'Cairo', sans-serif";
        ctx.fillStyle = "rgba(255, 255, 255, 0.25)";
        ctx.textAlign = "center";
        ctx.fillText(productName, width / 2, 60);
      }

      // Draw subtle shadow behind text
      const posY = (height * verticalPosition) / 100;

      // Draw Logo if uploaded
      if (logoImage) {
        const logoMaxDim = 80;
        const logoScale = Math.min(logoMaxDim / logoImage.width, logoMaxDim / logoImage.height);
        const logoW = logoImage.width * logoScale;
        const logoH = logoImage.height * logoScale;
        const logoX = width / 2 - logoW / 2;
        const logoY = posY - 70 - logoH / 2;

        ctx.save();
        ctx.shadowColor = "rgba(0,0,0,0.35)";
        ctx.shadowBlur = 8;
        ctx.drawImage(logoImage, logoX, logoY, logoW, logoH);
        ctx.restore();
      }

      // Font selection
      const fontObj = ARABIC_FONTS.find((f) => f.id === selectedFont) ?? ARABIC_FONTS[0];

      // Draw Primary Custom Text
      if (customText.trim()) {
        ctx.save();
        ctx.font = `bold ${fontSize}px ${fontObj.css}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        // Text shadow for realism
        ctx.shadowColor = "rgba(0, 0, 0, 0.4)";
        ctx.shadowBlur = 6;
        ctx.shadowOffsetX = 1;
        ctx.shadowOffsetY = 2;

        ctx.fillStyle = selectedColor;
        ctx.fillText(customText.trim(), width / 2, posY);
        ctx.restore();
      } else {
        // Placeholder text
        ctx.save();
        ctx.font = `italic 24px ${fontObj.css}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
        ctx.fillText("اكتب اسمك أو عبارة التخصيص هنا للمعاينة", width / 2, posY);
        ctx.restore();
      }

      // Draw Secondary Text (Subtitle or phone/role)
      if (secondaryText.trim()) {
        ctx.save();
        ctx.font = `bold ${Math.round(fontSize * 0.55)}px ${fontObj.css}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.shadowColor = "rgba(0, 0, 0, 0.3)";
        ctx.shadowBlur = 4;
        ctx.fillStyle = selectedColor === "#FFFFFF" ? "#CBD5E1" : selectedColor;
        ctx.fillText(secondaryText.trim(), width / 2, posY + fontSize * 0.9);
        ctx.restore();
      }

      // Live Watermark in corner
      ctx.font = "bold 11px sans-serif";
      ctx.textAlign = "right";
      ctx.fillStyle = "rgba(255, 255, 255, 0.5)";
      ctx.fillText("معاينة حية — استوديو الرؤية العربية", width - 25, height - 20);
    };

    if (baseImageUrl) {
      const bg = new Image();
      bg.crossOrigin = "anonymous";
      bg.onload = () => {
        setImageLoaded(true);
        renderMockup(bg);
      };
      bg.onerror = () => {
        renderMockup();
      };
      bg.src = baseImageUrl;
    } else {
      renderMockup();
    }
  }, [
    baseImageUrl,
    customText,
    secondaryText,
    selectedFont,
    selectedColor,
    fontSize,
    verticalPosition,
    logoImage,
    productName,
  ]);

  useEffect(() => {
    redrawCanvas();
  }, [redrawCanvas]);

  const downloadProof = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const link = document.createElement("a");
    link.download = `proof-${productName.replace(/\s+/g, "_")}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  };

  const handleApply = () => {
    const canvas = canvasRef.current;
    const previewDataUrl = canvas ? canvas.toDataURL("image/png") : undefined;
    if (onApplyCustomization) {
      onApplyCustomization({
        customText,
        fontFamily: selectedFont,
        textColor: selectedColor,
        hasLogo: Boolean(logoImage),
        previewDataUrl,
      });
    }
    setApplied(true);
    setTimeout(() => setApplied(false), 3000);
  };

  return (
    <div
      className={`rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900 ${className}`}
    >
      <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between border-b border-slate-100 pb-3 dark:border-slate-800">
        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 dark:bg-amber-500/20 dark:text-amber-400">
            <Sparkles className="size-4" />
          </div>
          <div>
            <h4 className="text-xs font-black text-slate-900 dark:text-slate-100">
              استوديو المعاينة الحية للطباعة والتخصيص
            </h4>
            <p className="text-[10px] font-bold text-slate-500 dark:text-slate-400">
              شاهد اسمك وشعارك فورياً على المنتج قبل الإضافة للسلة
            </p>
          </div>
        </div>

        <Badge variant="outline" className="text-[10px] font-black self-start">
          تفاعل لحظي في المتصفح
        </Badge>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        {/* Canvas Display Viewport */}
        <div className="lg:col-span-7 flex flex-col items-center justify-center">
          <div className="relative w-full overflow-hidden rounded-xl border border-slate-200 bg-slate-950 shadow-inner dark:border-slate-800">
            <canvas
              ref={canvasRef}
              className="w-full h-auto max-h-[360px] object-contain block mx-auto"
            />
          </div>

          <div className="mt-3 flex w-full items-center justify-between gap-2">
            <button
              type="button"
              onClick={downloadProof}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-black text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
            >
              <Download className="size-3.5" />
              <span>تنزيل بروفة التصميم (PNG)</span>
            </button>

            <button
              type="button"
              onClick={redrawCanvas}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
              title="إعادة تحديث المعاينة"
            >
              <RefreshCw className="size-3.5" />
            </button>
          </div>
        </div>

        {/* Customization Controls */}
        <div className="lg:col-span-5 flex flex-col gap-3.5 text-right">
          <div>
            <Label htmlFor="custom-text-input" className="text-xs font-black text-slate-700 dark:text-slate-300">
              نص التخصيص أو الاسم الرئيسي
            </Label>
            <Input
              id="custom-text-input"
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
              placeholder="مثال: د. أحمد الهاشمي أو شركة الرؤية"
              maxLength={60}
              className="mt-1 text-xs font-bold"
            />
          </div>

          <div>
            <Label htmlFor="secondary-text-input" className="text-xs font-bold text-slate-600 dark:text-slate-400">
              السطر الثانوي أو الصفة (اختياري)
            </Label>
            <Input
              id="secondary-text-input"
              value={secondaryText}
              onChange={(e) => setSecondaryText(e.target.value)}
              placeholder="مثال: المدير التنفيذي / بغداد"
              maxLength={60}
              className="mt-1 text-xs"
            />
          </div>

          {/* Font Selection */}
          <div>
            <Label className="text-xs font-bold text-slate-700 dark:text-slate-300">
              نوع الخط العربي
            </Label>
            <div className="mt-1.5 grid grid-cols-2 gap-1.5">
              {ARABIC_FONTS.map((font) => (
                <button
                  key={font.id}
                  type="button"
                  onClick={() => setSelectedFont(font.id)}
                  className={`rounded-lg border px-2 py-1.5 text-right text-[11px] font-black transition ${
                    selectedFont === font.id
                      ? "border-blue-600 bg-blue-50 text-blue-700 dark:border-blue-500 dark:bg-blue-950/60 dark:text-blue-300"
                      : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
                  }`}
                >
                  {font.name}
                </button>
              ))}
            </div>
          </div>

          {/* Color Selection */}
          <div>
            <Label className="text-xs font-bold text-slate-700 dark:text-slate-300">
              لون الطباعة / النقش
            </Label>
            <div className="mt-1.5 flex items-center gap-2">
              {PRESET_COLORS.map((color) => (
                <button
                  key={color.id}
                  type="button"
                  onClick={() => setSelectedColor(color.hex)}
                  title={color.name}
                  aria-label={color.name}
                  className={`size-7 rounded-full border-2 transition ${
                    selectedColor === color.hex
                      ? "ring-2 ring-blue-600 ring-offset-2 scale-110"
                      : "hover:scale-105"
                  } ${color.id === "white" ? "border-slate-300" : "border-transparent"}`}
                  style={{ backgroundColor: color.hex }}
                />
              ))}
            </div>
          </div>

          {/* Logo Upload */}
          <div>
            <Label className="text-xs font-bold text-slate-700 dark:text-slate-300">
              رفع شعار الشركة (Logo)
            </Label>
            <div className="mt-1 flex items-center gap-2">
              <label className="cursor-pointer inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
                <ImageIcon className="size-3.5" />
                <span>اختر ملف الشعار</span>
                <input
                  type="file"
                  accept="image/png, image/jpeg, image/svg+xml"
                  onChange={handleLogoUpload}
                  className="sr-only"
                />
              </label>

              {logoPreviewUrl && (
                <button
                  type="button"
                  onClick={removeLogo}
                  className="rounded-lg text-xs font-bold text-rose-600 hover:underline"
                >
                  إزالة الشعار
                </button>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="mt-2 border-t border-slate-100 pt-3 dark:border-slate-800">
            <Button
              type="button"
              onClick={handleApply}
              className="w-full text-xs font-black bg-blue-600 hover:bg-blue-700 text-white gap-2"
            >
              {applied ? (
                <>
                  <CheckCircle2 className="size-4" />
                  <span>تم اعتماد بيانات البروفة للطلب!</span>
                </>
              ) : (
                <>
                  <Eye className="size-4" />
                  <span>اعتماد بروفة التخصيص وإرفاقها</span>
                </>
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
