/**
 * CatalogAnomalies.tsx — لوحة تدقيق شذوذ الكتالوج (L2.3).
 *
 * **الغاية:** تعرض ست عدسات كشفٍ (L1-L6) على `productVariants` لأخطاء تكلفة/سعر/معامل
 * (حادثة SINARLINE-class). لكل صفٍّ: عرض المُقاييس، deep-link للإصلاح، أو تسجيل «قصديّ»
 * (تصفية/بضاعة قديمة) أو «تجاهل نهائيّاً» (whitelist).
 *
 * **الصلاحيات:** خلف `catalogAnomalies` — admin/manager (FULL) + accountant/auditor (READ فقط،
 * أفعال markIntentional/markIgnored محجوبة).
 */
import { useState } from "react";
import { Link } from "wouter";
import { AlertTriangle, CheckCircle2, ExternalLink, XCircle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState } from "@/components/PageState";
import { trpc } from "@/lib/trpc";

type Severity = "blocker" | "warning" | "info";
type LensCode = "L1" | "L2" | "L3" | "L4" | "L5" | "L6";

const LENS_LABELS: Record<LensCode, string> = {
  L1: "L1 · تكلفة ≥ ٥× بيع",
  L2: "L2 · تكلفة > بيع (خسارة)",
  L3: "L3 · هامش صفر",
  L4: "L4 · تكلفة صفر مع نشاط",
  L5: "L5 · معامل شاذّ",
  L6: "L6 · تكلفة وحدة > سعرها",
};

// توكنز دلالية (tokens.css) بدل الألوان الخام — يتوافق مع حارس check-no-raw-status-colors:
//   blocker → sem-neg (أحمر)  ·  warning → sem-warn (كهرمانيّ)  ·  info → sem-info (أزرق)
const SEVERITY_BADGE: Record<Severity, { className: string; label: string; icon: React.ReactNode }> = {
  blocker: { className: "bg-[var(--sem-neg-bg)] text-[var(--sem-neg)] border-[var(--sem-neg)]/30", label: "حاجز", icon: <XCircle className="size-3" aria-hidden /> },
  warning: { className: "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)] border-[var(--sem-warn)]/30", label: "تحذير", icon: <AlertTriangle className="size-3" aria-hidden /> },
  info: { className: "bg-[var(--sem-info-bg)] text-[var(--sem-info)] border-[var(--sem-info)]/30", label: "إخبار", icon: <CheckCircle2 className="size-3" aria-hidden /> },
};

