import { useCallback, useMemo, useState } from "react";
import { Link, useParams } from "wouter";
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  ClipboardCheck,
  Search,
  Send,
} from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useBarcodeScanner } from "@/hooks/useBarcodeScanner";
import { CameraScanner } from "@/components/scan/CameraScanner";
import { confirm } from "@/lib/confirm";
import { errMsg, notify } from "@/lib/notify";
import { fmtInt } from "@/lib/money";
import { newClientRequestId } from "@/lib/countQueue";
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

type State = RouterOutputs["count"]["state"];
type CountItem = State["items"][number];
type CountUnit = CountItem["units"][number];

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
 */
export default function MyStocktakeWorkspace() {
  const { code: rawCode } = useParams<{ code?: string }>();
  const code = decodeURIComponent(rawCode ?? "").trim();
  const utils = trpc.useUtils();
  const state = trpc.count.state.useQuery(
    { sessionCode: code },
    { enabled: Boolean(code), retry: false, refetchInterval: 5_000 },
  );
  const submit = trpc.count.submit.useMutation();
  const finish = trpc.count.finish.useMutation();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<CountItem | null>(null);
  /** الوحدة التي طابق باركودُها المسح — يبدأ التركيز عليها في بطاقة الكمية. */
  const [scannedUnit, setScannedUnit] = useState<string | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);

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

  const openItem = useCallback(
    (item: CountItem, unitName?: string) => {
      if (
        st?.session.status !== "COUNTING" ||
        st.assignment.status === "SUBMITTED"
      )
        return;
      if (
        st.session.dupPolicy === "BLOCK" &&
        item.colleagueCounted &&
        !item.myCount
      ) {
        notify.info("هذا المنتج عُدّ مسبقاً، وسياسة الجلسة تمنع العدّ المكرر.");
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
        notify.warn("الباركود لا يطابق منتجاً في هذه الجلسة", value);
        return;
      }
      // باركود وحدة أكبر (كرتون/درزن) ⇒ افتح الكمية على وحدته لا على وحدة الأساس.
      openItem(found, found.units.find((u) => unitHasBarcode(u, value))?.unitName);
    },
    [items, openItem],
  );
  // قارئ HID: يُعطَّل أثناء فتح البطاقة أو الكاميرا كي لا يتضاعف الالتقاط.
  useBarcodeScanner(onBarcode, {
    enabled: Boolean(st) && selected == null && !cameraOpen,
  });

  const save = (qty: number, unitBreakdown: string | undefined) => {
    if (!selected) return;
    if (!Number.isSafeInteger(qty) || qty < 0) {
      notify.warn("أدخل كمية صحيحة تساوي صفراً أو أكثر.");
      return;
    }
    submit.mutate(
      {
        sessionCode: code,
        variantId: selected.variantId,
        qty,
        unitBreakdown,
        clientRequestId: newClientRequestId(),
      },
      {
        onSuccess: async () => {
          setSelected(null);
          setScannedUnit(null);
          notify.ok("تم حفظ العدّ");
          await utils.count.state.invalidate({ sessionCode: code });
        },
        onError: (error) => notify.err(error),
      },
    );
  };

  const submitAssignment = async () => {
    if (
      !st ||
      !(await confirm({
        title: "تسليم العدّ للمراجعة",
        description:
          "لن تتمكن من إضافة أو تعديل عدّك بعد التسليم. لا تنهِ المهمة إلا بعد توجيه المسؤول.",
        confirmText: "تسليم العدّ",
        variant: "warning",
      }))
    )
      return;
    finish.mutate(
      { sessionCode: code },
      {
        onSuccess: async (result) => {
          notify.ok(
            result.sessionMovedToReview
              ? "اكتمل الجرد وانتقل للمراجعة"
              : "تم تسليم عدّك للمراجعة",
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
  if (state.isError || !st) {
    return (
      <Card className="mx-auto mt-10 max-w-2xl">
        <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
          <AlertTriangle className="size-10 text-stock-low" aria-hidden />
          <div>
            <p className="font-bold">لا يمكن فتح مهمة الجرد بهذا الحساب</p>
            <p className="mt-1 text-sm text-muted-foreground">
              يجب أن يكون تكليفك من نوع «حساب مستخدم داخل النظام». لا يوجد PIN
              في شاشة الحسابات.
            </p>
            <p className="mt-2 text-xs text-destructive">
              {state.error ? errMsg(state.error) : ""}
            </p>
          </div>
          <Link href="/my-stocktake">
            <Button variant="outline">العودة إلى جردي</Button>
          </Link>
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
  const minePct = mine.total ? Math.round((mine.counted / mine.total) * 100) : 0;
  const canCount =
    st.session.status === "COUNTING" && st.assignment.status === "ACTIVE";
  const statusHint = canCount
    ? "قيد العدّ — يمكنك الحفظ والمتابعة لاحقاً."
    : st.assignment.status === "SUBMITTED"
      ? "تم تسليم عدّك للمراجعة."
      : "أغلقت الجلسة للمراجعة.";

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
        <div className="flex items-center gap-2 rounded-xl bg-primary/10 px-3 py-1.5 text-xs font-bold text-primary sm:px-4 sm:py-2 sm:text-sm">
          <ClipboardCheck className="size-4" aria-hidden /> جرد أعمى
        </div>
      </header>

      {/* الهاتف: شريط تقدّم مضغوط + زرّ التسليم (بدل البطاقات الثلاث) */}
      <section className="rounded-2xl border bg-card p-4 sm:hidden">
        <div className="flex items-center justify-between gap-2 text-sm font-bold">
          <span>عدّي المسجّل</span>
          <span className="font-mono tabular-nums" dir="ltr">
            {fmtInt(mine.counted)} / {fmtInt(mine.total)}
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
          disabled={!canCount || finish.isPending}
          onClick={() => void submitAssignment()}
        >
          <Send className="size-4" aria-hidden /> تسليم عدّي للمراجعة
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
          value={`${fmtInt(mine.counted)} / ${fmtInt(mine.total)}`}
          hint="عدد المنتجات التي أدخلتها أنت"
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
              disabled={!canCount || finish.isPending}
              onClick={() => void submitAssignment()}
            >
              <Send className="size-4" aria-hidden /> تسليم عدّي للمراجعة
            </Button>
          </CardContent>
        </Card>
      </section>

      {st.recountTasks.length > 0 && (
        <div className="badge-stock-low rounded-xl border border-border p-4 text-sm">
          <p className="font-bold">
            يوجد {fmtInt(st.recountTasks.length)} طلب إعادة عدّ.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {st.recountTasks.map((task) => (
              <Button
                key={task.variantId}
                size="sm"
                variant="outline"
                onClick={() => {
                  const item = items.find(
                    (i) => i.variantId === task.variantId,
                  );
                  if (item) openItem(item);
                }}
              >
                {task.productName} — إعادة عدّ
              </Button>
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
            <div className="flex w-full items-center gap-2 sm:w-auto">
              <div className="relative min-w-0 flex-1 sm:w-80 sm:flex-none">
                <Search
                  className="absolute right-3 top-3 size-4 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="اسم المنتج أو SKU أو باركود…"
                  className="h-11 pr-9"
                />
              </div>
              <Button
                type="button"
                className="h-11 shrink-0 gap-1.5"
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
            {filtered.map((item) => (
              <button
                key={item.variantId}
                type="button"
                onClick={() => openItem(item)}
                disabled={!canCount}
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
                  {item.counted ? (
                    <span className="inline-flex items-center gap-1 text-stock-ok">
                      <CheckCircle2 className="size-4" aria-hidden /> معدود
                    </span>
                  ) : (
                    <span className="text-muted-foreground">غير معدود</span>
                  )}
                </span>
                <span className="w-14 shrink-0 text-left sm:w-[110px] sm:text-right">
                  {item.myCount ? (
                    <span className="font-mono text-primary" dir="ltr">
                      {fmtInt(item.myCount.qty)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </span>
              </button>
            ))}
            {filtered.length === 0 && (
              <p className="p-10 text-center text-sm text-muted-foreground">
                لا توجد نتائج مطابقة.
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
              key={selected.variantId}
              item={selected}
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
  focusUnit,
  saving,
  onCancel,
  onSave,
}: {
  item: CountItem;
  focusUnit: string | null;
  saving: boolean;
  onCancel: () => void;
  onSave: (qty: number, unitBreakdown: string | undefined) => void;
}) {
  // من الأكبر للأصغر (كرتون ← درزن ← قطعة) — نفس ترتيب بوابة العدّ.
  const units = useMemo(() => {
    const list = item.units.map((u) => ({ unitName: u.unitName, factor: u.factor }));
    if (list.length === 0) list.push({ unitName: "قطعة", factor: 1 });
    return list.sort((a, b) => b.factor - a.factor);
  }, [item.units]);
  const baseUnit = baseUnitName(item);

  const [vals, setVals] = useState<Record<string, string>>(() => {
    // تعبئة مسبقة من عدّي السابق: التفصيل بالوحدات إن حُفظ، وإلا الإجمالي بوحدة الأساس.
    const src = item.myCount?.unitBreakdown ?? null;
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
    if (item.myCount) return { [baseUnitName(item)]: String(item.myCount.qty) };
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
      {item.colleagueCounted && !item.myCount && (
        <p className="rounded-lg bg-primary/10 p-3 text-xs text-primary">
          عدّ تحققي: المنتج عُدّ من زميل، لكن كميته لا تظهر لك حفاظاً على الجرد
          الأعمى.
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

      <DialogFooter>
        <Button variant="outline" disabled={saving} onClick={onCancel}>
          إلغاء
        </Button>
        <Button disabled={saving || !valid} onClick={handleSave}>
          {saving ? "جارٍ الحفظ…" : "حفظ العدّ"}
        </Button>
      </DialogFooter>
    </div>
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
