import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState, LoadingState } from "@/components/PageState";
import { Archive, ArchiveRestore, Inbox as InboxIcon, MessageSquare, Phone, Send, ShoppingBag, Store, User } from "lucide-react";
import { fmtDateTime } from "@/lib/date";
import { notify } from "@/lib/notify";
import { confirm } from "@/lib/confirm";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useEffect, useMemo, useRef, useState } from "react";

/**
 * صَندوق الوارد المُوحَّد — `/inbox` (شَريحة #5).
 *
 * المَنطق: قائمة محادثات (يَمين) + خَيط رَسائل (يَسار) + composer سَريع لإرسال رِسالة.
 * القَنوات: WhatsApp / Instagram / TikTok / متجر / هاتف / حُضوري / أخرى.
 *
 * البَيانات: webhook لاحقاً (يَحتاج tokens مِن المالك) — حالياً المُوظَّف يُسجّل
 * الاتصالات الواردة (هاتف/حُضوري) يَدوياً. عند تَفعيل webhooks ⇒ تَظهر تِلقائياً.
 *
 * IDOR: الـrouter يَفرض branchScopedProcedure ⇒ كاشير الفَرع X لا يَرى مُحادثات الفَرع Y.
 */

type Conv = RouterOutputs["conversations"]["list"][number];

const CHANNEL_META: Record<string, { label: string; Icon: typeof MessageSquare; cls: string }> = {
  WHATSAPP: { label: "واتساب", Icon: MessageSquare, cls: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
  INSTAGRAM: { label: "انستغرام", Icon: User, cls: "bg-pink-500/10 text-pink-700 dark:text-pink-400" },
  TIKTOK: { label: "تيك توك", Icon: User, cls: "bg-slate-500/10 text-slate-700 dark:text-slate-300" },
  STORE: { label: "المتجر", Icon: ShoppingBag, cls: "bg-sky-500/10 text-sky-700 dark:text-sky-400" },
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

function MessageBubble({ m }: { m: RouterOutputs["conversations"]["messages"][number] }) {
  const isMine = m.direction === "OUT";
  const isNote = m.direction === "NOTE";
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
        {m.mediaUrl && (
          <a href={m.mediaUrl} target="_blank" rel="noopener noreferrer" className="block mt-1 text-xs underline opacity-90">
            {m.mediaType?.startsWith("image/") ? "عَرض الصورة" : m.mediaType === "application/pdf" ? "فَتح PDF" : "تَنزيل مَلف"}
          </a>
        )}
        <div className={`text-[10px] mt-1 opacity-70 ${isMine ? "text-primary-foreground" : "text-muted-foreground"}`} dir="ltr">
          {isMine && m.authorName ? `${m.authorName} · ` : ""}{fmtDateTime(m.createdAt)}
          {isMine && m.deliveryStatus ? ` · ${m.deliveryStatus}` : ""}
        </div>
      </div>
    </div>
  );
}

function ComposerPanel({ conversationId, onSent }: { conversationId: number; onSent: () => void }) {
  const [body, setBody] = useState("");
  const [direction, setDirection] = useState<"OUT" | "IN" | "NOTE">("OUT");
  const send = trpc.conversations.sendMessage.useMutation({
    onSuccess: () => { setBody(""); onSent(); },
    onError: (e) => notify.err(e),
  });
  const submit = () => {
    if (!body.trim()) return;
    send.mutate({ conversationId, direction, body });
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
      <div className="flex gap-2 items-end">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } }}
          rows={2}
          placeholder={direction === "OUT" ? "اكتب رِسالتك للعَميل... (Ctrl+Enter للإرسال)" : direction === "IN" ? "اكتب ما قاله العَميل في الاتصال..." : "اكتب مُلاحظة داخِلية..."}
          className="flex-1 rounded-lg border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-none"
        />
        <Button onClick={submit} disabled={send.isPending || !body.trim()} className="h-10">
          <Send aria-hidden className="size-4 me-1" /> إرسال
        </Button>
      </div>
    </div>
  );
}

function ConversationDetail({ id, onChanged }: { id: number; onChanged: () => void }) {
  const messages = trpc.conversations.messages.useQuery({ conversationId: id });
  const utils = trpc.useUtils();
  const listRef = useRef<HTMLDivElement | null>(null);

  const markRead = trpc.conversations.markRead.useMutation({
    onSuccess: () => { utils.conversations.list.invalidate(); onChanged(); },
  });
  const setStatus = trpc.conversations.setStatus.useMutation({
    onSuccess: () => { utils.conversations.list.invalidate(); onChanged(); },
    onError: (e) => notify.err(e),
  });

  // تَصفير العَدّاد تِلقائياً عند فَتح المحادثة (debounce بـuseEffect).
  useEffect(() => { markRead.mutate({ conversationId: id }); /* eslint-disable-next-line */ }, [id]);

  // Scroll to bottom on new messages.
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages.data?.length]);

  return (
    <div className="h-full flex flex-col bg-background">
      <div className="border-b p-3 flex items-center justify-between gap-2">
        <div className="text-sm font-bold">المحادثة #{id}</div>
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
        {messages.data?.map((m) => <MessageBubble key={m.id} m={m} />)}
      </div>
      <ComposerPanel conversationId={id} onSent={() => { messages.refetch(); utils.conversations.list.invalidate(); }} />
    </div>
  );
}

function NewConversationDialog({ onCreated, onClose }: { onCreated: (id: number) => void; onClose: () => void }) {
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
            onClick={() => upsert.mutate({ channel, channelHandle: handle.trim(), displayName: displayName.trim() || null })}
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
  const list = trpc.conversations.list.useQuery({ filter });
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
        {selId != null ? (
          <ConversationDetail id={selId} onChanged={() => list.refetch()} />
        ) : (
          <div className="grid place-items-center h-full text-muted-foreground text-center px-6">
            <div>
              <InboxIcon aria-hidden className="size-12 mx-auto mb-3 opacity-40" />
              <div className="text-sm">اِختر مُحادثة مِن القائمة، أو أَنشئ جَديدة لِتَسجيل اتصال هاتفي/زائر.</div>
            </div>
          </div>
        )}
      </div>

      {showNew && <NewConversationDialog onCreated={(id) => { setSelId(id); list.refetch(); }} onClose={() => setShowNew(false)} />}
    </div>
  );
}
