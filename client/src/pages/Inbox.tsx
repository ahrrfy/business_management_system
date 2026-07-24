import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState, LoadingState } from "@/components/PageState";
import CustomerPicker from "@/components/CustomerPicker";
import {
  Archive,
  ArchiveRestore,
  AlertTriangle,
  Check,
  CheckCheck,
  Clock,
  Download,
  Inbox as InboxIcon,
  LayoutTemplate,
  Loader2,
  MessageSquare,
  Phone,
  Send,
  ShoppingBag,
  Store,
  User,
  UserPlus,
  X,
} from "lucide-react";
import { fmtDateTime } from "@/lib/date";
import { notify } from "@/lib/notify";
import { confirm } from "@/lib/confirm";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "wouter";

/**
 * صَندوق الوارد المُوحَّد — `/inbox` (شَريحة #5 + إعادة تَوصيل نَواة Cloud API — تَكليف T1.4).
 *
 * المَنطق: قائمة محادثات (يَمين) + خَيط رَسائل (يَسار) + composer سَريع لإرسال رِسالة.
 * القَنوات: WhatsApp / Instagram / TikTok / متجر / هاتف / حُضوري / أخرى.
 *
 * OUT لِمُحادثة WHATSAPP بِتَكامل ACTIVE ⇒ يَمُرّ فِعلياً عَبر الصَندوق الصادِر (Cloud API): يَظهر
 * فَوراً كَعُنصر «قَيد الإرسال» (pending)، ثُم يَتحوَّل لِرَسالة حَقيقية بِحالة تَسليم (PENDING/SENT/
 * DELIVERED/READ/FAILED) بَعد المُعالَجة الخَلفية. بِلا تَكامل ⇒ سِجلّ يَدوي كَما كان دائماً.
 *
 * IDOR: الـrouter يَفرض branchScopedProcedure ⇒ كاشير الفَرع X لا يَرى مُحادثات الفَرع Y.
 */

type Conv = RouterOutputs["conversations"]["list"][number];
type Msg = RouterOutputs["conversations"]["messages"][number];

