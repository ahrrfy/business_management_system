/**
 * CountPortal — بوابة عدّ الجرد العامة (موبايل أولاً، RTL، خارج AppLayout).
 *
 * المسار: /count/:code — صفحة عامة بلا جلسة دخول النظام:
 *   - عامل خارجي: PIN ٤ أرقام ⇒ `count.auth` يصدر كوكي count_token.
 *   - مستخدم النظام بتكليف USER: يدخل بلا PIN (نجرّب auth بلا pin أولاً).
 *
 * جرد أعمى تماماً: لا يظهر أي رصيد دفتري أو سعر أو كمية زميل في أي موضع.
 * أوفلاين: فشل شبكي في submit ⇒ طابور localStorage (countQueue) بنفس
 * clientRequestId ⇒ المزامنة الآلية (عند online وكل ٥ ثوانٍ) آمنة التكرار.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useParams } from "wouter";
import { TRPCClientError } from "@trpc/client";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { trpc } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";
import { notify, errMsg } from "@/lib/notify";
import { fmtInt } from "@/lib/money";
import { confirm } from "@/lib/confirm";
import { openWhatsApp } from "@/lib/whatsapp";
import { useBarcodeScanner } from "@/hooks/useBarcodeScanner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import {
  enqueue,
  peekAll,
  remove as removeQueued,
  size as queueSize,
  newClientRequestId,
  type QueuedCount,
} from "@/lib/countQueue";

type CountState = RouterOutputs["count"]["state"];
type CountItem = CountState["items"][number];
type CountMode = "FIRST" | "RECOUNT" | "VERIFY";

/* ─────────────────────────── مساعدات ─────────────────────────── */

/** فشل شبكي (لم يصل للخادم) ⇄ رفض خادمي (وصل ورُفض برسالة). */
function isNetworkError(e: unknown): boolean {
  if (typeof navigator !== "undefined" && !navigator.onLine) return true;
  if (e instanceof TRPCClientError) return e.data == null;
  return e instanceof TypeError;
}

/** اسم الوحدة الأساس (factor=1) لعرض الكميات. */
function baseUnitName(item: CountItem): string {
  const base = item.units.find((u) => u.factor === 1);
  return base?.unitName ?? item.units[0]?.unitName ?? "قطعة";
}

/** باركود العرض على البطاقة: وحدة الأساس أولاً ثم أي وحدة. */
function displayBarcode(item: CountItem): string | null {
  const base = item.units.find((u) => u.factor === 1 && u.barcode);
  return base?.barcode ?? item.units.find((u) => u.barcode)?.barcode ?? null;
}

function CenterScreen({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 py-10 text-center">
      {children}
    </div>
  );
}

function BrandMark() {
  return (
    <div className="grid size-16 place-items-center rounded-2xl bg-primary text-2xl font-bold text-primary-foreground">
      ر
    </div>
  );
}

/* ─────────────────────────── الصفحة ─────────────────────────── */

