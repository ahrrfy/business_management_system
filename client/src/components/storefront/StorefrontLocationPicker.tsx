import { useEffect, useRef, useState } from "react";
import { MapPin, Check, X, Loader2 } from "lucide-react";
import {
  buildGoogleMapsUrl,
  extractShortMapUrl,
  parseGeoCoordinates,
} from "@shared/geoCoordinates";
import { trpc } from "@/lib/trpc";

export function parseCoordinatesOrUrl(input: string): { lat: number; lng: number } | null {
  return parseGeoCoordinates(input);
}

interface GoogleMapsGlobal {
  maps?: {
    importLibrary?: (name: string) => Promise<Record<string, unknown>>;
  };
}

let googleMapsBootstrapPromise: Promise<GoogleMapsGlobal["maps"]> | null = null;

function loadGoogleMapsJsApi(apiKey: string): Promise<GoogleMapsGlobal["maps"]> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Window unavailable"));
  }
  const existing = (window as unknown as { google?: GoogleMapsGlobal }).google?.maps;
  if (existing?.importLibrary) {
    return Promise.resolve(existing);
  }
  if (googleMapsBootstrapPromise) {
    return googleMapsBootstrapPromise;
  }
  googleMapsBootstrapPromise = new Promise((resolve, reject) => {
    const callbackName = "__alArabiyaGmapsInit";
    (window as unknown as Record<string, unknown>)[callbackName] = () => {
      const loaded = (window as unknown as { google?: GoogleMapsGlobal }).google?.maps;
      if (loaded?.importLibrary) {
        resolve(loaded);
      } else {
        googleMapsBootstrapPromise = null;
        reject(new Error("Google Maps importLibrary unavailable"));
      }
    };
    const script = document.createElement("script");
    script.async = true;
    script.defer = true;
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&v=weekly&loading=async&language=ar&region=IQ&callback=${callbackName}`;
    script.onerror = () => {
      googleMapsBootstrapPromise = null;
      reject(new Error("Failed to load Google Maps JS API"));
    };
    document.head.appendChild(script);
  });
  return googleMapsBootstrapPromise;
}

const BAGHDAD_CENTER = { lat: 33.315241, lng: 44.366067 };

interface StorefrontLocationPickerProps {
  latitude: number | null;
  longitude: number | null;
  onChange: (coords: { latitude: number | null; longitude: number | null }) => void;
  disabled?: boolean;
}

export function StorefrontLocationPicker({
  latitude,
  longitude,
  onChange,
  disabled,
}: StorefrontLocationPickerProps) {
  const [showMapModal, setShowMapModal] = useState(false);
  const [manualMapUrl, setManualMapUrl] = useState("");
  const [locating, setLocating] = useState(false);
  const [locationFeedback, setLocationFeedback] = useState<string | null>(null);
  const [draftPin, setDraftPin] = useState<{ lat: number; lng: number } | null>(null);
  const [mapLoadError, setMapLoadError] = useState(false);

  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const resolveUrlM = trpc.storefront.resolveLocationUrl.useMutation();

  const envVars = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const mapsApiKey = envVars?.VITE_GOOGLE_MAPS_API_KEY?.trim() || "";
  const mapsMapId = envVars?.VITE_GOOGLE_MAPS_MAP_ID?.trim() || "DEMO_MAP_ID";
  const hasCoordinates = latitude != null && longitude != null;
  const previewUrl = buildGoogleMapsUrl(latitude, longitude);

  useEffect(() => {
    if (!showMapModal) return;
    setDraftPin(
      latitude != null && longitude != null
        ? { lat: latitude, lng: longitude }
        : null,
    );
    setMapLoadError(false);
  }, [showMapModal, latitude, longitude]);

  useEffect(() => {
    if (!showMapModal || !mapsApiKey || !mapContainerRef.current) return;
    let cancelled = false;

    void loadGoogleMapsJsApi(mapsApiKey)
      .then(async (gmaps) => {
        if (cancelled || !gmaps?.importLibrary || !mapContainerRef.current) return;
        const mapsLib = (await gmaps.importLibrary("maps")) as {
          Map: new (el: HTMLElement, opts: Record<string, unknown>) => {
            addListener: (event: string, handler: (ev: { latLng?: { lat: () => number; lng: () => number } }) => void) => void;
            panTo: (pos: { lat: number; lng: number }) => void;
          };
        };
        const markerLib = (await gmaps.importLibrary("marker")) as {
          AdvancedMarkerElement: new (opts: Record<string, unknown>) => {
            position: { lat: number; lng: number } | null;
            addListener: (event: string, handler: () => void) => void;
          };
        };
        if (cancelled || !mapContainerRef.current) return;

        const initialPos =
          latitude != null && longitude != null
            ? { lat: latitude, lng: longitude }
            : BAGHDAD_CENTER;

        const map = new mapsLib.Map(mapContainerRef.current, {
          center: initialPos,
          zoom: latitude != null && longitude != null ? 16 : 12,
          mapId: mapsMapId,
          gestureHandling: "greedy",
          streetViewControl: false,
          mapTypeControl: false,
          internalUsageAttributionIds: ["gmp_git_agentskills_v1"],
        });

        const marker = new markerLib.AdvancedMarkerElement({
          map,
          position: initialPos,
          gmpDraggable: true,
        });

        map.addListener("click", (ev) => {
          if (!ev.latLng) return;
          const next = {
            lat: Number(ev.latLng.lat().toFixed(6)),
            lng: Number(ev.latLng.lng().toFixed(6)),
          };
          marker.position = next;
          setDraftPin(next);
          setLocationFeedback(null);
        });

        marker.addListener("dragend", () => {
          const pos = marker.position as { lat: number | (() => number); lng: number | (() => number) } | null;
          if (!pos) return;
          const rawLat = typeof pos.lat === "function" ? pos.lat() : pos.lat;
          const rawLng = typeof pos.lng === "function" ? pos.lng() : pos.lng;
          const next = {
            lat: Number(Number(rawLat).toFixed(6)),
            lng: Number(Number(rawLng).toFixed(6)),
          };
          setDraftPin(next);
          setLocationFeedback(null);
        });
      })
      .catch(() => {
        if (!cancelled) {
          setMapLoadError(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [showMapModal, mapsApiKey, mapsMapId, latitude, longitude]);

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

  const handleApplyManualLocation = async () => {
    if (disabled) return;
    const trimmed = manualMapUrl.trim();
    if (!trimmed && draftPin) {
      onChange({ latitude: draftPin.lat, longitude: draftPin.lng });
      setShowMapModal(false);
      setLocationFeedback("تم تثبيت الدبوس المحدد على الخريطة بنجاح");
      return;
    }

    const directCoords = parseCoordinatesOrUrl(trimmed);
    if (directCoords) {
      onChange({ latitude: directCoords.lat, longitude: directCoords.lng });
      setShowMapModal(false);
      setManualMapUrl("");
      setLocationFeedback("تم تثبيت الموقع بنجاح");
      return;
    }

    const shortUrl = extractShortMapUrl(trimmed);
    if (shortUrl) {
      setLocationFeedback(null);
      try {
        const resolved = await resolveUrlM.mutateAsync({ url: shortUrl });
        onChange({ latitude: resolved.lat, longitude: resolved.lng });
        setShowMapModal(false);
        setManualMapUrl("");
        setLocationFeedback("تم فك رابط خرائط Google المختصر وتثبيت الموقع بنجاح");
        return;
      } catch (err) {
        const msg = err instanceof Error && err.message
          ? err.message
          : "تعذر فك الرابط المختصر؛ افتح الرابط في خرائط Google وانسخ الرابط الكامل أو الإحداثيات.";
        setLocationFeedback(msg);
        return;
      }
    }

    setLocationFeedback("الرابط أو الإحداثيات غير صحيحة. تأكد من صحة رابط خرائط Google أو الأرقام.");
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-[#fbfdfc] p-3 text-xs dark:border-slate-800 dark:bg-slate-900/50">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 font-extrabold text-slate-800 dark:text-slate-200">
          <MapPin className="size-4 text-emerald-600" />
          موقع التوصيل على الخريطة
        </span>
        {hasCoordinates && (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-bold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
            <Check className="size-3" />
            محدد بدقة
          </span>
        )}
      </div>

      {hasCoordinates ? (
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
            {previewUrl && (
              <a
                href={previewUrl}
                target="_blank"
                rel="noreferrer"
                className={`font-bold text-emerald-700 underline dark:text-emerald-400 ${disabled ? "pointer-events-none opacity-50" : ""}`}
              >
                معاينة على خرائط Google
              </a>
            )}
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
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
            <button
              type="button"
              onClick={handleGetGpsLocation}
              disabled={locating || disabled}
              className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-xl border border-emerald-600 bg-emerald-600 px-3 py-2 text-xs font-bold text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-50"
            >
              {locating ? <Loader2 className="size-3.5 animate-spin" /> : <MapPin className="size-3.5" />}
              <span>{locating ? "جارٍ تحديد موقعك…" : "موقعي الحالي (GPS)"}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                if (disabled) return;
                setLocationFeedback(null);
                setShowMapModal(true);
              }}
              disabled={disabled}
              className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-700 transition hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 disabled:opacity-50"
            >
              <span>{mapsApiKey ? "تحديد على الخريطة أو لصق رابط" : "لصق رابط خريطة أو إحداثيات"}</span>
            </button>
          </div>
        </div>
      )}

      {locationFeedback && !showMapModal && (
        <p className="mt-2 text-[11px] font-bold text-slate-600 dark:text-slate-300">
          {locationFeedback}
        </p>
      )}

      {showMapModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" dir="rtl">
          <div className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-2xl dark:bg-slate-900">
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
              {mapsApiKey && !mapLoadError && (
                <div className="space-y-1.5">
                  <p className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">
                    انقر على الخريطة أو اسحب الدبوس لتثبيت باب المنزل بدقة:
                  </p>
                  <div
                    ref={mapContainerRef}
                    className="h-56 w-full overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700"
                  />
                  {draftPin && (
                    <p className="text-[11px] font-bold text-emerald-700 dark:text-emerald-400" dir="ltr">
                      الدبوس المحدد: {draftPin.lat}, {draftPin.lng}
                    </p>
                  )}
                </div>
              )}

              <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-400">
                أو الصق رابط موقعك المنسوخ من تطبيق خرائط Google (بما فيه الروابط المختصرة) أو واتساب، أو اكتب الإحداثيات:
              </p>
              <input
                type="text"
                value={manualMapUrl}
                onChange={(e) => setManualMapUrl(e.target.value)}
                placeholder="مثال: https://maps.app.goo.gl/... أو 33.315241, 44.366067"
                dir="ltr"
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs outline-none focus:border-emerald-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              />

              {locationFeedback && (
                <p className="rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11px] font-bold text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
                  {locationFeedback}
                </p>
              )}

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
                  onClick={() => void handleApplyManualLocation()}
                  disabled={resolveUrlM.isPending || (!manualMapUrl.trim() && !draftPin)}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-1.5 text-xs font-bold text-white transition hover:bg-emerald-700 disabled:opacity-50"
                >
                  {resolveUrlM.isPending && <Loader2 className="size-3.5 animate-spin" />}
                  <span>{resolveUrlM.isPending ? "جارٍ فك الرابط…" : "تثبيت الموقع"}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
