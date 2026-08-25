import { useCallback, useEffect, useMemo, useState } from "react";
import { connectivity, useConnectivity } from "@/lib/offline/connectivity";
import {
  flushOutbox,
  getDeviceCode,
  isOfflineSaleEnabled,
  listOutboxItems,
  readOutboxSummary,
  replayParkedWithApproval,
  requeueParkedItem,
  setOfflineSaleEnabled,
  subscribeOutbox,
  type OutboxSummary,
  type ReplayApiMap,
  type ReplayArgs,
} from "@/lib/offline/outbox";
import { getOfflineProfile, setOfflinePin, type OfflineProfile } from "@/lib/offline/pinLock";
import { getMeta, requestPersistentStorage, type OfflineOutboxItem } from "@/lib/offline/db";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { AlertTriangle, CheckCircle2, CloudOff, CloudUpload, RefreshCw, Settings2, X } from "lucide-react";

/**
 * شارة مزامنة الكاشير + درج الإيصالات — الشريحة ٣ من خطة الأوفلاين.
 * تظهر فقط حين يوجد ما يستحق (طابور/معلّقات/مزامنة جارية/يلزم دخول) — صفر ضجيج في التشغيل
 * الطبيعي. الطبقة z-[140]: فوق محتوى POS وتحت الشريط العلوي (150) وحوار التأكيد (200).
 * المحفّزات هنا أيضاً: عودة الاتصال + عودة رؤية التبويب + نبضة كل ٣٠ث والطابور غير فارغ.
 */