export default function CountPortal() {
  const params = useParams<{ code?: string }>();
  const code = decodeURIComponent(params.code ?? "").trim();
  const utils = trpc.useUtils();

  const [phase, setPhase] = useState<"boot" | "pin" | "counting">("boot");
  const [bootOffline, setBootOffline] = useState(false);
  const [pin, setPin] = useState("");
  const [authErr, setAuthErr] = useState<string | null>(null);

  const [online, setOnline] = useState<boolean>(() => typeof navigator === "undefined" || navigator.onLine);
  const [queueCount, setQueueCount] = useState<number>(() => (code ? queueSize(code) : 0));

  const [q, setQ] = useState("");
  const [openVariantId, setOpenVariantId] = useState<number | null>(null);
  const [flashId, setFlashId] = useState<number | null>(null);
  const [showOthers, setShowOthers] = useState(false);
  const [finished, setFinished] = useState<{ sessionMovedToReview: boolean } | null>(null);
  const [showListAfterSubmit, setShowListAfterSubmit] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const prev = document.title;
    document.title = "بوابة عدّ الجرد — الرؤية العربية";
    return () => {
      document.title = prev;
    };
  }, []);

  /* ── الدخول الصامت: كوكي سارٍ ⇒ مباشرة، وإلا auth بلا PIN (مستخدم نظام بتكليف USER)، وإلا شاشة PIN ── */
  const boot = useCallback(async () => {
    setBootOffline(false);
    try {
      await utils.client.count.state.query({ sessionCode: code });
      setPhase("counting");
      return;
    } catch (e) {
      if (isNetworkError(e)) {
        setBootOffline(true);
        return;
      }
    }
    try {
      await utils.client.count.auth.mutate({ sessionCode: code });
      setPhase("counting");
    } catch (e) {
      if (isNetworkError(e)) {
        setBootOffline(true);
        return;
      }
      setPhase("pin");
    }
  }, [code, utils]);

  useEffect(() => {
    if (code) void boot();
  }, [code, boot]);

  // عودة الاتصال أثناء شاشة «لا اتصال» الأولى ⇒ أعد محاولة الدخول تلقائياً.
  useEffect(() => {
    if (!bootOffline) return;
    const up = () => void boot();
    window.addEventListener("online", up);
    return () => window.removeEventListener("online", up);
  }, [bootOffline, boot]);

  /* ── دخول PIN ── */
  const authMut = trpc.count.auth.useMutation();
  const doAuth = useCallback(
    (pinValue: string) => {
      if (pinValue.length !== 4 || authMut.isPending) return;
      setAuthErr(null);
      authMut.mutate(
        { sessionCode: code, pin: pinValue },
        {
          onSuccess: () => setPhase("counting"),
          onError: (e) => {
            setPin("");
            setAuthErr(isNetworkError(e) ? "لا اتصال بالشبكة — تحقّق من الإنترنت وحاول مجدداً." : errMsg(e));
          },
        },
      );
    },
    [authMut, code],
  );

  /* ── حالة الجلسة (متابعة حيّة كل ٥ ثوانٍ) ── */
  const stateQ = trpc.count.state.useQuery(
    { sessionCode: code },
    { enabled: phase === "counting" && code !== "", refetchInterval: 5000, retry: false },
  );
  const st = stateQ.data;

  // نجاح ⇒ متصل؛ فشل شبكي ⇒ مقطوع؛ انتهاء صلاحية الدخول ⇒ عودة لشاشة PIN.
  useEffect(() => {
    if (phase !== "counting") return;
    if (stateQ.isSuccess) setOnline(true);
  }, [phase, stateQ.isSuccess, stateQ.dataUpdatedAt]);
  useEffect(() => {
    if (phase !== "counting" || !stateQ.isError) return;
    if (isNetworkError(stateQ.error)) {
      setOnline(false);
      return;
    }
    const errCode = (stateQ.error as { data?: { code?: string } | null }).data?.code;
    if (errCode === "UNAUTHORIZED") {
      setAuthErr("انتهت صلاحية الدخول — أدخل رمز PIN مجدداً.");
      setPhase("pin");
    }
  }, [phase, stateQ.isError, stateQ.error, stateQ.errorUpdatedAt]);

  /* ── مزامنة الطابور (idempotent عبر clientRequestId نفسه) ── */
  const flushing = useRef(false);
  const flushQueue = useCallback(async () => {
    if (flushing.current || !code) return;
    const pending = peekAll(code);
    if (pending.length === 0) return;
    flushing.current = true;
    let synced = 0;
    try {
      for (const it of pending) {
        try {
          await utils.client.count.submit.mutate({
            sessionCode: code,
            variantId: it.variantId,
            qty: it.qty,
            unitBreakdown: it.unitBreakdown,
            clientRequestId: it.clientRequestId,
          });
          removeQueued(code, it.clientRequestId);
          synced++;
        } catch (e) {
          if (isNetworkError(e)) {
            setOnline(false);
            break; // ما زال الاتصال مقطوعاً — نعيد المحاولة في الدورة القادمة
          }
          // رفض خادمي نهائي (مثلاً أُقفل العدّ) — لا معنى لإبقائها بالطابور.
          removeQueued(code, it.clientRequestId);
          notify.warn("تعذّرت مزامنة عدّة محفوظة", errMsg(e));
        }
      }
    } finally {
      flushing.current = false;
      setQueueCount(queueSize(code));
      if (synced > 0) {
        setOnline(true);
        notify.ok(`عاد الاتصال — تمت مزامنة ${fmtInt(synced)} عدّة محفوظة محلياً ✓`);
        void utils.count.state.invalidate();
      }
    }
  }, [code, utils]);

  useEffect(() => {
    const up = () => {
      setOnline(true);
      void flushQueue();
    };
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, [flushQueue]);

  useEffect(() => {
    if (phase !== "counting") return;
    const t = window.setInterval(() => void flushQueue(), 5000);
    return () => window.clearInterval(t);
  }, [phase, flushQueue]);

  /* ── مشتقات القائمة ── */
  const items = useMemo(() => st?.items ?? [], [st]);
  const queuedByVariant = useMemo(() => {
    const m = new Map<number, QueuedCount>();
    if (code) for (const it of peekAll(code)) m.set(it.variantId, it);
    return m;
    // queueCount يتغيّر مع كل enqueue/مزامنة ⇒ يعيد القراءة.
  }, [code, queueCount]);

  const pendingRecountSet = useMemo(
    () => new Set((st?.recountTasks ?? []).map((t) => t.variantId)),
    [st],
  );

  const needle = q.trim().toLowerCase();
  const matches = useCallback(
    (i: CountItem) => {
      if (!needle) return true;
      return (
        i.productName.toLowerCase().includes(needle) ||
        (i.variantName ?? "").toLowerCase().includes(needle) ||
        (i.sku ?? "").toLowerCase().includes(needle) ||
        i.units.some((u) => (u.barcode ?? "").includes(needle))
      );
    },
    [needle],
  );

  const myAll = useMemo(() => items.filter((i) => i.isMine), [items]);
  const myFiltered = useMemo(() => myAll.filter(matches), [myAll, matches]);
  const otherAll = useMemo(() => items.filter((i) => !i.isMine), [items]);
  const otherFiltered = useMemo(() => otherAll.filter(matches), [otherAll, matches]);

  /** «معدود» محلياً = عدّي المُزامَن أو عدّة معلّقة بالطابور. */
  const hasMyCount = useCallback(
    (i: CountItem) => i.myCount != null || queuedByVariant.has(i.variantId),
    [queuedByVariant],
  );
  const effCounted = useMemo(() => myAll.filter(hasMyCount).length, [myAll, hasMyCount]);
  const pendingRecounts = st?.recountTasks.length ?? 0;
  const allDone = myAll.length > 0 ? effCounted >= myAll.length && pendingRecounts === 0 : pendingRecounts === 0;
  const remaining = Math.max(0, myAll.length - effCounted) + pendingRecounts;

  const sessionStatus = st?.session.status ?? "COUNTING";
  const submittedAssignment = finished != null || st?.assignment.status === "SUBMITTED";
  const canCount = phase === "counting" && sessionStatus === "COUNTING" && !submittedAssignment;
  const dupBlocked = st?.session.dupPolicy === "BLOCK";

  /* ── فتح بطاقة العدّ ── */
  const openCard = useCallback(
    (i: CountItem) => {
      if (!canCount) return;
      if (!i.isMine && dupBlocked) {
        notify.info(
          i.colleagueCounted
            ? "🔒 الصنف معدود من زميلك — سياسة الجلسة تمنع العدّ المكرر"
            : "🔒 الصنف من منطقة زميل — اطلب من المسؤول إسناده إليك",
        );
        return;
      }
      setOpenVariantId(i.variantId);
    },
    [canCount, dupBlocked],
  );

  const handleBarcode = useCallback(
    (raw: string) => {
      const scanned = raw.trim();
      if (!scanned) return;
      const hit = items.find((i) => i.units.some((u) => u.barcode != null && u.barcode === scanned));
      if (!hit) {
        notify.warn("الباركود غير موجود ضمن أصناف هذه الجلسة", scanned);
        return;
      }
      setFlashId(hit.variantId);
      window.setTimeout(() => setFlashId(null), 600);
      openCard(hit);
    },
    [items, openCard],
  );

  useBarcodeScanner((raw) => handleBarcode(raw), {
    enabled: phase === "counting" && openVariantId == null && canCount,
  });

  /** Enter في حقل البحث: تطابق حرفي مع باركود/SKU ⇒ افتح البطاقة مباشرة. */
  const tryOpenByQuery = useCallback(() => {
    const exact = q.trim();
    if (!exact) return;
    const hit =
      items.find((i) => i.units.some((u) => u.barcode != null && u.barcode === exact)) ??
      items.find((i) => (i.sku ?? "") === exact);
    if (hit) {
      setQ("");
      setFlashId(hit.variantId);
      window.setTimeout(() => setFlashId(null), 600);
      openCard(hit);
    }
  }, [q, items, openCard]);

  /* ── حفظ العدّ ── */
  const submitMut = trpc.count.submit.useMutation();
  const openItem = openVariantId != null ? items.find((i) => i.variantId === openVariantId) ?? null : null;
  const openMode: CountMode = openItem
    ? openItem.isMine
      ? pendingRecountSet.has(openItem.variantId)
        ? "RECOUNT"
        : "FIRST"
      : openItem.colleagueCounted
        ? "VERIFY"
        : "FIRST"
    : "FIRST";
  const openRecountReason = openItem
    ? st?.recountTasks.find((t) => t.variantId === openItem.variantId)?.reason
    : undefined;

  const saveCount = useCallback(
    (item: CountItem, mode: CountMode, qty: number, unitBreakdown: string | undefined) => {
      const clientRequestId = newClientRequestId();
      submitMut.mutate(
        { sessionCode: code, variantId: item.variantId, qty, unitBreakdown, clientRequestId },
        {
          onSuccess: (res) => {
            // عدّة مباشرة نجحت ⇒ أي نسخة معلّقة قديمة لنفس الصنف صارت لاغية.
            const stale = peekAll(code).find((qc) => qc.variantId === item.variantId);
            if (stale) removeQueued(code, stale.clientRequestId);
            setQueueCount(queueSize(code));
            setOpenVariantId(null);
            // الخادم هو الحَكَم في نوع العدّ والتعارض — نقرأ حقوله إن وُجدت بتساهل.
            const r = res as unknown as { isConflict?: boolean; kind?: string } | undefined;
            const kind = r?.kind ?? mode;
            if (kind === "VERIFY") {
              if (r?.isConflict === true) notify.warn("⚠ اختلف عدّك عن عدّ زميلك — رُفع تعارض للمسؤول للفصل");
              else if (r?.isConflict === false) notify.ok("✓ تطابق العدّان — تأكيد إضافي للموثوقية");
              else notify.ok("سُجّل العدّ التحقّقي ✓");
            } else if (kind === "RECOUNT") {
              notify.ok("سُجّلت إعادة العدّ ✓");
            } else {
              notify.ok("سُجّلت الكمية ✓");
            }
            void utils.count.state.invalidate();
          },
          onError: (e) => {
            if (isNetworkError(e)) {
              setOnline(false);
              const persisted = enqueue(code, {
                clientRequestId,
                variantId: item.variantId,
                qty,
                unitBreakdown,
                queuedAt: new Date().toISOString(),
              });
              setQueueCount(queueSize(code));
              setOpenVariantId(null);
              if (persisted) {
                notify.info("📴 لا اتصال — حُفظت الكمية محلياً", "سيُزامَن العدّ تلقائياً عند عودة الاتصال");
              } else {
                notify.err("تعذّر الحفظ محلياً على هذا الجهاز — أعد المحاولة عند توفّر الاتصال");
              }
            } else {
              // رفض خادمي (مثل سياسة منع العدّ المكرر) — رسالة الخادم بأدب، والبطاقة تبقى مفتوحة.
              notify.err(e);
            }
          },
        },
      );
    },
    [code, submitMut, utils],
  );

  /* ── التسليم النهائي ── */
  const finishMut = trpc.count.finish.useMutation();
  const doFinish = useCallback(async () => {
    if (!st) return;
    const zone = st.assignment.zone;
    const ok = await confirm({
      variant: "warning",
      title: "تسليم العدّ النهائي",
      description: `بعد التسليم لا يمكنك تعديل عدّك${zone ? ` — منطقة «${zone}»` : ""}. هل أنت متأكد؟`,
      confirmText: "تسليم العدّ",
    });
    if (!ok) return;
    finishMut.mutate(
      { sessionCode: code },
      {
        onSuccess: (res) => {
          const moved = Boolean((res as unknown as { sessionMovedToReview?: boolean })?.sessionMovedToReview);
          setFinished({ sessionMovedToReview: moved });
          setShowListAfterSubmit(false);
          notify.ok(moved ? "سُلّم العدّ — اكتمل الجرد وانتقلت الجلسة للمراجعة ✓" : "سُلّم العدّ — شكراً لجهدك ✓");
          void utils.count.state.invalidate();
        },
        onError: (e) => notify.err(e),
      },
    );
  }, [st, code, finishMut, utils]);

  /* ═══════════════════════ العرض ═══════════════════════ */

  const frame = (body: ReactNode) => (
    <div dir="rtl" className="fixed inset-0 z-0 flex justify-center overflow-hidden bg-muted/40 font-sans">
      <div className="relative flex h-full w-full max-w-md flex-col overflow-hidden bg-background sm:border-x sm:border-border sm:shadow-sm">
        {body}
      </div>
    </div>
  );

  if (!code) {
    return frame(
      <CenterScreen>
        <BrandMark />
        <p className="text-lg font-bold">رابط غير صالح</p>
        <p className="text-sm text-muted-foreground">رابط بوابة العدّ ناقص رمز الجلسة — اطلب الرابط الصحيح من المسؤول.</p>
      </CenterScreen>,
    );
  }

  /* ── شاشة الإقلاع ── */
  if (phase === "boot") {
    return frame(
      bootOffline ? (
        <CenterScreen>
          <BrandMark />
          <p className="text-lg font-bold">📴 لا اتصال بالشبكة</p>
          <p className="text-sm text-muted-foreground">تعذّر الوصول للخادم — تحقّق من الإنترنت ثم أعد المحاولة.</p>
          <Button size="lg" className="w-44" onClick={() => void boot()}>
            إعادة المحاولة
          </Button>
        </CenterScreen>
      ) : (
        <CenterScreen>
          <BrandMark />
          <p className="text-sm font-semibold text-muted-foreground">جارٍ التحقّق…</p>
        </CenterScreen>
      ),
    );
  }

  /* ── شاشة PIN ── */
  if (phase === "pin") {
    return frame(
      <CenterScreen>
        <BrandMark />
        <div>
          <p className="text-lg font-bold">جرد المخزون</p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            جلسة <span className="font-mono font-bold text-foreground" dir="ltr">{code}</span>
          </p>
          <p className="mt-2 text-sm text-muted-foreground">أدخل رمز الدخول (PIN) الذي زوّدك به المسؤول</p>
        </div>
        <div dir="ltr">
          <InputOTP
            maxLength={4}
            value={pin}
            onChange={(v) => {
              setPin(v);
              setAuthErr(null);
            }}
            onComplete={(v: string) => doAuth(v)}
            pattern={REGEXP_ONLY_DIGITS}
            inputMode="numeric"
            autoFocus
            disabled={authMut.isPending}
            containerClassName="justify-center"
          >
            <InputOTPGroup className="gap-2">
              {[0, 1, 2, 3].map((idx) => (
                <InputOTPSlot
                  key={idx}
                  index={idx}
                  className="h-14 w-14 rounded-xl border text-2xl font-bold first:rounded-l-xl last:rounded-r-xl"
                />
              ))}
            </InputOTPGroup>
          </InputOTP>
        </div>
        {authErr && <p className="text-xs font-semibold text-destructive">{authErr}</p>}
        <Button size="lg" className="h-12 w-44 text-base font-bold" disabled={pin.length !== 4 || authMut.isPending} onClick={() => doAuth(pin)}>
          {authMut.isPending ? "جارٍ الدخول…" : "دخول"}
        </Button>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          الرابط مؤقت ومقيّد بهذه الجلسة ومنطقتك فقط — كل إدخال يُسجَّل باسمك ووقته.
        </p>
      </CenterScreen>,
    );
  }

  /* ── قيد العدّ: تحميل/خطأ ── */
  if (!st) {
    return frame(
      stateQ.isError ? (
        <CenterScreen>
          <BrandMark />
          <p className="text-lg font-bold">تعذّر الوصول للجلسة</p>
          <p className="text-sm text-muted-foreground">
            {isNetworkError(stateQ.error) ? "📴 لا اتصال بالشبكة — سنعيد المحاولة تلقائياً." : errMsg(stateQ.error)}
          </p>
          <Button size="lg" className="w-44" onClick={() => void stateQ.refetch()}>
            إعادة المحاولة
          </Button>
        </CenterScreen>
      ) : (
        <CenterScreen>
          <BrandMark />
          <p className="text-sm font-semibold text-muted-foreground">جارٍ تحميل أصنافك…</p>
        </CenterScreen>
      ),
    );
  }

  /* ── حالات الجلسة المنتهية (مهذبة) ── */
  if (sessionStatus === "CANCELLED") {
    return frame(
      <CenterScreen>
        <div className="grid size-16 place-items-center rounded-full bg-muted text-3xl">🚫</div>
        <p className="text-lg font-bold">أُلغيت جلسة الجرد</p>
        <p className="text-sm leading-relaxed text-muted-foreground">
          ألغى المسؤول هذه الجلسة — لا حاجة لمزيد من العدّ. شكراً لجهدك {st.assignment.name}.
        </p>
      </CenterScreen>,
    );
  }
  if (sessionStatus === "APPROVED") {
    return frame(
      <CenterScreen>
        <div className="grid size-16 place-items-center rounded-full bg-emerald-100 text-3xl text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">✓</div>
        <p className="text-lg font-bold">اعتُمدت نتائج الجرد</p>
        <p className="text-sm leading-relaxed text-muted-foreground">
          أُغلقت جلسة «{st.session.name}» واعتُمدت نتائجها — شكراً لمشاركتك {st.assignment.name}.
        </p>
      </CenterScreen>,
    );
  }

  /* ── تكليف مسلَّم: شاشة شكر (ثم قائمة للقراءة فقط عند الطلب) ── */
  const movedToReview = finished?.sessionMovedToReview === true || sessionStatus === "REVIEW";
  if (submittedAssignment && !showListAfterSubmit) {
    const waNotify = Boolean((st.session as unknown as { waNotify?: boolean }).waNotify);
    const sessionProgress = st.progress.session;
    const waMsg = [
      `✅ سلّمت عدّي — جلسة الجرد «${st.session.name}» (${st.session.code})`,
      `👷 العامل: ${st.assignment.name}`,
      st.assignment.zone ? `📍 المنطقة: ${st.assignment.zone}` : "",
      `📊 تقدّم الجلسة: ${fmtInt(sessionProgress.counted)}/${fmtInt(sessionProgress.total)}`,
    ]
      .filter(Boolean)
      .join("\n");
    return frame(
      <CenterScreen>
        <div className="grid size-20 place-items-center rounded-full bg-emerald-100 text-4xl text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">✓</div>
        <p className="text-xl font-bold">سلّمت عدّك — شكراً {st.assignment.name.split(" ")[0]} 🎉</p>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {movedToReview
            ? "اكتمل العدّ من جميع العمّال — الجلسة الآن قيد مراجعة المسؤول."
            : `بانتظار بقية الزملاء — تقدّم الجلسة ${fmtInt(sessionProgress.counted)}/${fmtInt(sessionProgress.total)} صنفاً.`}
        </p>
        {waNotify && (
          <Button variant="outline" size="lg" className="h-12 w-60 text-base font-bold" onClick={() => openWhatsApp(null, waMsg)}>
            📤 إبلاغ المسؤول عبر واتساب
          </Button>
        )}
        <button type="button" className="py-2 text-sm font-bold text-primary" onClick={() => setShowListAfterSubmit(true)}>
          عرض أصنافي (للقراءة فقط)
        </button>
      </CenterScreen>,
    );
  }

  /* ── أُقفل العدّ يدوياً (الجلسة للمراجعة وتكليفي ما زال نشطاً) ── */
  if (sessionStatus === "REVIEW" && !submittedAssignment) {
    return frame(
      <CenterScreen>
        <div className="grid size-16 place-items-center rounded-full bg-amber-100 text-3xl dark:bg-amber-950">🔒</div>
        <p className="text-lg font-bold">أُقفل العدّ</p>
        <p className="text-sm leading-relaxed text-muted-foreground">
          نقل المسؤول الجلسة لمرحلة المراجعة — لم يعد إدخال العدّ متاحاً. شكراً لجهدك {st.assignment.name}.
        </p>
      </CenterScreen>,
    );
  }

  /* ── الشاشة الرئيسية: ترويسة + مهام إعادة العدّ + بحث + قائمة + تسليم ── */
  const firstName = st.assignment.name.split(" ")[0];
  const pct = myAll.length > 0 ? Math.min(100, Math.round((effCounted / myAll.length) * 100)) : 0;
  const othersOpen = showOthers || (needle !== "" && otherFiltered.length > 0);

  return frame(
    <>
      {/* الترويسة اللاصقة */}
      <header className="z-30 border-b border-border bg-card px-4 pb-3 pt-[max(0.625rem,env(safe-area-inset-top))]">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-bold">
              {st.session.name} <span className="font-normal text-muted-foreground">— {st.session.branchName}</span>
            </p>
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              مرحباً {firstName} 👋{st.assignment.zone ? ` · منطقتك: ${st.assignment.zone}` : ""}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
            {queueCount > 0 && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-800 dark:bg-amber-950 dark:text-amber-300" title="عدّات بانتظار المزامنة">
                ⏳ {fmtInt(queueCount)}
              </span>
            )}
            {st.session.blind && (
              <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-bold text-violet-700 dark:bg-violet-950 dark:text-violet-300">
                جرد أعمى
              </span>
            )}
            <span className="text-sm leading-none" title={online ? "متصل" : "لا اتصال"} aria-label={online ? "متصل" : "لا اتصال"}>
              {online ? "🟢" : "🔴"}
            </span>
          </div>
        </div>
        <div className="mt-2.5 flex items-center gap-2">
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-primary/15">
            <div
              className={cn("h-full rounded-full transition-all", allDone ? "bg-emerald-500" : "bg-primary")}
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="text-xs font-bold tabular-nums" dir="ltr">
            {fmtInt(effCounted)}/{fmtInt(myAll.length)}
          </span>
        </div>
      </header>

      {/* مؤشر انقطاع الاتصال */}
      {!online && (
        <div className="flex items-center justify-between border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs font-bold text-amber-800 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-300">
          <span>📴 لا اتصال — العدّ يُحفظ محلياً</span>
          {queueCount > 0 && (
            <span className="rounded-full bg-amber-200 px-2 py-0.5 dark:bg-amber-900">{fmtInt(queueCount)} بانتظار المزامنة</span>
          )}
        </div>
      )}

      {/* مهام إعادة العدّ */}
      {canCount && st.recountTasks.length > 0 && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2.5 dark:border-amber-900 dark:bg-amber-950/40">
          <p className="text-xs font-bold text-amber-800 dark:text-amber-300">⟳ مطلوب إعادة عدّ ({fmtInt(st.recountTasks.length)}):</p>
          {st.recountTasks.map((t) => (
            <button
              key={t.variantId}
              type="button"
              onClick={() => {
                const it = items.find((i) => i.variantId === t.variantId);
                if (it) openCard(it);
              }}
              className="mt-1.5 flex w-full items-center justify-between gap-2 rounded-lg border border-amber-300 bg-card px-3 py-2.5 text-right text-sm font-semibold active:scale-[0.99] dark:border-amber-800"
            >
              <span className="min-w-0">
                <span className="block truncate">
                  {t.productName}
                  {t.variantName ? <span className="font-normal text-muted-foreground"> {t.variantName}</span> : null}
                </span>
                <span className="block truncate text-[11px] font-normal text-amber-700 dark:text-amber-400">السبب: {t.reason}</span>
              </span>
              <span className="shrink-0 text-amber-700 dark:text-amber-400">عدّ الآن ←</span>
            </button>
          ))}
        </div>
      )}

      {/* بحث + مسح */}
      <div className="flex gap-2 px-4 py-3">
        <input
          ref={searchRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              tryOpenByQuery();
            }
          }}
          placeholder="بحث بالاسم أو SKU أو رقم الباركود…"
          className="h-11 min-w-0 flex-1 rounded-xl border border-border bg-card px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring/40"
        />
        <button
          type="button"
          onClick={() => {
            searchRef.current?.focus();
            notify.info("جاهز للمسح 📷", "استخدم ماسح الباركود، أو اكتب الرقم في حقل البحث ثم اضغط إدخال");
          }}
          className="flex h-11 shrink-0 items-center gap-1.5 rounded-xl bg-primary px-4 text-sm font-bold text-primary-foreground active:scale-95"
        >
          <span className="text-base leading-none">▮▍▮</span> مسح
        </button>
      </div>

      {/* القائمة */}
      <main className="flex-1 overflow-y-auto px-4 pb-32">
        {myFiltered.length === 0 && needle !== "" && otherFiltered.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">لا نتائج للبحث «{q.trim()}»</p>
        )}

        {/* أصنافي */}
        {myFiltered.map((i) => {
          const queued = queuedByVariant.get(i.variantId);
          const isRecPending = pendingRecountSet.has(i.variantId);
          const countedHere = hasMyCount(i);
          const shownQty = queued?.qty ?? i.myCount?.qty ?? null;
          const bc = displayBarcode(i);
          return (
            <button
              key={i.variantId}
              type="button"
              onClick={() => openCard(i)}
              disabled={!canCount}
              className={cn(
                "mb-2 flex w-full items-center gap-3 rounded-xl border bg-card p-3 text-right transition-all active:scale-[0.99]",
                flashId === i.variantId ? "border-primary ring-2 ring-primary/40" : "border-border",
                !canCount && "opacity-60",
              )}
            >
              <div
                className={cn(
                  "grid size-9 shrink-0 place-items-center rounded-full text-sm font-bold",
                  countedHere && !isRecPending
                    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                    : isRecPending
                      ? "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                      : "bg-muted text-muted-foreground",
                )}
              >
                {countedHere && !isRecPending ? "✓" : isRecPending ? "⟳" : "•"}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold">
                  {i.productName}
                  {i.variantName ? <span className="font-normal text-muted-foreground"> {i.variantName}</span> : null}
                </p>
                <p className="truncate font-mono text-[10px] text-muted-foreground" dir="ltr">
                  {[bc, i.sku].filter(Boolean).join(" · ") || "—"}
                </p>
              </div>
              {countedHere && shownQty != null ? (
                <span
                  className="flex shrink-0 items-center gap-1 rounded-lg bg-emerald-50 px-2.5 py-1 font-mono text-xs font-bold tabular-nums text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                  dir="ltr"
                >
                  {queued && <span title="بانتظار المزامنة">⏳</span>}✓ {fmtInt(shownQty)} {baseUnitName(i)}
                </span>
              ) : canCount ? (
                <span className="shrink-0 text-xs font-semibold text-primary">عدّ ←</span>
              ) : null}
            </button>
          );
        })}

        {/* من مناطق الزملاء — قابل للطي */}
        {otherAll.length > 0 && (
          <div className="mt-3">
            <button
              type="button"
              onClick={() => setShowOthers((v) => !v)}
              className="flex w-full items-center justify-between rounded-lg px-1 py-2 text-right"
            >
              <span className="text-[12px] font-bold text-muted-foreground">
                من مناطق الزملاء ({fmtInt(needle ? otherFiltered.length : otherAll.length)}) —{" "}
                {dupBlocked ? "مقفلة (سياسة الجلسة: منع العدّ المكرر)" : "متاح عدّ تحقّقي للمعدود منها"}
              </span>
              <span className="text-xs text-muted-foreground">{othersOpen ? "▲" : "▼"}</span>
            </button>
            {othersOpen &&
              otherFiltered.map((i) => {
                const queued = queuedByVariant.get(i.variantId);
                const verifiedByMe = i.myCount != null || queued != null;
                const bc = displayBarcode(i);
                return (
                  <button
                    key={`o-${i.variantId}`}
                    type="button"
                    onClick={() => {
                      if (!canCount) return;
                      if (verifiedByMe) {
                        openCard(i); // تعديل عدّي التحقّقي قبل التسليم
                        return;
                      }
                      if (!i.colleagueCounted && !dupBlocked) {
                        notify.info("لم يُعدّ بعد من صاحب المنطقة", "إن عددته الآن يُسجَّل عدّاً أول باسمك");
                      }
                      openCard(i);
                    }}
                    disabled={!canCount}
                    className={cn(
                      "mb-2 flex w-full items-center gap-3 rounded-xl border border-dashed bg-card/60 p-3 text-right transition-all active:scale-[0.99]",
                      flashId === i.variantId && "ring-2 ring-primary/40",
                      dupBlocked ? "border-border opacity-70" : "border-violet-300 dark:border-violet-800",
                      !canCount && "opacity-60",
                    )}
                  >
                    <div
                      className={cn(
                        "grid size-9 shrink-0 place-items-center rounded-full text-sm font-bold",
                        verifiedByMe
                          ? "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300"
                          : i.colleagueCounted
                            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                            : "bg-muted text-muted-foreground",
                      )}
                    >
                      {dupBlocked ? "🔒" : verifiedByMe ? "✓✓" : i.colleagueCounted ? "✓" : "•"}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold">
                        {i.productName}
                        {i.variantName ? <span className="font-normal text-muted-foreground"> {i.variantName}</span> : null}
                      </p>
                      <p className="truncate text-[10px] text-muted-foreground">
                        {/* جرد أعمى: «معدود من زميل» بلا أي كمية */}
                        {i.colleagueCounted ? "معدود من زميل" : "لم يُعدّ بعد"}
                        {verifiedByMe ? ` · عدّك التحقّقي مُسجّل${queued ? " ⏳" : ""}` : ""}
                        {bc ? <span className="font-mono" dir="ltr"> · {bc}</span> : null}
                      </p>
                    </div>
                    {!dupBlocked && canCount && i.colleagueCounted && !verifiedByMe && (
                      <span className="shrink-0 text-xs font-semibold text-violet-700 dark:text-violet-400">عدّ تحقّقي ←</span>
                    )}
                  </button>
                );
              })}
          </div>
        )}
      </main>

      {/* شريط التسليم السفلي */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-background via-background/95 to-transparent px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-8">
        {submittedAssignment ? (
          <div className="pointer-events-auto rounded-xl bg-emerald-100 px-4 py-3 text-center text-sm font-bold text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
            ✓ سلّمت العدّ — بانتظار مراجعة المسؤول
          </div>
        ) : (
          <button
            type="button"
            disabled={!allDone || !online || queueCount > 0 || finishMut.isPending}
            onClick={() => void doFinish()}
            className={cn(
              "pointer-events-auto h-12 w-full rounded-xl text-base font-bold transition-colors",
              allDone && online && queueCount === 0 && !finishMut.isPending
                ? "bg-emerald-600 text-white active:bg-emerald-700"
                : "cursor-not-allowed bg-muted text-muted-foreground",
            )}
          >
            {!online
              ? "📴 التسليم يتطلب اتصالاً — العدّ محفوظ"
              : queueCount > 0
                ? `⏳ بانتظار مزامنة ${fmtInt(queueCount)} عدّة — التسليم بعدها`
                : !allDone
                  ? `بقي ${fmtInt(remaining)} — أكمل العدّ للتسليم`
                  : finishMut.isPending
                    ? "جارٍ التسليم…"
                    : "تسليم العدّ النهائي"}
          </button>
        )}
      </div>

      {/* بطاقة العدّ (bottom sheet) */}
      {openItem && (
        <div className="absolute inset-0 z-40">
          <button type="button" aria-label="إغلاق" className="absolute inset-0 bg-black/40" onClick={() => setOpenVariantId(null)} />
          <div className="absolute inset-x-0 bottom-0 max-h-[88%] overflow-y-auto rounded-t-2xl bg-background p-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl">
            <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-border" />
            <QtySheet
              key={`${openItem.variantId}-${openMode}`}
              item={openItem}
              mode={openMode}
              recountReason={openRecountReason}
              queued={queuedByVariant.get(openItem.variantId)}
              saving={submitMut.isPending}
              onCancel={() => setOpenVariantId(null)}
              onSave={(qty, breakdown) => saveCount(openItem, openMode, qty, breakdown)}
            />
          </div>
        </div>
      )}
    </>,
  );
}

