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
 *
 * **شريطُ الفرز السريع**: حين تتدفّق إلى هنا كلُّ الطوابير، تصير القائمةُ المسطّحة صعبةَ الفرز.
 * فشريطُ الشرائح يُظهر عدّادَ كلّ نوعٍ معلَّقٍ الآن (والمتأخّرَ) ويُصفّيه **محلّياً وفوريّاً** —
 * والخادمُ يُصفّي الفرعَ والعمر وحدهما كي يبقى العدّادُ كاملاً مهما كان الفلتر.
 */
import * as React from "react";
import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Bell,
  CheckCircle2,
  ClipboardList,
  ExternalLink,
  Inbox as InboxIcon,
  ListTodo,
  Megaphone,
  RefreshCw,
} from "lucide-react";
import { Link, useLocation, useSearch } from "wouter";
import { DecisionRow } from "@/components/decision/DecisionRow";
import { PageHeader } from "@/components/PageHeader";
import { AppSelect } from "@/components/ui/AppSelect";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { fmtDateTime } from "@/lib/date";
import { trpc } from "@/lib/trpc";
import { ACTION_LABELS } from "@shared/actionLabels";
import {
  decisionSpec,
  type DecisionDecideResult,
  type DecisionRowModel,
} from "@shared/decisionRegistry";

/** صفٌّ حُسم للتوّ: يُحفَظ مع نتيجته كي لا تختفي النتيجةُ المُهيكَلة حين يُعاد تحميل المعلَّق. */
type DecidedRow = { row: DecisionRowModel; result: DecisionDecideResult };
const rowKey = (r: Pick<DecisionRowModel, "kind" | "id">) =>
  `${r.kind}-${r.id}`;

/** فلاتر العمر — بالساعات؛ الصفر = الكلّ. */
const AGE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "0", label: "كل الأعمار" },
  { value: "24", label: "أقدم من يوم" },
  { value: "72", label: "أقدم من 3 أيام" },
  { value: "168", label: "أقدم من أسبوع" },
];

/** شريحةُ فرزٍ سريعة (نوعٌ أو «الكل») — نمطٌ موحَّد مع حالة التفعيل. */
const CHIP_BASE =
  "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-2xs font-bold transition-colors";
const chipCls = (active: boolean) =>
  `${CHIP_BASE} ${active ? "border-transparent bg-primary text-primary-foreground" : "hover:bg-muted"}`;

export type MyWorkTab = "decisions" | "tasks" | "updates";

const MY_WORK_TABS: ReadonlyArray<{
  value: MyWorkTab;
  label: string;
  description: string;
  icon: typeof ClipboardList;
}> = [
  {
    value: "decisions",
    label: "قرارات",
    description: "اعتمادات تنتظر حسمك",
    icon: CheckCircle2,
  },
  {
    value: "tasks",
    label: "مهامي",
    description: "المهام المسندة إليك",
    icon: ListTodo,
  },
  {
    value: "updates",
    label: "تحديثات",
    description: "الإعلانات والإشعارات",
    icon: Bell,
  },
];

const MY_WORK_TAB_VALUES = new Set<MyWorkTab>(
  MY_WORK_TABS.map((tab) => tab.value),
);

/**
 * عقد URL للصفحة. التبويب الصريح الصحيح يسبق الهاش القديم، بينما
 * `/my-work#announcements` يبقى رابطاً صالحاً إلى تحديثات الإعلانات.
 */