const CHANNEL_META: Record<string, { label: string; Icon: typeof MessageSquare; cls: string }> = {
  WHATSAPP: { label: "واتساب", Icon: MessageSquare, cls: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
  INSTAGRAM: { label: "انستغرام", Icon: User, cls: "bg-pink-500/10 text-pink-700 dark:text-pink-400" },
  TIKTOK: { label: "تيك توك", Icon: User, cls: "bg-muted text-muted-foreground" },
  STORE: { label: "المتجر", Icon: ShoppingBag, cls: "bg-[var(--sem-info-bg)] text-[var(--sem-info)]" },
  PHONE: { label: "اتصال", Icon: Phone, cls: "bg-amber-500/10 text-amber-700 dark:text-amber-400" },
  WALK_IN: { label: "حُضوري", Icon: Store, cls: "bg-violet-500/10 text-violet-700 dark:text-violet-400" },
  OTHER: { label: "أخرى", Icon: MessageSquare, cls: "bg-muted text-muted-foreground" },
};

const FILTERS: { key: "all" | "unread" | "archived" | "closed"; label: string }[] = [
  { key: "all", label: "كل المفتوحة" },
  { key: "unread", label: "غَير المَقروء" },
  { key: "archived", label: "المُؤرشَفة" },
  { key: "closed", label: "المُغلقة" },
];

/** ساعة حَيّة تُحدَّث كل دَقيقة — تَقود شارة النافِذة الحُرّة وتَعطيل الملحن مَعاً بَلا مُؤقِّتَين مُنفصِلَين. */
function useNow(intervalMs = 60_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function ConvRow({ c, active, onClick }: { c: Conv; active: boolean; onClick: () => void }) {
  const meta = CHANNEL_META[c.channel as string] ?? CHANNEL_META.OTHER;
  const name = c.customerName ?? c.displayName ?? c.channelHandle;
  const unread = c.unreadCount > 0;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-right rounded-lg border p-2.5 transition-colors flex items-start gap-2.5 ${
        active ? "border-primary bg-primary/5" : "hover:bg-accent"
      }`}
    >
      <div className={`size-10 rounded-full grid place-items-center flex-shrink-0 ${meta.cls}`}>
        <meta.Icon aria-hidden className="size-5" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className={`font-bold text-sm truncate ${unread ? "" : "text-foreground/80"}`}>{name}</span>
          {unread && (
            <Badge variant="destructive" className="h-5 min-w-5 px-1.5 text-[10px] flex-shrink-0">
              {c.unreadCount}
            </Badge>
          )}
        </div>
        <div className="text-[11px] text-muted-foreground mt-0.5 truncate">
          {c.lastMessagePreview ?? "(لا رَسائل بَعد)"}
        </div>
        <div className="text-[10px] text-muted-foreground/70 mt-0.5 flex items-center gap-2">
          <span>{meta.label}</span>
          <span dir="ltr">·</span>
          <span dir="ltr">{c.lastMessageAt ? fmtDateTime(c.lastMessageAt) : "—"}</span>
        </div>
      </div>
    </button>
  );
}

/** شارة نافِذة الرَدّ الحُرّ (٢٤ ساعة) — مَفتوحة تَعرض العَدّ التَنازُلي، مُغلَقة/بِلا تَكامل تَعرض
 *  «النافِذة مُغلَقة» فَقط عِند apiActive (بِلا تَكامل نُخفيها كُلياً — لا مَعنى لَها). */
function WindowBadge({ windowExpiresAt, now }: { windowExpiresAt: Date | string | null; now: number }) {
  if (!windowExpiresAt) return <Badge variant="neutral">النافذة مغلقة</Badge>;
  const remainingMs = new Date(windowExpiresAt).getTime() - now;
  if (remainingMs <= 0) return <Badge variant="neutral">النافذة مغلقة</Badge>;
  const h = Math.floor(remainingMs / 3600_000);
  const m = Math.floor((remainingMs % 3600_000) / 60_000);
  return (
    <Badge variant="success">
      الرد الحر متاح — تتبقى <span dir="ltr">{h}:{String(m).padStart(2, "0")}</span>
    </Badge>
  );
}

/** أَيقونة حالة التَسليم بِجوار وَقت الرَسالة — تُغطّي كِلا المَصدرَين: رَسالة حَقيقية (deliveryStatus)
 *  أو عُنصر زائف مُعلَّق مِن الصَندوق الصادِر (pending). */
function DeliveryMark({ m, onRetry }: { m: Msg; onRetry: (outboxId: number) => void }) {
  // lucide-react لا يَقبل `title` كَمُعامِل SVG مُباشِر (ElementAttributes تَستثنيه) — نَلفّه بِـ
  // <span title> (نَفس نَمط CustomerPicker.tsx: `title="رصيد ذمة العميل"`).
  if (m.pending) {
    if (m.pending.status === "FAILED") {
      return (
        <span className="inline-flex items-center gap-1">
          <span title={m.pending.lastError ?? "فَشل الإرسال"}>
            <AlertTriangle aria-hidden className="size-3 text-destructive" />
          </span>
          <button
            type="button"
            onClick={() => onRetry(m.pending!.outboxId)}
            className="underline text-[10px] text-destructive hover:opacity-80"
          >
            أَعِد المُحاولة
          </button>
        </span>
      );
    }
    return (
      <span title={m.pending.status === "SENDING" ? "جارٍ الإرسال…" : "قَيد الإرسال…"}>
        <Clock aria-hidden className="size-3 opacity-70" />
      </span>
    );
  }
  if (!m.deliveryStatus) return null;
  if (m.deliveryStatus === "PENDING") {
    return <span title="بِانتظار التَسليم"><Clock aria-hidden className="size-3 opacity-70" /></span>;
  }
  if (m.deliveryStatus === "SENT") {
    return <span title="أُرسِلَت"><Check aria-hidden className="size-3 opacity-70" /></span>;
  }
  if (m.deliveryStatus === "DELIVERED") {
    return <span title="وَصَلَت"><CheckCheck aria-hidden className="size-3 opacity-70" /></span>;
  }
  if (m.deliveryStatus === "READ") {
    return <span title="قُرِئَت"><CheckCheck aria-hidden className="size-3 text-[var(--sem-info)]" /></span>;
  }
  if (m.deliveryStatus === "FAILED") {
    return (
      <span title={m.errorCode ? `فَشِل التَسليم (رَمز ${m.errorCode})` : "فَشِل التَسليم"}>
        <AlertTriangle aria-hidden className="size-3 text-destructive" />
      </span>
    );
  }
  return null;
}

function MessageBubble({ m, onRetry }: { m: Msg; onRetry: (outboxId: number) => void }) {
  const isMine = m.direction === "OUT";
  const isNote = m.direction === "NOTE";
  const isImage = m.mediaType?.startsWith("image/") ?? false;
  if (isNote) {
    return (
      <div className="my-2 text-center">
        <div className="inline-block badge-stock-low border rounded-md px-3 py-1.5 text-xs">
          <span className="font-bold">مُلاحظة داخِلية: </span>{m.body}
          <span className="text-[10px] text-muted-foreground/80 ms-2" dir="ltr">{fmtDateTime(m.createdAt)}</span>
        </div>
      </div>
    );
  }
  return (
    <div className={`flex ${isMine ? "justify-start" : "justify-end"} mb-2`}>
      <div
        className={`max-w-[78%] rounded-2xl px-3.5 py-2 text-sm ${
          isMine
            ? "bg-primary text-primary-foreground rounded-bl-sm"
            : "bg-muted text-foreground rounded-br-sm"
        }`}
      >
        {m.body && <div className="whitespace-pre-wrap break-words">{m.body}</div>}

        {m.mediaUrl && isImage && (
          <a href={m.mediaUrl} target="_blank" rel="noopener noreferrer" className="block mt-1">
            <img src={m.mediaUrl} alt="وَسائط المُحادثة" className="max-w-[220px] max-h-[220px] rounded-lg object-cover" />
          </a>
        )}
        {m.mediaUrl && !isImage && (
          <a
            href={m.mediaUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 inline-flex items-center gap-1 text-xs underline opacity-90"
          >
            <Download aria-hidden className="size-3.5" />
            {m.mediaType === "application/pdf" ? "فَتح PDF" : "تَنزيل مَلف"}
          </a>
        )}
        {!m.mediaUrl && m.mediaType && <div className="mt-1 text-xs opacity-70 italic">وَسائط قَيد الجَلب…</div>}

        <div className={`text-[10px] mt-1 opacity-70 flex items-center gap-1 ${isMine ? "text-primary-foreground" : "text-muted-foreground"}`} dir="ltr">
          {isMine && m.authorName ? `${m.authorName} · ` : ""}{fmtDateTime(m.createdAt)}
          {m.origin === "PHONE_APP" && <span className="opacity-80">· من الهاتف</span>}
          {isMine && <DeliveryMark m={m} onRetry={onRetry} />}
        </div>
      </div>
    </div>
  );
}

type WaTemplateRow = RouterOutputs["integrations"]["templates"]["list"][number];

/** مُنتَقي القَوالِب (T4.3) — الوَسيلة الوَحيدة لِلإرسال خارِج نافِذة الرَدّ الحُرّ (القَوالِب مُعفاة مِن
 *  فَحص النافِذة فِعلياً في الخادِم؛ هَذا سَبب وُجودها). يَعرض المُعتَمَدة (APPROVED) فَقط + حُقول
 *  مُتَغيّراتها {{1}}..{{n}} + مُعاينة نَصّية حَيّة قَبل الإرسال. */
function TemplatePicker({
  conversationId,
  onSent,
  onCancel,
}: {
  conversationId: number;
  onSent: () => void;
  onCancel?: () => void;
}) {
  const templatesQ = trpc.integrations.templates.list.useQuery({ statusFilter: "APPROVED" });
  const templates = templatesQ.data ?? [];
  const [selectedKey, setSelectedKey] = useState("");
  const [params, setParams] = useState<string[]>([]);

  const selected: WaTemplateRow | null = templates.find((t) => `${t.name}::${t.language}` === selectedKey) ?? null;

  useEffect(() => {
    setParams(selected ? Array.from({ length: selected.variableCount }, () => "") : []);
  }, [selectedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = trpc.conversations.sendTemplate.useMutation({
    onSuccess: () => {
      notify.ok("أُرسِل القالِب");
      setSelectedKey("");
      setParams([]);
      onSent();
    },
    onError: (e) => notify.err(e),
  });

  const preview = useMemo(() => {
    if (!selected) return "";
    let text = selected.bodyText ?? "";
    params.forEach((v, i) => {
      text = text.replace(new RegExp(`\\{\\{\\s*${i + 1}\\s*\\}\\}`, "g"), v.trim() || `{{${i + 1}}}`);
    });
    return text;
  }, [selected, params]);

  const canSend = selected != null && params.every((p) => p.trim().length > 0) && !send.isPending;

  if (templatesQ.isLoading) {
    return <div className="text-xs text-muted-foreground py-2">جارٍ تحميل القَوالِب…</div>;
  }

  if (templates.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground inline-flex items-start gap-1.5">
        <LayoutTemplate aria-hidden className="size-3.5 flex-shrink-0 mt-0.5" />
        <span>لا قَوالِب مُعتَمَدة بَعد — زامِنها مِن الإعدادات (مَركَز واتساب).</span>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-muted/20 p-3 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-bold text-muted-foreground">
          <LayoutTemplate aria-hidden className="size-3.5" />
          إرسال قالِب مُعتَمَد
        </div>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
          >
            <X aria-hidden className="size-3.5" /> إلغاء
          </button>
        )}
      </div>
      <select
        value={selectedKey}
        onChange={(e) => setSelectedKey(e.target.value)}
        className="w-full h-9 border rounded-md px-2 text-sm bg-background"
      >
        <option value="">اِختَر قالِباً…</option>
        {templates.map((t) => (
          <option key={`${t.name}::${t.language}`} value={`${t.name}::${t.language}`}>
            {t.name} ({t.language})
          </option>
        ))}
      </select>
      {selected && selected.variableCount > 0 && (
        <div className="grid gap-2 sm:grid-cols-2">
          {params.map((v, i) => (
            <input
              key={i}
              value={v}
              onChange={(e) => setParams((arr) => arr.map((x, idx) => (idx === i ? e.target.value : x)))}
              placeholder={`مُتَغيّر {{${i + 1}}}`}
              dir="rtl"
              className="h-9 px-3 rounded-md border border-input bg-background text-sm"
            />
          ))}
        </div>
      )}
      {selected && (
        <div className="rounded-md border bg-background p-2 text-xs whitespace-pre-wrap">
          {preview || "—"}
        </div>
      )}
      <Button
        size="sm"
        onClick={() =>
          selected &&
          send.mutate({
            conversationId,
            templateName: selected.name,
            templateLang: selected.language,
            bodyParams: params.map((p) => p.trim()),
            clientRequestId: crypto.randomUUID(),
          })
        }
        disabled={!canSend}
      >
        {send.isPending ? <Loader2 aria-hidden className="size-4 me-1 animate-spin" /> : <Send aria-hidden className="size-4 me-1" />}
        إرسال القالِب
      </Button>
    </div>
  );
}

function ComposerPanel({
  conversationId,
  apiActive,
  windowOpen,
  onSent,
}: {
  conversationId: number;
  apiActive: boolean;
  windowOpen: boolean;
  onSent: () => void;
}) {
  const [body, setBody] = useState("");
  const [direction, setDirection] = useState<"OUT" | "IN" | "NOTE">("OUT");
  const [templateOpen, setTemplateOpen] = useState(false);
  const send = trpc.conversations.sendMessage.useMutation({
    onSuccess: () => { setBody(""); onSent(); },
    onError: (e) => notify.err(e),
  });
  // التَعطيل واجِهي فَقط عِند apiActive (تَكامل ACTIVE فِعلي عَلى الفَرع) — بِلا تَكامل يَبقى
  // الملحن كَما اليَوم تَماماً بِلا أَي قَيد نافِذة (المَبدأ الحاكِم).
  const blocked = direction === "OUT" && apiActive && !windowOpen;
  const submit = () => {
    if (!body.trim() || blocked || send.isPending) return;
    send.mutate({ conversationId, direction, body, clientRequestId: crypto.randomUUID() });
  };
  return (
    <div className="border-t bg-card p-3">
      <div className="flex gap-2 mb-2">
        {(["OUT", "IN", "NOTE"] as const).map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => setDirection(d)}
            className={`text-xs px-3 py-1 rounded-md font-medium border ${
              direction === d ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent"
            }`}
          >
            {d === "OUT" ? "إرسال للعَميل" : d === "IN" ? "تَسجيل وارِد (اتصال هاتفي)" : "مُلاحظة داخِلية"}
          </button>
        ))}
      </div>

      {/* النافِذة مُغلَقة (تَكامل ACTIVE فِعلي) ⇒ القَوالِب المُعتَمَدة هي الوَسيلة الوَحيدة (§ب) —
          تَستَبدل الملحن الحُرّ كُلياً، لا زِرّ تَبديل (لا بَديل يُعرَض). */}
      {blocked ? (
        <TemplatePicker conversationId={conversationId} onSent={onSent} />
      ) : (
        <>
          <div className="flex gap-2 items-end">
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } }}
              rows={2}
              placeholder={
                direction === "OUT" ? "اكتب رِسالتك للعَميل... (Ctrl+Enter للإرسال)" : direction === "IN" ? "اكتب ما قاله العَميل في الاتصال..." : "اكتب مُلاحظة داخِلية..."
              }
              className="flex-1 rounded-lg border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-none"
            />
            <Button onClick={submit} disabled={send.isPending || !body.trim()} className="h-10">
              <Send aria-hidden className="size-4 me-1" /> إرسال
            </Button>
          </div>

          {/* خِيار إضافي دائم عِند تَكامل ACTIVE (حَتى مَع نافِذة مَفتوحة) — §ب في المُواصَفة. */}
          {direction === "OUT" && apiActive && (
            <div className="mt-2">
              {templateOpen ? (
                <TemplatePicker
                  conversationId={conversationId}
                  onSent={() => { onSent(); setTemplateOpen(false); }}
                  onCancel={() => setTemplateOpen(false)}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setTemplateOpen(true)}
                  className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5"
                >
                  <LayoutTemplate aria-hidden className="size-3.5" /> أو أَرسِل قالِباً مُعتَمَداً بَدلاً مِن ذَلك
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** «عُميل جَديد» مِن شَريحة الوارِد — يَنقل لِشاشة إضافة العَميل. `CustomerNew.tsx` **لا تَدعم** حَقول
 *  query لِلتَعبئة المُسبَقة (فُحص صَراحةً) ⇒ نَنسخ الاسم/الهاتف لِلحافظة بَدَلاً مِن تَعديل تِلك
 *  الشاشة (خارِج نِطاق هَذا التَكليف). */
function NewCustomerFromConv({ conv }: { conv: Conv }) {
  const [, navigate] = useLocation();
  const handleClick = () => {
    const phone = conv.channel === "WHATSAPP" ? (conv.channelHandle.startsWith("+") ? conv.channelHandle : `+${conv.channelHandle}`) : conv.channelHandle;
    const text = [conv.displayName, phone].filter(Boolean).join(" — ");
    void navigator.clipboard?.writeText(text).catch(() => {});
    notify.info("نُسخت بيانات العَميل (الاسم/الهاتف) للحافظة", "الصِقها في شاشة «عَميل جَديد» بَعد الاِنتقال.");
    navigate("/customers/new");
  };
  return (
    <Button type="button" size="sm" variant="ghost" onClick={handleClick}>
      <UserPlus aria-hidden className="size-3.5 me-1" /> عَميل جَديد
    </Button>
  );
}

/** شَريحة العَميل في رَأس المحادثة: مَربوط ⇒ زِرّ باسمه (رابِط لِصَفحته)؛ غَير مَربوط ⇒ اِختيار
 *  عَبر CustomerPicker القائم أو إضافة عَميل جَديد. */
function CustomerLinkChip({ conv, onLinked }: { conv: Conv; onLinked: () => void }) {
  const [open, setOpen] = useState(false);
  const [pendingId, setPendingId] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const linkCustomer = trpc.conversations.linkCustomer.useMutation({
    onSuccess: () => { setOpen(false); setPendingId(null); onLinked(); },
    onError: (e) => notify.err(e),
  });

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  if (conv.customerId != null) {
    return (
      <Link
        href={`/customers/${conv.customerId}/edit`}
        className="inline-flex items-center gap-1.5 text-xs font-medium rounded-md border px-2.5 h-8 hover:bg-accent"
      >
        <User aria-hidden className="size-3.5" />
        {conv.customerName ?? `#${conv.customerId}`}
      </Link>
    );
  }

  return (
    <div className="relative flex items-center gap-1" ref={wrapRef}>
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen((v) => !v)}>
        <User aria-hidden className="size-3.5 me-1" /> اِختر العَميل
      </Button>
      <NewCustomerFromConv conv={conv} />
      {open && (
        <div className="absolute z-30 top-full mt-1 right-0 w-80 rounded-lg border bg-popover shadow-lg p-3">
          <CustomerPicker
            customerId={pendingId}
            onCustomerChange={(id) => {
              setPendingId(id);
              if (id != null) linkCustomer.mutate({ conversationId: Number(conv.id), customerId: id });
            }}
          />
        </div>
      )}
    </div>
  );
}

