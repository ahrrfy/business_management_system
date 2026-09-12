import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RowActions, type RowAction } from "@/components/list/RowActions";
import {
  Activity,
  BadgeCheck,
  ChevronLeft,
  Fingerprint,
  Link2,
  MapPin,
  ScanFace,
  Settings2,
  ShieldQuestion,
  Users,
  Wifi,
  WifiOff,
} from "lucide-react";
import { fmtRelativeTime, PROTOCOL_LABELS } from "./hrDeviceTypes";

export interface HrDeviceDetailCardProps {
  selectedDevice: any | null;
  selectedOrigin?: any | null;
  actionsForDevice: (device: any) => RowAction[];
  onApprove: (id: number) => void;
  isApprovePending: boolean;
  onShowDevicePunches: (id: number) => void;
  onTestConnection: (id: number) => void;
  onOpenUserMapping: (id: number) => void;
  onTrustOrigin: (originId: number, deviceId?: number) => void;
  isTrustOriginPending: boolean;
  onDismissOrigin: (originId: number) => void;
  isDismissOriginPending: boolean;
  onOpenGuide: () => void;
}

export function HrDeviceDetailCard({
  selectedDevice,
  selectedOrigin,
  actionsForDevice,
  onApprove,
  isApprovePending,
  onShowDevicePunches,
  onTestConnection,
  onOpenUserMapping,
  onTrustOrigin,
  isTrustOriginPending,
  onDismissOrigin,
  isDismissOriginPending,
  onOpenGuide,
}: HrDeviceDetailCardProps) {
  return (
    <Card className="overflow-hidden xl:sticky xl:top-3">
      {selectedDevice ? (
        <>
          <CardHeader className="space-y-4 border-b">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <CardTitle className="truncate text-base">
                  {selectedDevice.name}
                </CardTitle>
                <p className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <MapPin aria-hidden className="size-3.5" />
                  {selectedDevice.branchName ?? "بلا فرع"}
                  {selectedDevice.location
                    ? ` · ${selectedDevice.location}`
                    : ""}
                </p>
              </div>
              <RowActions
                mode="menu"
                align="start"
                label={`إجراءات ${selectedDevice.name}`}
                actions={actionsForDevice(selectedDevice)}
              />
            </div>

            <div className="flex items-center gap-3">
              <span
                className={`grid size-11 place-items-center rounded-lg ${!selectedDevice.enabled ? "badge-stock-low" : selectedDevice.status === "online" ? "badge-status-active" : "badge-stock-out"}`}
              >
                {selectedDevice.status === "online" &&
                selectedDevice.enabled ? (
                  <Wifi aria-hidden className="size-5" />
                ) : (
                  <WifiOff aria-hidden className="size-5" />
                )}
              </span>
              <div>
                <div
                  className={`text-lg font-bold ${!selectedDevice.enabled ? "text-[var(--sem-warn)]" : selectedDevice.status === "online" ? "text-[var(--status-active)]" : "text-[var(--sem-neg)]"}`}
                >
                  {!selectedDevice.enabled
                    ? "بانتظار الاعتماد"
                    : selectedDevice.status === "online"
                      ? "متصل الآن"
                      : "غير متصل"}
                </div>
                <div className="text-xs text-muted-foreground">
                  آخر إشارة: {fmtRelativeTime(selectedDevice.lastSeenAt)}
                </div>
              </div>
            </div>

            {!selectedDevice.enabled ? (
              <Button
                disabled={isApprovePending}
                onClick={() => onApprove(selectedDevice.id)}
              >
                <BadgeCheck aria-hidden className="size-4" /> اعتماد الجهاز
              </Button>
            ) : (
              <Button onClick={() => onShowDevicePunches(selectedDevice.id)}>
                <Fingerprint aria-hidden className="size-4" /> عرض البصمات
              </Button>
            )}
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!selectedDevice.enabled}
                onClick={() => onTestConnection(selectedDevice.id)}
              >
                <Activity aria-hidden className="size-4" /> اختبار الاتصال
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!selectedDevice.enabled}
                onClick={() => onOpenUserMapping(selectedDevice.id)}
              >
                <Users aria-hidden className="size-4" /> ربط الموظفين
              </Button>
            </div>
          </CardHeader>

          <CardContent className="space-y-5 p-4">
            {selectedOrigin && (
              <div className="space-y-2 rounded-lg border border-[color-mix(in_oklch,var(--sem-warn)_35%,transparent)] bg-[var(--sem-warn-bg)] p-3">
                <div className="flex items-start gap-2">
                  <ShieldQuestion
                    aria-hidden
                    className="mt-0.5 size-4 shrink-0 text-[var(--sem-warn)]"
                  />
                  <div>
                    <div className="text-xs font-semibold">
                      محاولة اتصال من عنوان جديد
                    </div>
                    <div
                      className="mt-0.5 text-[11px] text-muted-foreground"
                      dir="ltr"
                    >
                      {selectedOrigin.ip}
                    </div>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={isTrustOriginPending}
                    onClick={() =>
                      onTrustOrigin(
                        selectedOrigin.id,
                        selectedOrigin.deviceId == null
                          ? selectedDevice.id
                          : undefined,
                      )
                    }
                  >
                    اعتماد
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={isDismissOriginPending}
                    onClick={() => onDismissOrigin(selectedOrigin.id)}
                  >
                    رفض
                  </Button>
                </div>
              </div>
            )}

            <section>
              <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                <Activity
                  aria-hidden
                  className="size-4 text-muted-foreground"
                />{" "}
                التشغيل
              </h3>
              <dl className="space-y-2 text-xs">
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">
                    البصمات المستلمة
                  </dt>
                  <dd className="font-semibold tabular-nums">
                    {(selectedDevice.receivedPunches ?? 0).toLocaleString(
                      "en-US",
                    )}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">آخر مزامنة</dt>
                  <dd>{fmtRelativeTime(selectedDevice.lastHandshakeAt)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">مستخدمو الجهاز</dt>
                  <dd className="tabular-nums">
                    {selectedDevice.usersCount ?? 0}
                  </dd>
                </div>
              </dl>
            </section>

            <section className="border-t pt-4">
              <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                <Link2
                  aria-hidden
                  className="size-4 text-muted-foreground"
                />{" "}
                الربط
              </h3>
              <dl className="space-y-2 text-xs">
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">الفرع</dt>
                  <dd>{selectedDevice.branchName ?? "غير محدد"}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">الموقع</dt>
                  <dd>{selectedDevice.location ?? "غير محدد"}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">
                    بصمات تحتاج ربطاً
                  </dt>
                  <dd
                    className={
                      (selectedDevice.pendingPunches ?? 0) > 0
                        ? "font-semibold text-[var(--sem-warn)]"
                        : "text-muted-foreground"
                    }
                  >
                    {selectedDevice.pendingPunches ?? 0}
                  </dd>
                </div>
              </dl>
            </section>

            <section className="border-t pt-4">
              <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                <ScanFace
                  aria-hidden
                  className="size-4 text-muted-foreground"
                />{" "}
                معلومات الجهاز
              </h3>
              <dl className="space-y-2 text-xs">
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">الرقم التسلسلي</dt>
                  <dd className="max-w-44 truncate font-mono" dir="ltr">
                    {selectedDevice.serialNumber ?? "—"}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">الطراز</dt>
                  <dd>{selectedDevice.model ?? "—"}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">إصدار البرنامج</dt>
                  <dd className="font-mono" dir="ltr">
                    {selectedDevice.firmware ?? "—"}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">البروتوكول</dt>
                  <dd>
                    {PROTOCOL_LABELS[selectedDevice.protocol ?? ""] ??
                      selectedDevice.protocol ??
                      "—"}
                  </dd>
                </div>
              </dl>
            </section>

            <Button
              variant="outline"
              className="w-full justify-between"
              onClick={onOpenGuide}
            >
              <span className="inline-flex items-center gap-2">
                <Settings2 aria-hidden className="size-4" /> إعدادات الاتصال
              </span>
              <ChevronLeft aria-hidden className="size-4" />
            </Button>
          </CardContent>
        </>
      ) : (
        <CardContent className="grid min-h-72 place-items-center p-6 text-center">
          <div>
            <ScanFace
              aria-hidden
              className="mx-auto mb-3 size-8 text-muted-foreground"
            />
            <p className="text-sm font-semibold">
              اختر جهازاً لعرض تفاصيله
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              ستظهر هنا حالة الاتصال والربط والإجراءات المتاحة.
            </p>
          </div>
        </CardContent>
      )}
    </Card>
  );
}
