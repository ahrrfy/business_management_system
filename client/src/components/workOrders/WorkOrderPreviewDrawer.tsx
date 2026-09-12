import { useEffect } from "react";
import { Link } from "wouter";
import {
  AlertTriangle,
  ArrowRight,
  Calendar,
  CheckCircle2,
  ChevronRight,
  FileText,
  Package,
  Pencil,
  Printer,
  Receipt,
  Rows3,
  Timer,
  Truck,
  Wrench,
  X,
} from "lucide-react";
import { AppSelect } from "@/components/ui/AppSelect";
import { ErrorState, LoadingState } from "@/components/PageState";
import { WhatsAppIcon, WhatsAppShare } from "@/components/WhatsAppShare";
import { ChannelBadge } from "@/components/ChannelBadge";
import { printWorkOrder } from "@/lib/printing/printTemplates";
import { printWorkOrderReceipt } from "@/lib/printing/print";
import { CopyInline } from "@/components/CopyButton";
import { CopyAsMenu } from "@/lib/copy/CopyAsMenu";
import { formatWorkOrderAsWhatsApp } from "@/lib/copy/formatters";
import { fmtAr, fmtInt, D, positiveDiff } from "@/lib/money";
import { fmtDate, fmtDateTime } from "@/lib/date";
import { trpc } from "@/lib/trpc";
import {
  type WorkOrderStatus,
  WO_NEXT_STATUS,
  WO_STAGE_INDEX,
  workOrderStatusHue,
  workOrderStatusLabel,
  workOrderTimelineLabel,
} from "@shared/workOrderStatus";
import {
  type WO,
  type Detail,
  type Status,
  type ColKey,
  STATUSES,
  ADV_LABEL,
  PAYMENT_METHOD_LABEL,
  PRIORITIES,
  dueInfo,
  progressOf,
  workOrderCardLabel,
  avatarHue,
  initials,
  workOrderContactMessage,
  printWoFromCard,
  printWoThermalFromCard,
  printWoShippingLabel,
} from "./workOrderTypes";