function ConversationDetail({ conv, onChanged }: { conv: Conv; onChanged: () => void }) {
  const id = Number(conv.id);
  const messages = trpc.conversations.messages.useQuery({ conversationId: id });
  const utils = trpc.useUtils();
  const listRef = useRef<HTMLDivElement | null>(null);
  const now = useNow();

  const markRead = trpc.conversations.markRead.useMutation({
    onSuccess: () => { utils.conversations.list.invalidate(); onChanged(); },
  });
  const setStatus = trpc.conversations.setStatus.useMutation({
    onSuccess: () => { utils.conversations.list.invalidate(); onChanged(); },
    onError: (e) => notify.err(e),
  });
  const retrySend = trpc.conversations.retrySend.useMutation({
    onSuccess: () => { messages.refetch(); },
    onError: (e) => notify.err(e),
  });

  // تَصفير العَدّاد تِلقائياً عند فَتح المحادثة (debounce بـuseEffect).
  useEffect(() => { markRead.mutate({ conversationId: id }); /* eslint-disable-next-line */ }, [id]);

  // Scroll to bottom on new messages.
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages.data?.length]);

  const windowOpen = conv.windowExpiresAt != null && new Date(conv.windowExpiresAt).getTime() > now;

  return (
    <div className="h-full flex flex-col bg-background">
      <div className="border-b p-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="text-sm font-bold">المحادثة #{id}</div>
          <CustomerLinkChip conv={conv} onLinked={() => { utils.conversations.list.invalidate(); onChanged(); }} />
          {conv.apiActive && <WindowBadge windowExpiresAt={conv.windowExpiresAt} now={now} />}
        </div>
        <div className="flex gap-1.5">
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              if (!(await confirm({ variant: "info", title: "تَأرشيف المحادثة", description: "أَرشَفة هذه المحادثة (تُخفى مِن القائمة الافتراضية، تُحفَظ).", confirmText: "تَأرشيف", cancelText: "تَراجع" }))) return;
              setStatus.mutate({ conversationId: id, status: "ARCHIVED" });
            }}
            disabled={setStatus.isPending}
          >
            <Archive aria-hidden className="size-3.5 me-1" /> أَرشَفة
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              if (!(await confirm({ variant: "info", title: "إعادة فَتح", description: "إعادة فَتح المحادثة وإظهارها في القائمة الافتراضية.", confirmText: "فَتح", cancelText: "تَراجع" }))) return;
              setStatus.mutate({ conversationId: id, status: "OPEN" });
            }}
            disabled={setStatus.isPending}
          >
            <ArchiveRestore aria-hidden className="size-3.5 me-1" /> فَتح
          </Button>
        </div>
      </div>
      <div ref={listRef} className="flex-1 overflow-y-auto p-4" dir="rtl">
        {messages.isLoading && <LoadingState />}
        {messages.isError && <ErrorState message="تعذّر تحميل الرَسائل." onRetry={() => messages.refetch()} />}
        {messages.data?.length === 0 && (
          <div className="text-center text-muted-foreground text-sm py-8">
            لا رَسائل بَعد. اِبدأ بإرسال رِسالة أو تَسجيل اتصال هاتفي.
          </div>
        )}
        {messages.data?.map((m) => (
          <MessageBubble key={m.id} m={m} onRetry={(outboxId) => retrySend.mutate({ outboxId })} />
        ))}
      </div>
      <ComposerPanel
        conversationId={id}
        apiActive={conv.apiActive}
        windowOpen={windowOpen}
        onSent={() => { messages.refetch(); utils.conversations.list.invalidate(); }}
      />
    </div>
  );
}

