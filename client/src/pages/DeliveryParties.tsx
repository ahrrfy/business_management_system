import { useMemo, useState } from "react";
import { Banknote, PackageOpen, Truck, Users } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/PageState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { confirm } from "@/lib/confirm";
import { notify } from "@/lib/notify";
import { fmt } from "@/lib/money";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { printDeliveryPartyStmt } from "@/lib/printing/printTemplates";

type Party = RouterOutputs["delivery"]["listParties"][number];

function ageDays(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / 86400000));
}
function ageBadge(days: number | null) {
  if (days == null) return <span className="text-muted-foreground">—</span>;
  const cls = days <= 7 ? "bg-emerald-100 text-emerald-700" : days <= 14 ? "bg-amber-100 text-amber-700" : days <= 30 ? "bg-orange-100 text-orange-700" : "bg-red-100 text-red-700";
  return <span className={cn("rounded px-2 py-0.5 text-xs font-bold", cls)}>{days} يوم</span>;
}

export default function DeliveryParties() {
  const me = trpc.auth.me.useQuery();
  const isManager = ["admin", "manager"].includes(me.data?.role ?? "");
  // مرآة بوّابة الخادم: settle = cashierProcedure = requireRole("cashier","manager") وadmin يمرّ ضمنياً.
  const canSettle = ["admin", "cashier", "manager"].includes(me.data?.role ?? "");
  const utils = trpc.useUtils();
  const list = trpc.delivery.listParties.useQuery({});
  const [showCreate, setShowCreate] = useState(false);
  const [settleFor, setSettleFor] = useState<Party | null>(null);
  const [writeOffFor, setWriteOffFor] = useState<Party | null>(null);

  const printStatement = async (party: Party) => {
    const data = await utils.delivery.partyStatement.fetch({ partyId: party.id });
    if (!data) return;
    let bal = 0, totDispatch = 0, totSettled = 0, totFees = 0;
    const txs: { date: string; ref: string; description: string; debit: string | null; credit: string | null; balance: string }[] = [];
    for (const e of data.entries) {
      const amt = Number(e.amount);
      const date = new Date(e.entryDate).toLocaleDateString("en-GB");
      const ref = (e.notes ?? "").replace(/^.*?([CD][NR]-\S+).*$/, "$1") || "—";
      if (e.type === "DELIVERY_DISPATCH") { bal += amt; totDispatch += amt; txs.push({ date, ref, description: "إرسالية (عهدة COD)", debit: e.amount, credit: null, balance: bal.toFixed(2) }); }
      else if (e.type === "DELIVERY_REMIT") { bal -= amt; totSettled += amt; txs.push({ date, ref, description: "توريد/تسوية", debit: null, credit: e.amount, balance: bal.toFixed(2) }); }
      else if (e.type === "DELIVERY_WRITEOFF") { bal -= amt; totSettled += amt; txs.push({ date, ref, description: "شطب عجز", debit: null, credit: e.amount, balance: bal.toFixed(2) }); }
      else if (e.type === "DELIVERY_FEE") { totFees += amt; }
    }
    printDeliveryPartyStmt({
      partyName: data.party.name,
      partyType: data.party.partyType === "COMPANY" ? "شركة توصيل" : "مندوب",
      partyPhone: data.party.phone ?? undefined,
      transactions: txs,
      totalDispatched: totDispatch.toFixed(2),
      totalSettled: totSettled.toFixed(2),
      totalFees: totFees.toFixed(2),
      closingBalance: data.currentBalance,
    });
  };

  const kpis = useMemo(() => {
    const rows = list.data ?? [];
    const totalFloat = rows.reduce((s, p) => s + Number(p.currentBalance ?? 0), 0);
    const openCount = rows.reduce((s, p) => s + Number(p.openConsignments ?? 0), 0);
    const oldest = rows.map((p) => ageDays(p.oldestOutstanding)).filter((d): d is number => d != null);
    return { totalFloat, openCount, count: rows.length, oldest: oldest.length ? Math.max(...oldest) : null };
  }, [list.data]);

  if (list.isError) return <div className="p-6"><ErrorState onRetry={() => list.refetch()} /></div>;
  const rows = list.data ?? [];

  return (
    <div className="space-y-5 p-4 md:p-6" dir="rtl">
      <PageHeader
        title="جهات التوصيل وذممها"
        description="المناديب وشركات التوصيل — العهدة القائمة (COD غير المورَّد) وأعمارها."
        icon={<Truck className="size-6 text-primary" aria-hidden />}
        actions={<Button onClick={() => setShowCreate(true)} disabled={!isManager}>+ جهة جديدة</Button>}
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="إجمالي النقد بذمّة المناديب" value={`${fmt(String(kpis.totalFloat))} د.ع`} icon={Banknote} tone={kpis.totalFloat > 0 ? "warning" : "default"} />
        <StatCard label="شحنات مفتوحة" value={String(kpis.openCount)} icon={PackageOpen} />
        <StatCard label="عدد الجهات" value={String(kpis.count)} icon={Users} />
        <StatCard label="أقدم مستحق" value={kpis.oldest != null ? `${kpis.oldest} يوم` : "—"} icon={Truck} tone={kpis.oldest != null && kpis.oldest > 14 ? "warning" : "default"} />
      </div>

      <div className="rounded-xl border bg-card">
        {list.isLoading ? (
          <div className="p-8 text-center text-muted-foreground">جارٍ التحميل…</div>
        ) : rows.length === 0 ? (
          <EmptyState icon={Truck} title="لا جهات توصيل" description="أضِف مندوباً أو شركة توصيل للبدء." actionLabel={isManager ? "+ جهة جديدة" : undefined} onAction={() => setShowCreate(true)} />
        ) : (
          <ScrollTableShell bordered={false}>
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="p-3 text-right">الجهة</th>
                  <th className="p-3 text-right">النوع</th>
                  <th className="p-3 text-left">نقد بذمّتها</th>
                  <th className="p-3 text-center">شحنات مفتوحة</th>
                  <th className="p-3 text-center">أقدم مستحق</th>
                  <th className="p-3 text-center">الحالة</th>
                  <th className="p-3 text-center">إجراءات</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const bal = Number(p.currentBalance ?? 0);
                  return (
                    <tr key={p.id} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="p-3 font-medium">{p.name}{p.phone && <span className="ms-2 text-xs text-muted-foreground" dir="ltr">{p.phone}</span>}</td>
                      <td className="p-3">{p.partyType === "COMPANY" ? "شركة" : "مندوب"}</td>
                      <td className={cn("p-3 text-left tabular-nums font-bold", bal > 0 ? "text-destructive" : "")} dir="ltr">{fmt(p.currentBalance)}</td>
                      <td className="p-3 text-center tabular-nums">{p.openConsignments}</td>
                      <td className="p-3 text-center">{ageBadge(ageDays(p.oldestOutstanding))}</td>
                      <td className="p-3 text-center">{p.isActive ? <Badge variant="secondary">نشط</Badge> : <Badge variant="outline">معطّل</Badge>}</td>
                      <td className="p-3 text-center">
                        <div className="inline-flex gap-1.5">
                          <Button size="sm" variant="ghost" onClick={() => printStatement(p)}>كشف</Button>
                          {canSettle && <Button size="sm" variant="outline" onClick={() => setSettleFor(p)} disabled={bal <= 0}>تسوية</Button>}
                          {isManager && <Button size="sm" variant="outline" className="text-destructive" onClick={() => setWriteOffFor(p)} disabled={bal <= 0}>شطب</Button>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ScrollTableShell>
        )}
      </div>

      {showCreate && <CreatePartyDialog onClose={() => setShowCreate(false)} onDone={() => { setShowCreate(false); utils.delivery.listParties.invalidate(); }} />}
      {settleFor && <SettleDialog party={settleFor} onClose={() => setSettleFor(null)} onDone={() => { setSettleFor(null); utils.delivery.listParties.invalidate(); }} />}
      {writeOffFor && <WriteOffDialog party={writeOffFor} onClose={() => setWriteOffFor(null)} onDone={() => { setWriteOffFor(null); utils.delivery.listParties.invalidate(); }} />}
    </div>
  );
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" dir="rtl" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-card p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-4 text-lg font-extrabold">{title}</h3>
        {children}
      </div>
    </div>
  );
}

function CreatePartyDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [partyType, setPartyType] = useState<"INDIVIDUAL" | "COMPANY">("INDIVIDUAL");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [defaultFee, setDefaultFee] = useState("0");
  const [userId, setUserId] = useState<number | null>(null);
  // حسابات المناديب (courier) لربط جهة فرد بحساب دخول ⇒ يرى «توصيلاتي». المتاح = غير المرتبط سلفاً.
  const accounts = trpc.delivery.courierAccounts.useQuery();
  const available = (accounts.data ?? []).filter((a) => a.linkedPartyId == null);
  const m = trpc.delivery.createParty.useMutation({ onSuccess: () => { notify.ok("أُضيفت الجهة"); onDone(); }, onError: (e) => notify.err(e) });
  return (
    <Modal title="جهة توصيل جديدة" onClose={onClose}>
      <label className="mb-1.5 block text-sm font-bold">النوع</label>
      <select className="mb-3 h-11 w-full rounded-md border bg-transparent px-3 text-sm" value={partyType} onChange={(e) => { setPartyType(e.target.value as typeof partyType); if (e.target.value === "COMPANY") setUserId(null); }}>
        <option value="INDIVIDUAL">مندوب فرد</option>
        <option value="COMPANY">شركة توصيل</option>
      </select>
      <label className="mb-1.5 block text-sm font-bold">الاسم</label>
      <Input value={name} onChange={(e) => setName(e.target.value)} className="mb-3 h-11" />
      <label className="mb-1.5 block text-sm font-bold">الهاتف</label>
      <Input dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} className="mb-3 h-11 text-end" />
      <label className="mb-1.5 block text-sm font-bold">أجرة توصيل افتراضية (د.ع)</label>
      <Input dir="ltr" inputMode="decimal" value={defaultFee} onChange={(e) => setDefaultFee(e.target.value)} className="mb-3 h-11 text-end tabular-nums" />
      {partyType === "INDIVIDUAL" && (
        <>
          <label className="mb-1.5 block text-sm font-bold">حساب الدخول للمندوب (اختياري)</label>
          <select className="mb-1 h-11 w-full rounded-md border bg-transparent px-3 text-sm" value={userId ?? ""} onChange={(e) => setUserId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">بلا حساب دخول</option>
            {available.map((a) => (
              <option key={a.id} value={a.id}>{a.name}{a.username ? ` (${a.username})` : ""}</option>
            ))}
          </select>
          <p className="mb-4 text-xs text-muted-foreground">اربطه بحساب دوره «مندوب توصيل» ليدخل ويرى شاشة «توصيلاتي». أنشئ الحساب من «المستخدمون» أولاً.</p>
        </>
      )}
      <div className="flex gap-2.5">
        <Button variant="outline" className="flex-1" onClick={onClose}>إلغاء</Button>
        <Button className="flex-1" disabled={m.isPending || !name.trim()} onClick={() => m.mutate({ partyType, name: name.trim(), phone: phone || null, userId: userId ?? undefined, defaultFee: /^\d+(\.\d{1,2})?$/.test(defaultFee) ? defaultFee : "0" })}>{m.isPending ? "جارٍ…" : "إضافة"}</Button>
      </div>
    </Modal>
  );
}

