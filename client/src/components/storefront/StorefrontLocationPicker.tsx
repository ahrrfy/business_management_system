import { useState } from "react";
import { MapPin, Check, X, Loader2 } from "lucide-react";

export function parseCoordinatesOrUrl(input: string): { lat: number; lng: number } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Format: "33.315, 44.366" or "33.315 44.366"
  const coordsMatch = trimmed.match(/^([+-]?\d+(?:\.\d+)?)(?:,\s*|\s+)([+-]?\d+(?:\.\d+)?)$/);
  if (coordsMatch) {
    const lat = Number(coordsMatch[1]);
    const lng = Number(coordsMatch[2]);
    if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
      return { lat, lng };
    }
  }
  // Format: https://maps.google.com/?q=33.315,44.366
  try {
    const url = new URL(trimmed);
    const q = url.searchParams.get("q") || url.searchParams.get("ll");
    if (q) {
      const parts = q.split(",");
      if (parts.length >= 2) {
        const lat = Number(parts[0]);
        const lng = Number(parts[1]);
        if (!Number.isNaN(lat) && !Number.isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
          return { lat, lng };
        }
      }
    }
    // Format: @33.315,44.366
    const path = url.pathname;
    const atMatch = path.match(/@([+-]?\d+(?:\.\d+)?),([+-]?\d+(?:\.\d+)?)/);
    if (atMatch) {
      const lat = Number(atMatch[1]);
      const lng = Number(atMatch[2]);
      if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
        return { lat, lng };
      }
    }
  } catch (e) {
    // Ignore URL parse errors
  }
  return null;
}

interface StorefrontLocationPickerProps {
  latitude: number | null;
  longitude: number | null;
  onChange: (coords: { latitude: number | null; longitude: number | null }) => void;
  disabled?: boolean;
}

export function StorefrontLocationPicker({ latitude, longitude, onChange, disabled }: StorefrontLocationPickerProps) {
  const [showMapModal, setShowMapModal] = useState(false);
  const [manualMapUrl, setManualMapUrl] = useState("");
  const [locating, setLocating] = useState(false);
  const [locationFeedback, setLocationFeedback] = useState<string | null>(null);

  const handleGetGpsLocation = () => {
    if (disabled) return;
    if (typeof window === "undefined" || !navigator.geolocation) {
      setLocationFeedback("المتصفح لا يدعم تحديد الموقع الجغرافي");
      return;
    }
    setLocating(true);
    setLocationFeedback(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        const lat = Number(pos.coords.latitude.toFixed(6));
        const lng = Number(pos.coords.longitude.toFixed(6));
        onChange({ latitude: lat, longitude: lng });
        setLocationFeedback("تم التقاط موقعك الجغرافي بنجاح");
      },
      () => {
        setLocating(false);
        setLocationFeedback("تعذر الوصول للموقع. يرجى تفعيل إذن الموقع أو إدخاله يدوياً.");
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  const handleApplyManualLocation = () => {
    if (disabled) return;
    const coords = parseCoordinatesOrUrl(manualMapUrl);
    if (coords) {
      onChange({ latitude: coords.lat, longitude: coords.lng });
      setShowMapModal(false);
      setManualMapUrl("");
      setLocationFeedback("تم تثبيت الموقع بنجاح");
    } else {
      setLocationFeedback("الرابط أو الإحداثيات غير صحيحة. تأكد من صحة الرابط أو الأرقام.");
    }
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-[#fbfdfc] p-3 text-xs dark:border-slate-800 dark:bg-slate-900/50">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 font-extrabold text-slate-800 dark:text-slate-200">
          <MapPin className="size-4 text-emerald-600" />
          موقع التوصيل على الخريطة
        </span>
        {latitude && longitude && (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-bold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
            <Check className="size-3" />
            محدد بدقة
          </span>
        )}
      </div>

      {latitude && longitude ? (
        <div className="space-y-2 rounded-xl border border-emerald-300 bg-emerald-50/80 p-2.5 dark:border-emerald-800 dark:bg-emerald-950/40">
          <div className="flex items-center justify-between text-[11px]">
            <span className="font-bold text-emerald-900 dark:text-emerald-200" dir="ltr">
              GPS: {latitude}, {longitude}
            </span>
            <button
              type="button"
              onClick={() => {
                if (disabled) return;
                onChange({ latitude: null, longitude: null });
                setLocationFeedback(null);
              }}
              disabled={disabled}
              className="font-bold text-red-600 hover:underline disabled:opacity-50"
            >
              إلغاء الموقع
            </button>
          </div>
          <div className="flex items-center gap-3 text-[11px]">
            <a
              href={`https://maps.google.com/?q=${latitude},${longitude}`}
              target="_blank"
              rel="noreferrer"
              className={`font-bold text-emerald-700 underline dark:text-emerald-400 ${disabled ? 'pointer-events-none opacity-50' : ''}`}
            >
              معاينة على خرائط Google
            </a>
            <button
              type="button"
              onClick={() => !disabled && setShowMapModal(true)}
              disabled={disabled}
              className="font-bold text-slate-600 underline hover:text-slate-900 dark:text-slate-400 disabled:opacity-50"
            >
              تغيير الموقع
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
            حدد موقعك ليسهل على مندوب التوصيل الوصول لباب منزلك مباشرة دون تأخير:
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleGetGpsLocation}
              disabled={locating || disabled}
              className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-600 bg-emerald-600 px-3 py-2 text-xs font-bold text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-50"
            >
              {locating ? <Loader2 className="size-3.5 animate-spin" /> : <MapPin className="size-3.5" />}
              <span>{locating ? "جارٍ تحديد موقعك…" : "موقعي الحالي (GPS)"}</span>
            </button>
            <button
              type="button"
              onClick={() => !disabled && setShowMapModal(true)}
              disabled={disabled}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-700 transition hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 disabled:opacity-50"
            >
              <span>لصق رابط خريطة أو إحداثيات</span>
            </button>
          </div>
        </div>
      )}

      {locationFeedback && (
        <p className="mt-2 text-[11px] font-bold text-slate-600 dark:text-slate-300">
          {locationFeedback}
        </p>
      )}

      {showMapModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" dir="rtl">
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl dark:bg-slate-900">
            <div className="flex items-center justify-between border-b pb-3 dark:border-slate-800">
              <h3 className="flex items-center gap-2 text-sm font-extrabold text-slate-900 dark:text-slate-100">
                <MapPin className="size-4 text-emerald-600" />
                تحديد موقع التوصيل على الخريطة
              </h3>
              <button
                type="button"
                onClick={() => setShowMapModal(false)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="mt-4 space-y-3">
              <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-400">
                الصق رابط موقعك المنسوخ من تطبيق خرائط Google أو واتساب، أو اكتب الإحداثيات (خط العرض، خط الطول):
              </p>
              <input
                type="text"
                value={manualMapUrl}
                onChange={(e) => setManualMapUrl(e.target.value)}
                placeholder="مثال: https://maps.app.goo.gl/... أو 33.315, 44.366"
                dir="ltr"
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs outline-none focus:border-emerald-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              />
              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowMapModal(false)}
                  className="rounded-xl px-3 py-1.5 text-xs font-bold text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  إلغاء
                </button>
                <button
                  type="button"
                  onClick={handleApplyManualLocation}
                  disabled={!manualMapUrl.trim()}
                  className="rounded-xl bg-emerald-600 px-4 py-1.5 text-xs font-bold text-white transition hover:bg-emerald-700 disabled:opacity-50"
                >
                  تثبيت الموقع
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
