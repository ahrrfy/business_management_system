import { fmtDateTime } from "@/lib/date";

export type DeliveryDocumentCopy =
  | { readonly kind?: "ORIGINAL" }
  | {
      readonly kind: "REPRINT";
      readonly reason?: string | null;
      readonly actorName?: string | null;
    };

/**
 * بيانات تدقيق المستند كما كانت لحظة الحدث. لا تُشتقّ ساعة الحدث من ساعة إعادة
 * الطباعة؛ المتصل يمرّر وقت الحدث المحفوظ، بينما تنشئ طبقة الطباعة `printedAt`
 * مستقلاً لكل نسخة.
 */
export interface DeliveryDocumentAudit {
  readonly eventAt?: Date | string | null;
  readonly printedAt?: Date | string | null;
  readonly copy?: DeliveryDocumentCopy;
}

export interface DeliveryDocumentSnapshot<TPayload> {
  readonly documentType: "DISPATCH_SLIP" | "HANDOVER_MANIFEST" | "REMITTANCE_RECEIPT";
  readonly eventAt: Date | string | null;
  readonly printedAt: Date | string;
  readonly copy: DeliveryDocumentCopy;
  readonly payload: Readonly<TPayload>;
}

export function createDeliveryDocumentSnapshot<TPayload>(input: {
  documentType: DeliveryDocumentSnapshot<TPayload>["documentType"];
  payload: TPayload;
  audit?: DeliveryDocumentAudit;
  now?: Date;
}): DeliveryDocumentSnapshot<TPayload> {
  return Object.freeze({
    documentType: input.documentType,
    eventAt: input.audit?.eventAt ?? null,
    printedAt: input.audit?.printedAt ?? input.now ?? new Date(),
    copy: input.audit?.copy ?? Object.freeze({ kind: "ORIGINAL" as const }),
    payload: Object.freeze({ ...input.payload }),
  });
}

export function deliveryDocumentAuditLines(
  eventLabel: string,
  snapshot: Pick<DeliveryDocumentSnapshot<unknown>, "eventAt" | "printedAt" | "copy">,
): string[] {
  const lines = [
    ...(snapshot.eventAt ? [`${eventLabel}: ${fmtDateTime(snapshot.eventAt)}`] : []),
    `وقت الطباعة: ${fmtDateTime(snapshot.printedAt)}`,
  ];
  if (snapshot.copy.kind === "REPRINT") {
    lines.push("نوع النسخة: نسخة معاد طباعتها");
    if (snapshot.copy.reason?.trim()) lines.push(`سبب إعادة الطباعة: ${snapshot.copy.reason.trim()}`);
    if (snapshot.copy.actorName?.trim()) lines.push(`أعاد الطباعة: ${snapshot.copy.actorName.trim()}`);
  }
  return lines;
}