function NewConversationDialog({ onCreated, onClose, branchId }: { onCreated: (id: number) => void; onClose: () => void; branchId?: number }) {
  const [channel, setChannel] = useState<"WHATSAPP" | "INSTAGRAM" | "TIKTOK" | "STORE" | "PHONE" | "WALK_IN" | "OTHER">("PHONE");
  const [handle, setHandle] = useState("");
  const [displayName, setDisplayName] = useState("");
  const upsert = trpc.conversations.upsert.useMutation({
    onSuccess: (r) => { onCreated(r.id); onClose(); },
    onError: (e) => notify.err(e),
  });
  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm grid place-items-center p-4" onClick={onClose}>
      <Card className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <CardHeader>
          <CardTitle className="text-base">محادثة جَديدة</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <label className="text-xs text-muted-foreground">القَناة</label>
            <select
              value={channel}
              onChange={(e) => setChannel(e.target.value as typeof channel)}
              className="w-full h-9 border rounded-md px-2 text-sm bg-background mt-1"
            >
              {Object.entries(CHANNEL_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">
              {channel === "PHONE" || channel === "WHATSAPP" ? "رَقم الهاتف" : channel === "INSTAGRAM" || channel === "TIKTOK" ? "@username" : "المُعَرّف"}
            </label>
            <input
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              placeholder={channel === "PHONE" ? "07XX XXX XXXX" : "@..."}
              dir="ltr"
              className="w-full h-9 border rounded-md px-2 text-sm bg-background mt-1"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">الاسم المَعروض (اختياري)</label>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="اسم العَميل"
              className="w-full h-9 border rounded-md px-2 text-sm bg-background mt-1"
            />
          </div>
        </CardContent>
        <div className="flex gap-2 p-4 pt-0">
          <Button variant="outline" onClick={onClose} className="flex-1">إلغاء</Button>
          <Button
            onClick={() => upsert.mutate({ channel, channelHandle: handle.trim(), displayName: displayName.trim() || null, branchId })}
            disabled={upsert.isPending || !handle.trim()}
            className="flex-1"
          >
            إنشاء
          </Button>
        </div>
      </Card>
    </div>
  );
}

export default function Inbox() {
  const [filter, setFilter] = useState<"all" | "unread" | "archived" | "closed">("all");
  // #8 (تدقيق التثبيت): channelsRead يشتقّ scopedBranchId خادمياً؛ للمدير/الأدمن تعود null
  // فتطلب branchId صريحاً وإلا BAD_REQUEST ⇒ صندوق فارغ صامت. نمرّر branchId من هوية المستخدم
  // (كلّ مدير/أدمن مُسنَد فرعياً في هذا النظام) — الكاشير/الفني يتجاهل الخادم إدخاله للمعزول.
  const me = trpc.auth.me.useQuery();
  const inputBranchId = me.data?.branchId ? Number(me.data.branchId) : undefined;
  const list = trpc.conversations.list.useQuery(
    { filter, branchId: inputBranchId },
    { enabled: !!me.data },
  );
  const [selId, setSelId] = useState<number | null>(null);
  const [showNew, setShowNew] = useState(false);

  const totalUnread = useMemo(
    () => (list.data ?? []).reduce((sum, c) => sum + (c.unreadCount ?? 0), 0),
    [list.data],
  );

  // اختيار أَول مُحادثة لو لم يُحَدّد شَيء.
  useEffect(() => {
    if (selId == null && list.data?.length) setSelId(Number(list.data[0].id));
  }, [list.data, selId]);

  const activeConv = useMemo(
    () => (selId == null ? null : list.data?.find((c) => Number(c.id) === selId) ?? null),
    [list.data, selId],
  );

  return (
    <div className="flex flex-col lg:flex-row gap-4 h-[calc(100vh-7rem)]">
      {/* القائمة الجانبية */}
      <div className="lg:w-[360px] lg:flex-none flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-bold inline-flex items-center gap-2">
            <InboxIcon aria-hidden className="size-5" />
            صَندوق الوارد
            {totalUnread > 0 && <Badge variant="destructive" className="h-5">{totalUnread}</Badge>}
          </h1>
          <Button size="sm" onClick={() => setShowNew(true)}>+ جَديدة</Button>
        </div>

        <div className="flex gap-1.5 flex-wrap">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={`text-xs px-3 py-1 rounded-md font-medium ${
                filter === f.key ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-accent"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto space-y-2 pr-1">
          {list.isLoading && <LoadingState />}
          {list.isError && <ErrorState message="تعذّر تحميل المحادثات." onRetry={() => list.refetch()} />}
          {list.data?.length === 0 && (
            <div className="text-xs text-muted-foreground border border-dashed rounded-lg p-4 text-center">
              لا محادثات. اِضغط «+ جَديدة» لِتَسجيل اتصال أو رَسالة وارِدة.
            </div>
          )}
          {list.data?.map((c) => (
            <ConvRow key={c.id} c={c} active={selId === Number(c.id)} onClick={() => setSelId(Number(c.id))} />
          ))}
        </div>
      </div>

      {/* لوحة المحادثة */}
      <div className="flex-1 min-w-0 border rounded-xl bg-card overflow-hidden">
        {activeConv != null ? (
          <ConversationDetail conv={activeConv} onChanged={() => list.refetch()} />
        ) : (
          <div className="grid place-items-center h-full text-muted-foreground text-center px-6">
            <div>
              <InboxIcon aria-hidden className="size-12 mx-auto mb-3 opacity-40" />
              <div className="text-sm">اِختر مُحادثة مِن القائمة، أو أَنشئ جَديدة لِتَسجيل اتصال هاتفي/زائر.</div>
            </div>
          </div>
        )}
      </div>

      {showNew && <NewConversationDialog onCreated={(id) => { setSelId(id); list.refetch(); }} onClose={() => setShowNew(false)} branchId={inputBranchId} />}
    </div>
  );
}