export default function CatalogAnomalies() {
  const [includeOverridden, setIncludeOverridden] = useState(false);
  const [codeFilter, setCodeFilter] = useState<LensCode | "">("");
  const [sevFilter, setSevFilter] = useState<Severity | "">("");
  const [search, setSearch] = useState("");
  const [markDialog, setMarkDialog] = useState<{
    variantId: number; code: LensCode; kind: "INTENTIONAL" | "IGNORED"; productLabel: string;
  } | null>(null);

  const utils = trpc.useUtils();
  const meQ = trpc.auth.me.useQuery();
  const canWrite = meQ.data?.role === "admin" || meQ.data?.role === "manager";
  const listQ = trpc.catalogAnomalies.list.useQuery({
    includeOverridden,
    codes: codeFilter ? [codeFilter] : undefined,
    severities: sevFilter ? [sevFilter] : undefined,
    limitPerLens: 200,
  }, { staleTime: 60 * 1000 });

  const markIntentional = trpc.catalogAnomalies.markIntentional.useMutation({
    onSuccess: () => { utils.catalogAnomalies.list.invalidate(); setMarkDialog(null); },
  });
  const markIgnored = trpc.catalogAnomalies.markIgnored.useMutation({
    onSuccess: () => { utils.catalogAnomalies.list.invalidate(); setMarkDialog(null); },
  });
  const clearOverride = trpc.catalogAnomalies.clearOverride.useMutation({
    onSuccess: () => utils.catalogAnomalies.list.invalidate(),
  });

  const filtered = (listQ.data?.findings ?? []).filter((f) => {
    if (!search.trim()) return true;
    const s = search.trim().toLowerCase();
    return (
      f.sku.toLowerCase().includes(s) ||
      f.productName.toLowerCase().includes(s) ||
      String(f.variantId).includes(s)
    );
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="تدقيق شذوذ الكتالوج"
        description="كشف رجعيّ لأخطاء التكلفة/السعر/المعامل بست عدسات (L1-L6). الأفعال: إصلاح (deep-link)، قصديّ (تصفية/بضاعة قديمة)، تجاهل نهائيّاً."
      />

      {/* بطاقات الملخّص */}
      {listQ.data && (
        <div className="grid grid-cols-4 gap-3">
          <Card><CardContent className="p-3"><div className="text-xs text-muted-foreground">حاجز</div><div className="text-2xl font-bold text-[var(--sem-neg)] tabular-nums">{listQ.data.counts.blocker}</div></CardContent></Card>
          <Card><CardContent className="p-3"><div className="text-xs text-muted-foreground">تحذير</div><div className="text-2xl font-bold text-[var(--sem-warn)] tabular-nums">{listQ.data.counts.warning}</div></CardContent></Card>
          <Card><CardContent className="p-3"><div className="text-xs text-muted-foreground">إخبار</div><div className="text-2xl font-bold text-[var(--sem-info)] tabular-nums">{listQ.data.counts.info}</div></CardContent></Card>
          <Card><CardContent className="p-3"><div className="text-xs text-muted-foreground">مستثنى</div><div className="text-2xl font-bold text-muted-foreground tabular-nums">{listQ.data.overriddenCount}</div></CardContent></Card>
        </div>
      )}

      {/* الفلاتر */}
      <Card>
        <CardContent className="p-3 flex flex-wrap items-center gap-3">
          <Input
            placeholder="بحث بالمنتج/SKU/vid…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-xs h-8"
          />
          <select value={codeFilter} onChange={(e) => setCodeFilter(e.target.value as LensCode | "")} className="h-8 rounded-md border border-input bg-transparent px-2 text-xs">
            <option value="">كل العدسات</option>
            {(Object.keys(LENS_LABELS) as LensCode[]).map((k) => (
              <option key={k} value={k}>{LENS_LABELS[k]}</option>
            ))}
          </select>
          <select value={sevFilter} onChange={(e) => setSevFilter(e.target.value as Severity | "")} className="h-8 rounded-md border border-input bg-transparent px-2 text-xs">
            <option value="">كل الحدّات</option>
            <option value="blocker">حاجز</option>
            <option value="warning">تحذير</option>
            <option value="info">إخبار</option>
          </select>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
            <input type="checkbox" checked={includeOverridden} onChange={(e) => setIncludeOverridden(e.target.checked)} />
            تضمين المستثنى
          </label>
        </CardContent>
      </Card>

      {/* الجدول */}
      <Card>
        <CardHeader><CardTitle className="text-base">النتائج ({filtered.length})</CardTitle></CardHeader>
        <CardContent>
          {listQ.isLoading ? <LoadingState /> : filtered.length === 0 ? (
            <div className="text-center py-8 text-sm text-muted-foreground">
              <CheckCircle2 className="size-8 mx-auto mb-2 text-[var(--sem-pos)]" aria-hidden />
              لا شذوذ — جميع المتغيّرات ضمن الحدود المعقولة أو مستثناة.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground border-b">
                  <tr>
                    <th className="text-start p-2">الحدّة</th>
                    <th className="text-start p-2">العدسة</th>
                    <th className="text-start p-2">المنتج</th>
                    <th className="text-start p-2">SKU</th>
                    <th className="text-start p-2">تفاصيل</th>
                    <th className="text-start p-2">الحالة</th>
                    <th className="text-start p-2">أفعال</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((f) => {
                    const sev = SEVERITY_BADGE[f.severity as Severity];
                    return (
                      <tr key={`${f.variantId}:${f.code}`} className="border-b hover:bg-muted/30">
                        <td className="p-2">
                          <Badge variant="outline" className={sev.className}>
                            {sev.icon} {sev.label}
                          </Badge>
                        </td>
                        <td className="p-2 text-xs">{LENS_LABELS[f.code as LensCode]}</td>
                        <td className="p-2 max-w-xs truncate" title={f.productName}>{f.productName}</td>
                        <td className="p-2 font-mono text-xs">{f.sku}</td>
                        <td className="p-2 text-xs text-muted-foreground">{f.note}</td>
                        <td className="p-2">
                          {f.override ? (
                            <Badge variant="secondary" className="text-[10px]">
                              {f.override.kind === "INTENTIONAL" ? "قصديّ" : "متجاهَل"}
                              {f.override.excludeUntil ? ` حتى ${String(f.override.excludeUntil).slice(0, 10)}` : ""}
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">نشط</span>
                          )}
                        </td>
                        <td className="p-2">
                          <div className="flex items-center gap-1">
                            <Link href={`/products/${f.productId}/edit`}>
                              <Button size="sm" variant="outline" className="h-7 text-xs" title="فتح المنتج للتعديل">
                                <ExternalLink className="size-3 me-1" aria-hidden />
                                إصلاح
                              </Button>
                            </Link>
                            {canWrite && !f.override && (
                              <>
                                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setMarkDialog({ variantId: f.variantId, code: f.code as LensCode, kind: "INTENTIONAL", productLabel: f.productName })}>
                                  قصديّ
                                </Button>
                                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setMarkDialog({ variantId: f.variantId, code: f.code as LensCode, kind: "IGNORED", productLabel: f.productName })}>
                                  تجاهل
                                </Button>
                              </>
                            )}
                            {canWrite && f.override && (
                              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => clearOverride.mutate({ variantId: f.variantId, code: f.code as LensCode })}>
                                <RotateCcw className="size-3 me-1" aria-hidden />
                                إلغاء الاستثناء
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* حوار «قصديّ / تجاهل» */}
      {markDialog && (
        <MarkOverrideDialog
          info={markDialog}
          onClose={() => setMarkDialog(null)}
          onConfirm={(payload) => {
            if (markDialog.kind === "INTENTIONAL") {
              markIntentional.mutate(payload);
            } else {
              markIgnored.mutate({ variantId: markDialog.variantId, code: markDialog.code, justification: payload.justification });
            }
          }}
          isPending={markIntentional.isPending || markIgnored.isPending}
        />
      )}

      {/* L3: سجلّ تغيّرات التكلفة الأخيرة + استعادة */}
      <CostChangeLogSection canWrite={canWrite} />
    </div>
  );
}

/**
 * **L3.4/L3.5:** سجلّ تغيّرات التكلفة الأخيرة — يستهلك `changeLog` و`revertChange` من الراوتر.
 * كل صفٍّ يعرض قبل/بعد + نسبة + الفاعل + الوقت، مع زرّ استعادة (للـmanager) خلال ٣٠ يوماً.
 */
function CostChangeLogSection({ canWrite }: { canWrite: boolean }) {
  const [minSeverity, setMinSeverity] = useState<"info" | "warning" | "blocker" | "catastrophic">("warning");
  const [days, setDays] = useState(30);
  const utils = trpc.useUtils();
  const logQ = trpc.catalogAnomalies.changeLog.useQuery({ minSeverity, days, limit: 50 }, { staleTime: 60 * 1000 });
  const revert = trpc.catalogAnomalies.revertChange.useMutation({
    onSuccess: () => {
      utils.catalogAnomalies.changeLog.invalidate();
      utils.catalogAnomalies.list.invalidate();
    },
  });
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">سجلّ تغيّرات التكلفة (Trigger BEFORE UPDATE)</CardTitle>
        <div className="flex items-center gap-2">
          <select value={minSeverity} onChange={(e) => setMinSeverity(e.target.value as typeof minSeverity)} className="h-8 rounded-md border border-input bg-transparent px-2 text-xs">
            <option value="info">إخبار فأعلى</option>
            <option value="warning">تحذير فأعلى</option>
            <option value="blocker">حاجز فأعلى</option>
            <option value="catastrophic">كارثيّ فقط</option>
          </select>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="h-8 rounded-md border border-input bg-transparent px-2 text-xs">
            <option value={7}>٧ أيام</option>
            <option value={30}>٣٠ يوماً</option>
            <option value={90}>٩٠ يوماً</option>
          </select>
        </div>
      </CardHeader>
      <CardContent>
        {logQ.isLoading ? <LoadingState /> : (logQ.data ?? []).length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-4">لا تغيّرات مسجّلة في هذه النافذة.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground border-b">
                <tr>
                  <th className="text-start p-2">الوقت</th>
                  <th className="text-start p-2">المنتج</th>
                  <th className="text-start p-2">قبل → بعد</th>
                  <th className="text-start p-2">الحدّة</th>
                  <th className="text-start p-2">الفاعل</th>
                  <th className="text-start p-2">الحالة</th>
                </tr>
              </thead>
              <tbody>
                {(logQ.data ?? []).map((row) => {
                  const oldV = Number(row.oldValue);
                  const newV = Number(row.newValue);
                  const ratio = oldV > 0 ? newV / oldV : 0;
                  return (
                    <tr key={row.id} className="border-b hover:bg-muted/30">
                      <td className="p-2 text-xs tabular-nums" dir="ltr">{new Date(row.createdAt).toLocaleString("ar-IQ")}</td>
                      <td className="p-2 max-w-xs truncate" title={row.productName ?? ""}>{row.productName ?? `vid=${row.variantId}`} <span className="text-[10px] text-muted-foreground">{row.sku ?? ""}</span></td>
                      <td className="p-2 text-xs tabular-nums" dir="ltr">
                        {oldV.toLocaleString("en-US")} → {newV.toLocaleString("en-US")} <span className="text-muted-foreground">({ratio.toFixed(2)}×)</span>
                      </td>
                      <td className="p-2 text-xs">{row.severity}</td>
                      <td className="p-2 text-xs text-muted-foreground">{row.actorName ?? "—"}</td>
                      <td className="p-2 text-xs">
                        {row.reverted ? (
                          <Badge variant="secondary" className="text-[10px]">مستعادٌ سابقاً</Badge>
                        ) : canWrite ? (
                          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => {
                            if (confirm(`استعادة التكلفة إلى ${oldV.toLocaleString("en-US")} د.ع؟`)) revert.mutate({ logId: row.id });
                          }}>
                            <RotateCcw className="size-3 me-1" aria-hidden /> استعادة
                          </Button>
                        ) : (
                          <span className="text-muted-foreground">نشط</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function MarkOverrideDialog({
  info, onClose, onConfirm, isPending,
}: {
  info: { variantId: number; code: LensCode; kind: "INTENTIONAL" | "IGNORED"; productLabel: string };
  onClose: () => void;
  onConfirm: (payload: { variantId: number; code: LensCode; justification: string; excludeUntil: string | null }) => void;
  isPending: boolean;
}) {
  const [justification, setJustification] = useState("");
  const [excludeUntil, setExcludeUntil] = useState("");
  const disabled = justification.trim().length < 10 || isPending;

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {info.kind === "INTENTIONAL" ? "تعليم «قصديّ»" : "تجاهل نهائيّ"}
          </DialogTitle>
          <p className="text-xs text-muted-foreground">
            {info.productLabel} — {LENS_LABELS[info.code]}
          </p>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium">التبرير <span className="text-[var(--sem-neg)]">*</span> (≥ ١٠ محارف)</label>
            <Textarea
              value={justification}
              onChange={(e) => setJustification(e.target.value)}
              placeholder={info.kind === "INTENTIONAL" ? "مثال: تصفية مذكرات ٢٠٢٧ — قرار المالك ١/٩" : "مثال: هامش تاريخيّ متعمّد لصنف ولاء"}
              rows={3}
            />
          </div>
          {info.kind === "INTENTIONAL" && (
            <div>
              <label className="text-xs font-medium">مدّة الاستثناء (اختياري — يعود للطابور بعدها)</label>
              <Input
                type="date"
                value={excludeUntil}
                onChange={(e) => setExcludeUntil(e.target.value)}
              />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>إلغاء</Button>
          <Button
            disabled={disabled}
            onClick={() => onConfirm({ variantId: info.variantId, code: info.code, justification: justification.trim(), excludeUntil: excludeUntil || null })}
          >
            {isPending ? "جارٍ الحفظ…" : "تأكيد"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
