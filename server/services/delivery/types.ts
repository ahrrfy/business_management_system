// عقد التوصيل (COD) المشترك — الفاعلان داخليان للحزمة، DeliveryPartyKind عام.

import type { ServiceOperationAuthority } from "../authorization/operationAuthority";

type PaymentMethod = "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET";
/** فاعل التحوّلات: يَحمل الدور لقرار درج/خزينة وعزل الفرع.
 *  تصدير داخلي للحزمة فقط (يستهلكه dispatch/remittance/returns/settle) — لا يُعاد تصديره من البرميل. */
export type DeliveryTxActor = { userId: number; branchId?: number | null; role?: string; operationAuthority?: ServiceOperationAuthority };

/** الفاعل خفيف: branchId اختياري/فارغ (admin بلا فرع) بخلاف Actor الصارم.
 *  تصدير داخلي للحزمة فقط (يستهلكه parties) — لا يُعاد تصديره من البرميل. */
export type DeliveryActor = { userId: number; branchId?: number | null; role?: string };

export type DeliveryPartyKind = "INDIVIDUAL" | "COMPANY";