export function OfflineSyncChip({ userRole }: { userRole?: string | null }) {
  const connState = useConnectivity();
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery(undefined, { retry: false });
  const currentUserId = Number(me.data?.id ?? 0) || null;
  const [summary, setSummary] = useState<OutboxSummary | null>(null);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<OfflineOutboxItem[]>([]);
  // ش٥ — إعدادات الجهاز: مفتاح التجربة + PIN + التخزين الدائم + كود الجهاز.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deviceCode, setDeviceCode] = useState("");
  // الافتراضي مفعَّل (قرار مالك ١٦/٨) — الحالة الأولية تعكسه قبل القراءة من الجهاز كي لا
  // تومض الشارة «معطَّل» للحظة على جهازٍ يعمل فعلاً.
  const [saleEnabled, setSaleEnabled] = useState(true);
  const [persisted, setPersisted] = useState<string | null>(null);
  const [profile, setProfile] = useState<OfflineProfile | null>(null);
  const [pinInput, setPinInput] = useState("");
  const [pinConfirm, setPinConfirm] = useState("");
  const [pinMsg, setPinMsg] = useState<string | null>(null);
  const elevated = userRole === "admin" || userRole === "manager";

  const refreshSettings = useCallback(() => {
    void getDeviceCode().then(setDeviceCode);
    void isOfflineSaleEnabled().then(setSaleEnabled);
    void getMeta("storagePersisted").then(setPersisted);
    void getOfflineProfile().then(setProfile);
  }, []);
  useEffect(() => {
    if (settingsOpen) refreshSettings();
  }, [settingsOpen, refreshSettings]);
  // ش٤: اعتماد مدير لعنصر معلَّق (تحت التكلفة) — نموذج مصغّر داخل بطاقة العنصر.
  const [approvalFor, setApprovalFor] = useState<string | null>(null);
  const [mgrEmail, setMgrEmail] = useState("");
  const [mgrPwd, setMgrPwd] = useState("");
  const [approvalBusy, setApprovalBusy] = useState(false);

  // خريطة الترحيل الكاملة: الشارة عامّة (تُركَّب في كلّ شاشات الكاشير) فتُفرّغ **كلّ** الأنواع،
  // لا نوع الشاشة التي تحملها وحده — وإلا بقي عنصرُ استقبالٍ عالقاً لأن الكاشير فتح التجزئة.
  const api: ReplayApiMap = useMemo(() => {
    const common = (args: ReplayArgs) => ({
      ...(args.payload as never as object),
      capturedAt: args.capturedAt,
      offlineReceiptNumber: args.offlineReceiptNumber,
      deviceId: args.deviceId,
    });
    return {
      SALE: (args) => utils.client.offline.replaySale.mutate(common(args) as never),
      PRINT_SALE: (args) => utils.client.offline.replayPrintSale.mutate(common(args) as never),
      RECEPTION: (args) => utils.client.offline.replayReception.mutate(common(args) as never),
    };
  }, [utils]);

  const refresh = useCallback(() => {
    void readOutboxSummary().then(setSummary);
  }, []);

  const flushNow = useCallback(
    (force = false) => {
      if (connectivity.get() !== "online" || currentUserId == null) return;
      void flushOutbox(api, { force, currentUserId }).then(() => {
        refresh();
        // بعد تفريغٍ ناجح: أنعش شاشات المبيعات/المخزون (الفواتير الرسمية وصلت الآن).
        void utils.catalog.posList.invalidate();
      });
    },
    [api, currentUserId, refresh, utils],
  );

  useEffect(() => {
    refresh();
    const offOutbox = subscribeOutbox(refresh);
    const offConn = connectivity.subscribe((s) => {
      if (s === "online") flushNow();
    });
    const onVisible = () => {
      if (document.visibilityState === "visible") flushNow();
    };
    document.addEventListener("visibilitychange", onVisible);
    const interval = window.setInterval(() => {
      void readOutboxSummary().then((s) => {
        setSummary(s);
        if (s.queued > 0) flushNow();
      });
    }, 30_000);
    // محاولة فورية عند التركيب (بقايا طابور من جلسة سابقة).
    flushNow();
    return () => {
      offOutbox();
      offConn();
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(interval);
    };
  }, [flushNow, refresh]);

  useEffect(() => {
    if (open) void listOutboxItems().then(setItems);
  }, [open, summary]);

  if (!summary) return null;
  // ش٥: الشارة دائمة الظهور (خفيفة عند الخمول) — بوّابة إعدادات الجهاز يجب أن تبقى في المتناول.
  const busy = summary.queued > 0 || summary.parked > 0 || summary.flushing || summary.needsLogin;

  const offline = connState !== "online";
  const chipTone = summary.parked > 0 || summary.needsLogin
    ? "bg-[var(--sem-neg)] text-background"
    : summary.flushing
      ? "bg-sky-600 text-white"
      : offline
        ? "bg-[var(--sem-warn)] text-background"
        : busy
          ? "bg-sky-600 text-white"
          : "border bg-background/90 text-muted-foreground";

  const STATUS_LABEL: Record<OfflineOutboxItem["status"], string> = {
    QUEUED: "بالانتظار",
    SENDING: "جارٍ الترحيل",
    SENT: "رُحِّل",
    PARKED: "معلَّق",
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "fixed bottom-3 left-3 z-[140] flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-bold shadow-lg",
          chipTone,
        )}
      >
        {summary.flushing ? (
          <RefreshCw aria-hidden className="size-3.5 animate-spin" />
        ) : summary.parked > 0 ? (
          <AlertTriangle aria-hidden className="size-3.5" />
        ) : offline ? (
          <CloudOff aria-hidden className="size-3.5" />
        ) : (
          <CloudUpload aria-hidden className="size-3.5" />
        )}
        <span>
          {summary.needsLogin
            ? "سجّل الدخول للمزامنة"
            : summary.flushing
              ? "جارٍ مزامنة المبيعات…"
              : summary.queued > 0
                ? `${summary.queued} بانتظار المزامنة`
                : summary.parked > 0
                  ? `${summary.parked} معلَّقة للمراجعة`
                  : offline
                    ? "دون اتصال"
                    : "الأوفلاين"}
        </span>
      </button>

      {open ? (
        <div className="fixed bottom-14 left-3 z-[140] flex max-h-[70vh] w-96 max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-xl border bg-background text-foreground shadow-2xl">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <p className="text-sm font-bold">مزامنة المبيعات الأوفلاينية</p>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setSettingsOpen((s) => !s)}
                aria-label="إعدادات الجهاز"
                className={cn("rounded-md border p-1", settingsOpen && "bg-muted")}
              >
                <Settings2 aria-hidden className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={() => flushNow(true)}
                disabled={summary.flushing || offline}
                className="rounded-md border px-2 py-1 text-xs font-semibold disabled:opacity-50"
              >
                <RefreshCw aria-hidden className={cn("me-1 inline size-3", summary.flushing && "animate-spin")} />
                مزامنة الآن
              </button>
              <button type="button" onClick={() => setOpen(false)} aria-label="إغلاق" className="rounded-md p-1 hover:bg-muted">
                <X aria-hidden className="size-4" />
              </button>
            </div>
          </div>

          {settingsOpen ? (
            <div className="space-y-3 border-b bg-muted/30 px-3 py-3 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">كود هذا الجهاز</span>
                <span className="font-mono font-bold">{deviceCode || "—"}</span>
              </div>

              {/* مفعَّلٌ تلقائياً على كل جهاز (قرار مالك ١٦/٨) — المفتاح استثناءٌ للتعطيل لا شرطٌ
                  للتفعيل. القراءة/التصفح كانا وما زالا دائمَين. */}
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-bold">البيع النقدي دون اتصال</p>
                  <p className="text-[10px] text-muted-foreground">
                    {elevated
                      ? "مفعَّل تلقائياً على كل جهاز — عطّله هنا إن أردت استبعاد هذا الجهاز وحده"
                      : "مفعَّل تلقائياً — تعطيله لهذا الجهاز قرار إداري يبدّله المدير من حسابه"}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={!elevated}
                  onClick={() => {
                    void setOfflineSaleEnabled(!saleEnabled).then(refreshSettings);
                  }}
                  className={cn(
                    "rounded-full px-3 py-1 text-[11px] font-bold disabled:opacity-60",
                    saleEnabled ? "bg-[var(--sem-pos)] text-background" : "border bg-background",
                  )}
                >
                  {saleEnabled ? "مفعَّل" : "معطَّل"}
                </button>
              </div>

              {/* التخزين الدائم + تحذير مسح المتصفح (قرار الخطة: PWA فقط). */}
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-bold">التخزين الدائم للمتصفح</p>
                  <p className="text-[10px] text-muted-foreground">
                    لا تمسح بيانات المتصفح على جهاز الكاشير — المسح يمحو الكتالوج وطابور المزامنة.
                  </p>
                </div>
                {persisted === "1" ? (
                  <span className="rounded-full bg-[var(--sem-pos-bg)] px-2 py-0.5 text-[10px] font-bold text-[var(--sem-pos)]">مثبَّت</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      void requestPersistentStorage().then(refreshSettings);
                    }}
                    className="rounded border px-2 py-0.5 text-[10px] font-bold"
                  >
                    طلب التثبيت
                  </button>
                )}
              </div>

              {/* رمز PIN للإقلاع دون اتصال — حراسة واجهة لا تشفير هوية (يفتح شاشة الكاشير فقط). */}
              <div>
                <p className="font-bold">
                  رمز PIN للإقلاع دون اتصال
                  {profile?.hasPin ? <span className="ms-2 rounded-full bg-[var(--sem-pos-bg)] px-2 py-0.5 text-[10px] text-[var(--sem-pos)]">مضبوط</span> : null}
                </p>
                <p className="mb-1 text-[10px] text-muted-foreground">
                  يفتح شاشة الكاشير عند تشغيل الجهاز والاتصال مقطوع ({profile?.name ?? "سجّل الدخول أولاً"}).
                </p>
                <div className="flex gap-1">
                  <input
                    type="password"
                    inputMode="numeric"
                    dir="ltr"
                    value={pinInput}
                    onChange={(e) => setPinInput(e.target.value)}
                    placeholder="PIN جديد (٤-٨ أرقام)"
                    className="w-full rounded border bg-background px-2 py-1 text-[11px]"
                  />
                  <input
                    type="password"
                    inputMode="numeric"
                    dir="ltr"
                    value={pinConfirm}
                    onChange={(e) => setPinConfirm(e.target.value)}
                    placeholder="تأكيد"
                    className="w-full rounded border bg-background px-2 py-1 text-[11px]"
                  />
                  <button
                    type="button"
                    disabled={!pinInput || pinInput !== pinConfirm}
                    onClick={() => {
                      void setOfflinePin(pinInput).then((r) => {
                        setPinMsg(r.ok ? "ضُبط رمز PIN" : r.error ?? "تعذّر الضبط");
                        if (r.ok) {
                          setPinInput("");
                          setPinConfirm("");
                        }
                        refreshSettings();
                      });
                    }}
                    className="shrink-0 rounded bg-sky-600 px-2 py-1 text-[11px] font-bold text-white disabled:opacity-50"
                  >
                    حفظ
                  </button>
                </div>
                {pinMsg ? <p className="mt-1 text-[10px] text-muted-foreground">{pinMsg}</p> : null}
              </div>

              {elevated ? (
                <a href="/reports/offline-sales" className="block text-[11px] font-bold text-sky-700 underline dark:text-sky-400">
                  تقرير المبيعات الأوفلاين (للإدارة)
                </a>
              ) : null}
            </div>
          ) : null}
          {summary.queuedTotal > 0 ? (
            <p className="border-b bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
              قيمة الطابور: {summary.queuedTotal.toLocaleString("en")} د.ع
            </p>
          ) : null}
          <div className="flex-1 overflow-y-auto">
            {items.length === 0 ? (
              <p className="p-4 text-center text-xs text-muted-foreground">لا عناصر</p>
            ) : (
              items.map((item) => (
                <div key={item.clientRequestId} className="border-b px-3 py-2 text-xs last:border-b-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono font-semibold">{item.offlineReceiptNumber}</span>
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-[10px] font-bold",
                        item.status === "SENT" && "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]",
                        item.status === "PARKED" && "bg-[var(--sem-neg-bg)] text-[var(--sem-neg)]",
                        (item.status === "QUEUED" || item.status === "SENDING") && "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]",
                      )}
                    >
                      {STATUS_LABEL[item.status]}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2 text-muted-foreground">
                    <span>{Number(item.total).toLocaleString("en")} د.ع</span>
                    {item.status === "SENT" && item.resultInvoiceNumber ? (
                      <span className="flex items-center gap-1 font-mono">
                        <CheckCircle2 aria-hidden className="size-3 text-[var(--sem-pos)]" />
                        {item.resultInvoiceNumber}
                      </span>
                    ) : null}
                  </div>
                  {item.status === "PARKED" ? (
                    <div className="mt-1 space-y-1">
                      {item.lastError ? <p className="text-[var(--sem-neg)]">{item.lastError}</p> : null}
                      <div className="flex flex-wrap gap-1">
                        <button
                          type="button"
                          onClick={() => {
                            void requeueParkedItem(item.clientRequestId).then(() => flushNow(true));
                          }}
                          className="rounded border px-2 py-0.5 text-[11px] font-semibold"
                        >
                          إعادة المحاولة
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setApprovalFor((cur) => (cur === item.clientRequestId ? null : item.clientRequestId));
                            setMgrEmail("");
                            setMgrPwd("");
                          }}
                          className="rounded border px-2 py-0.5 text-[11px] font-semibold"
                        >
                          اعتماد مدير
                        </button>
                      </div>
                      {approvalFor === item.clientRequestId ? (
                        <div className="mt-1 space-y-1 rounded-md border bg-muted/40 p-2">
                          <p className="text-[10px] text-muted-foreground">
                            لترحيل بيعٍ رُفض (كسعرٍ تحت التكلفة) — تُتحقَّق هوية المدير خادمياً وتُدقَّق.
                          </p>
                          <input
                            type="email"
                            dir="ltr"
                            value={mgrEmail}
                            onChange={(e) => setMgrEmail(e.target.value)}
                            placeholder="بريد المدير"
                            className="w-full rounded border bg-background px-2 py-1 text-[11px]"
                          />
                          <input
                            type="password"
                            dir="ltr"
                            value={mgrPwd}
                            onChange={(e) => setMgrPwd(e.target.value)}
                            placeholder="كلمة المرور"
                            className="w-full rounded border bg-background px-2 py-1 text-[11px]"
                          />
                          <button
                            type="button"
                            disabled={!mgrEmail || !mgrPwd || approvalBusy || offline}
                            onClick={() => {
                              setApprovalBusy(true);
                              // اعتماد المدير يجب أن يسلك **مسار نوع العنصر** لا مسار التجزئة
                              // دائماً — وإلا رُحِّلت سلّة استقبالٍ معلَّقة عبر عقدٍ لا يقبلها.
                              const withApproval = (args: ReplayArgs) => ({
                                ...(args.payload as never as object),
                                capturedAt: args.capturedAt,
                                offlineReceiptNumber: args.offlineReceiptNumber,
                                deviceId: args.deviceId,
                                managerApproval: { email: mgrEmail, password: mgrPwd },
                              });
                              const approvalApi: ReplayApiMap = {
                                SALE: (args) => utils.client.offline.replaySale.mutate(withApproval(args) as never),
                                PRINT_SALE: (args) => utils.client.offline.replayPrintSale.mutate(withApproval(args) as never),
                                RECEPTION: (args) => utils.client.offline.replayReception.mutate(withApproval(args) as never),
                              };
                              void replayParkedWithApproval(item.clientRequestId, approvalApi).then((r) => {
                                setApprovalBusy(false);
                                if (r.ok) {
                                  setApprovalFor(null);
                                  setMgrEmail("");
                                  setMgrPwd("");
                                }
                                refresh();
                              });
                            }}
                            className="w-full rounded bg-sky-600 px-2 py-1 text-[11px] font-bold text-white disabled:opacity-50"
                          >
                            {approvalBusy ? "جارٍ الترحيل…" : "اعتماد وترحيل"}
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
