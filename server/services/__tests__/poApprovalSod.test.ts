import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertApprover } from "../approval/ownerGate";
import { purchaseOrderControlTrigger } from "@shared/approvalTriggers";
import { TRPCError } from "@trpc/server";

const FLAG = "ROLLOUT_OWNER_ONLY_APPROVAL";

const CREATOR_ID = 10;
const EDITOR_ID = 20;
const REQUESTER_ID = 30;
const INDEPENDENT_APPROVER_ID = 40;
const OWNER_ID = 99;

const PO_FIXTURE = {
  poNumber: "PO-2026-001",
  createdBy: CREATOR_ID,
  lastEditedBy: EDITOR_ID,
};

const REQUEST_FIXTURE = {
  requestedBy: REQUESTER_ID,
  kind: "PRICE_INCREASE" as const,
};

function makeLegacyCheck(actorUserId: number) {
  return () => {
    if (
      actorUserId === Number(REQUEST_FIXTURE.requestedBy) ||
      actorUserId === Number(PO_FIXTURE.createdBy) ||
      actorUserId === Number(PO_FIXTURE.lastEditedBy)
    ) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "يلزم معتمد مستقل عن المنشئ وآخر محرر وصاحب الطلب",
      });
    }
  };
}

describe("VULN-RBAC-01: Segregation of Duties in PO Approval under ROLLOUT_OWNER_ONLY_APPROVAL", () => {
  const originalFlag = process.env[FLAG];

  afterEach(() => {
    if (originalFlag == null) delete process.env[FLAG];
    else process.env[FLAG] = originalFlag;
  });

  describe("When ROLLOUT_OWNER_ONLY_APPROVAL is OFF", () => {
    beforeEach(() => {
      delete process.env[FLAG];
    });

    it("منشئ أمر الشراء يُمنَع من اعتماد طلبه بنفسه", () => {
      const trigger = purchaseOrderControlTrigger(REQUEST_FIXTURE.kind, true);
      expect(() =>
        assertApprover({
          actor: { userId: CREATOR_ID, role: "manager", isOwner: false },
          trigger,
          subject: `أمر الشراء ${PO_FIXTURE.poNumber}`,
          retainLegacy: true,
          legacy: makeLegacyCheck(CREATOR_ID),
        }),
      ).toThrowError(/يلزم معتمد مستقل/);
    });

    it("آخر محرر لأمر الشراء يُمنَع من اعتماد الطلب", () => {
      const trigger = purchaseOrderControlTrigger(REQUEST_FIXTURE.kind, true);
      expect(() =>
        assertApprover({
          actor: { userId: EDITOR_ID, role: "manager", isOwner: false },
          trigger,
          subject: `أمر الشراء ${PO_FIXTURE.poNumber}`,
          retainLegacy: true,
          legacy: makeLegacyCheck(EDITOR_ID),
        }),
      ).toThrowError(/يلزم معتمد مستقل/);
    });

    it("مقدم طلب التحكم يُمنَع من اعتماده بنفسه", () => {
      const trigger = purchaseOrderControlTrigger(REQUEST_FIXTURE.kind, true);
      expect(() =>
        assertApprover({
          actor: { userId: REQUESTER_ID, role: "manager", isOwner: false },
          trigger,
          subject: `أمر الشراء ${PO_FIXTURE.poNumber}`,
          retainLegacy: true,
          legacy: makeLegacyCheck(REQUESTER_ID),
        }),
      ).toThrowError(/يلزم معتمد مستقل/);
    });

    it("معتمد مستقل يمر بنجاح", () => {
      const trigger = purchaseOrderControlTrigger(REQUEST_FIXTURE.kind, true);
      expect(() =>
        assertApprover({
          actor: { userId: INDEPENDENT_APPROVER_ID, role: "manager", isOwner: false },
          trigger,
          subject: `أمر الشراء ${PO_FIXTURE.poNumber}`,
          retainLegacy: true,
          legacy: makeLegacyCheck(INDEPENDENT_APPROVER_ID),
        }),
      ).not.toThrow();
    });
  });

  describe("When ROLLOUT_OWNER_ONLY_APPROVAL is ON (Fix Verification)", () => {
    beforeEach(() => {
      process.env[FLAG] = "ON";
    });

    it("مع retainLegacy: true والتصنيف null، منشئ أمر الشراء يُمنَع قطعياً من اعتماده بنفسه (إغلاق ثغرة VULN-RBAC-01)", () => {
      // الاعتماد العادي يرجع trigger = null
      const trigger = purchaseOrderControlTrigger(REQUEST_FIXTURE.kind, true);
      expect(trigger).toBeNull();

      expect(() =>
        assertApprover({
          actor: { userId: CREATOR_ID, role: "manager", isOwner: false },
          trigger,
          subject: `أمر الشراء ${PO_FIXTURE.poNumber}`,
          retainLegacy: true,
          legacy: makeLegacyCheck(CREATOR_ID),
        }),
      ).toThrowError(/يلزم معتمد مستقل/);
    });

    it("مع retainLegacy: true والتصنيف null، آخر محرر يُمنَع من الاعتماد", () => {
      const trigger = purchaseOrderControlTrigger(REQUEST_FIXTURE.kind, true);
      expect(() =>
        assertApprover({
          actor: { userId: EDITOR_ID, role: "manager", isOwner: false },
          trigger,
          subject: `أمر الشراء ${PO_FIXTURE.poNumber}`,
          retainLegacy: true,
          legacy: makeLegacyCheck(EDITOR_ID),
        }),
      ).toThrowError(/يلزم معتمد مستقل/);
    });

    it("مع retainLegacy: true والتصنيف null، مقدم طلب التحكم يُمنَع من الاعتماد", () => {
      const trigger = purchaseOrderControlTrigger(REQUEST_FIXTURE.kind, true);
      expect(() =>
        assertApprover({
          actor: { userId: REQUESTER_ID, role: "manager", isOwner: false },
          trigger,
          subject: `أمر الشراء ${PO_FIXTURE.poNumber}`,
          retainLegacy: true,
          legacy: makeLegacyCheck(REQUESTER_ID),
        }),
      ).toThrowError(/يلزم معتمد مستقل/);
    });

    it("معتمد مستقل يمر بنجاح عند trigger = null", () => {
      const trigger = purchaseOrderControlTrigger(REQUEST_FIXTURE.kind, true);
      expect(() =>
        assertApprover({
          actor: { userId: INDEPENDENT_APPROVER_ID, role: "manager", isOwner: false },
          trigger,
          subject: `أمر الشراء ${PO_FIXTURE.poNumber}`,
          retainLegacy: true,
          legacy: makeLegacyCheck(INDEPENDENT_APPROVER_ID),
        }),
      ).not.toThrow();
    });

    it("المالك مستثنى لأن قراره نهائي ولا معنى لاعتماد ثانٍ عليه", () => {
      const trigger = purchaseOrderControlTrigger(REQUEST_FIXTURE.kind, true);
      const legacySpy = vi.fn();
      expect(() =>
        assertApprover({
          actor: { userId: OWNER_ID, role: "admin", isOwner: true },
          trigger,
          subject: `أمر الشراء ${PO_FIXTURE.poNumber}`,
          retainLegacy: true,
          legacy: legacySpy,
        }),
      ).not.toThrow();
      expect(legacySpy).not.toHaveBeenCalled();
    });

    it("المطابقة المضادة (Inversion / Falsification): إزالة retainLegacy كانت تسقط فحص فصل المهام", () => {
      const trigger = purchaseOrderControlTrigger(REQUEST_FIXTURE.kind, true);
      expect(trigger).toBeNull();
      const legacySpy = vi.fn();

      // بلا retainLegacy: يتخطى args.legacy() ويعود مباشرةً
      assertApprover({
        actor: { userId: CREATOR_ID, role: "manager", isOwner: false },
        trigger,
        subject: `أمر الشراء ${PO_FIXTURE.poNumber}`,
        // retainLegacy is omitted
        legacy: legacySpy,
      });

      // يثبت أن عدم تمرير retainLegacy كان سبب الثغرة
      expect(legacySpy).not.toHaveBeenCalled();
    });
  });
});