export function resolveMyWorkTab(
  search: string,
  hash: string,
): {
  tab: MyWorkTab;
  invalidTab: string | null;
  focusAnnouncements: boolean;
} {
  const requested = new URLSearchParams(search).get("tab");
  const normalizedHash = hash.replace(/^#/, "");
  if (requested && MY_WORK_TAB_VALUES.has(requested as MyWorkTab)) {
    const tab = requested as MyWorkTab;
    return {
      tab,
      invalidTab: null,
      focusAnnouncements:
        tab === "updates" && normalizedHash === "announcements",
    };
  }
  if (requested) {
    return {
      tab: "decisions",
      invalidTab: requested,
      focusAnnouncements: false,
    };
  }
  if (normalizedHash === "announcements") {
    return { tab: "updates", invalidTab: null, focusAnnouncements: true };
  }
  return { tab: "decisions", invalidTab: null, focusAnnouncements: false };
}

/** يبقي أي معاملاتٍ أخرى في الرابط ويكتب التبويب صراحةً كي يعمل refresh/back. */
export function buildMyWorkTabHref(
  pathname: string,
  search: string,
  tab: MyWorkTab,
): string {
  const params = new URLSearchParams(search);
  params.set("tab", tab);
  const cleanPath = pathname.split(/[?#]/, 1)[0] || "/my-work";
  return `${cleanPath}?${params.toString()}`;
}

export type SourcePanelState = "loading" | "error" | "empty" | "ready";

/** الخطأ يسبق الفراغ عمداً: فشل المصدر لا يعني أن نتيجته صفر. */
export function sourcePanelState(input: {
  isLoading: boolean;
  isError: boolean;
  count: number;
}): SourcePanelState {
  if (input.isError) return "error";
  if (input.isLoading) return "loading";
  return input.count === 0 ? "empty" : "ready";
}

function currentHash(): string {
  return typeof window === "undefined" ? "" : window.location.hash;
}

function useBrowserHash(locationKey: string): string {
  const [hash, setHash] = useState(currentHash);
  useEffect(() => {
    // `history.pushState` لا يطلق hashchange؛ مزامنة مفتاح wouter تغطي تنقّل التبويبات نفسه.
    setHash(currentHash());
  }, [locationKey]);
  useEffect(() => {
    const sync = () => setHash(currentHash());
    const events = [
      "hashchange",
      "popstate",
      "pushState",
      "replaceState",
    ] as const;
    for (const event of events) window.addEventListener(event, sync);
    return () => {
      for (const event of events) window.removeEventListener(event, sync);
    };
  }, []);
  return hash;
}

function taskStatusLabel(status: string): string {
  if (status === "NEW") return "جديدة";
  if (status === "IN_PROGRESS") return "قيد التنفيذ";
  if (status === "WAITING_CUSTOMER") return "بانتظار العميل";
  return status;
}

function taskPriorityLabel(priority: string): string {
  if (priority === "LOW") return "منخفضة";
  if (priority === "HIGH") return "عالية";
  if (priority === "URGENT") return "عاجلة";
  if (priority === "NORMAL") return "عادية";
  return priority;
}

export default function MyWork() {
  const [pathname, navigate] = useLocation();
  const search = useSearch();
  const hash = useBrowserHash(`${pathname}?${search}`);
  const tabState = resolveMyWorkTab(search, hash);
  const activeTab = tabState.tab;
  const decisionsActive = activeTab === "decisions";
  const tasksActive = activeTab === "tasks";
  const updatesActive = activeTab === "updates";
  const announcementsRef = React.useRef<HTMLDivElement>(null);

  const [kind, setKind] = useState("");
  const [branchId, setBranchId] = useState("");
  const [minAge, setMinAge] = useState("0");
  const [breachedOnly, setBreachedOnly] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [decided, setDecided] = useState<DecidedRow[]>([]);

  const branches = trpc.branches.list.useQuery(undefined, {
    enabled: decisionsActive,
  });
  const inbox = trpc.decisions.inbox.useQuery(
    {
      branchId: branchId ? Number(branchId) : undefined,
      minAgeHours: Number(minAge) > 0 ? Number(minAge) : undefined,
      limit: 200,
    },
    { enabled: decisionsActive, staleTime: 15_000 },
  );
  const notifications = trpc.superApp.notifications.useQuery(
    { limit: 20, unreadOnly },
    { enabled: updatesActive, staleTime: 30_000 },
  );
  const workspace = trpc.superApp.myWorkspace.useQuery(undefined, {
    enabled: tasksActive,
    staleTime: 60_000,
  });
  const announcements = trpc.announcements.mine.useQuery(
    { limit: 20 },
    { enabled: updatesActive, staleTime: 30_000 },
  );
  const markRead = trpc.superApp.markNotificationRead.useMutation({
    onSuccess: () => void notifications.refetch(),
  });
  const markAnnouncementRead = trpc.announcements.markRead.useMutation({
    onSuccess: () => void announcements.refetch(),
  });
  const acknowledgeAnnouncement = trpc.announcements.acknowledge.useMutation({
    onSuccess: () => void announcements.refetch(),
  });

  useEffect(() => {
    if (!tabState.focusAnnouncements || activeTab !== "updates") return;
    const frame = window.requestAnimationFrame(() => {
      announcementsRef.current?.focus({ preventScroll: true });
      announcementsRef.current?.scrollIntoView({
        block: "start",
        behavior: "smooth",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeTab, tabState.focusAnnouncements]);

  // الصفوفُ المحسومة للتوّ تبقى ظاهرةً بنتيجتها فوق المعلَّق، ويُستبعَد نظيرُها من المعلَّق
  // إن بقي فيه (مثل STALE على طلبٍ لا يزال قائماً).
  const decidedKeys = useMemo(
    () => new Set(decided.map((d) => rowKey(d.row))),
    [decided],
  );
  // الخادمُ يُصفّي الفرعَ والعمر؛ النوعُ والمتأخّرُ يُصفَّيان هنا كي يبقى شريطُ الفرز كاملاً وفوريّاً.
  const allPending = useMemo(
    () => (inbox.data?.rows ?? []).filter((r) => !decidedKeys.has(rowKey(r))),
    [inbox.data?.rows, decidedKeys],
  );
  const total = inbox.data?.total ?? 0;
  const failed = inbox.data?.failedSources ?? [];
  // الخادمُ قصَّ الطابورَ (أكثر من الحدّ) — لا مجرّدُ تصفيةٍ محلّية.
  const loadedCapped = total > (inbox.data?.rows?.length ?? 0);
  // عدّادُ كلّ نوعٍ له معلَّقٌ الآن — لا كلَّ السجلّ (نوعٌ بلا صفوفٍ لا شريحةَ له).
  const kindCounts = useMemo(() => {
    const m = new Map<string, { title: string; count: number }>();
    for (const r of allPending) {
      const prev = m.get(r.kind);
      if (prev) prev.count += 1;
      else
        m.set(r.kind, {
          title: decisionSpec(r.kind)?.title ?? r.kind,
          count: 1,
        });
    }
    return Array.from(m.entries())
      .map(([k, v]) => ({ kind: k, title: v.title, count: v.count }))
      .sort(
        (a, b) => b.count - a.count || a.title.localeCompare(b.title, "ar"),
      );
  }, [allPending]);
  const breached = allPending.filter((r) => r.sla?.breached).length;
  const gatedKinds = inbox.data?.kinds?.length ?? 0;
  // العرضُ النهائيّ: تصفيةُ النوع والمتأخّر محلّياً (فوريّة، بلا إعادة تحميل).
  const rows = allPending.filter(
    (r) => (!kind || r.kind === kind) && (!breachedOnly || r.sla?.breached),
  );

  const notesData = notifications.data;
  const notes = Array.isArray(notesData) ? notesData : (notesData?.rows ?? []);
  const unread = Array.isArray(notesData) ? 0 : (notesData?.unreadCount ?? 0);
  const announcementRows = announcements.data?.rows ?? [];
  const unreadAnnouncements = announcements.data?.unreadCount ?? 0;
  const hasFilters =
    kind !== "" || branchId !== "" || minAge !== "0" || breachedOnly;
  const announcementState = sourcePanelState({
    isLoading: announcements.isLoading,
    isError: announcements.isError,
    count: announcementRows.length,
  });
  const notificationState = sourcePanelState({
    isLoading: notifications.isLoading,
    isError: notifications.isError,
    count: notes.length,
  });
  const activeIsFetching = decisionsActive
    ? inbox.isFetching
    : tasksActive
      ? workspace.isFetching
      : notifications.isFetching || announcements.isFetching;

  function selectTab(tab: MyWorkTab) {
    if (
      tab === activeTab &&
      tabState.invalidTab === null &&
      !tabState.focusAnnouncements
    )
      return;
    navigate(buildMyWorkTabHref(pathname, search, tab));
  }

  function refetchActiveTab() {
    if (decisionsActive) {
      void inbox.refetch();
      return;
    }
    if (tasksActive) {
      void workspace.refetch();
      return;
    }
    void Promise.all([notifications.refetch(), announcements.refetch()]);
  }

  return (
    <div className="mx-auto w-full max-w-[1180px] px-4 py-5">
      <PageHeader
        title="مطلوب منّي الآن"
        description="مساحة عمل واحدة تجمع قراراتك ومهامك وتحديثاتك، من دون التنقل بين شاشات متفرقة."
        icon={<ClipboardList aria-hidden className="size-5" />}
        actions={
          <Button
            size="sm"
            variant="outline"
            onClick={refetchActiveTab}
            disabled={activeIsFetching}
          >
            <RefreshCw
              aria-hidden
              className={`size-3.5 me-1 ${activeIsFetching ? "animate-spin" : ""}`}
            />{" "}
            {ACTION_LABELS.refresh}
          </Button>
        }
      />

      <div
        className="mb-4 border-b"
        role="tablist"
        aria-label="أقسام مطلوب مني الآن"
      >
        <div className="flex min-w-0 gap-1 overflow-x-auto">
          {MY_WORK_TABS.map((tab) => {
            const Icon = tab.icon;
            const selected = tab.value === activeTab;
            return (
              <button
                key={tab.value}
                id={`my-work-tab-${tab.value}`}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`my-work-panel-${tab.value}`}
                onClick={() => selectTab(tab.value)}
                className={`min-h-12 shrink-0 border-b-2 px-4 py-2 text-start transition-colors ${
                  selected
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:border-border hover:text-foreground"
                }`}
              >
                <span className="flex items-center gap-2 text-sm font-extrabold">
                  <Icon aria-hidden className="size-4" />
                  {tab.label}
                </span>
                <span className="mt-0.5 block text-2xs font-normal">
                  {tab.description}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {tabState.invalidTab && (
        <Card className="mb-4 gap-0 border-[var(--sem-warn)] py-0">
          <CardContent className="flex items-start gap-2 py-3 text-2xs text-[var(--sem-warn)]">
            <AlertCircle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            <p>
              قيمة التبويب في الرابط غير صالحة؛ عُرض تبويب القرارات بدلاً منها
              ويمكنك اختيار تبويب آخر من الأعلى.
            </p>
          </CardContent>
        </Card>
      )}

      {decisionsActive && (
        <section
          id="my-work-panel-decisions"
          role="tabpanel"
          aria-labelledby="my-work-tab-decisions"
          className="space-y-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="flex items-center gap-2 text-sm font-extrabold">
              <CheckCircle2 aria-hidden className="size-4" />
              قرارات تنتظرني
              {total > 0 && (
                <span className="rounded-full bg-[var(--sem-warn-bg)] px-2 py-0.5 text-2xs font-extrabold text-[var(--sem-warn)]">
                  {total}
                </span>
              )}
            </h2>
            <div className="ms-auto flex flex-wrap items-center gap-2">
              {(branches.data?.length ?? 0) > 1 && (
                <AppSelect
                  className="h-8 min-w-28 text-xs"
                  value={branchId}
                  onValueChange={setBranchId}
                  aria-label="الفرع"
                >
                  <option value="">كل الفروع</option>
                  {branches.data?.map((b) => (
                    <option key={b.id} value={String(b.id)}>
                      {b.name}
                    </option>
                  ))}
                </AppSelect>
              )}
              <AppSelect
                className="h-8 min-w-28 text-xs"
                value={minAge}
                onValueChange={setMinAge}
                aria-label="العمر"
              >
                {AGE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </AppSelect>
            </div>
          </div>

          {/* ─── شريط الفرز السريع: عدّاد كل نوعٍ معلَّق + المتأخّر (تصفية محلّية فوريّة) ─── */}
          {allPending.length > 0 && (
            <div
              className="flex flex-wrap items-center gap-1.5"
              role="group"
              aria-label="فرز سريع"
            >
              <button
                type="button"
                onClick={() => {
                  setKind("");
                  setBreachedOnly(false);
                }}
                aria-pressed={kind === "" && !breachedOnly}
                className={chipCls(kind === "" && !breachedOnly)}
              >
                الكل <span className="tabular-nums">{allPending.length}</span>
              </button>
              {breached > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setBreachedOnly((v) => !v);
                    setKind("");
                  }}
                  aria-pressed={breachedOnly}
                  title="تجاوزت سقف القرار"
                  className={`${CHIP_BASE} border-[var(--sem-danger-bg)] bg-[var(--sem-danger-bg)] text-[var(--sem-danger)] ${breachedOnly ? "ring-2 ring-[var(--sem-danger)]" : "hover:brightness-95"}`}
                >
                  <AlertCircle aria-hidden className="size-3" /> متأخّر{" "}
                  <span className="tabular-nums">{breached}</span>
                </button>
              )}
              {kindCounts.map((k) => (
                <button
                  key={k.kind}
                  type="button"
                  onClick={() => {
                    setKind((cur) => (cur === k.kind ? "" : k.kind));
                    setBreachedOnly(false);
                  }}
                  aria-pressed={kind === k.kind}
                  className={chipCls(kind === k.kind)}
                >
                  {k.title} <span className="tabular-nums">{k.count}</span>
                </button>
              ))}
            </div>
          )}

          {failed.length > 0 && (
            <Card>
              <CardContent className="flex items-start gap-2 py-3 text-2xs text-[var(--sem-warn)]">
                <AlertCircle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                <div>
                  <p className="font-bold">
                    تعذّر سرد بعض الطوابير — قد يكون فيها ما ينتظرك:
                  </p>
                  <ul className="mt-1 list-disc ps-4">
                    {failed.map((f) => (
                      <li key={f.key}>
                        {f.key}: {f.message}
                      </li>
                    ))}
                  </ul>
                </div>
              </CardContent>
            </Card>
          )}

          {inbox.isLoading && (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                {ACTION_LABELS.loading}
              </CardContent>
            </Card>
          )}
          {inbox.isError && (
            <Card>
              <CardContent className="py-8 text-center text-sm text-[var(--sem-danger)]">
                تعذّر تحميل القرارات: {inbox.error.message}
                <Button
                  size="sm"
                  variant="outline"
                  className="ms-2"
                  onClick={() => void inbox.refetch()}
                >
                  {ACTION_LABELS.retry}
                </Button>
              </CardContent>
            </Card>
          )}
          {!inbox.isLoading && !inbox.isError && rows.length === 0 && (
            <Card>
              <CardContent className="py-10 text-center">
                <CheckCircle2
                  aria-hidden
                  className="mx-auto mb-2 size-8 text-[var(--sem-pos)]"
                />
                <p className="text-sm font-bold">
                  {hasFilters ? "لا قرارات مطابقة للفلاتر" : "لا قرارات معلّقة"}
                </p>
                <p className="mt-1 text-2xs text-muted-foreground">
                  {hasFilters
                    ? "أزِل فلتراً أو وسّعه لترى الباقي."
                    : gatedKinds === 0
                      ? "دورك لا يملك بوّابة اعتمادٍ على أيّ نوعٍ موصول بالصندوق."
                      : "لا شيء ينتظر قرارك الآن في الأنواع التي تملك بوّابتها."}
                </p>
              </CardContent>
            </Card>
          )}

          {decided.map(({ row, result }) => (
            <DecisionRow
              key={`decided-${rowKey(row)}`}
              row={row}
              initialResult={result}
              onDismiss={() =>
                setDecided((list) =>
                  list.filter((d) => rowKey(d.row) !== rowKey(row)),
                )
              }
            />
          ))}
          {rows.map((row) => (
            <DecisionRow
              key={rowKey(row)}
              row={row}
              onDecided={(result) => {
                setDecided((list) => [
                  { row, result },
                  ...list.filter((d) => rowKey(d.row) !== rowKey(row)),
                ]);
                void inbox.refetch();
              }}
            />
          ))}
          {loadedCapped && (
            <p className="text-center text-2xs text-muted-foreground">
              حُمِّل {inbox.data?.rows?.length ?? 0} من {total} — احسم ما يظهر
              ليظهر الباقي.
            </p>
          )}
        </section>
      )}

      {tasksActive && (
        <section
          id="my-work-panel-tasks"
          role="tabpanel"
          aria-labelledby="my-work-tab-tasks"
          className="space-y-4"
        >
          {workspace.isLoading && (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                {ACTION_LABELS.loading}
              </CardContent>
            </Card>
          )}
          {workspace.isError && (
            <Card>
              <CardContent className="py-8 text-center text-sm text-[var(--sem-danger)]">
                تعذّر تحميل مهامك: {workspace.error.message}
                <Button
                  size="sm"
                  variant="outline"
                  className="ms-2"
                  onClick={() => void workspace.refetch()}
                >
                  {ACTION_LABELS.retry}
                </Button>
              </CardContent>
            </Card>
          )}
          {workspace.data && (
            <>
              {workspace.data.employee && (
                <Card className="gap-0 py-0">
                  <CardContent className="flex flex-wrap items-center gap-x-3 gap-y-1 py-4">
                    <InboxIcon
                      aria-hidden
                      className="size-4 text-muted-foreground"
                    />
                    <p className="text-sm font-extrabold">
                      {workspace.data.employee.name}
                    </p>
                    {(workspace.data.employee.position ||
                      workspace.data.employee.department) && (
                      <p className="text-2xs text-muted-foreground">
                        {[
                          workspace.data.employee.position,
                          workspace.data.employee.department,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    )}
                  </CardContent>
                </Card>
              )}

              <Card className="gap-0 py-0">
                <CardContent className="py-4">
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    <h2 className="flex items-center gap-2 text-sm font-extrabold">
                      <ListTodo aria-hidden className="size-4" /> المهام النشطة
                      المسندة إليّ
                    </h2>
                    <Button
                      asChild
                      size="sm"
                      variant="outline"
                      className="ms-auto"
                    >
                      <Link href="/tasks?tab=mine">عرض كل مهامي</Link>
                    </Button>
                  </div>
                  {workspace.data.tasks.length === 0 ? (
                    <div className="py-8 text-center">
                      <CheckCircle2
                        aria-hidden
                        className="mx-auto mb-2 size-8 text-[var(--sem-pos)]"
                      />
                      <p className="text-sm font-bold">
                        لا توجد مهام نشطة مسندة إليك
                      </p>
                    </div>
                  ) : (
                    <ul className="divide-y rounded-md border">
                      {workspace.data.tasks.map((task) => (
                        <li key={task.id}>
                          <Link
                            href={`/tasks/${task.id}`}
                            className="flex min-h-16 items-start gap-3 p-3 transition-colors hover:bg-muted/50"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span
                                  className="font-mono text-2xs text-muted-foreground"
                                  dir="ltr"
                                >
                                  {task.taskNumber}
                                </span>
                                <Badge variant="outline">
                                  {taskStatusLabel(task.status)}
                                </Badge>
                                <Badge
                                  variant={
                                    task.priority === "URGENT"
                                      ? "danger"
                                      : task.priority === "HIGH"
                                        ? "warning"
                                        : "neutral"
                                  }
                                >
                                  {taskPriorityLabel(task.priority)}
                                </Badge>
                              </div>
                              <p className="mt-1 text-sm font-bold">
                                {task.title}
                              </p>
                              {task.dueAt && (
                                <p className="mt-1 text-2xs text-muted-foreground">
                                  الاستحقاق: {fmtDateTime(task.dueAt)}
                                </p>
                              )}
                            </div>
                            <ExternalLink
                              aria-hidden
                              className="mt-1 size-3.5 shrink-0 text-muted-foreground"
                            />
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </section>
      )}

      {updatesActive && (
        <section
          id="my-work-panel-updates"
          role="tabpanel"
          aria-labelledby="my-work-tab-updates"
          className="grid items-start gap-4 lg:grid-cols-2"
        >
          <Card
            id="announcements"
            ref={announcementsRef}
            tabIndex={-1}
            className="gap-0 py-0 scroll-mt-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <CardContent className="py-4">
              <h2 className="mb-3 flex flex-wrap items-center gap-2 text-sm font-extrabold">
                <Megaphone aria-hidden className="size-4" /> الإعلانات
                {unreadAnnouncements > 0 && (
                  <span className="rounded-full bg-[var(--sem-info-bg)] px-2 py-0.5 text-2xs font-extrabold text-[var(--sem-info)]">
                    {unreadAnnouncements} غير مقروء
                  </span>
                )}
              </h2>
              {announcementState === "loading" && (
                <p className="py-6 text-center text-2xs text-muted-foreground">
                  {ACTION_LABELS.loading}
                </p>
              )}
              {announcementState === "error" && (
                <div className="py-6 text-center text-2xs text-[var(--sem-danger)]">
                  <p>تعذّر تحميل الإعلانات: {announcements.error?.message}</p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2"
                    onClick={() => void announcements.refetch()}
                  >
                    {ACTION_LABELS.retry}
                  </Button>
                </div>
              )}
              {announcementState === "empty" && (
                <p className="py-6 text-center text-2xs text-muted-foreground">
                  لا توجد إعلانات موجهة إليك
                </p>
              )}
              {announcementState === "ready" && (
                <ul className="space-y-2">
                  {announcementRows.map((announcement) => (
                    <li key={announcement.id} className="rounded-md border p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-xs font-bold">
                            {announcement.title}
                          </p>
                          <p className="mt-1 whitespace-pre-wrap text-2xs leading-relaxed text-muted-foreground">
                            {announcement.body}
                          </p>
                          <p className="mt-1 text-2xs text-muted-foreground">
                            {fmtDateTime(announcement.createdAt)}
                            {announcement.expiresAt
                              ? ` · ينتهي ${fmtDateTime(announcement.expiresAt)}`
                              : ""}
                          </p>
                        </div>
                        {!announcement.readAt && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              markAnnouncementRead.mutate({
                                id: announcement.id,
                              })
                            }
                          >
                            تعيين كمقروء
                          </Button>
                        )}
                      </div>
                      {announcement.requiresAck &&
                        !announcement.acknowledgedAt && (
                          <Button
                            size="sm"
                            className="mt-2"
                            disabled={acknowledgeAnnouncement.isPending}
                            onClick={() =>
                              acknowledgeAnnouncement.mutate({
                                id: announcement.id,
                              })
                            }
                          >
                            {acknowledgeAnnouncement.isPending
                              ? ACTION_LABELS.processing
                              : "أقرّ بالاطلاع"}
                          </Button>
                        )}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card className="gap-0 py-0">
            <CardContent className="py-4">
              <h2 className="mb-3 flex flex-wrap items-center gap-2 text-sm font-extrabold">
                <Bell aria-hidden className="size-4" /> آخر الإشعارات
                {unread > 0 && (
                  <span className="rounded-full bg-[var(--sem-info-bg)] px-2 py-0.5 text-2xs font-extrabold text-[var(--sem-info)]">
                    {unread} غير مقروء
                  </span>
                )}
                <button
                  type="button"
                  aria-pressed={unreadOnly}
                  onClick={() => setUnreadOnly((value) => !value)}
                  className={`ms-auto rounded-full border px-2 py-0.5 text-2xs font-bold transition-colors ${
                    unreadOnly
                      ? "border-transparent bg-primary text-primary-foreground"
                      : "hover:bg-muted"
                  }`}
                >
                  غير المقروء فقط
                </button>
              </h2>
              <p className="mb-3 rounded-md bg-muted/50 p-2 text-2xs leading-relaxed text-muted-foreground">
                سجلُّ ما وصلك — وقد يكون بعضُه نُفِّذ من شخصٍ آخر. الطابور
                الفعليّ في تبويب «قرارات».
              </p>
              {notificationState === "loading" && (
                <p className="py-6 text-center text-2xs text-muted-foreground">
                  {ACTION_LABELS.loading}
                </p>
              )}
              {notificationState === "error" && (
                <div className="py-6 text-center text-2xs text-[var(--sem-danger)]">
                  <p>تعذّر تحميل الإشعارات: {notifications.error?.message}</p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2"
                    onClick={() => void notifications.refetch()}
                  >
                    {ACTION_LABELS.retry}
                  </Button>
                </div>
              )}
              {notificationState === "empty" && (
                <p className="py-6 text-center text-2xs text-muted-foreground">
                  {unreadOnly ? "لا توجد إشعارات غير مقروءة" : "لا إشعارات"}
                </p>
              )}
              {notificationState === "ready" && (
                <ul className="space-y-2">
                  {notes.map((notification) => {
                    const body = (
                      <div className="flex items-start gap-2">
                        {notification.requiresAction ? (
                          <AlertCircle
                            aria-hidden
                            className="mt-0.5 size-3.5 shrink-0 text-[var(--sem-warn)]"
                          />
                        ) : (
                          <Bell
                            aria-hidden
                            className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                          />
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-bold">
                            {notification.title}
                          </p>
                          {notification.body && (
                            <p className="mt-0.5 text-2xs text-muted-foreground">
                              {notification.body}
                            </p>
                          )}
                          <p className="mt-0.5 text-2xs text-muted-foreground">
                            {fmtDateTime(notification.createdAt)}
                          </p>
                        </div>
                        {notification.route && (
                          <ExternalLink
                            aria-hidden
                            className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                          />
                        )}
                      </div>
                    );
                    if (!notification.route) {
                      return (
                        <li
                          key={notification.id}
                          className="rounded-md border p-2"
                        >
                          {body}
                        </li>
                      );
                    }
                    return (
                      <li key={notification.id}>
                        <Link
                          href={notification.route}
                          className="block min-h-11 rounded-md border p-2 transition-colors hover:bg-muted/50"
                          onClick={() => {
                            if (!notification.readAt)
                              markRead.mutate({ id: notification.id });
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
      )}
    </div>
  );
}
