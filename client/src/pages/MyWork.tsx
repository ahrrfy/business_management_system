/**
 * **مطلوب منّي الآن** (ش٦ من المرحلة ٢، ١٩/٨).
 *
 * يستهلك هذا السطح الآن `superApp.approvalInbox` و`myWorkspace` و`notifications` و
 * `announcements.mine` من الويب نفسه، مع إبقاء كل قرار في شاشته الأصلية وقراءة الإعلانات
 * وإقرارها من هذا السطح دون نسخ منطق الصلاحيات.
 *
 * **قراءةٌ محضة**: صفر كتابةٍ وصفر أثرٍ ماليّ. وكلُّ مصدرٍ يحتفظ ببوّابته الأصلية (صلاحية
 * وحدته ونطاق فرعه وفصل المهام داخل خدمة المجال) — فلا فحصَ صلاحيةٍ جديدٌ هنا.
 *
 *  **حدٌّ صريح لا يُخفى:** `appNotifications` **لا تُبطَل** حين ينفّذ الإجراءَ شخصٌ آخر —
 * لا مسار كتابةٍ لـ`requiresAction` بعد الإنشاء. لذلك «مطلوب منّي» مبنيٌّ على
 * `approvalInbox` **الحيّ** (يقرأ الحالة الحقيقية)، والإشعاراتُ تُعرض **سجلّاً لا طابورَ
 * فعل** — وإلّا طالبت الشاشةُ بعملٍ منتهٍ.
 */
import { useState } from "react";
import { AlertCircle, Bell, CheckCircle2, ClipboardList, ExternalLink, Inbox as InboxIcon, Megaphone } from "lucide-react";
import { Link } from "wouter";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { fmtDateTime } from "@/lib/date";
import { fmtAr } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import { ACTION_LABELS } from "@shared/actionLabels";