export function WorkOrderPreviewDrawer({
  id, onClose, isManager, canRequestControl, canRequestCancel, canDeliver, onAdvance, onCancel, onDeliver, onAssign, onEdit, onOpenCustomer, busy,
}: {
  id: number; onClose: () => void; isManager: boolean; canRequestControl: boolean;
  /** طلبُ الإلغاء أوسعُ من التعديل التجاريّ: يشمل فنّي المطبعة (قرار المالك ١/٩/٢٦). */
  canRequestCancel: boolean; canDeliver: boolean;
  onAdvance: (id: number, to: Status) => void; onCancel: (d: Detail) => void;
  onDeliver: (d: Detail) => void; onAssign: (id: number, staffId: number | null) => void;
  onEdit: (id: number) => void; busy: boolean;
  onOpenCustomer?: (customerId: number) => void;
}) {
  const detail = trpc.workOrders.get.useQuery({ workOrderId: id });
  const timeline = trpc.workOrders.timeline.useQuery({ workOrderId: id });
  const staff = trpc.workOrders.assignableStaff.useQuery(undefined, { enabled: isManager });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const d = detail.data ?? null;
  const di = d ? dueInfo(d) : null;
  const pri = d ? (PRIORITIES[d.priority ?? "NORMAL"] ?? PRIORITIES.NORMAL) : null;
  const next = d ? WO_NEXT_STATUS[d.status as WorkOrderStatus] : undefined;
  const hue = workOrderStatusHue(d?.status);
  const cur = d ? Math.max(WO_STAGE_INDEX[d.status as WorkOrderStatus] ?? 0, 0) : 0;

  // أحداث الخط الزمني: من سجلّ التدقيق إن توفّر، وإلا اشتقاق صادق من الطوابع.
  const tlRows = timeline.data ?? [];
  const tlItems = timeline.isError ? [] : tlRows.length
    ? tlRows.map((r) => ({ ev: workOrderTimelineLabel(r.action), at: r.createdAt, by: r.userName as string | null }))
    : d ? [
        { ev: "استُلم الطلب", at: d.createdAt, by: null as string | null },
        ...(d.deliveredAt ? [{ ev: "سُلّم وصدرت الفاتورة", at: d.deliveredAt, by: null as string | null }] : []),
      ] : [];

  return (
    <>
      <div className="wob-scrim" onClick={onClose} />
      <div className="wob-drawer" role="dialog" aria-modal="true" aria-label="تفاصيل طلب الخدمة">
        <button className="wob-dr-close" onClick={onClose} aria-label="إغلاق"><X aria-hidden className="size-4" /></button>
        {detail.isError ? (
          <div className="wob-dr-body">
            <ErrorState message="تعذّر تحميل أمر الشغل؛ لم يُفترض أنه غير موجود." onRetry={() => void detail.refetch()} />
          </div>
        ) : !d ? (
          <div className="wob-dr-body"><LoadingState message="جارٍ تحميل أمر الشغل…" /></div>
        ) : (
          <>
            <div className="wob-dr-head">
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <div className="wob-thumb" style={{ width: 48, height: 48, background: `oklch(0.6 0.15 ${hue})` }}>
                  {d.images?.[0]?.url ? <img src={d.images[0].url} alt="" /> : <span className="wob-thumb-abbr"><Printer aria-hidden size={20} /></span>}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 11, color: "var(--muted-fg)" }}>
                    <CopyInline value={d.orderNumber} successMessage="تم نَسخ رَقم الأَمر" />
                  </div>
                  <div style={{ fontSize: 18, fontWeight: 800, lineHeight: 1.3 }}>{d.title}</div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
                <span className="wob-meta-pill" style={{ background: `oklch(0.6 0.17 ${hue} / 0.13)`, color: `oklch(0.45 0.17 ${hue})`, display: "inline-flex", alignItems: "center", gap: 6 }}><span className="inline-block size-2 rounded-full" style={{ background: `oklch(0.45 0.17 ${hue})` }} />{workOrderCardLabel(d)}</span>
                {pri && <span className={`wob-pri ${pri.cls}`}><span className="wob-pri-dot" />{pri.label}</span>}
                {di && <span className={`wob-due wob-${di.state}`} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>{di.state === "late" ? <Timer aria-hidden className="size-3.5" /> : <Calendar aria-hidden className="size-3.5" />} {di.text}</span>}
              </div>
            </div>

            <div className="wob-dr-body">
              <div>
                <div className="wob-kv">
                  <div>
                    <div className="wob-k">العميل</div>
                    <div className="wob-v">
                      {d.customerId && onOpenCustomer ? (
                        <button type="button" className="text-primary hover:underline" onClick={() => onOpenCustomer(Number(d.customerId))}>
                          {d.customerName ?? `عميل #${d.customerId}`} · بطاقة ٣٦٠°
                        </button>
                      ) : "عميل نقدي"}
                    </div>
                  </div>
                  {d.customerPhone && <div><div className="wob-k">هاتف العميل</div><div className="wob-v" dir="ltr">{d.customerPhone}</div></div>}
                  <div><div className="wob-k">قناة الاستلام</div><div className="wob-v inline-flex items-center gap-1"><ChannelBadge channel={d.receptionChannel} handle={d.channelHandle} /></div></div>
                  <div><div className="wob-k">الكمية</div><div className="wob-v">{fmtInt(d.quantity)}</div></div>
                  <div><div className="wob-k">سعر البيع</div><div className="wob-v" style={{ direction: "ltr", textAlign: "right" }}>{fmtAr(d.salePrice)} د.ع</div></div>
                  {Number(d.deposit ?? 0) > 0 && <div><div className="wob-k">العربون</div><div className="wob-v" style={{ direction: "ltr", textAlign: "right" }}>{fmtAr(d.deposit)} د.ع</div></div>}
                  {Number(d.deposit ?? 0) > 0 && <div><div className="wob-k">طريقة دفع العربون</div><div className="wob-v">{PAYMENT_METHOD_LABEL[d.paymentMethod ?? ""] ?? d.paymentMethod ?? "—"}</div></div>}
                  {d.paymentReference && <div><div className="wob-k">مرجع الدفع</div><div className="wob-v" dir="ltr">{d.paymentReference}</div></div>}
                  <div><div className="wob-k">الاستحقاق</div><div className="wob-v">{fmtDate(d.dueDate)}</div></div>
                  <div><div className="wob-k">أنشأ الطلب</div><div className="wob-v">{d.createdByName ?? "—"}</div></div>
                  <div><div className="wob-k">وقت الاستلام</div><div className="wob-v">{fmtDateTime(d.createdAt)}</div></div>
                  {d.hasDelivery && <div><div className="wob-k">هاتف التوصيل</div><div className="wob-v" dir="ltr">{d.deliveryPhone ?? d.customerPhone ?? "—"}</div></div>}
                  {d.hasDelivery && <div style={{ gridColumn: "1 / -1" }}><div className="wob-k">عنوان التوصيل</div><div className="wob-v">{d.deliveryAddress ?? "—"}</div></div>}
                  {d.materialsCost != null && <div><div className="wob-k">كلفة المواد</div><div className="wob-v" style={{ direction: "ltr", textAlign: "right" }}>{fmtAr(d.materialsCost)} د.ع</div></div>}
                  {d.laborCost != null && <div><div className="wob-k">كلفة العمالة</div><div className="wob-v" style={{ direction: "ltr", textAlign: "right" }}>{fmtAr(d.laborCost)} د.ع</div></div>}
                  <div style={{ gridColumn: "1 / -1" }}>
                    <div className="wob-k">الموظف المسؤول</div>
                    {isManager ? (
                      /* contentClassName="z-[60]" إلزاميّ هنا لا تجميل: `.wob-drawer` لوحةٌ يدويّة
                         بـ`z-index: 51` (WorkOrders.board.css)، وpopup الـRadix يُبوَّب إلى body
                         بغلافٍ يرث z-index المحتوى — أي **50** — فيُدفَن تحت الدرج. والـ<select>
                         الأصليّ الذي كان هنا كان محصَّناً (popup على مستوى المتصفّح لا CSS)، فالعطب
                         يولد مع التحويل وحده. وRadix يقفل المؤشّر خارج القائمة وهي مفتوحة ⇒ الدرج
                         يبدو متجمّداً لا «بلا قائمة». ٦٠ يحترم قانون الطبقات: 50 عاديّ < 60 هنا
                         < 100 النوافذ اليدويّة < 200 حوار التأكيد. راجع [[modal-zindex-layering-law]]. */
                      <AppSelect
                        className="mt-1"
                        contentClassName="z-[60]"
                        aria-label="الموظف المسؤول"
                        value={d.assignedTo != null ? String(d.assignedTo) : ""}
                        onValueChange={(value) => onAssign(d.id, value ? Number(value) : null)}
                        disabled={busy}
                      >
                        <option value="">— غير مُسنَد —</option>
                        {(staff.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name} — {s.role}</option>)}
                      </AppSelect>
                    ) : (
                      <div className="wob-v">{d.assigneeName ?? "غير مُسنَد"}</div>
                    )}
                  </div>
                </div>
                {d.customizationText && (
                  <div className="wob-note"><span style={{ fontWeight: 700 }}>التخصيص/الملاحظات: </span>{d.customizationText}</div>
                )}
                {d.paymentReceiptUrl && (
                  <a href={d.paymentReceiptUrl} target="_blank" rel="noreferrer" className="mt-3 block rounded-xl border bg-card p-2 hover:border-primary">
                    <div className="mb-2 text-xs font-bold text-muted-foreground">صورة إيصال العربون — اضغط للتكبير</div>
                    <img src={d.paymentReceiptUrl} alt="إيصال دفع العربون" className="max-h-44 w-full rounded-lg object-contain" />
                  </a>
                )}
              </div>

              <div>
                <div className="wob-dr-sec-t">مراحل الإنتاج — {cur + 1}/4 ({progressOf(d.status).pct}%)</div>
                <div className="wob-prog-bar" style={{ marginBottom: 12 }}><div className="wob-prog-fill" style={{ width: progressOf(d.status).pct + "%", background: `oklch(0.6 0.17 ${hue})` }} /></div>
                {STATUSES.map((s, i) => (
                  <div key={s.key} className={`wob-stage-row ${i < cur ? "wob-on" : ""}`}>
                    <div className={`wob-stage-box ${i < cur ? "wob-on" : ""} ${i === cur ? "wob-cur" : ""}`}>{i < cur ? <CheckCircle2 aria-hidden className="size-4" /> : i + 1}</div>
                    <span className="wob-stage-label">{s.label}</span>
                  </div>
                ))}
              </div>

              <div>
                <div className="wob-dr-sec-t">الخط الزمني للأمر</div>
                {timeline.isError ? (
                  <ErrorState
                    className="p-4"
                    message="تعذّر تحميل سجل الأمر؛ لن نعرض طوابع مشتقة كأنها السجل الحقيقي."
                    onRetry={() => void timeline.refetch()}
                  />
                ) : timeline.isLoading ? (
                  <LoadingState className="p-4" message="جارٍ تحميل سجل الأمر…" />
                ) : <div className="wob-timeline">
                  {[...tlItems].reverse().map((e, i) => (
                    <div className="wob-tl-item" key={i}>
                      <div className="wob-tl-dot" style={{ background: i === 0 ? `oklch(0.6 0.17 ${hue})` : "var(--border-strong)" }} />
                      <div className="wob-tl-ev">{e.ev}</div>
                      <div className="wob-tl-meta" style={{ direction: "ltr", textAlign: "right" }}>{fmtDateTime(e.at)}{e.by ? ` — ${e.by}` : ""}</div>
                    </div>
                  ))}
                  {tlItems.length === 0 && <div style={{ color: "var(--muted-fg)", fontSize: 12.5 }}>لا أحداث مسجّلة بعد.</div>}
                </div>}
              </div>

              {d.qrPayload && (
                <div>
                  <div className="wob-dr-sec-t">باركود التذكرة</div>
                  <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, direction: "ltr", textAlign: "right", color: "var(--muted-fg)" }}>{d.orderNumber}</div>
                </div>
              )}
            </div>

            <div className="wob-dr-foot">
              <CopyAsMenu
                label="نَسخ تَفاصيل الأَمر"
                plain={formatWorkOrderAsWhatsApp({
                  number: d.orderNumber,
                  date: d.createdAt,
                  customer: d.customerName,
                  description: d.customizationText,
                  status: workOrderStatusLabel(d.status),
                  items: [{ name: d.title, qty: d.quantity, unit: "نُسخة" }],
                  deposit: d.deposit,
                  total: d.salePrice,
                  deliveryDate: d.dueDate,
                })}
                whatsapp={formatWorkOrderAsWhatsApp({
                  number: d.orderNumber,
                  date: d.createdAt,
                  customer: d.customerName,
                  description: d.customizationText,
                  status: workOrderStatusLabel(d.status),
                  items: [{ name: d.title, qty: d.quantity, unit: "نُسخة" }],
                  deposit: d.deposit,
                  total: d.salePrice,
                  deliveryDate: d.dueDate,
                })}
              />
              <button className="wob-btn wob-btn-ghost" onClick={() => printWorkOrder({
                woNumber: d.orderNumber,
                woDate: d.createdAt ? String(d.createdAt).slice(0, 10) : undefined,
                dueDate: d.dueDate ? String(d.dueDate).slice(0, 10) : undefined,
                status: d.status,
                employeeName: d.createdByName?.trim() || "موظف الخدمة",
                customerName: d.customerName,
                customerPhone: d.customerPhone,
                jobType: d.title,
                specs: d.customizationText,
                items: [{ name: `${d.title} (${d.quantity} نسخة)`, unit: "مهمة", quantity: 1, unitPrice: d.salePrice, total: d.salePrice }],
                subtotal: d.salePrice,
                total: d.salePrice,
              })}><Printer aria-hidden className="size-4 inline-block align-text-bottom me-1" /> طباعة A4</button>
              <button
                className="wob-btn wob-btn-ghost"
                title="إيصال طلب خدمة حراري 80مم — جسر الخادم/WebUSB/متصفّح"
                onClick={() => void printWorkOrderReceipt({
                  orderNumber: d.orderNumber,
                  orderDate: d.createdAt ? String(d.createdAt).slice(0, 10) : undefined,
                  dueDate: d.dueDate ? String(d.dueDate).slice(0, 10) : undefined,
                  status: d.status,
                  employeeName: d.createdByName?.trim() || "موظف الخدمة",
                  customerName: d.customerName ?? undefined,
                  customerPhone: d.customerPhone ?? undefined,
                  jobTitle: d.title,
                  quantity: d.quantity ? `${d.quantity} نسخة` : undefined,
                  specs: d.customizationText ?? undefined,
                  total: d.salePrice,
                })}
              ><Receipt aria-hidden className="size-4 inline-block align-text-bottom me-1" /> حراري 80مم</button>
              <button
                className="wob-btn wob-btn-ghost"
                title="ملصق شحن يُلصَق على الطرد (بالقياس المحفوظ — الافتراضي ٨٠×١٢٠مم)"
                onClick={() => printWoShippingLabel(d)}
              ><Package aria-hidden className="size-4 inline-block align-text-bottom me-1" /> ملصق شحن</button>
              <WhatsAppShare
                phone={d.customerPhone}
                alternativePhones={[d.deliveryPhone]}
                message={workOrderContactMessage(d)}
                label="راسل العميل"
                appearance="solid"
                className="wob-wa-lg"
              />
              {next === ("DELIVERED" as ColKey) && d.hasDelivery && canDeliver ? (
                <Link href="/delivery" className="wob-btn wob-btn-primary" style={{ flex: 1 }}>
                  <Truck aria-hidden className="size-4 inline-block align-text-bottom me-1" /> إسناد للتوصيل
                </Link>
              ) : next ? (next !== "DELIVERED" || canDeliver) && (
                <button className="wob-btn wob-btn-primary" style={{ flex: 1 }} disabled={busy}
                  onClick={() => (next === ("DELIVERED" as ColKey) ? onDeliver(d) : onAdvance(d.id, next))}>{ADV_LABEL[next]}</button>
              ) : (
                <button className="wob-btn wob-btn-ghost" disabled style={{ flex: 1, opacity: 0.6 }}><CheckCircle2 aria-hidden className="size-4 inline-block align-text-bottom me-1" /> اكتمل الأمر</button>
              )}
              {canRequestControl && d.status !== "DELIVERED" && d.status !== "CANCELLED" && (
                <button className="wob-btn wob-btn-ghost" disabled={busy} onClick={() => onEdit(d.id)}>
                  <Pencil aria-hidden className="size-4 inline-block align-text-bottom me-1" /> {isManager ? "تعديل" : "طلب تعديل"}
                </button>
              )}
              {canRequestCancel && d.status !== "DELIVERED" && d.status !== "CANCELLED" && (
                <button className="wob-btn wob-btn-danger" disabled={busy} onClick={() => onCancel(d)}>
                  {isManager ? "إلغاء الأمر" : "طلب إلغاء الأمر"}
                </button>
              )}
              {d.status === "DELIVERED" && d.invoiceId && (
                // رابط مباشر لتفاصيل الفاتورة الصادرة عن التسليم (كان يهبط على القائمة العامة)
                <Link href={`/invoices/${d.invoiceId}`} className="wob-btn wob-btn-ghost">الفاتورة #{d.invoiceId}</Link>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}
