import { useCallback, useEffect, useRef, useState } from "react";
import {
  getDeviceCode,
  isOfflineSaleEnabled,
  setOfflineSaleEnabled,
} from "@/lib/offline/outbox";
import { getMeta, requestPersistentStorage } from "@/lib/offline/db";
import {
  getOfflineProfile,
  setOfflinePin,
  type OfflineProfile,
} from "@/lib/offline/pinLock";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useOfflineAction, type OfflineAction } from "./useOfflineAction";

export function OfflineDeviceSettings({
  elevated,
  action,
}: {
  elevated: boolean;
  action: OfflineAction;
}) {
  const [deviceCode, setDeviceCode] = useState("");
  const [saleEnabled, setSaleEnabled] = useState(true);
  const [persisted, setPersisted] = useState<string | null>(null);
  const [profile, setProfile] = useState<OfflineProfile | null>(null);
  const [ready, setReady] = useState(false);
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const active = useRef(true);
  const {
    run: runLoad,
    pending: loading,
    error: loadError,
  } = useOfflineAction();
  const { run, pending, error } = action;
  const refresh = useCallback(async () => {
    const [code, enabled, persistence, currentProfile] = await Promise.all([
      getDeviceCode(),
      isOfflineSaleEnabled(),
      getMeta("storagePersisted"),
      getOfflineProfile(),
    ]);
    if (!active.current) return;
    setDeviceCode(code);
    setSaleEnabled(enabled);
    setPersisted(persistence);
    setProfile(currentProfile);
    setReady(true);
  }, []);
  const reload = useCallback(() => void runLoad(refresh), [runLoad, refresh]);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    if (!pending) reload();
  }, [pending, reload]);
  if (!ready)
    return (
      <div className="border-b p-3 text-xs">
        {loadError ? (
          <div role="alert">
            <p>{loadError}</p>
            <Button size="sm" variant="outline" onClick={reload}>
              إعادة تحميل الإعدادات
            </Button>
          </div>
        ) : (
          <p role="status">
            {pending
              ? "قيد إتمام العملية السابقة على الجهاز…"
              : "قيد تحميل إعدادات الجهاز…"}
          </p>
        )}
      </div>
    );
  const disabled = pending || loading;
  return (
    <section
      aria-label="إعدادات الجهاز"
      className="min-w-0 space-y-3 border-b bg-muted/30 p-3 text-xs [overflow-wrap:anywhere]"
    >
      {error || loadError ? (
        <p role="alert" className="text-destructive">
          {error ?? loadError}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-muted-foreground">كود هذا الجهاز</span>
        <span className="break-all font-mono font-bold" dir="ltr">
          {deviceCode || "—"}
        </span>
      </div>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-bold">البيع النقدي دون اتصال</p>
          <p className="text-[11px] text-muted-foreground">
            {elevated
              ? "مفعل تلقائياً على كل جهاز؛ التعطيل يستبعد هذا الجهاز وحده."
              : "مفعل تلقائياً؛ تعطيل هذا الجهاز قرار إداري من حساب المدير."}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!elevated || disabled}
          aria-label="تبديل البيع النقدي دون اتصال"
          aria-pressed={saleEnabled}
          onClick={() =>
            void run(async () => {
              await setOfflineSaleEnabled(!saleEnabled);
            })
          }
        >
          {saleEnabled ? "مفعل" : "معطل"}
        </Button>
      </div>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 basis-40">
          <p className="font-bold">التخزين الدائم للمتصفح</p>
          <p className="text-[11px] text-muted-foreground">
            لا تمسح بيانات المتصفح على جهاز الكاشير؛ المسح يمحو الكتالوج وطابور
            المزامنة.
          </p>
        </div>
        {persisted === "1" ? (
          <span className="rounded border px-2 py-1 font-bold">مثبت</span>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() =>
              void run(async () => {
                const accepted = await requestPersistentStorage();
                if (!accepted)
                  throw new Error("لم يسمح المتصفح بتثبيت التخزين الدائم");
              })
            }
          >
            طلب التثبيت
          </Button>
        )}
      </div>
      <div className="space-y-2">
        <p className="font-bold">
          رمز PIN للإقلاع دون اتصال{" "}
          {profile?.hasPin ? (
            <span className="ms-1 font-normal text-muted-foreground">
              (مضبوط)
            </span>
          ) : null}
        </p>
        <p className="text-[11px] text-muted-foreground">
          يفتح شاشة الكاشير عند تشغيل الجهاز والاتصال مقطوع (
          {profile?.name ?? "سجل الدخول أولاً"}).
        </p>
        <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
          <Input
            type="password"
            inputMode="numeric"
            dir="ltr"
            aria-label="رمز PIN الجديد"
            autoComplete="new-password"
            placeholder="PIN جديد (٤-٨ أرقام)"
            value={pin}
            disabled={disabled}
            onChange={(event) => setPin(event.target.value)}
            className="min-w-0"
          />
          <Input
            type="password"
            inputMode="numeric"
            dir="ltr"
            aria-label="تأكيد رمز PIN"
            autoComplete="new-password"
            placeholder="تأكيد"
            value={confirm}
            disabled={disabled}
            onChange={(event) => setConfirm(event.target.value)}
            className="min-w-0"
          />
          <Button
            type="button"
            size="sm"
            className="sm:col-span-2"
            aria-busy={pending}
            disabled={
              !profile || disabled || !/^\d{4,8}$/.test(pin) || pin !== confirm
            }
            onClick={() => {
              setMessage(null);
              void run(async () => {
                const result = await setOfflinePin(pin);
                if (!result.ok)
                  throw new Error(result.error ?? "تعذر ضبط رمز PIN");
                if (!active.current) return;
                setMessage("تم ضبط رمز PIN");
                setPin("");
                setConfirm("");
              });
            }}
          >
            حفظ
          </Button>
        </div>
        {message ? (
          <p role="status" className="text-muted-foreground">
            {message}
          </p>
        ) : null}
      </div>
      {elevated ? (
        <a
          href="/reports/offline-sales"
          className="block font-bold text-primary underline"
        >
          تقرير المبيعات الأوفلاين (للإدارة)
        </a>
      ) : null}
    </section>
  );
}