export default function MyWork() {
  const me = trpc.auth.me.useQuery();
  // مركزُ القرارات الحيّ — بوّابتُه `superAppProcedure`، وقد يردّ فارغاً لمن لا سلطة له.
  const approvals = trpc.superApp.approvalInbox.useQuery({ limit: 30 }, { staleTime: 20_000 });
  // ترشيحٌ **خادميّ**: الصندوق يُقتطع بـ`limit` قبل أن تراه الشاشة، فترشيحُه هنا يُخفي ما لم
  // يصل أصلاً ويكذب العدّاد.
  const [unreadOnly, setUnreadOnly] = useState(false);
  const notifications = trpc.superApp.notifications.useQuery(
    { limit: 20, unreadOnly },
    { staleTime: 30_000 },
  );
  const workspace = trpc.superApp.myWorkspace.useQuery(undefined, { staleTime: 60_000 });
  const announcements = trpc.announcements.mine.useQuery({ limit: 20 }, { staleTime: 30_000 });
  // فتحُ الإشعار يَسِمه مقروءاً: الوسمُ أثرُ الفتح لا زرٌّ منفصل، وإلّا بقي العدّاد يكذب.
  const markRead = trpc.superApp.markNotificationRead.useMutation({
    onSuccess: () => void notifications.refetch(),
  });
  const markAnnouncementRead = trpc.announcements.markRead.useMutation({
    onSuccess: () => void announcements.refetch(),
  });
  const acknowledgeAnnouncement = trpc.announcements.acknowledge.useMutation({
    onSuccess: () => void announcements.refetch(),
  });

  const items = approvals.data ?? [];
  // العقد يعيد {rows, unreadCount} — والعدّاد يأتي مجّاناً بلا حسابٍ في الواجهة.
  const notesData = notifications.data;
  const notes = Array.isArray(notesData) ? notesData : (notesData?.rows ?? []);
  const unread = Array.isArray(notesData) ? 0 : (notesData?.unreadCount ?? 0);
  const announcementRows = announcements.data?.rows ?? [];
  const unreadAnnouncements = announcements.data?.unreadCount ?? 0;

  return (
    <div className="mx-auto w-full max-w-[1180px] px-4 py-5">
      <PageHeader
        title="مطلوب منّي الآن"
        description="قراراتٌ تنتظر موافقتك، وما يخصّك من عملٍ وإشعارات — سطحٌ واحد بدل تجوالٍ بين الشاشات."
        icon={<ClipboardList aria-hidden className="size-5" />}
      />

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        {/* ─── قرارات تنتظرني ─── */}
        <section aria-label="قرارات تنتظرني" className="space-y-3">
          <h2 className="flex items-center gap-2 text-sm font-extrabold">
            <CheckCircle2 aria-hidden className="size-4" />
            قرارات تنتظرني
            {items.length > 0 && (
              <span className="rounded-full bg-[var(--sem-warn-bg)] px-2 py-0.5 text-2xs font-extrabold text-[var(--sem-warn)]">
                {items.length}
              </span>
            )}
          </h2>

          {approvals.isLoading && (
            <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">{ACTION_LABELS.loading}</CardContent></Card>
          )}
          {approvals.isError && (
            <Card><CardContent className="py-8 text-center text-sm text-[var(--sem-danger)]">
              تعذّر تحميل القرارات.
              <Button size="sm" variant="outline" className="ms-2" onClick={() => approvals.refetch()}>إعادة</Button>
            </CardContent></Card>
          )}
          {!approvals.isLoading && !approvals.isError && items.length === 0 && (
            <Card><CardContent className="py-10 text-center">
              <CheckCircle2 aria-hidden className="mx-auto mb-2 size-8 text-[var(--sem-pos)]" />
              <p className="text-sm font-bold">لا قرارات معلّقة</p>
              <p className="mt-1 text-2xs text-muted-foreground">
                لا شيء ينتظر موافقتك الآن — أو أنّ دورك لا يملك سلطة اعتمادٍ على أيّ وحدة.
              </p>
            </CardContent></Card>
          )}

          {items.map((it) => (
            <Card key={`${it.kind}-${it.id}`}>
              <CardContent className="flex flex-wrap items-start justify-between gap-3 py-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded bg-muted px-1.5 py-0.5 text-2xs font-bold text-muted-foreground">
                      {KIND_LABEL[it.kind] ?? it.kind}
                    </span>
                    <span className="truncate text-sm font-bold">{it.title}</span>
                  </div>
                  <p className="mt-1 text-2xs text-muted-foreground">
                    {it.reference}
                    {it.detail ? ` · ${it.detail}` : ""}
                    {it.createdAt ? ` · ${fmtDateTime(it.createdAt)}` : ""}
                  </p>
                  {"amount" in it && it.amount != null && (
                    <p className="mt-1 text-sm font-extrabold tabular-nums" dir="ltr">
                      {fmtAr(String(it.amount))}
                    </p>
                  )}
                </div>
                {/*  لا زرَّ اعتمادٍ هنا: القرارُ يقع في شاشته الأصلية بحرّاسها كاملةً —
                    و`href` يعيده الخادم فعلاً بمساراتِ ويبٍّ حقيقية. */}
                <Button size="sm" variant="outline" asChild>
                  <Link href={it.href}>
                    <ExternalLink aria-hidden className="size-3.5 me-1" /> افتح للقرار
                  </Link>
                </Button>
              </CardContent>
            </Card>
          ))}
        </section>

        {/* ─── عملي وإشعاراتي ─── */}
        <section aria-label="عملي وإشعاراتي" className="space-y-4">
          {workspace.data && (
            <Card>
              <CardContent className="py-4">
                <h2 className="mb-2 flex items-center gap-2 text-sm font-extrabold">
                  <InboxIcon aria-hidden className="size-4" /> ملفّي
                </h2>
                <p className="text-2xs text-muted-foreground">
                  {me.data?.name ?? ""}
                  {workspace.data.employee?.position ? ` · ${workspace.data.employee.position}` : ""}
                </p>
              </CardContent>
            </Card>
          )}

          <Card id="announcements">
            <CardContent className="py-4">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-extrabold">
                <Megaphone aria-hidden className="size-4" /> الإعلانات
                {unreadAnnouncements > 0 && <span className="rounded-full bg-[var(--sem-info-bg)] px-2 py-0.5 text-2xs font-extrabold text-[var(--sem-info)]">{unreadAnnouncements} غير مقروء</span>}
              </h2>
              {announcementRows.length === 0 ? (
                <p className="py-3 text-center text-2xs text-muted-foreground">لا توجد إعلانات موجهة إليك</p>
              ) : (
                <ul className="space-y-2">
                  {announcementRows.map((a) => (
                    <li key={a.id} className="rounded-md border p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-xs font-bold">{a.title}</p>
                          <p className="mt-1 whitespace-pre-wrap text-2xs leading-relaxed text-muted-foreground">{a.body}</p>
                          <p className="mt-1 text-2xs text-muted-foreground">{fmtDateTime(a.createdAt)}{a.expiresAt ? ` · ينتهي ${fmtDateTime(a.expiresAt)}` : ""}</p>
                        </div>
                        {!a.readAt && <Button size="sm" variant="ghost" onClick={() => markAnnouncementRead.mutate({ id: a.id })}>تعيين كمقروء</Button>}
                      </div>
                      {a.requiresAck && !a.acknowledgedAt && (
                        <Button size="sm" className="mt-2" disabled={acknowledgeAnnouncement.isPending} onClick={() => acknowledgeAnnouncement.mutate({ id: a.id })}>
                          {acknowledgeAnnouncement.isPending ? "جارٍ…" : "أقرّ بالاطلاع"}
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="py-4">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-extrabold">
                <Bell aria-hidden className="size-4" /> آخر الإشعارات
                {unread > 0 && (
                  <span className="rounded-full bg-[var(--sem-info-bg)] px-2 py-0.5 text-2xs font-extrabold text-[var(--sem-info)]">
                    {unread} غير مقروء
                  </span>
                )}
                <button
                  type="button"
                  aria-pressed={unreadOnly}
                  onClick={() => setUnreadOnly((v) => !v)}
                  className={`ms-auto rounded-full border px-2 py-0.5 text-2xs font-bold transition-colors ${
                    unreadOnly ? "border-transparent bg-primary text-primary-foreground" : "hover:bg-muted"
                  }`}
                >
                  غير المقروء فقط
                </button>
              </h2>
              {/*  **سجلٌّ لا طابورُ فعل**: الإشعار لا يُبطَل حين ينفّذ الإجراءَ شخصٌ آخر
                  (لا مسار كتابةٍ لـ`requiresAction` بعد الإنشاء) ⇒ عرضُه طابوراً يطالب بعملٍ
                  منتهٍ. الطابورُ الحقيقيّ هو «قرارات تنتظرني» أعلاه. */}
              <p className="mb-3 rounded-md bg-muted/50 p-2 text-2xs leading-relaxed text-muted-foreground">
                سجلُّ ما وصلك — وقد يكون بعضُه نُفِّذ من شخصٍ آخر. الطابور الفعليّ في «قرارات تنتظرني».
              </p>
              {notes.length === 0 ? (
                <p className="py-4 text-center text-2xs text-muted-foreground">لا إشعارات</p>
              ) : (
                <ul className="space-y-2">
                  {notes.map((n) => {
                    // ٢٠/٨ (بلاغ إنتاج): البطاقة كانت `li` صمّاء — تُسمّي المهمة ولا تفتحها.
                    // فموظّفٌ أُسندت إليه مهمّةُ استوديو يقرأ «أُسندت إليك مهمة رقم ٤٢٨٦» ولا
                    // يجد إليها سبيلاً. و`route` كان مُعاداً من الخادم أصلاً (`db.select()`
                    // كامل) ومُعقَّماً عند الكتابة بـ`safeInternalRoute` — الشاشة وحدها كانت
                    // تُهمله. لا إشعارَ ذا وجهةٍ يبقى طريقاً مسدوداً بعد اليوم.
                    const body = (
                      <div className="flex items-start gap-2">
                        {n.requiresAction ? (
                          <AlertCircle aria-hidden className="mt-0.5 size-3.5 shrink-0 text-[var(--sem-warn)]" />
                        ) : (
                          <Bell aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-bold">{n.title}</p>
                          {n.body && <p className="mt-0.5 text-2xs text-muted-foreground">{n.body}</p>}
                          <p className="mt-0.5 text-2xs text-muted-foreground">{fmtDateTime(n.createdAt)}</p>
                        </div>
                        {n.route && <ExternalLink aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />}
                      </div>
                    );
                    if (!n.route) {
                      return (
                        <li key={n.id} className="rounded-md border p-2">
                          {body}
                        </li>
                      );
                    }
                    return (
                      <li key={n.id}>
                        <Link
                          href={n.route}
                          // ارتفاعٌ لمسيّ كامل: البطاقة تُفتح من الهاتف قبل المكتب.
                          className="block min-h-11 rounded-md border p-2 transition-colors hover:bg-muted/50"
                          onClick={() => {
                            if (!n.readAt) markRead.mutate({ id: n.id });
                          }}
                        >
                          {body}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        </section>
      </div>
    </div>
  );
}

const KIND_LABEL: Record<string, string> = {
  inventory: "تسوية مخزون",
  leave: "إجازة",
  voucher: "سند",
  expense: "مصروف",
  gift: "قسيمة هدية",
};
