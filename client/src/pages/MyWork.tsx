/**
 * **مطلوب منّي الآن** — الصندوق الموحّد المبنيّ من سجلّ القرارات (م٧ ق٢: «الفعل في مكانه»).
 *
 * كان هذا السطح يقرأ `superApp.approvalInbox` (ستّة أنواع) ويرسل المعتمِد إلى شاشةٍ أخرى
 * ليقرّر. صار يقرأ `decisions.inbox` — كلَّ الطوابير الموصولة بـ`shared/decisionRegistry.ts`
 * (المشتريات التسعة أوّلاً) — ويعرض في كلّ صفٍّ **ما يُقرَّر عليه** (الطرف · المبلغ · الأصناف
 * بكمّياتها وأسعارها · السبب) ويحسم في مكانه بنتيجةٍ مُهيكَلة (`<DecisionRow>`).
 *
 * **قراءةٌ محضة على مستوى الصفحة**: الحسمُ نفسه يقع داخل الصفّ عبر `decisions.decide` الذي
 * يوجّهه الخادم إلى دالّة الحسم الأصلية بحرّاسها. الإعلاناتُ والإشعاراتُ تبقى سجلّاً لا طابورَ
 * فعل (لا مسار كتابةٍ يُبطلها حين ينفّذ غيرُك الإجراء).
 */
import { useMemo, useState } from "react";
import { AlertCircle, Bell, CheckCircle2, ClipboardList, ExternalLink, Inbox as InboxIcon, Megaphone, RefreshCw } from "lucide-react";
import { Link } from "wouter";
import { DecisionRow } from "@/components/decision/DecisionRow";
import { PageHeader } from "@/components/PageHeader";
import { AppSelect } from "@/components/ui/AppSelect";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { fmtDateTime } from "@/lib/date";
import { trpc } from "@/lib/trpc";
import { ACTION_LABELS } from "@shared/actionLabels";
import { decisionSpec } from "@shared/decisionRegistry";

/** فلاتر العمر — بالساعات؛ الصفر = الكلّ. */
const AGE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "0", label: "كل الأعمار" },
  { value: "24", label: "أقدم من يوم" },
  { value: "72", label: "أقدم من 3 أيام" },
  { value: "168", label: "أقدم من أسبوع" },
];