function SettleDialog({ party, onClose, onDone }: { party: Party; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState(String(Number(party.currentBalance ?? 0)));
  // IDEMPOTENCY (تدقيق ٢/٧): مفتاح ثابت لكل جلسة حوار (لا UUID جديد لكل نقرة) ⇒ النقر المزدوج
  // يُعاد كـreplay على الخادم بدل تسجيل تسويتين نقديّتين.
  const [reqId] = useState(() => crypto.randomUUID());
  const m = trpc.delivery.settle.useMutation({ onSuccess: () => { notify.ok("سُجِّلت التسوية"); onDone(); }, onError: (e) => notify.err(e) });
  return (
    <Modal title={`تسوية عهدة «${party.name}»`} onClose={onClose}>
      <p className="mb-3 text-sm text-muted-foreground">العهدة الحالية: <span dir="ltr" className="font-bold tabular-nums">{fmt(party.currentBalance)} د.ع</span>. يدفع المندوب نقداً (يدخل درج وردية مفتوحة).</p>
      <label className="mb-1.5 block text-sm font-bold">المبلغ المُسدَّد (د.ع)</label>
      <Input dir="ltr" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="mb-4 h-11 text-end text-lg font-bold tabular-nums" />
      <div className="flex gap-2.5">
        <Button variant="outline" className="flex-1" onClick={onClose}>إلغاء</Button>
        <Button className="flex-1" disabled={m.isPending || !/^\d+(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0} onClick={() => m.mutate({ partyId: party.id, amount, clientRequestId: reqId })}>{m.isPending ? "جارٍ…" : "تسجيل التسوية"}</Button>
      </div>
    </Modal>
  );
}

function WriteOffDialog({ party, onClose, onDone }: { party: Party; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState(String(Number(party.currentBalance ?? 0)));
  const [reason, setReason] = useState("");
  // IDEMPOTENCY (تدقيق ٢/٧): مفتاح ثابت لكل جلسة حوار — النقر المزدوج لا يشطب العجز مرّتين.
  const [reqId] = useState(() => crypto.randomUUID());
  const m = trpc.delivery.writeOff.useMutation({ onSuccess: () => { notify.ok("شُطِب العجز"); onDone(); }, onError: (e) => notify.err(e) });
  const submit = async () => {
    const ok = await confirm({ variant: "danger", title: "شطب عجز عهدة", description: `سيُشطب ${fmt(amount)} د.ع من عهدة «${party.name}» كمصروف (خسارة) لا رجعة فيه.`, confirmText: "شطب", requireText: party.name });
    if (ok) m.mutate({ partyId: party.id, amount, reason: reason.trim(), clientRequestId: reqId });
  };
  return (
    <Modal title={`شطب عجز «${party.name}»`} onClose={onClose}>
      <p className="mb-3 text-sm text-destructive">إبراء دَين غير قابل للتحصيل — يُقيَّد خسارةً. (مدير فقط)</p>
      <label className="mb-1.5 block text-sm font-bold">المبلغ المشطوب (د.ع)</label>
      <Input dir="ltr" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="mb-3 h-11 text-end text-lg font-bold tabular-nums" />
      <label className="mb-1.5 block text-sm font-bold">السبب</label>
      <Input value={reason} onChange={(e) => setReason(e.target.value)} className="mb-4 h-11" placeholder="سبب الشطب (٣ أحرف فأكثر)" />
      <div className="flex gap-2.5">
        <Button variant="outline" className="flex-1" onClick={onClose}>إلغاء</Button>
        <Button className="flex-1 bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={m.isPending || !/^\d+(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0 || reason.trim().length < 3} onClick={submit}>{m.isPending ? "جارٍ…" : "شطب"}</Button>
      </div>
    </Modal>
  );
}
