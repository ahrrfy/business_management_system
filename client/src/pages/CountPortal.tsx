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
import { useLocation, useParams } from "wouter";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { trpc } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";
import { notify, errMsg } from "@/lib/notify";
import { isNetworkError } from "@/lib/netError";
import { fmtInt } from "@/lib/money";
import { confirm } from "@/lib/confirm";
import { openWhatsApp } from "@/lib/whatsapp";
import { useBarcodeScanner } from "@/hooks/useBarcodeScanner";
import { useBarcodeInput } from "@/hooks/useBarcodeInput";
import { BarcodeSearchCue, barcodeSearchInputClass } from "@/components/scan/BarcodeSearchCue";
import { ProductScanIdentityCard } from "@/components/scan/ProductScanIdentityCard";
import { usePulsedCountState } from "@/hooks/usePulsedCountState";
import type { PortalState } from "@shared/countPortalMerge";
import {
  resolveProductBarcodeMatch,
  type ProductBarcodeMatch,
} from "@shared/productScan";
import type { CountEntryMethod } from "@shared/stocktakeCountMethod";
import { CameraScanner } from "@/components/scan/CameraScanner";
import { cn } from "@/lib/utils";
import {
  WifiOff,
  Check,
  Hourglass,
  Lock,
  Ban,
  Send,
  Camera,
  RefreshCw,
  PartyPopper,
  ChevronUp,
  ChevronDown,
  Hand,
  ScanLine,
  ListPlus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import {
  enqueue,
  peekAll,
  remove as removeQueued,
  size as queueSize,
  newClientRequestId,
  enqueueUnknown,
  peekUnknown,
  removeUnknown,
  type QueuedCount,
} from "@/lib/countQueue";

// النوع من الوحدة المشتركة مباشرةً: `count.state` صار غلافاً (كتالوج + متغيّر) تُركّبه
// `usePulsedCountState`، فاشتقاق النوع من شكل الردّ لم يعد يمثّل الحالة المعروضة.
type CountState = PortalState;
type CountItem = CountState["items"][number];
type CountMode = "FIRST" | "RECOUNT" | "VERIFY";

/* ─────────────────────────── مساعدات ─────────────────────────── */

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

/** يحلّ الباركود عبر العقد المشترك ويعيد الصنف والوحدة المطابقين معاً. */
function findBarcodeMatch(
  items: readonly CountItem[],
  raw: string,
): { item: CountItem; match: ProductBarcodeMatch } | null {
  for (const item of items) {
    const match = resolveProductBarcodeMatch(item.units, raw);
    if (match) return { item, match };
  }
  return null;
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
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  // رابط /count مخصص للعامل الخارجي فقط. إذا كان المتصفح يحمل حساب نظام،
  // ننقله إلى مساحة الحاسوب كي لا يظهر له PIN أو واجهة الهاتف.
  const account = trpc.auth.me.useQuery(undefined, { retry: false });

  const [phase, setPhase] = useState<"boot" | "pin" | "counting" | "paused">("boot");
  // يزيد عند كل تبدّل هوية (دخول/خروج) ⇒ يُصفّر كاش الحالة كي لا يرى العادّ الجديد بيانات سابقه.
  const [identityEpoch, setIdentityEpoch] = useState(0);
  const [bootOffline, setBootOffline] = useState(false);
  const [pin, setPin] = useState("");
  const [authErr, setAuthErr] = useState<string | null>(null);

  const [online, setOnline] = useState<boolean>(() => typeof navigator === "undefined" || navigator.onLine);
  const [queueCount, setQueueCount] = useState<number>(() => (code ? queueSize(code) : 0));

  const [q, setQ] = useState("");
  const [openVariantId, setOpenVariantId] = useState<number | null>(null);
  // كيف فُتحت البطاقة (نسبُ العدّة): مسحٌ فعليّ يحمل باركوده، أو اختيار حرّ/يدويّ.
  const [openEntry, setOpenEntry] = useState<{
    method: CountEntryMethod;
    scannedBarcode: string | null;
  }>({ method: "SEARCH_PICK", scannedBarcode: null });
  const [cameraOpen, setCameraOpen] = useState(false);
  const [flashId, setFlashId] = useState<number | null>(null);
  // وضع التجميع (ب-٥، لكل جهاز): كل مسحة تزيد الوحدة الممسوحة +١ في البطاقة المفتوحة —
  // لأرفف القطع الكثيرة. bump يبلّغ QtySheet بزيادةٍ عبر token تصاعديّ.
  const [tallyMode, setTallyMode] = useState(false);
  const [bump, setBump] = useState<{ unit: string; token: number } | null>(null);
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

  useEffect(() => {
    if (account.data && code) navigate(`/my-stocktake/${encodeURIComponent(code)}`, { replace: true });
  }, [account.data, code, navigate]);

  if (account.data) return null;

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
          onSuccess: () => {
            setIdentityEpoch((n) => n + 1);
            setPhase("counting");
          },
          onError: (e) => {
            setPin("");
            setAuthErr(isNetworkError(e) ? "لا اتصال بالشبكة — تحقّق من الإنترنت وحاول مجدداً." : errMsg(e));
          },
        },
      );
    },
    [authMut, code],
  );

  /* ── حالة الجلسة (متابعة حيّة كل ٥ ثوانٍ عبر نبضةٍ رخيصة — usePulsedCountState) ── */
  const stateQ = usePulsedCountState(code, phase === "counting" && code !== "", identityEpoch);
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
    const pendingUnknown = peekUnknown(code);
    if (pending.length === 0 && pendingUnknown.length === 0) return;
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
            entryMethod: it.entryMethod,
            scannedBarcode: it.scannedBarcode ?? undefined,
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
          const serverCode = (e as { data?: { code?: string } | null }).data?.code;
          if (serverCode === "PRECONDITION_FAILED") {
            notify.warn(
              "استُبعدت عدّة محفوظة لأنها لم تعد صالحة",
              `${errMsg(e)} — لم تُعَد المحاولة، وجرى تحديث حالة المنتج من الخادم.`,
            );
            void utils.count.state.invalidate();
          } else {
            notify.warn("تعذّرت مزامنة عدّة محفوظة", errMsg(e));
          }
        }
      }
      // طابور الباركود المجهول (مراجعة Codex #2): يُزامَن كالعدّات فلا يضيع أوفلاين.
      for (const u of pendingUnknown) {
        try {
          await utils.client.count.submit.mutate({
            sessionCode: code,
            unknownBarcode: u.barcode,
            clientRequestId: u.clientRequestId,
          });
          removeUnknown(code, u.clientRequestId);
        } catch (e) {
          if (isNetworkError(e)) {
            setOnline(false);
            break;
          }
          // رفضٌ خادميّ نهائيّ (جلسة لم تعد COUNTING مثلاً) — لا معنى للإبقاء.
          removeUnknown(code, u.clientRequestId);
        }
      }
    } finally {
      flushing.current = false;
      setQueueCount(queueSize(code) + peekUnknown(code).length);
      if (synced > 0) {
        setOnline(true);
        notify.ok(`عاد الاتصال — تمت مزامنة ${fmtInt(synced)} عدّة محفوظة محلياً`);
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
        // الباركودات تُخفَّض أيضاً — الإبرة مُخفَّضة سلفاً، وباركود بحروف كبيرة كان لا يُطابَق أبداً.
        i.units.some(
          (u) =>
            (u.barcode ?? "").toLowerCase().includes(needle) ||
            u.aliases.some((a) => a.toLowerCase().includes(needle)),
        )
      );
    },
    [needle],
  );

  // Every worker receives the same blind product list; allocation happens in the field.
  const myAll = items;
  const myFiltered = useMemo(() => myAll.filter(matches), [myAll, matches]);
  const otherAll: CountItem[] = [];
  const otherFiltered = useMemo(() => otherAll.filter(matches), [otherAll, matches]);

  /** «معدود» محلياً = عدّي المُزامَن أو عدّة معلّقة بالطابور. */
  const hasMyCount = useCallback(
    (i: CountItem) => i.myCount != null || queuedByVariant.has(i.variantId),
    [queuedByVariant],
  );
  const effCounted = st?.progress.session.counted ?? 0;
  const pendingRecounts = st?.recountTasks.length ?? 0;
  const sessionTotal = st?.progress.session.total ?? myAll.length;
  const allDone = sessionTotal > 0 ? effCounted >= sessionTotal && pendingRecounts === 0 : pendingRecounts === 0;
  const remaining = Math.max(0, sessionTotal - effCounted) + pendingRecounts;

  const sessionStatus = st?.session.status ?? "COUNTING";
  const submittedAssignment = finished != null || st?.assignment.status === "SUBMITTED";
  const canCount = phase === "counting" && sessionStatus === "COUNTING" && !submittedAssignment;
  const dupBlocked = st?.session.dupPolicy === "BLOCK";
  // أسلوب الجلسة: المسح الإلزامي يمنع فتح البطاقة بالنقر — لا يُفتح العدّ إلا بمسحٍ فعليّ.
  // الإنفاذ النهائيّ خادميّ (submit يعيد حلّ الباركود)؛ هذا يمنع الاستسهال في الواجهة.
  const scanRequired = st?.session.countMethod === "SCAN_REQUIRED";

  /* ── فتح بطاقة العدّ ── */
  const openCard = useCallback(
    (
      i: CountItem,
      entry: { method: CountEntryMethod; scannedBarcode: string | null } = {
        method: "SEARCH_PICK",
        scannedBarcode: null,
      },
    ) => {
      if (!canCount) return;
      if (dupBlocked && i.colleagueCounted && !i.myCount) {
        notify.info(
          i.colleagueCounted
            ? "المنتج معدود من زميلك — سياسة الجلسة تمنع العدّ المكرر"
            : "المنتج من منطقة زميل — اطلب من المسؤول إسناده إليك",
        );
        return;
      }
      // المسح الإلزامي: النقر/الاختيار الحر لا يفتح البطاقة — امسح باركود الصنف.
      if (
        scanRequired &&
        entry.method !== "SCAN_HID" &&
        entry.method !== "SCAN_CAMERA"
      ) {
        notify.info(
          "هذه الجلسة بأسلوب المسح الإلزامي",
          "امسح باركود الصنف (قارئ أو كاميرا) لفتح بطاقة العدّ.",
        );
        return;
      }
      // كل فتحٍ يبدأ بـ bump نظيف؛ مسار مسح التجميع وحده يُعيد ضبطه بعد هذا (منع +١ وهميّ
      // من token قديم عند الفتح بالنقر/البحث أثناء تفعيل التجميع).
      setBump(null);
      setOpenEntry(entry);
      setOpenVariantId(i.variantId);
    },
    [canCount, dupBlocked, scanRequired],
  );

  const handleBarcode = useCallback(
    (raw: string, source: "SCAN_HID" | "SCAN_CAMERA" = "SCAN_HID") => {
      const scanned = raw.trim();
      if (!scanned) return;
      const resolved = findBarcodeMatch(items, scanned);
      if (!resolved) {
        // باركودٌ خارج الجلسة (ب-٤): لا يضيع — يُوضَع في طابورٍ يُزامَن (كالعدّات) فيصمد الانقطاع
        // (مراجعة Codex #2: الإرسال-وانسَ كان يفقده أوفلاين رغم إبلاغ العامل بأنّه سُجّل).
        if (canCount) {
          const queued = enqueueUnknown(code, {
            clientRequestId: newClientRequestId(),
            barcode: scanned,
            queuedAt: new Date().toISOString(),
          });
          setQueueCount(queueSize(code) + peekUnknown(code).length);
          if (queued) {
            notify.warn(
              "الباركود غير موجود ضمن منتجات الجلسة — سُجّل للمشرف (يُزامَن تلقائياً)",
              scanned,
            );
          } else {
            notify.err(
              "تعذّر حفظ الباركود — طابور الجهاز ممتلئ أو غير متاح",
              "اتصل بالشبكة ثم أعد المسح، وأبلغ المشرف إذا استمر العطل.",
            );
          }
        } else {
          notify.warn("الباركود غير موجود ضمن منتجات هذه الجلسة", scanned);
        }
        return;
      }
      const { item: hit, match } = resolved;
      const unitName = match.unitName;
      // وضع التجميع: مسحٌ متكرّر للبطاقة المفتوحة يزيد وحدته +١؛ وصنفٌ آخر يلزمه حفظ الحالي أولاً.
      if (tallyMode && openVariantId != null) {
        if (openVariantId === hit.variantId) {
          setBump((b) => ({ unit: unitName, token: (b?.token ?? 0) + 1 }));
        } else {
          notify.info(
            "احفظ العدّة الحالية قبل الانتقال لصنفٍ آخر",
            "في وضع التجميع اعدّ صنفاً واحداً حتى تحفظه ثم امسح التالي.",
          );
        }
        return;
      }
      setFlashId(hit.variantId);
      window.setTimeout(() => setFlashId(null), 600);
      openCard(hit, { method: source, scannedBarcode: scanned });
      // فتحُ بطاقةٍ في وضع التجميع يبدأ الوحدة الممسوحة عند ١ (عدٌّ طازج بالمسح).
      if (tallyMode) setBump({ unit: unitName, token: 1 });
    },
    [items, openCard, canCount, code, utils, tallyMode, openVariantId],
  );
  const barcodeInput = useBarcodeInput((code) => {
    setQ("");
    handleBarcode(code, "SCAN_HID");
  });

  useBarcodeScanner((raw) => handleBarcode(raw, "SCAN_HID"), {
    // في وضع التجميع يبقى القارئ حيّاً والبطاقة مفتوحة (كل مسحة +١)؛ وإلا يُعطَّل أثناء الفتح.
    enabled:
      phase === "counting" &&
      canCount &&
      (openVariantId == null || tallyMode),
  });

  /** Enter في حقل البحث: تطابق حرفي مع باركود/SKU ⇒ افتح البطاقة (اختيار يدويّ لا مسح). */
  const tryOpenByQuery = useCallback(() => {
    const exact = q.trim();
    if (!exact) return;
    const hit =
      findBarcodeMatch(items, exact)?.item ??
      items.find((i) => (i.sku ?? "") === exact);
    if (hit) {
      setQ("");
      setFlashId(hit.variantId);
      window.setTimeout(() => setFlashId(null), 600);
      openCard(hit, { method: "SEARCH_PICK", scannedBarcode: null });
    }
  }, [q, items, openCard]);

  /* ── حفظ العدّ ── */
  const submitMut = trpc.count.submit.useMutation();
  const openItem = openVariantId != null ? items.find((i) => i.variantId === openVariantId) ?? null : null;
  const openScanMatch = useMemo(
    () =>
      openItem && openEntry.scannedBarcode
        ? resolveProductBarcodeMatch(openItem.units, openEntry.scannedBarcode)
        : null,
    [openItem, openEntry.scannedBarcode],
  );
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
      // نسبُ العدّة كما فُتحت البطاقة — الخادم يعيد حلّ الباركود ويطابقه في المسح الإلزامي.
      const entryMethod = openEntry.method;
      const scannedBarcode = openEntry.scannedBarcode;
      submitMut.mutate(
        {
          sessionCode: code,
          variantId: item.variantId,
          qty,
          unitBreakdown,
          entryMethod,
          scannedBarcode: scannedBarcode ?? undefined,
          clientRequestId,
        },
        {
          onSuccess: (res) => {
            // عدّة مباشرة نجحت ⇒ أي نسخة معلّقة قديمة لنفس المنتج صارت لاغية.
            const stale = peekAll(code).find((qc) => qc.variantId === item.variantId);
            if (stale) removeQueued(code, stale.clientRequestId);
            setQueueCount(queueSize(code));
            setOpenVariantId(null);
            // الخادم هو الحَكَم في نوع العدّ ونتيجة المطابقة. ⚠️ كان يُقرأ `isConflict` وهو حقل
            // لا يُعيده `count.submit` أصلاً (يُعيد `verifyMatch`) ⇒ لم تظهر رسالة التعارض قط.
            const kind = res.kind ?? mode;
            if (kind === "VERIFY") {
              if (res.verifyMatch === false) notify.warn("اختلف عدّك عن عدّ زميلك — رُفع تعارض للمسؤول للفصل");
              else if (res.verifyMatch === true) notify.ok("تطابق العدّان — تأكيد إضافي للموثوقية");
              else notify.ok("سُجّل العدّ التحقّقي");
            } else if (kind === "RECOUNT") {
              notify.ok("سُجّلت إعادة العدّ");
            } else {
              notify.ok("سُجّلت الكمية");
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
                entryMethod,
                scannedBarcode,
                queuedAt: new Date().toISOString(),
              });
              setQueueCount(queueSize(code));
              setOpenVariantId(null);
              if (persisted) {
                notify.info("لا اتصال — حُفظت الكمية محلياً", "سيُزامَن العدّ تلقائياً عند عودة الاتصال");
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
    [code, submitMut, utils, openEntry],
  );

  /* ── التسليم النهائي ── */
  const finishMut = trpc.count.finish.useMutation();
  const logoutMut = trpc.count.logout.useMutation();
  const doPause = useCallback(() => {
    if (!online || queueCount > 0 || logoutMut.isPending) return;
    logoutMut.mutate(undefined, {
      onSuccess: () => {
        setIdentityEpoch((n) => n + 1);
        setPhase("paused");
        notify.ok("حُفظت العدّات وأنهيت الوردية", "يمكنك العودة لاحقاً وإكمال الجرد من نفس التقدم.");
      },
      onError: (e) => notify.err(e),
    });
  }, [logoutMut, online, queueCount]);
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
          notify.ok(moved ? "سُلّم العدّ — اكتمل الجرد وانتقلت الجلسة للمراجعة" : "سُلّم العدّ — شكراً لجهدك");
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
          <p className="flex items-center justify-center gap-2 text-lg font-bold">
            <WifiOff aria-hidden className="size-5" /> لا اتصال بالشبكة
          </p>
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

  if (phase === "paused") {
    return frame(
      <CenterScreen>
        <div className="badge-status-active grid size-16 place-items-center rounded-full">
          <Check aria-hidden className="size-8" />
        </div>
        <p className="text-lg font-bold">حُفظت الوردية</p>
        <p className="text-sm leading-relaxed text-muted-foreground">الجلسة ما زالت قيد العدّ. يمكنك العودة في أي يوم والمتابعة من حيث توقفت.</p>
        <Button size="lg" className="h-12 text-base font-bold" onClick={() => void boot()}>
          متابعة الجرد
        </Button>
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
          <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            {isNetworkError(stateQ.error) ? (
              <>
                <WifiOff aria-hidden className="size-4" /> لا اتصال بالشبكة — سنعيد المحاولة تلقائياً.
              </>
            ) : (
              errMsg(stateQ.error)
            )}
          </p>
          <Button size="lg" className="w-44" onClick={() => void stateQ.refetch()}>
            إعادة المحاولة
          </Button>
        </CenterScreen>
      ) : (
        <CenterScreen>
          <BrandMark />
          <p className="text-sm font-semibold text-muted-foreground">جارٍ تحميل منتجاتك…</p>
        </CenterScreen>
      ),
    );
  }

  /* ── حالات الجلسة المنتهية (مهذبة) ── */
  if (sessionStatus === "CANCELLED") {
    return frame(
      <CenterScreen>
        <div className="grid size-16 place-items-center rounded-full bg-muted text-muted-foreground">
          <Ban aria-hidden className="size-8" />
        </div>
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
        <div className="grid size-16 place-items-center rounded-full bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]">
          <Check aria-hidden className="size-8" />
        </div>
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
      `سلّمت عدّي — جلسة الجرد «${st.session.name}» (${st.session.code})`,
      `العامل: ${st.assignment.name}`,
      st.assignment.zone ? `المنطقة: ${st.assignment.zone}` : "",
      `تقدّم الجلسة: ${fmtInt(sessionProgress.counted)}/${fmtInt(sessionProgress.total)}`,
    ]
      .filter(Boolean)
      .join("\n");
    return frame(
      <CenterScreen>
        <div className="grid size-20 place-items-center rounded-full bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]">
          <Check aria-hidden className="size-10" />
        </div>
        <p className="flex items-center justify-center gap-2 text-xl font-bold">
          سلّمت عدّك — شكراً {st.assignment.name.split(" ")[0]}
          <PartyPopper aria-hidden className="size-5" />
        </p>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {movedToReview
            ? "اكتمل العدّ من جميع العمّال — الجلسة الآن قيد مراجعة المسؤول."
            : `بانتظار بقية الزملاء — تقدّم الجلسة ${fmtInt(sessionProgress.counted)}/${fmtInt(sessionProgress.total)} منتجاً.`}
        </p>
        {waNotify && (
          <Button variant="outline" size="lg" className="h-12 w-60 text-base font-bold" onClick={() => openWhatsApp(null, waMsg)}>
            <Send aria-hidden className="size-4" /> إبلاغ المسؤول عبر واتساب
          </Button>
        )}
        <button type="button" className="py-2 text-sm font-bold text-primary" onClick={() => setShowListAfterSubmit(true)}>
          عرض منتجاتي (للقراءة فقط)
        </button>
      </CenterScreen>,
    );
  }

  /* ── أُقفل العدّ يدوياً (الجلسة للمراجعة وتكليفي ما زال نشطاً) ── */
  if (sessionStatus === "REVIEW" && !submittedAssignment) {
    return frame(
      <CenterScreen>
        <div className="grid size-16 place-items-center rounded-full bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]">
          <Lock aria-hidden className="size-8" />
        </div>
        <p className="text-lg font-bold">أُقفل العدّ</p>
        <p className="text-sm leading-relaxed text-muted-foreground">
          نقل المسؤول الجلسة لمرحلة المراجعة — لم يعد إدخال العدّ متاحاً. شكراً لجهدك {st.assignment.name}.
        </p>
      </CenterScreen>,
    );
  }

  /* ── الشاشة الرئيسية: ترويسة + مهام إعادة العدّ + بحث + قائمة + تسليم ── */
  const firstName = st.assignment.name.split(" ")[0];
  const pct = sessionTotal > 0 ? Math.min(100, Math.round((effCounted / sessionTotal) * 100)) : 0;
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
            <p className="mt-0.5 flex items-center gap-1 text-[12px] text-muted-foreground">
              مرحباً {firstName}
              <Hand aria-hidden className="size-3.5" />
              {st.assignment.zone ? <span>· منطقتك: {st.assignment.zone}</span> : null}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
            {queueCount > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-[var(--sem-warn-bg)] px-2 py-0.5 text-[11px] font-bold text-[var(--sem-warn)]" title="عدّات بانتظار المزامنة">
                <Hourglass aria-hidden className="size-3" /> {fmtInt(queueCount)}
              </span>
            )}
            {st.session.blind && (
              <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-bold text-violet-700 dark:bg-violet-950 dark:text-violet-300">
                جرد أعمى
              </span>
            )}
            <span
              className={cn(
                "inline-block size-2.5 rounded-full",
                online ? "bg-[var(--sem-pos)]" : "bg-[var(--sem-neg)]",
              )}
              title={online ? "متصل" : "لا اتصال"}
              aria-label={online ? "متصل" : "لا اتصال"}
            />
          </div>
        </div>
        <div className="mt-2.5 flex items-center gap-2">
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-primary/15">
            <div
              className={cn("h-full rounded-full transition-all", allDone ? "bg-[var(--sem-pos)]" : "bg-primary")}
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="text-xs font-bold tabular-nums" dir="ltr">
            {fmtInt(effCounted)}/{fmtInt(sessionTotal)}
          </span>
        </div>
      </header>

      {/* مؤشر انقطاع الاتصال */}
      {!online && (
        <div className="flex items-center justify-between border-b border-[var(--sem-warn)]/30 bg-[var(--sem-warn-bg)] px-4 py-2 text-xs font-bold text-[var(--sem-warn)]">
          <span className="inline-flex items-center gap-1.5">
            <WifiOff aria-hidden className="size-3.5" /> لا اتصال — العدّ يُحفظ محلياً
          </span>
          {queueCount > 0 && (
            <span className="rounded-full bg-[var(--sem-warn-bg)] px-2 py-0.5">{fmtInt(queueCount)} بانتظار المزامنة</span>
          )}
        </div>
      )}

      {/* مهام إعادة العدّ */}
      {canCount && st.recountTasks.length > 0 && (
        <div className="border-b border-[var(--sem-warn)]/30 bg-[var(--sem-warn-bg)] px-4 py-2.5">
          <p className="inline-flex items-center gap-1 text-xs font-bold text-[var(--sem-warn)]">
            <RefreshCw aria-hidden className="size-3.5" /> مطلوب إعادة عدّ ({fmtInt(st.recountTasks.length)}):
          </p>
          {st.recountTasks.map((t) => (
            <button
              key={t.variantId}
              type="button"
              onClick={() => {
                const it = items.find((i) => i.variantId === t.variantId);
                if (it) openCard(it);
              }}
              className="mt-1.5 flex w-full items-center justify-between gap-2 rounded-lg border border-[var(--sem-warn)]/40 bg-card px-3 py-2.5 text-right text-sm font-semibold active:scale-[0.99]"
            >
              <span className="min-w-0">
                <span className="block truncate">
                  {t.productName}
                  {t.variantName ? <span className="font-normal text-muted-foreground"> {t.variantName}</span> : null}
                </span>
                <span className="block truncate text-[11px] font-normal text-[var(--sem-warn)]">السبب: {t.reason}</span>
              </span>
              <span className="shrink-0 text-[var(--sem-warn)]">عدّ الآن ←</span>
            </button>
          ))}
        </div>
      )}

      {/* بحث + مسح */}
      <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row">
        <div className="relative w-full min-w-0 flex-1 sm:min-w-72">
          <input
            ref={searchRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              barcodeInput.handleKeyDown(e, setQ);
              if (e.defaultPrevented) return;
              if (e.key === "Enter") {
                e.preventDefault();
                tryOpenByQuery();
              }
            }}
            placeholder="بحث بالاسم أو SKU أو رقم الباركود…"
            className={cn("h-11 w-full min-w-0 rounded-xl px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30", barcodeSearchInputClass)}
          />
          <BarcodeSearchCue />
        </div>
        <button
          type="button"
          onClick={() => {
            if (!canCount) return;
            setCameraOpen(true);
          }}
          disabled={!canCount}
          className="flex h-11 w-full shrink-0 items-center justify-center gap-1.5 rounded-xl bg-primary px-4 text-sm font-bold text-primary-foreground active:scale-95 sm:w-auto"
        >
          <Camera aria-hidden className="size-4" /> مسح
        </button>
        {/* وضع التجميع (ب-٥): كل مسحة +١ في البطاقة المفتوحة — لأرفف القطع الكثيرة. */}
        <button
          type="button"
          onClick={() => setTallyMode((v) => !v)}
          aria-pressed={tallyMode}
          className={cn(
            "flex h-11 w-full shrink-0 items-center justify-center gap-1.5 rounded-xl border px-4 text-sm font-bold transition-colors active:scale-95 sm:w-auto",
            tallyMode
              ? "border-primary bg-primary/10 text-primary"
              : "border-border bg-background text-muted-foreground",
          )}
        >
          <ListPlus aria-hidden className="size-4" />
          {tallyMode ? "التجميع مُفعَّل" : "تجميع"}
        </button>
      </div>

      {/* القائمة */}
      <main className="flex-1 overflow-y-auto px-4 pb-32">
        {scanRequired && (
          <div className="mt-1 mb-3 flex items-start gap-2 rounded-xl bg-primary/5 px-3 py-2.5 text-xs font-semibold leading-relaxed text-primary">
            <ScanLine aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span>
              المسح إلزاميّ — امسح باركود الصنف (قارئ أو كاميرا) لفتح بطاقة العدّ. النقر على
              المنتج لا يفتحه؛ القائمة لمتابعة ما تبقّى عليك.
            </span>
          </div>
        )}
        {myFiltered.length === 0 && needle !== "" && otherFiltered.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">لا نتائج للبحث «{q.trim()}»</p>
        )}

        {/* منتجاتي */}
        {myFiltered.map((i) => {
          const queued = queuedByVariant.get(i.variantId);
          const isRecPending = pendingRecountSet.has(i.variantId);
          const countedHere = i.counted || hasMyCount(i);
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
                    ? "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]"
                    : isRecPending
                      ? "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]"
                      : "bg-muted text-muted-foreground",
                )}
              >
                {countedHere && !isRecPending ? (
                  <Check aria-hidden className="size-4" />
                ) : isRecPending ? (
                  <RefreshCw aria-hidden className="size-4" />
                ) : (
                  <span className="inline-block size-1.5 rounded-full bg-current opacity-60" />
                )}
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
                  className="flex shrink-0 items-center gap-1 rounded-lg bg-[var(--sem-pos-bg)] px-2.5 py-1 font-mono text-xs font-bold tabular-nums text-[var(--sem-pos)]"
                  dir="ltr"
                >
                  {queued && <Hourglass aria-hidden className="size-3" />}
                  <Check aria-hidden className="size-3" /> {fmtInt(shownQty)} {baseUnitName(i)}
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
              <span className="text-xs text-muted-foreground">
                {othersOpen ? (
                  <ChevronUp aria-hidden className="size-3.5" />
                ) : (
                  <ChevronDown aria-hidden className="size-3.5" />
                )}
              </span>
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
                            ? "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]"
                            : "bg-muted text-muted-foreground",
                      )}
                    >
                      {dupBlocked ? (
                        <Lock aria-hidden className="size-4" />
                      ) : verifiedByMe ? (
                        <span className="inline-flex items-center -space-x-1 rtl:space-x-reverse">
                          <Check aria-hidden className="size-3.5" />
                          <Check aria-hidden className="size-3.5" />
                        </span>
                      ) : i.colleagueCounted ? (
                        <Check aria-hidden className="size-4" />
                      ) : (
                        <span className="inline-block size-1.5 rounded-full bg-current opacity-60" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold">
                        {i.productName}
                        {i.variantName ? <span className="font-normal text-muted-foreground"> {i.variantName}</span> : null}
                      </p>
                      <p className="truncate text-[10px] text-muted-foreground">
                        {/* جرد أعمى: «معدود من زميل» بلا أي كمية */}
                        {i.colleagueCounted ? "معدود من زميل" : "لم يُعدّ بعد"}
                        {verifiedByMe ? (
                          <>
                            {" · عدّك التحقّقي مُسجّل"}
                            {queued ? (
                              <Hourglass aria-hidden className="ml-1 inline size-3 align-text-bottom" />
                            ) : null}
                          </>
                        ) : null}
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
        {!submittedAssignment && (
          <button
            type="button"
            disabled={!online || queueCount > 0 || logoutMut.isPending}
            onClick={doPause}
            className={cn(
              "pointer-events-auto mb-2 h-10 w-full rounded-xl border text-sm font-bold transition-colors",
              online && queueCount === 0 && !logoutMut.isPending
                ? "border-border bg-background text-foreground active:bg-muted"
                : "cursor-not-allowed border-border bg-muted text-muted-foreground",
            )}
          >
            {logoutMut.isPending ? "جارٍ حفظ الوردية…" : "حفظ وإنهاء الوردية — أكمل لاحقاً"}
          </button>
        )}
        {submittedAssignment ? (
          <div className="pointer-events-auto inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-[var(--sem-pos-bg)] px-4 py-3 text-center text-sm font-bold text-[var(--sem-pos)]">
            <Check aria-hidden className="size-4" /> سلّمت العدّ — بانتظار مراجعة المسؤول
          </div>
        ) : (
          <button
            type="button"
            disabled={!allDone || !online || queueCount > 0 || finishMut.isPending}
            onClick={() => void doFinish()}
            className={cn(
              "pointer-events-auto h-12 w-full rounded-xl text-base font-bold transition-colors",
              allDone && online && queueCount === 0 && !finishMut.isPending
                ? "bg-[var(--sem-pos)] text-background active:opacity-90"
                : "cursor-not-allowed bg-muted text-muted-foreground",
            )}
          >
            {!online
              ? "التسليم يتطلب اتصالاً — العدّ محفوظ"
              : queueCount > 0
                ? `بانتظار مزامنة ${fmtInt(queueCount)} عدّة — التسليم بعدها`
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
          <button
            type="button"
            aria-label="إغلاق"
            className="absolute inset-0 bg-black/40"
            onClick={() => {
              setOpenVariantId(null);
              setBump(null);
            }}
          />
          <div className="absolute inset-x-0 bottom-0 max-h-[88%] overflow-y-auto rounded-t-2xl bg-background p-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl">
            <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-border" />
            <ProductScanIdentityCard
              className="mb-4"
              productName={openItem.productName}
              variantName={openItem.variantName}
              sku={openItem.sku}
              barcode={openEntry.scannedBarcode ?? displayBarcode(openItem)}
              imageUrl={openItem.imageUrl}
              scanned={openEntry.scannedBarcode != null}
              scanMatch={openScanMatch}
            />
            <QtySheet
              key={`${openItem.variantId}-${openMode}`}
              item={openItem}
              mode={openMode}
              recountReason={openRecountReason}
              queued={queuedByVariant.get(openItem.variantId)}
              saving={submitMut.isPending}
              tally={tallyMode}
              bump={bump}
              onCancel={() => {
                setOpenVariantId(null);
                setBump(null);
              }}
              onSave={(qty, breakdown) => saveCount(openItem, openMode, qty, breakdown)}
            />
          </div>
        </div>
      )}
      <CameraScanner
        open={cameraOpen}
        onClose={() => setCameraOpen(false)}
        onDetect={(raw) => {
          setCameraOpen(false);
          handleBarcode(raw, "SCAN_CAMERA");
        }}
      />
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
  tally = false,
  bump = null,
  onCancel,
  onSave,
}: {
  item: CountItem;
  mode: CountMode;
  recountReason?: string;
  queued?: QueuedCount;
  saving: boolean;
  /** وضع التجميع: عدٌّ طازجٌ بالمسح (بلا تعبئة مسبقة)، وكل مسحة تزيد وحدتها +١. */
  tally?: boolean;
  /** إشارة زيادةٍ من الأب عند كل مسحة (token تصاعديّ) — تزيد الوحدة المذكورة +١. */
  bump?: { unit: string; token: number } | null;
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
    // في وضع التجميع نبدأ فارغين دائماً (عدٌّ طازجٌ يتراكم بالمسح).
    // وإلا: تعبئة مسبقة عند تعديل عدّي السابق فقط — إعادة العدّ/التحقّقي عدٌّ جديد أعمى من الصفر.
    if (!tally && mode === "FIRST") {
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

  // وضع التجميع: كل زيادةٍ من الأب (token جديد) تضيف ١ للوحدة الممسوحة.
  // ⚠️ الشرط `tally` إلزاميّ: قد تُفتح بطاقةٌ في الوضع العاديّ و`bump` ما زال يحمل قيمةً قديمة من
  // جلسة تجميعٍ سابقة (لا يُصفَّر إلا عند الإغلاق)، فبدونه يُطبَّق +١ وهميّ عند التركيب.
  const lastBump = useRef(0);
  useEffect(() => {
    if (!tally || !bump || bump.token <= lastBump.current) return;
    lastBump.current = bump.token;
    setVals((v) => {
      const cur = parseInt(v[bump.unit] || "0", 10) || 0;
      return { ...v, [bump.unit]: String(Math.min(cur + 1, 9_999_999)) };
    });
  }, [bump, tally]);

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

      {tally && (
        <div className="mb-2 inline-flex items-start gap-1.5 rounded-lg bg-primary/10 px-3 py-2 text-xs font-semibold leading-relaxed text-primary">
          <ListPlus aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>وضع التجميع: كل مسحةٍ لهذا الصنف تزيد وحدتها +١. احفظ عند الانتهاء ثم امسح الصنف التالي.</span>
        </div>
      )}
      {isRecount && (
        <div className="mb-2 inline-flex items-start gap-1.5 rounded-lg bg-[var(--sem-warn-bg)] px-3 py-2 text-xs font-semibold leading-relaxed text-[var(--sem-warn)]">
          <RefreshCw aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>مطلوب إعادة عدّ ثانية لهذا المنتج{recountReason ? ` — السبب: ${recountReason}` : ""}. عُدّ من جديد بتمعّن.</span>
        </div>
      )}
      {isVerify && (
        <div className="mb-2 inline-flex items-start gap-1.5 rounded-lg bg-violet-50 px-3 py-2 text-xs font-semibold leading-relaxed text-violet-800 dark:bg-violet-950/50 dark:text-violet-300">
          <span className="mt-0.5 inline-flex shrink-0 items-center -space-x-1 rtl:space-x-reverse">
            <Check aria-hidden className="size-3.5" />
            <Check aria-hidden className="size-3.5" />
          </span>
          <span>عدّ تحقّقي — المنتج عدّه زميلك سابقاً. عدّك لن يستبدل عدّه: إن تطابقا تأكّد الرقم، وإن اختلفا يُرفع
          تعارض يفصل فيه المسؤول. (كميته لا تُعرض لك — جرد أعمى)</span>
        </div>
      )}
      {!item.isMine && !isVerify && (
        <div className="mb-2 rounded-lg bg-muted px-3 py-2 text-xs font-semibold leading-relaxed text-muted-foreground">
          المنتج من منطقة زميل ولم يُعدّ بعد — سيُسجَّل العدّ الأول باسمك.
        </div>
      )}

      <p className="mb-2 mt-3 text-sm font-bold">الكمية المعدودة فعلياً على الرف:</p>
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