export default function MyWork() {
  const me = trpc.auth.me.useQuery();
  const [kind, setKind] = useState("");
  const [branchId, setBranchId] = useState("");
  const [minAge, setMinAge] = useState("0");
  const [unreadOnly, setUnreadOnly] = useState(false);

  const branches = trpc.branches.list.useQuery();
  const inbox = trpc.decisions.inbox.useQuery(
    {
      kind: kind || undefined,
      branchId: branchId ? Number(branchId) : undefined,
      minAgeHours: Number(minAge) > 0 ? Number(minAge) : undefined,
      limit: 200,
    },
    { staleTime: 15_000 },
  );
  const notifications = trpc.superApp.notifications.useQuery({ limit: 20, unreadOnly }, { staleTime: 30_000 });
  const workspace = trpc.superApp.myWorkspace.useQuery(undefined, { staleTime: 60_000 });
  const announcements = trpc.announcements.mine.useQuery({ limit: 20 }, { staleTime: 30_000 });
  const markRead = trpc.superApp.markNotificationRead.useMutation({ onSuccess: () => void notifications.refetch() });
  const markAnnouncementRead = trpc.announcements.markRead.useMutation({ onSuccess: () => void announcements.refetch() });
  const acknowledgeAnnouncement = trpc.announcements.acknowledge.useMutation({ onSuccess: () => void announcements.refetch() });

  const rows = inbox.data?.rows ?? [];
  const total = inbox.data?.total ?? 0;
  const failed = inbox.data?.failedSources ?? [];
  // فلترُ النوع يعرض الأنواع التي يملك المستخدم بوّابتها — لا كلَّ السجلّ.
  const kindOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const k of inbox.data?.kinds ?? []) {
      const spec = decisionSpec(k);
      if (spec && !seen.has(k)) seen.set(k, spec.title);
    }
    return Array.from(seen.entries()).sort((a, b) => a[1].localeCompare(b[1], "ar"));
  }, [inbox.data?.kinds]);
  const breached = rows.filter((r) => r.sla?.breached).length;

  const notesData = notifications.data;
  const notes = Array.isArray(notesData) ? notesData : (notesData?.rows ?? []);
  const unread = Array.isArray(notesData) ? 0 : (notesData?.unreadCount ?? 0);
  const announcementRows = announcements.data?.rows ?? [];
  const unreadAnnouncements = announcements.data?.unreadCount ?? 0;
  const hasFilters = kind !== "" || branchId !== "" || minAge !== "0";

  return (
    <div className="mx-auto w-full max-w-[1180px] px-4 py-5">
      <PageHeader
        title="مطلوب منّي الآن"
        description="كل قرارٍ ينتظرك من كل الوحدات في صندوقٍ واحد — تقرأ ما يُقرَّر عليه وتحسمه في مكانه."
        icon={<ClipboardList aria-hidden className="size-5" />}
        actions={
          <Button size="sm" variant="outline" onClick={() => void inbox.refetch()} disabled={inbox.isFetching}>
            <RefreshCw aria-hidden className={`size-3.5 me-1 ${inbox.isFetching ? "animate-spin" : ""}`} /> {ACTION_LABELS.refresh}
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        {/* ─── قرارات تنتظرني ─── */}
        <section aria-label="قرارات تنتظرني" className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="flex items-center gap-2 text-sm font-extrabold">
              <CheckCircle2 aria-hidden className="size-4" />
              قرارات تنتظرني
              {total > 0 && (
                <span className="rounded-full bg-[var(--sem-warn-bg)] px-2 py-0.5 text-2xs font-extrabold text-[var(--sem-warn)]">
                  {total}
                </span>
              )}
              {breached > 0 && (
                <span className="rounded-full bg-[var(--sem-danger-bg)] px-2 py-0.5 text-2xs font-extrabold text-[var(--sem-danger)]" title="تجاوزت سقف القرار">
                  {breached} متأخر
                </span>
              )}
            </h2>
            <div className="ms-auto flex flex-wrap items-center gap-2">
              <AppSelect className="h-8 min-w-36 text-xs" value={kind} onValueChange={setKind} aria-label="النوع">
                <option value="">كل الأنواع</option>
                {kindOptions.map(([k, title]) => (
                  <option key={k} value={k}>{title}</option>
                ))}
              </AppSelect>
              {(branches.data?.length ?? 0) > 1 && (
                <AppSelect className="h-8 min-w-28 text-xs" value={branchId} onValueChange={setBranchId} aria-label="الفرع">
                  <option value="">كل الفروع</option>
                  {branches.data?.map((b) => (
                    <option key={b.id} value={String(b.id)}>{b.name}</option>
                  ))}
                </AppSelect>
              )}
              <AppSelect className="h-8 min-w-28 text-xs" value={minAge} onValueChange={setMinAge} aria-label="العمر">
                {AGE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </AppSelect>
            </div>
          </div>

          {failed.length > 0 && (
            <Card>
              <CardContent className="flex items-start gap-2 py-3 text-2xs text-[var(--sem-warn)]">
                <AlertCircle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                <div>
                  <p className="font-bold">تعذّر سرد بعض الطوابير — قد يكون فيها ما ينتظرك:</p>
                  <ul className="mt-1 list-disc ps-4">
                    {failed.map((f) => (
                      <li key={f.key}>{f.key}: {f.message}</li>
                    ))}
                  </ul>
                </div>
              </CardContent>
            </Card>
          )}

          {inbox.isLoading && (
            <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">{ACTION_LABELS.loading}</CardContent></Card>
          )}
          {inbox.isError && (
            <Card><CardContent className="py-8 text-center text-sm text-[var(--sem-danger)]">
              تعذّر تحميل القرارات: {inbox.error.message}
              <Button size="sm" variant="outline" className="ms-2" onClick={() => void inbox.refetch()}>{ACTION_LABELS.retry}</Button>
            </CardContent></Card>
          )}
          {!inbox.isLoading && !inbox.isError && rows.length === 0 && (
            <Card><CardContent className="py-10 text-center">
              <CheckCircle2 aria-hidden className="mx-auto mb-2 size-8 text-[var(--sem-pos)]" />
              <p className="text-sm font-bold">{hasFilters ? "لا قرارات مطابقة للفلاتر" : "لا قرارات معلّقة"}</p>
              <p className="mt-1 text-2xs text-muted-foreground">
                {hasFilters
                  ? "وسّع النوع أو الفرع أو العمر."
                  : kindOptions.length === 0
                    ? "دورك لا يملك بوّابة اعتمادٍ على أيّ نوعٍ موصول بالصندوق."
                    : "لا شيء ينتظر قرارك الآن في الأنواع التي تملك بوّابتها."}
              </p>
            </CardContent></Card>
          )}

          {rows.map((row) => (
            <DecisionRow key={`${row.kind}-${row.id}`} row={row} onDecided={() => void inbox.refetch()} />
          ))}
          {total > rows.length && (
            <p className="text-center text-2xs text-muted-foreground">يُعرض {rows.length} من {total} — احسم ما يظهر ليظهر الباقي.</p>
          )}
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
                          {acknowledgeAnnouncement.isPending ? ACTION_LABELS.processing : "أقرّ بالاطلاع"}
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
              <p className="mb-3 rounded-md bg-muted/50 p-2 text-2xs leading-relaxed text-muted-foreground">
                سجلُّ ما وصلك — وقد يكون بعضُه نُفِّذ من شخصٍ آخر. الطابور الفعليّ في «قرارات تنتظرني».
              </p>
              {notes.length === 0 ? (
                <p className="py-4 text-center text-2xs text-muted-foreground">لا إشعارات</p>
              ) : (
                <ul className="space-y-2">
                  {notes.map((n) => {
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
