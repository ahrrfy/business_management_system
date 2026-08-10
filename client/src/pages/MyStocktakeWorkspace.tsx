import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Link, useParams } from "wouter";
import {
  AlertTriangle,
  Ban,
  Camera,
  Check,
  CheckCircle2,
  ClipboardCheck,
  Hourglass,
  Lock,
  PartyPopper,
  RefreshCw,
  Search,
  Send,
  WifiOff,
} from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useBarcodeScanner } from "@/hooks/useBarcodeScanner";
import { useBarcodeInput } from "@/hooks/useBarcodeInput";
import { BarcodeSearchCue, barcodeSearchInputClass } from "@/components/scan/BarcodeSearchCue";
import { usePulsedCountState } from "@/hooks/usePulsedCountState";
import type { PortalState } from "@shared/countPortalMerge";
import { CameraScanner } from "@/components/scan/CameraScanner";
import { confirm } from "@/lib/confirm";
import { errMsg, notify } from "@/lib/notify";
import { isNetworkError } from "@/lib/netError";
import { fmtInt } from "@/lib/money";
import {
  enqueue,
  newClientRequestId,
  peekAll,
  remove as removeQueued,
  size as queueSize,
  type QueuedCount,
} from "@/lib/countQueue";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

// النوع من الوحدة المشتركة مباشرةً: `count.state` صار غلافاً (كتالوج + متغيّر) تُركّبه
// `usePulsedCountState`، فاشتقاق النوع من شكل الردّ لم يعد يمثّل الحالة المعروضة.
type State = PortalState;
type CountItem = State["items"][number];
type CountUnit = CountItem["units"][number];
/** نوع العدّة كما تُسمّيها بوابة العدّ: أول عدّ · إعادة عدّ مطلوبة · عدّ تحقّقي فوق عدّ زميل. */
type CountMode = "FIRST" | "RECOUNT" | "VERIFY";

/** مطابقة حرفية لباركود الوحدة — الأساسيّ أو أيّ بديل (فضاء تفرّد واحد كما في الكاشير). */
function unitHasBarcode(unit: CountUnit, value: string) {
  return unit.barcode === value || unit.aliases.includes(value);
}

function matchesBarcode(item: CountItem, value: string) {
  return item.units.some((unit) => unitHasBarcode(unit, value));
}

function productLabel(item: CountItem) {
  return item.variantName
    ? `${item.productName} — ${item.variantName}`
    : item.productName;
}

/** اسم الوحدة الأساس (factor=1) — كل الكميات تُحفظ بها. */
function baseUnitName(item: CountItem) {
  const base = item.units.find((u) => u.factor === 1);
  return base?.unitName ?? item.units[0]?.unitName ?? "قطعة";
}

/**
 * مساحة عدّ الجرد للحساب المسند إليه تكليف USER — تعمل على الحاسوب والهاتف معاً:
 * مسح بكاميرا الجهاز (كبوابة العدّ الخارجية) أو بقارئ HID، وإدخال الكمية بالوحدات.
 *
 * أوفلاين: فشل شبكي في الحفظ ⇒ طابور localStorage (نفس `countQueue` المستعمل في بوابة
 * العدّ) بنفس `clientRequestId` ⇒ المزامنة الآلية (عند عودة الاتصال وكل ٥ ثوانٍ) آمنة
 * التكرار عبر UNIQUE(sessionId, clientRequestId) على الخادم.
 */