/* ─────────────────────── ورقة إدخال الكمية ─────────────────────── */

function QtySheet({
  item,
  mode,
  recountReason,
  queued,
  saving,
  onCancel,
  onSave,
}: {
  item: CountItem;
  mode: CountMode;
  recountReason?: string;
  queued?: QueuedCount;
  saving: boolean;
  onCancel: () => void;
  onSave: (qty: number, unitBreakdown: string | undefined) => void;
}) {
  // وحدات مرتّبة من الأكبر للأصغر (كرتون ← درزن ← قطعة) بنسخة محلية مستقلة النوع.
  const units = useMemo(() => {
    const us = item.units.map((u) => ({ unitName: u.unitName, factor: u.factor, barcode: u.barcode ?? null }));
    if (us.length === 0) us.push({ unitName: "قطعة", factor: 1, barcode: null });
    return us.sort((a, b) => b.factor - a.factor);
  }, [item.units]);
  const baseUnit = baseUnitName(item);

  const [vals, setVals] = useState<Record<string, string>>(() => {
    // تعبئة مسبقة عند تعديل عدّي السابق فقط — إعادة العدّ/التحقّقي عدّ جديد أعمى من الصفر.
    if (mode === "FIRST") {
      const src = queued?.unitBreakdown ?? item.myCount?.unitBreakdown ?? null;
      if (src) {
        try {
          const parsed = JSON.parse(src) as Record<string, unknown>;
          const init: Record<string, string> = {};
          for (const u of item.units) {
            const v = parsed[u.unitName];
            if (typeof v === "number" && Number.isInteger(v) && v >= 0) init[u.unitName] = String(v);
          }
          if (Object.keys(init).length > 0) return init;
        } catch {
          /* تفصيل غير قابل للقراءة — نبدأ فارغين */
        }
      }
    }
    return {};
  });

  const setVal = (unitName: string, raw: string) => {
    setVals((v) => ({ ...v, [unitName]: raw.replace(/\D/g, "").slice(0, 7) }));
  };
  const step = (unitName: string, delta: number) => {
    setVals((v) => {
      const cur = parseInt(v[unitName] || "0", 10) || 0;
      const next = Math.max(0, cur + delta);
      return { ...v, [unitName]: String(next) };
    });
  };

  // الكميات أعداد صحيحة (ليست أموالاً) — حساب عددي مباشر.
  const entries: Record<string, number> = {};
  for (const u of units) {
    const raw = vals[u.unitName];
    if (raw !== undefined && raw !== "") entries[u.unitName] = parseInt(raw, 10) || 0;
  }
  const total = units.reduce((s, u) => s + (entries[u.unitName] ?? 0) * u.factor, 0);
  const anyEntered = Object.keys(entries).length > 0;
  const valid = anyEntered && Number.isSafeInteger(total) && total >= 0;

  const handleSave = () => {
    if (!valid || saving) return;
    const json = JSON.stringify(entries);
    onSave(total, json.length <= 500 ? json : undefined);
  };

  const isVerify = mode === "VERIFY";
  const isRecount = mode === "RECOUNT";

  return (
    <div className="flex flex-col">
      <button type="button" onClick={onCancel} className="self-start py-2 text-sm font-bold text-primary">
        → رجوع للقائمة
      </button>

      {isRecount && (
        <div className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold leading-relaxed text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
          ⟳ مطلوب إعادة عدّ ثانية لهذا الصنف{recountReason ? ` — السبب: ${recountReason}` : ""}. عُدّ من جديد بتمعّن.
        </div>
      )}
      {isVerify && (
        <div className="mb-2 rounded-lg bg-violet-50 px-3 py-2 text-xs font-semibold leading-relaxed text-violet-800 dark:bg-violet-950/50 dark:text-violet-300">
          ✓✓ عدّ تحقّقي — الصنف عدّه زميلك سابقاً. عدّك لن يستبدل عدّه: إن تطابقا تأكّد الرقم، وإن اختلفا يُرفع
          تعارض يفصل فيه المسؤول. (كميته لا تُعرض لك — جرد أعمى)
        </div>
      )}
      {!item.isMine && !isVerify && (
        <div className="mb-2 rounded-lg bg-muted px-3 py-2 text-xs font-semibold leading-relaxed text-muted-foreground">
          الصنف من منطقة زميل ولم يُعدّ بعد — سيُسجَّل العدّ الأول باسمك.
        </div>
      )}

      <div className="rounded-xl border border-border bg-card p-4">
        <p className="text-lg font-bold">{item.productName}</p>
        {item.variantName ? <p className="text-sm text-muted-foreground">{item.variantName}</p> : null}
        <p className="mt-1 font-mono text-xs text-muted-foreground" dir="ltr">
          {[displayBarcode(item), item.sku].filter(Boolean).join(" · ") || "—"}
        </p>
      </div>

      <p className="mb-2 mt-4 text-sm font-bold">الكمية المعدودة فعلياً على الرف:</p>
      <div className="space-y-2">
        {units.map((u) => {
          const cur = vals[u.unitName] ?? "";
          return (
            <div key={u.unitName} className="flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <span className="block text-sm font-bold">{u.unitName}</span>
                <span className="block text-[11px] text-muted-foreground">
                  {u.factor === 1 ? "وحدة الأساس" : `= ${fmtInt(u.factor)} ${baseUnit}`}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1.5" dir="ltr">
                <button
                  type="button"
                  aria-label={`إنقاص ${u.unitName}`}
                  onClick={() => step(u.unitName, -1)}
                  disabled={(parseInt(cur || "0", 10) || 0) === 0}
                  className="grid size-11 place-items-center rounded-lg border border-border bg-background text-xl font-bold active:scale-95 disabled:opacity-40"
                >
                  −
                </button>
                <input
                  inputMode="numeric"
                  dir="ltr"
                  value={cur}
                  placeholder="0"
                  onChange={(e) => setVal(u.unitName, e.target.value)}
                  className="h-11 w-20 rounded-lg border border-border bg-background text-center font-mono text-lg font-bold focus:border-primary focus:outline-none"
                  aria-label={`كمية ${u.unitName}`}
                />
                <button
                  type="button"
                  aria-label={`زيادة ${u.unitName}`}
                  onClick={() => step(u.unitName, 1)}
                  className="grid size-11 place-items-center rounded-lg border border-border bg-background text-xl font-bold active:scale-95"
                >
                  +
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex items-center justify-between rounded-xl bg-primary/5 px-4 py-3">
        <span className="text-sm font-bold">الإجمالي بالوحدة الأساس</span>
        <span className="font-mono text-xl font-bold tabular-nums text-primary" dir="ltr">
          {fmtInt(total)} {baseUnit}
        </span>
      </div>

      <button
        type="button"
        disabled={!valid || saving}
        onClick={handleSave}
        className={cn(
          "mt-4 h-12 w-full rounded-xl text-base font-bold text-white transition-colors",
          valid && !saving
            ? isVerify
              ? "bg-violet-600 active:bg-violet-700"
              : "bg-primary active:bg-primary/90"
            : "cursor-not-allowed bg-muted text-muted-foreground",
        )}
      >
        {saving ? "جارٍ الحفظ…" : isVerify ? "تسجيل العدّ التحقّقي" : isRecount ? "تسجيل إعادة العدّ" : "تسجيل الكمية"}
      </button>
      <p className="mt-2 text-center text-[11px] text-muted-foreground">
        يُسجَّل الإدخال باسمك ووقته — يمكنك تعديل العدّ قبل التسليم.
      </p>
    </div>
  );
}