export default function MyStocktakeWorkspace() {
  const { code: rawCode } = useParams<{ code?: string }>();
  const code = decodeURIComponent(rawCode ?? "").trim();
  const utils = trpc.useUtils();
  // محكومة بنبضةٍ رخيصة بدل جلب الحالة الكاملة كل ٥ ثوانٍ — راجع usePulsedCountState.
  const state = usePulsedCountState(code, Boolean(code));
  const submit = trpc.count.submit.useMutation();
  const finish = trpc.count.finish.useMutation();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<CountItem | null>(null);
  /** الوحدة التي طابق باركودُها المسح — يبدأ التركيز عليها في بطاقة الكمية. */
  const [scannedUnit, setScannedUnit] = useState<string | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [online, setOnline] = useState<boolean>(
    () => typeof navigator === "undefined" || navigator.onLine,
  );
  const [queueCount, setQueueCount] = useState<number>(() => (code ? queueSize(code) : 0));
  /** بعد التسليم: عرض القائمة للقراءة فقط بدل بطاقة الشكر (كبوابة العدّ). */
  const [showListAfterSubmit, setShowListAfterSubmit] = useState(false);

  const st = state.data;
  const items = useMemo(() => st?.items ?? [], [st]);
  const needle = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      items.filter((item) => {
        if (!needle) return true;
        return (
          productLabel(item).toLowerCase().includes(needle) ||
          item.sku.toLowerCase().includes(needle) ||
          item.units.some(
            (u) =>
              (u.barcode ?? "").toLowerCase().includes(needle) ||
              u.aliases.some((a) => a.toLowerCase().includes(needle)),
          )
        );
      }),
    [items, needle],
  );

  /* ── حالة الاتصال: نجاح الاستعلام الدوري ⇒ متصل، وفشلٌ شبكيّ ⇒ مقطوع ── */
  useEffect(() => {
    if (state.isSuccess) setOnline(true);
  }, [state.isSuccess, state.dataUpdatedAt]);
  useEffect(() => {
    if (state.isError && isNetworkError(state.error)) setOnline(false);
  }, [state.isError, state.error, state.errorUpdatedAt]);

  /* ── مزامنة الطابور (idempotent بنفس clientRequestId) ── */
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
          // رفض خادمي نهائي (أُقفل العدّ مثلاً) — لا معنى لإبقائها بالطابور.
          removeQueued(code, it.clientRequestId);
          const serverCode = (e as { data?: { code?: string } | null }).data?.code;
          if (serverCode === "PRECONDITION_FAILED") {
            notify.warn(
              "استُبعدت عدّة محفوظة لأنها لم تعد صالحة",
              `${errMsg(e)} — لم تُعَد المحاولة، وجرى تحديث حالة المنتج من الخادم.`,
            );
            await utils.count.state.invalidate({ sessionCode: code });
          } else {
            notify.warn("تعذّرت مزامنة عدّة محفوظة", errMsg(e));
          }
        }
      }
    } finally {
      flushing.current = false;
      setQueueCount(queueSize(code));
      if (synced > 0) {
        setOnline(true);
        notify.ok(`عاد الاتصال — تمت مزامنة ${fmtInt(synced)} عدّة محفوظة محلياً`);
        await utils.count.state.invalidate({ sessionCode: code });
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
    const timer = window.setInterval(() => void flushQueue(), 5_000);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
      window.clearInterval(timer);
    };
  }, [flushQueue]);

  /** العدّات المحفوظة محلياً بانتظار المزامنة — مفتاحها المنتج. */
  const queuedByVariant = useMemo(() => {
    const m = new Map<number, QueuedCount>();
    if (code) for (const it of peekAll(code)) m.set(it.variantId, it);
    return m;
    // queueCount يتغيّر مع كل حفظ محليّ/مزامنة ⇒ يعيد القراءة.
  }, [code, queueCount]);

  const openItem = useCallback(
    (item: CountItem, unitName?: string) => {
      if (
        st?.session.status !== "COUNTING" ||
        st.assignment.status === "SUBMITTED"
      )
        return;
      if (item.reviewApproved) {
        notify.info("اعتمدت الإدارة عدّ هذا المنتج مرحلياً — انتقل إلى المنتج التالي");
        return;
      }
      if (
        st.session.dupPolicy === "BLOCK" &&
        item.colleagueCounted &&
        !item.myCount
      ) {
        notify.info("المنتج معدود من زميلك — سياسة الجلسة تمنع العدّ المكرر");
        return;
      }
      setScannedUnit(unitName ?? null);
      setSelected(item);
    },
    [st],
  );

  const onBarcode = useCallback(
    (raw: string) => {
      const value = raw.trim();
      if (!value) return;
      const found = items.find(
        (item) => matchesBarcode(item, value) || item.sku === value,
      );
      if (!found) {
        notify.warn("الباركود غير موجود ضمن منتجات هذه الجلسة", value);
        return;
      }
      // باركود وحدة أكبر (كرتون/درزن) ⇒ افتح الكمية على وحدته لا على وحدة الأساس.
      openItem(found, found.units.find((u) => unitHasBarcode(u, value))?.unitName);
    },
    [items, openItem],
  );
  const barcodeInput = useBarcodeInput((code) => {
    setQuery("");
    onBarcode(code);
  });
  // قارئ HID: يُعطَّل أثناء فتح البطاقة أو الكاميرا كي لا يتضاعف الالتقاط.
  useBarcodeScanner(onBarcode, {
    enabled: Boolean(st) && selected == null && !cameraOpen,
  });

  /** Enter في حقل البحث: تطابق حرفيّ مع باركود/SKU ⇒ افتح البطاقة مباشرةً (كبوابة العدّ). */
  const tryOpenByQuery = useCallback(() => {
    const exact = query.trim();
    if (!exact) return;
    const hit =
      items.find((i) => i.units.some((u) => unitHasBarcode(u, exact))) ??
      items.find((i) => i.sku === exact);
    if (!hit) return;
    setQuery("");
    openItem(hit, hit.units.find((u) => unitHasBarcode(u, exact))?.unitName);
  }, [items, openItem, query]);

  /** مهام إعادة العدّ المعلّقة — تحدّد نوع العدّة وتُعرض بسببها. */
  const recountReasonByVariant = useMemo(() => {
    const m = new Map<number, string>();
    for (const t of st?.recountTasks ?? []) m.set(t.variantId, t.reason);
    return m;
  }, [st]);

  /** نوع عدّة المنتج المفتوح: إعادة عدّ مطلوبة ⇐ تحقّقي فوق عدّ زميل ⇐ عدّ أول. */
  const selectedMode: CountMode = selected
    ? recountReasonByVariant.has(selected.variantId)
      ? "RECOUNT"
      : selected.colleagueCounted && !selected.myCount
        ? "VERIFY"
        : "FIRST"
    : "FIRST";

  const save = (qty: number, unitBreakdown: string | undefined) => {
    if (!selected) return;
    if (!Number.isSafeInteger(qty) || qty < 0) {
      notify.warn("أدخل كمية صحيحة تساوي صفراً أو أكثر.");
      return;
    }
    const item = selected;
    const mode = selectedMode;
    const clientRequestId = newClientRequestId();
    submit.mutate(
      {
        sessionCode: code,
        variantId: item.variantId,
        qty,
        unitBreakdown,
        clientRequestId,
      },
      {
        onSuccess: async (res) => {
          // عدّة مباشرة نجحت ⇒ أي نسخة معلّقة قديمة لنفس المنتج صارت لاغية.
          const stale = peekAll(code).find((q) => q.variantId === item.variantId);
          if (stale) removeQueued(code, stale.clientRequestId);
          setQueueCount(queueSize(code));
          setOnline(true);
          setSelected(null);
          setScannedUnit(null);
          // الخادم هو الحَكَم في نوع العدّة ونتيجة المطابقة — لا الواجهة.
          const kind = res.kind ?? mode;
          if (kind === "VERIFY") {
            if (res.verifyMatch === false)
              notify.warn("اختلف عدّك عن عدّ زميلك — رُفع تعارض للمسؤول للفصل");
            else if (res.verifyMatch === true)
              notify.ok("تطابق العدّان — تأكيد إضافي للموثوقية");
            else notify.ok("سُجّل العدّ التحقّقي");
          } else if (kind === "RECOUNT") {
            notify.ok("سُجّلت إعادة العدّ");
          } else {
            notify.ok("سُجّلت الكمية");
          }
          await utils.count.state.invalidate({ sessionCode: code });
        },
        onError: (error) => {
          if (!isNetworkError(error)) {
            // رفض خادميّ (سياسة الجلسة، إقفال العدّ…) — البطاقة تبقى مفتوحة برسالة الخادم.
            notify.err(error);
            return;
          }
          setOnline(false);
          const persisted = enqueue(code, {
            clientRequestId,
            variantId: item.variantId,
            qty,
            unitBreakdown,
            queuedAt: new Date().toISOString(),
          });
          setQueueCount(queueSize(code));
          setSelected(null);
          setScannedUnit(null);
          if (persisted) {
            notify.info(
              "لا اتصال — حُفظت الكمية على الجهاز",
              "ستُزامَن تلقائياً عند عودة الاتصال",
            );
          } else {
            notify.err("تعذّر الحفظ على هذا الجهاز — أعد المحاولة عند توفّر الاتصال");
          }
        },
      },
    );
  };

  const submitAssignment = async () => {
    if (!st) return;
    const zone = st.assignment.zone;
    const ok = await confirm({
      variant: "warning",
      title: "تسليم العدّ النهائي",
      description: `بعد التسليم لا يمكنك تعديل عدّك${zone ? ` — منطقة «${zone}»` : ""}. هل أنت متأكد؟`,
      confirmText: "تسليم العدّ",
    });
    if (!ok) return;
    finish.mutate(
      { sessionCode: code },
      {
        onSuccess: async (result) => {
          setShowListAfterSubmit(false);
          notify.ok(
            result.sessionMovedToReview
              ? "سُلّم العدّ — اكتمل الجرد وانتقلت الجلسة للمراجعة"
              : "سُلّم العدّ — شكراً لجهدك",
          );
          await Promise.all([
            utils.count.state.invalidate({ sessionCode: code }),
            utils.count.mine.invalidate(),
          ]);
        },
        onError: (error) => notify.err(error),
      },
    );
  };

  if (!code)
    return <p className="p-8 text-destructive">رابط مهمة الجرد غير صالح.</p>;
  if (state.isLoading)
    return (
      <p className="p-8 text-sm text-muted-foreground">جارٍ فتح مساحة الجرد…</p>
    );
  // انقطاعٌ شبكيّ بعد التحميل لا يطرد العامل: ما دامت لقطة الجلسة في الكاش يواصل العدّ
  // (يُحفظ محلياً ويُزامَن لاحقاً). شاشة العطل تظهر فقط حين لا توجد بيانات أصلاً.
  if (!st) {
    const offlineBoot = state.isError && isNetworkError(state.error);
    return (
      <Card className="mx-auto mt-10 max-w-2xl">
        <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
          {offlineBoot ? (
            <WifiOff className="size-10 text-stock-low" aria-hidden />
          ) : (
            <AlertTriangle className="size-10 text-stock-low" aria-hidden />
          )}
          <div>
            <p className="font-bold">
              {offlineBoot ? "لا اتصال بالشبكة" : "لا يمكن فتح مهمة الجرد بهذا الحساب"}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {offlineBoot
                ? "تعذّر تحميل منتجات الجلسة — تحقّق من الإنترنت ثم أعد المحاولة."
                : "يجب أن يكون تكليفك من نوع «حساب مستخدم داخل النظام». لا يوجد PIN في شاشة الحسابات."}
            </p>
            {!offlineBoot && (
              <p className="mt-2 text-xs text-destructive">
                {state.error ? errMsg(state.error) : ""}
              </p>
            )}
          </div>
          {offlineBoot ? (
            <Button variant="outline" onClick={() => void state.refetch()}>
              إعادة المحاولة
            </Button>
          ) : (
            <Link href="/my-stocktake">
              <Button variant="outline">العودة إلى جردي</Button>
            </Link>
          )}
        </CardContent>
      </Card>
    );
  }

  const overall = st.progress.session;
  const mine = st.progress.mine;
  const remaining = Math.max(0, overall.total - overall.counted);
  const overallPct = overall.total
    ? Math.round((overall.counted / overall.total) * 100)
    : 0;
  // العدّات المحفوظة محلياً تُحتسب في تقدّمي فوراً — العامل عدّها فعلاً وإن لم تُزامَن بعد.
  const queuedFresh = items.filter(
    (i) => i.myCount == null && queuedByVariant.has(i.variantId),
  ).length;
  const mineCounted = Math.min(mine.total, mine.counted + queuedFresh);
  const minePct = mine.total ? Math.round((mineCounted / mine.total) * 100) : 0;
  const canCount =
    st.session.status === "COUNTING" && st.assignment.status === "ACTIVE";
  const statusHint = canCount
    ? "قيد العدّ — يمكنك الحفظ والمتابعة لاحقاً."
    : st.assignment.status === "SUBMITTED"
      ? "تم تسليم عدّك للمراجعة."
      : "أغلقت الجلسة للمراجعة.";
  // التسليم نهائيّ ويحتاج خادماً: لا يُسمح به قبل مزامنة كل عدّة محفوظة محلياً.
  const canSubmitAssignment = canCount && online && queueCount === 0;
  const submitBlockedLabel = !online
    ? "التسليم يتطلّب اتصالاً — عدّك محفوظ"
    : queueCount > 0
      ? `بانتظار مزامنة ${fmtInt(queueCount)} عدّة`
      : null;

  /* ── حالات الجلسة المنتهية — بنصوص بوابة العدّ نفسها ── */
  if (st.session.status === "CANCELLED") {
    return (
      <StateCard
        icon={<Ban className="size-8" aria-hidden />}
        title="أُلغيت جلسة الجرد"
        body={`ألغى المسؤول هذه الجلسة — لا حاجة لمزيد من العدّ. شكراً لجهدك ${st.assignment.name}.`}
      />
    );
  }
  if (st.session.status === "APPROVED") {
    return (
      <StateCard
        icon={<Check className="size-8" aria-hidden />}
        tone="ok"
        title="اعتُمدت نتائج الجرد"
        body={`أُغلقت جلسة «${st.session.name}» واعتُمدت نتائجها — شكراً لمشاركتك ${st.assignment.name}.`}
      />
    );
  }
  if (st.session.status === "REVIEW" && st.assignment.status !== "SUBMITTED") {
    return (
      <StateCard
        icon={<Lock className="size-8" aria-hidden />}
        tone="low"
        title="أُقفل العدّ"
        body={`نقل المسؤول الجلسة لمرحلة المراجعة — لم يعد إدخال العدّ متاحاً. شكراً لجهدك ${st.assignment.name}.`}
      />
    );
  }

  /* ── تكليف مسلَّم: بطاقة شكر (ثم القائمة للقراءة فقط عند الطلب) ── */
  if (st.assignment.status === "SUBMITTED" && !showListAfterSubmit) {
    const movedToReview = st.session.status === "REVIEW";
    return (
      <Card className="mx-auto mt-10 max-w-2xl">
        <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
          <div className="badge-stock-ok grid size-20 place-items-center rounded-full">
            <Check className="size-10" aria-hidden />
          </div>
          <p className="flex items-center justify-center gap-2 text-xl font-bold">
            سلّمت عدّك — شكراً {st.assignment.name.split(" ")[0]}
            <PartyPopper className="size-5" aria-hidden />
          </p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {movedToReview
              ? "اكتمل العدّ من جميع العمّال — الجلسة الآن قيد مراجعة المسؤول."
              : `بانتظار بقية الزملاء — تقدّم الجلسة ${fmtInt(overall.counted)}/${fmtInt(overall.total)} منتجاً.`}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              className="py-2 text-sm font-bold text-primary"
              onClick={() => setShowListAfterSubmit(true)}
            >
              عرض منتجاتي (للقراءة فقط)
            </button>
            <Link href="/my-stocktake">
              <Button variant="outline">العودة إلى جردي</Button>
            </Link>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="mx-auto max-w-[1500px] space-y-4 p-1 sm:space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3 rounded-2xl border bg-card p-4 shadow-sm sm:p-6">
        <div className="min-w-0">
          <div className="mb-1.5 flex items-center gap-2 text-primary sm:mb-2">
            <ClipboardCheck className="size-4 sm:size-5" aria-hidden />
            <span className="text-xs font-bold sm:text-sm">
              مساحة عملي في الجرد
            </span>
          </div>
          <h1 className="truncate text-lg font-bold sm:text-2xl">
            {st.session.name}
          </h1>
          <p className="mt-1 text-xs text-muted-foreground sm:text-sm">
            {st.session.branchName} · مرحباً {st.assignment.name}
            {st.assignment.zone ? ` · المنطقة: ${st.assignment.zone}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {queueCount > 0 && (
            <span
              className="inline-flex items-center gap-1 rounded-xl bg-muted px-2.5 py-1.5 text-xs font-bold text-muted-foreground"
              title="عدّات محفوظة على الجهاز بانتظار المزامنة"
            >
              <Hourglass className="size-3.5" aria-hidden /> {fmtInt(queueCount)}
            </span>
          )}
          <span
            className={cn(
              "inline-block size-2.5 rounded-full",
              online ? "bg-[var(--stock-ok)]" : "bg-[var(--stock-out)]",
            )}
            title={online ? "متصل" : "لا اتصال"}
            aria-label={online ? "متصل" : "لا اتصال"}
          />
          {st.session.blind && (
            <div className="flex items-center gap-2 rounded-xl bg-primary/10 px-3 py-1.5 text-xs font-bold text-primary sm:px-4 sm:py-2 sm:text-sm">
              <ClipboardCheck className="size-4" aria-hidden /> جرد أعمى
            </div>
          )}
        </div>
      </header>

      {!online && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-muted px-4 py-2.5 text-xs font-bold text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <WifiOff className="size-3.5" aria-hidden /> لا اتصال — عدّك يُحفظ على
            الجهاز ويُزامَن تلقائياً عند عودة الشبكة
          </span>
          {queueCount > 0 && (
            <span className="rounded-full bg-background px-2 py-0.5">
              {fmtInt(queueCount)} بانتظار المزامنة
            </span>
          )}
        </div>
      )}

      {/* الهاتف: شريط تقدّم مضغوط + زرّ التسليم (بدل البطاقات الثلاث) */}
      <section className="rounded-2xl border bg-card p-4 sm:hidden">
        <div className="flex items-center justify-between gap-2 text-sm font-bold">
          <span>عدّي المسجّل</span>
          <span className="font-mono tabular-nums" dir="ltr">
            {fmtInt(mineCounted)} / {fmtInt(mine.total)}
          </span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-primary/10">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${Math.max(0, Math.min(100, minePct))}%` }}
          />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          تقدّم الجلسة {fmtInt(overall.counted)}/{fmtInt(overall.total)} ·{" "}
          {statusHint}
        </p>
        <Button
          className="mt-3 h-11 w-full"
          disabled={!canSubmitAssignment || finish.isPending}
          onClick={() => void submitAssignment()}
        >
          <Send className="size-4" aria-hidden />{" "}
          {submitBlockedLabel ?? "تسليم عدّي للمراجعة"}
        </Button>
      </section>

      <section className="hidden gap-4 sm:grid lg:grid-cols-3">
        <Metric
          title="تقدّم الجلسة"
          value={`${fmtInt(overall.counted)} / ${fmtInt(overall.total)}`}
          hint={`${fmtInt(remaining)} منتج متبقٍ`}
          pct={overallPct}
        />
        <Metric
          title="عدّي المسجّل"
          value={`${fmtInt(mineCounted)} / ${fmtInt(mine.total)}`}
          hint={
            queueCount > 0
              ? `منها ${fmtInt(queueCount)} محفوظة على الجهاز بانتظار المزامنة`
              : "عدد المنتجات التي أدخلتها أنت"
          }
          pct={minePct}
        />
        <Card className="gap-3 py-5">
          <CardHeader className="px-5">
            <CardTitle className="text-base">حالة المهمة</CardTitle>
            <CardDescription>{statusHint}</CardDescription>
          </CardHeader>
          <CardContent className="px-5">
            <Button
              className="w-full"
              disabled={!canSubmitAssignment || finish.isPending}
              onClick={() => void submitAssignment()}
            >
              <Send className="size-4" aria-hidden />{" "}
              {submitBlockedLabel ?? "تسليم عدّي للمراجعة"}
            </Button>
          </CardContent>
        </Card>
      </section>

      {canCount && st.recountTasks.length > 0 && (
        <div className="badge-stock-low rounded-xl border border-border p-4 text-sm">
          <p className="inline-flex items-center gap-1.5 font-bold">
            <RefreshCw className="size-3.5" aria-hidden /> مطلوب إعادة عدّ (
            {fmtInt(st.recountTasks.length)}):
          </p>
          <div className="mt-2 space-y-1.5">
            {st.recountTasks.map((task) => (
              <button
                key={task.variantId}
                type="button"
                onClick={() => {
                  const item = items.find((i) => i.variantId === task.variantId);
                  if (item) openItem(item);
                }}
                className="flex w-full items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2.5 text-right text-sm font-semibold transition hover:bg-muted/50"
              >
                <span className="min-w-0">
                  <span className="block truncate">
                    {task.productName}
                    {task.variantName ? (
                      <span className="font-normal text-muted-foreground">
                        {" "}
                        {task.variantName}
                      </span>
                    ) : null}
                  </span>
                  <span className="block truncate text-[11px] font-normal text-muted-foreground">
                    السبب: {task.reason}
                  </span>
                </span>
                <span className="shrink-0 text-xs">عدّ الآن ←</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <Card className="gap-0 overflow-hidden">
        <CardHeader className="border-b px-4 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <CardTitle className="text-base sm:text-lg">المنتجات</CardTitle>
              <CardDescription>
                امسح الباركود بكاميرا هاتفك أو بقارئ الحاسوب، أو ابحث ثم أدخل
                الكمية الفعلية.
              </CardDescription>
            </div>
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
              <div className="relative w-full min-w-0 flex-1 sm:w-80 sm:flex-none">
                <Search
                  className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    barcodeInput.handleKeyDown(e, setQuery);
                    if (e.defaultPrevented) return;
                    if (e.key === "Enter") {
                      e.preventDefault();
                      tryOpenByQuery();
                    }
                  }}
                  placeholder="بحث بالاسم أو SKU أو رقم الباركود…"
                  className={cn("h-11 pl-9", barcodeSearchInputClass)}
                />
                <BarcodeSearchCue />
              </div>
              <Button
                type="button"
                className="h-11 w-full shrink-0 gap-1.5 sm:w-auto"
                disabled={!canCount}
                onClick={() => setCameraOpen(true)}
              >
                <Camera className="size-4" aria-hidden /> مسح بالكاميرا
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="hidden border-b bg-muted/40 px-5 py-3 text-xs font-bold text-muted-foreground sm:flex sm:items-center sm:gap-3">
            <span className="min-w-0 flex-1">المنتج</span>
            <span className="w-[130px] shrink-0">حالة الجلسة</span>
            <span className="w-[110px] shrink-0">عدّي</span>
          </div>
          <div className="max-h-[52vh] overflow-y-auto">
            {filtered.map((item) => {
              const queued = queuedByVariant.get(item.variantId);
              // العدّة المحفوظة محلياً أحدث من المُزامَنة ⇒ هي المعروضة.
              const myQty = queued?.qty ?? item.myCount?.qty ?? null;
              return (
              <button
                key={item.variantId}
                type="button"
                onClick={() => openItem(item)}
                disabled={!canCount || item.reviewApproved}
                className="flex w-full items-center gap-3 border-b px-4 py-3 text-right transition hover:bg-muted/50 disabled:cursor-default sm:px-5"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-bold">
                    {productLabel(item)}
                  </span>
                  <span
                    className="mt-0.5 block truncate font-mono text-xs text-muted-foreground"
                    dir="ltr"
                  >
                    {item.sku ||
                      item.units.find((u) => u.barcode)?.barcode ||
                      "—"}
                  </span>
                </span>
                <span className="shrink-0 text-xs sm:w-[130px] sm:text-sm">
                  {item.reviewApproved ? (
                    <span className="inline-flex items-center gap-1 text-[var(--stock-ok)]">
                      <CheckCircle2 className="size-4" aria-hidden /> معتمد إدارياً
                    </span>
                  ) : queued ? (
                    <span className="inline-flex items-center gap-1 text-muted-foreground">
                      <Hourglass className="size-4" aria-hidden /> بانتظار المزامنة
                    </span>
                  ) : item.counted ? (
                    <span className="inline-flex items-center gap-1 text-[var(--stock-ok)]">
                      <CheckCircle2 className="size-4" aria-hidden /> معدود
                    </span>
                  ) : (
                    <span className="text-muted-foreground">غير معدود</span>
                  )}
                </span>
                <span className="w-14 shrink-0 text-left sm:w-[110px] sm:text-right">
                  {myQty != null ? (
                    <span className="font-mono text-primary" dir="ltr">
                      {fmtInt(myQty)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </span>
              </button>
              );
            })}
            {filtered.length === 0 && (
              <p className="p-10 text-center text-sm text-muted-foreground">
                {needle
                  ? `لا نتائج للبحث «${query.trim()}»`
                  : "لا توجد منتجات في هذه الجلسة."}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <Dialog
        open={selected != null}
        onOpenChange={(open) => {
          if (!open && !submit.isPending) {
            setSelected(null);
            setScannedUnit(null);
          }
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-right">
              {selected ? productLabel(selected) : ""}
            </DialogTitle>
          </DialogHeader>
          {selected && (
            <QtyEditor
              key={`${selected.variantId}-${selectedMode}`}
              item={selected}
              mode={selectedMode}
              recountReason={recountReasonByVariant.get(selected.variantId)}
              queued={queuedByVariant.get(selected.variantId)}
              focusUnit={scannedUnit}
              saving={submit.isPending}
              onCancel={() => {
                setSelected(null);
                setScannedUnit(null);
              }}
              onSave={save}
            />
          )}
        </DialogContent>
      </Dialog>

      <CameraScanner
        open={cameraOpen}
        onClose={() => setCameraOpen(false)}
        onDetect={(raw) => {
          setCameraOpen(false);
          onBarcode(raw);
        }}
      />
    </div>
  );
}

/* ───────────────────── بطاقة إدخال الكمية (وحدات متعددة) ───────────────────── */

function QtyEditor({
  item,
  mode,
  recountReason,
  queued,
  focusUnit,
  saving,
  onCancel,
  onSave,
}: {
  item: CountItem;
  mode: CountMode;
  recountReason?: string;
  /** عدّة محفوظة على الجهاز لم تُزامَن بعد — أحدث من `item.myCount` فتسبقها في التعبئة. */
  queued?: QueuedCount;
  focusUnit: string | null;
  saving: boolean;
  onCancel: () => void;
  onSave: (qty: number, unitBreakdown: string | undefined) => void;
}) {
  const isVerify = mode === "VERIFY";
  const isRecount = mode === "RECOUNT";
  // من الأكبر للأصغر (كرتون ← درزن ← قطعة) — نفس ترتيب بوابة العدّ.
  const units = useMemo(() => {
    const list = item.units.map((u) => ({ unitName: u.unitName, factor: u.factor }));
    if (list.length === 0) list.push({ unitName: "قطعة", factor: 1 });
    return list.sort((a, b) => b.factor - a.factor);
  }, [item.units]);
  const baseUnit = baseUnitName(item);

  const [vals, setVals] = useState<Record<string, string>>(() => {
    // إعادة العدّ والعدّ التحقّقي عدٌّ جديد **أعمى** يبدأ من الصفر (كبوابة العدّ) — التعبئة
    // المسبقة للعدّ الأول فقط: المحفوظ محلياً أولاً (الأحدث) ثم المُزامَن.
    if (mode !== "FIRST") return {};
    const src = queued?.unitBreakdown ?? item.myCount?.unitBreakdown ?? null;
    if (src) {
      try {
        const parsed = JSON.parse(src) as Record<string, unknown>;
        const init: Record<string, string> = {};
        for (const u of item.units) {
          const v = parsed[u.unitName];
          if (typeof v === "number" && Number.isInteger(v) && v >= 0)
            init[u.unitName] = String(v);
        }
        if (Object.keys(init).length > 0) return init;
      } catch {
        /* تفصيل غير قابل للقراءة — نبدأ من الإجمالي */
      }
    }
    const fallbackQty = queued?.qty ?? item.myCount?.qty ?? null;
    if (fallbackQty != null) return { [baseUnitName(item)]: String(fallbackQty) };
    return {};
  });

  const setVal = (unitName: string, raw: string) =>
    setVals((v) => ({ ...v, [unitName]: raw.replace(/\D/g, "").slice(0, 7) }));
  const step = (unitName: string, delta: number) =>
    setVals((v) => {
      const cur = parseInt(v[unitName] || "0", 10) || 0;
      return { ...v, [unitName]: String(Math.max(0, cur + delta)) };
    });

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
    onSave(total, units.length > 1 && json.length <= 500 ? json : undefined);
  };

  return (
    <div className="space-y-4">
      {isRecount && (
        <p className="badge-stock-low inline-flex items-start gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold leading-relaxed">
          <RefreshCw className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            مطلوب إعادة عدّ ثانية لهذا المنتج
            {recountReason ? ` — السبب: ${recountReason}` : ""}. عُدّ من جديد
            بتمعّن.
          </span>
        </p>
      )}
      {isVerify && (
        <p className="inline-flex items-start gap-1.5 rounded-lg bg-primary/10 px-3 py-2 text-xs font-semibold leading-relaxed text-primary">
          <span className="mt-0.5 inline-flex shrink-0 items-center -space-x-1 rtl:space-x-reverse">
            <Check className="size-3.5" aria-hidden />
            <Check className="size-3.5" aria-hidden />
          </span>
          <span>
            عدّ تحقّقي — المنتج عدّه زميلك سابقاً. عدّك لن يستبدل عدّه: إن تطابقا
            تأكّد الرقم، وإن اختلفا يُرفع تعارض يفصل فيه المسؤول. (كميته لا تُعرض
            لك — جرد أعمى)
          </span>
        </p>
      )}
      {queued && (
        <p className="inline-flex items-start gap-1.5 rounded-lg bg-muted p-3 text-xs font-semibold text-muted-foreground">
          <Hourglass className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            عدّتك السابقة لهذا المنتج محفوظة على الجهاز ولم تُزامَن بعد — تعديلها
            هنا يستبدلها، وتُرسَل تلقائياً عند عودة الاتصال.
          </span>
        </p>
      )}
      <div className="rounded-lg border bg-muted/30 p-3 text-sm">
        <p className="font-mono text-xs text-muted-foreground" dir="ltr">
          {item.sku || item.units.find((u) => u.barcode)?.barcode || "—"}
        </p>
        <p className="mt-2 text-muted-foreground">
          أدخل الكمية الفعلية على الرف — لكل وحدة حقلها، والإجمالي يُحتسب
          بـ«{baseUnit}».
        </p>
      </div>

      <div className="space-y-2">
        {units.map((u) => {
          const cur = vals[u.unitName] ?? "";
          return (
            <div
              key={u.unitName}
              className={cn(
                "flex items-center gap-2 rounded-xl border bg-card px-3 py-2.5",
                focusUnit === u.unitName && "border-primary ring-1 ring-primary/40",
              )}
            >
              <div className="min-w-0 flex-1">
                <span className="block text-sm font-bold">{u.unitName}</span>
                <span className="block text-[11px] text-muted-foreground">
                  {u.factor === 1
                    ? "وحدة الأساس"
                    : `= ${fmtInt(u.factor)} ${baseUnit}`}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1.5" dir="ltr">
                <button
                  type="button"
                  aria-label={`إنقاص ${u.unitName}`}
                  onClick={() => step(u.unitName, -1)}
                  disabled={(parseInt(cur || "0", 10) || 0) === 0}
                  className="grid size-11 place-items-center rounded-lg border bg-background text-xl font-bold active:scale-95 disabled:opacity-40"
                >
                  −
                </button>
                <Input
                  autoFocus={focusUnit ? focusUnit === u.unitName : u.factor === 1}
                  inputMode="numeric"
                  dir="ltr"
                  value={cur}
                  placeholder="0"
                  onChange={(e) => setVal(u.unitName, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSave();
                  }}
                  aria-label={`كمية ${u.unitName}`}
                  className="h-11 w-20 text-center font-mono text-lg font-bold"
                />
                <button
                  type="button"
                  aria-label={`زيادة ${u.unitName}`}
                  onClick={() => step(u.unitName, 1)}
                  className="grid size-11 place-items-center rounded-lg border bg-background text-xl font-bold active:scale-95"
                >
                  +
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between rounded-xl bg-primary/5 px-4 py-3">
        <span className="text-sm font-bold">الإجمالي بالوحدة الأساس</span>
        <span
          className="font-mono text-xl font-bold tabular-nums text-primary"
          dir="ltr"
        >
          {fmtInt(total)} {baseUnit}
        </span>
      </div>

      <DialogFooter className="flex-col gap-2 sm:flex-row">
        <Button variant="outline" disabled={saving} onClick={onCancel}>
          إلغاء
        </Button>
        <Button disabled={saving || !valid} onClick={handleSave}>
          {saving
            ? "جارٍ الحفظ…"
            : isVerify
              ? "تسجيل العدّ التحقّقي"
              : isRecount
                ? "تسجيل إعادة العدّ"
                : "تسجيل الكمية"}
        </Button>
      </DialogFooter>
      <p className="text-center text-[11px] text-muted-foreground">
        يُسجَّل الإدخال باسمك ووقته — يمكنك تعديل العدّ قبل التسليم.
      </p>
    </div>
  );
}

/** بطاقة حالةٍ نهائية (أُلغيت/اعتُمدت/أُقفلت) بنصوص بوابة العدّ نفسها. */
function StateCard({
  icon,
  title,
  body,
  tone = "muted",
}: {
  icon: ReactNode;
  title: string;
  body: string;
  tone?: "muted" | "ok" | "low";
}) {
  return (
    <Card className="mx-auto mt-10 max-w-2xl">
      <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
        <div
          className={cn(
            "grid size-16 place-items-center rounded-full",
            tone === "ok"
              ? "badge-stock-ok"
              : tone === "low"
                ? "badge-stock-low"
                : "bg-muted text-muted-foreground",
          )}
        >
          {icon}
        </div>
        <p className="text-lg font-bold">{title}</p>
        <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
          {body}
        </p>
        <Link href="/my-stocktake">
          <Button variant="outline">العودة إلى جردي</Button>
        </Link>
      </CardContent>
    </Card>
  );
}

function Metric({
  title,
  value,
  hint,
  pct,
}: {
  title: string;
  value: string;
  hint: string;
  pct: number;
}) {
  return (
    <Card className="gap-3 py-5">
      <CardHeader className="px-5">
        <CardTitle className="text-base">{title}</CardTitle>
        <div className="text-2xl font-bold tabular-nums" dir="ltr">
          {value}
        </div>
        <CardDescription>{hint}</CardDescription>
      </CardHeader>
      <CardContent className="px-5">
        <div className="h-2 overflow-hidden rounded-full bg-primary/10">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
          />
        </div>
      </CardContent>
    </Card>
  );
}
