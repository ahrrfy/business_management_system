import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { encryptSecret } from "../cryptoService";
import { dripRunningBroadcasts } from "../whatsapp/broadcastDispatch";
import {
  cancelBroadcast,
  getBroadcast,
  pauseBroadcast,
  resumeBroadcast,
} from "../whatsapp/broadcastService";
import {
  dispatchOutboxRow,
  enqueueOutbox,
  retryOutbox,
} from "../whatsapp/outboxService";
import { sweepWaOutboxOnce } from "../whatsapp/outboxSweeper";
import { conversationRouter } from "../../routers/conversationRouter";
import type { TrpcContext } from "../../context";

const db = () => getDb()!;
const actor = { userId: 1, branchId: 1, role: "admin" };
let transport: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  transport = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ messages: [{ id: "wamid.synthetic-accepted" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
  await db()
    .insert(s.branches)
    .values({ id: 1, name: "اختبار", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values({
    id: 1,
    openId: "outbox-test",
    name: "مدير اختبار",
    role: "admin",
    branchId: 1,
  });
  await db()
    .insert(s.channelIntegrations)
    .values({
      branchId: 1,
      channel: "WHATSAPP",
      status: "ACTIVE",
      phoneNumberId: "synthetic-number",
      encryptedAccessToken: encryptSecret("fake-only"),
    });
  await db().insert(s.waHubSettings).values({ id: 1, killSwitch: false });
  await db().insert(s.waTemplates).values({
    id: 1,
    name: "synthetic_promo",
    language: "ar",
    category: "MARKETING",
    templateStatus: "APPROVED",
    bodyText: "اختبار",
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function queued(campaignId?: number) {
  return enqueueOutbox({
    branchId: 1,
    dedupeKey: `audit-${campaignId ?? "direct"}`,
    kind: "TEMPLATE",
    templateName: "synthetic_promo",
    templateLang: "ar",
    toPhoneE164: "+9647700000001",
    payloadJson: { bodyParams: [] },
    campaignId,
  });
}
async function row(id: number) {
  return (await db().select().from(s.waOutbox).where(eq(s.waOutbox.id, id)))[0];
}
async function campaign() {
  await db().insert(s.customers).values({
    id: 1,
    name: "اختبار",
    phone: "07700000001",
    customerType: "فرد",
    waConsent: "OPTED_IN",
  });
  const id = extractInsertId(
    await db().insert(s.waBroadcasts).values({
      branchId: 1,
      name: "حملة اختبار",
      templateId: 1,
      templateLang: "ar",
      segmentJson: {},
      broadcastStatus: "RUNNING",
      throttlePerMinute: 1,
      createdBy: 1,
    }),
  );
  await dripRunningBroadcasts();
  const outbox = (
    await db().select().from(s.waOutbox).where(eq(s.waOutbox.campaignId, id))
  )[0];
  return { id, outboxId: outbox.id };
}

describe("WA interrupted send recovery", () => {
  it("holds a legacy stale send with no accepted identity for explicit reconciliation", async () => {
    const { id } = await queued();
    await db()
      .update(s.waOutbox)
      .set({ status: "SENDING", updatedAt: new Date(Date.now() - 3600_000) })
      .where(eq(s.waOutbox.id, id));
    await sweepWaOutboxOnce();
    expect((await row(id)).status).toBe("UNKNOWN");
    expect(transport).not.toHaveBeenCalled();
  });

  it("never retries a transport outcome that may already have been accepted", async () => {
    const { id } = await queued();
    transport.mockImplementation(async () => {
      throw new Error("synthetic response lost after provider acceptance");
    });
    await dispatchOutboxRow(id);
    expect((await row(id)).status).toBe("UNKNOWN");
    await sweepWaOutboxOnce();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("settles stale known-accepted sends without another provider attempt", async () => {
    const { id } = await queued();
    await db()
      .update(s.waOutbox)
      .set({
        status: "SENDING",
        wamid: "wamid.previously-accepted",
        updatedAt: new Date(Date.now() - 3600_000),
      })
      .where(eq(s.waOutbox.id, id));
    await sweepWaOutboxOnce();
    expect((await row(id)).status).toBe("SENT");
    expect((await row(id)).wamid).toBe("wamid.previously-accepted");
    expect(transport).not.toHaveBeenCalled();
  });

  it("recovers an expired modern claim before provider I/O exactly once", async () => {
    const { id } = await queued();
    await db()
      .update(s.waOutbox)
      .set({
        status: "SENDING",
        claimToken: "crashed-before-io",
        claimExpiresAt: new Date(Date.now() - 60_000),
      })
      .where(eq(s.waOutbox.id, id));
    await sweepWaOutboxOnce();
    await sweepWaOutboxOnce();
    expect(transport).toHaveBeenCalledTimes(1);
    expect((await row(id)).status).toBe("SENT");
  });

  it("preserves the stable attempt when an expired claim may have reached the provider", async () => {
    const { id } = await queued();
    await db()
      .update(s.waOutbox)
      .set({
        status: "SENDING",
        claimToken: "crashed-after-io",
        claimExpiresAt: new Date(Date.now() - 60_000),
        providerStartedAt: new Date(Date.now() - 120_000),
        providerAttemptId: "immutable-provider-attempt",
      })
      .where(eq(s.waOutbox.id, id));
    await sweepWaOutboxOnce();
    await sweepWaOutboxOnce();
    expect(transport).not.toHaveBeenCalled();
    expect((await row(id)).status).toBe("UNKNOWN");
    expect((await row(id)).providerAttemptId).toBe(
      "immutable-provider-attempt",
    );
  });
});

describe("explicit unknown-result reconciliation", () => {
  const caller = () =>
    conversationRouter.createCaller({
      user: { id: 1, role: "admin", branchId: 1, isActive: true },
      req: { headers: {} },
      res: {},
    } as unknown as TrpcContext);
  async function unknownConversation() {
    await db().insert(s.conversations).values({
      id: 1,
      branchId: 1,
      channel: "WHATSAPP",
      channelHandle: "9647700000001",
    });
    const { id } = await queued();
    await db()
      .update(s.waOutbox)
      .set({
        status: "UNKNOWN",
        conversationId: 1,
        providerAttemptId: "previous-attempt",
      })
      .where(eq(s.waOutbox.id, id));
    return id;
  }
  it("exposes branch-scoped unknown automation sends even without a conversation", async () => {
    const { id } = await queued();
    await db()
      .update(s.waOutbox)
      .set({ status: "UNKNOWN" })
      .where(eq(s.waOutbox.id, id));
    await db()
      .insert(s.waOutbox)
      .values({
        branchId: 2,
        dedupeKey: "other-branch-unknown",
        kind: "TEMPLATE",
        payloadJson: {},
        status: "UNKNOWN",
      });
    const result = (await caller().list({ branchId: 1 })) as unknown as {
      unresolvedOutbox?: { total: number; rows: Array<{ id: number }> };
    };
    expect(result.unresolvedOutbox?.total).toBe(1);
    expect(result.unresolvedOutbox?.rows.map((item) => item.id)).toEqual([id]);
    expect(transport).not.toHaveBeenCalled();
  });
  it("records provider acceptance and evidence atomically without sending again", async () => {
    const id = await unknownConversation();
    await caller().retrySend({
      outboxId: id,
      reconciliation: {
        outcome: "ACCEPTED",
        wamid: "wamid.provider-proof",
        reason: "مطابقة سجل المزود",
        evidence: "مرجع تحقق مزود وهمي 123",
      },
    } as never);
    expect((await row(id)).status).toBe("SENT");
    expect((await row(id)).wamid).toBe("wamid.provider-proof");
    expect((await row(id)).providerAttemptId).toBe("previous-attempt");
    expect(transport).not.toHaveBeenCalled();
    const evidence = await db()
      .select()
      .from(s.auditLogs)
      .where(eq(s.auditLogs.action, "whatsapp.reconcileOutbox"));
    expect(evidence).toHaveLength(1);
    expect(JSON.stringify(evidence[0].newValue)).toContain(
      "مرجع تحقق مزود وهمي 123",
    );
  });
  it("requires explicit proof of non-delivery before queuing one new attempt", async () => {
    const id = await unknownConversation();
    await expect(caller().retrySend({ outboxId: id })).rejects.toThrow();
    expect((await row(id)).status).toBe("UNKNOWN");
    await caller().retrySend({
      outboxId: id,
      reconciliation: {
        outcome: "NOT_SENT",
        reason: "تأكد عدم بدء الإرسال",
        evidence: "سجل مزود وهمي يؤكد عدم القبول",
      },
    } as never);
    expect((await row(id)).status).toBe("QUEUED");
    expect(transport).not.toHaveBeenCalled();
    await sweepWaOutboxOnce();
    expect(transport).toHaveBeenCalledTimes(1);
    expect((await row(id)).providerAttemptId).not.toBe("previous-attempt");
  });
  it("rechecks current administrative authority rather than trusting an old session role", async () => {
    const id = await unknownConversation();
    await db()
      .update(s.users)
      .set({ role: "cashier" })
      .where(eq(s.users.id, 1));
    await expect(
      caller().retrySend({
        outboxId: id,
        reconciliation: {
          outcome: "NOT_SENT",
          reason: "قرار مراجع غير مفوض",
          evidence: "دليل اختبار صلاحية تغيرت",
        },
      } as never),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await row(id)).status).toBe("UNKNOWN");
  });

  it("rejects reconciliation after account access expires despite an admitted admin session", async () => {
    const id = await unknownConversation();
    await db()
      .update(s.users)
      .set({ accessExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(s.users.id, 1));
    await expect(
      caller().retrySend({
        outboxId: id,
        reconciliation: {
          outcome: "ACCEPTED",
          wamid: "wamid.expired-must-not-settle",
          reason: "مراجعة قبول من المزود",
          evidence: "مرجع دليل لمستخدم انتهى وصوله",
        },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await row(id)).status).toBe("UNKNOWN");
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects reconciliation after the assigned administrative role is disabled", async () => {
    const id = await unknownConversation();
    await db()
      .insert(s.roles)
      .values({
        id: 1,
        key: "outbox-review-admin",
        label: "مراجع اختبار",
        baseRole: "admin",
        permissions: {},
        isActive: false,
      });
    await db()
      .update(s.users)
      .set({ customRoleId: 1 })
      .where(eq(s.users.id, 1));
    await expect(
      caller().retrySend({
        outboxId: id,
        reconciliation: {
          outcome: "NOT_SENT",
          reason: "مراجعة عدم قبول مزود",
          evidence: "مرجع دليل لدور جرى تعطيله",
        },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await row(id)).status).toBe("UNKNOWN");
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects reconciliation after the source operation permission is revoked", async () => {
    const id = await unknownConversation();
    await db()
      .update(s.users)
      .set({
        operationPolicy: {
          version: 1,
          grants: { "operation.conversations.retrySend": false },
        },
      })
      .where(eq(s.users.id, 1));
    await expect(
      caller().retrySend({
        outboxId: id,
        reconciliation: {
          outcome: "NOT_SENT",
          reason: "مراجعة عدم قبول مزود",
          evidence: "مرجع دليل لصلاحية جرى سحبها",
        },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await row(id)).status).toBe("UNKNOWN");
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects a plain retry whose request branch changed before the decision", async () => {
    const { id } = await queued();
    await db()
      .update(s.waOutbox)
      .set({ status: "FAILED", branchId: 2 })
      .where(eq(s.waOutbox.id, id));
    await db()
      .update(s.users)
      .set({ role: "cashier", branchId: 2 })
      .where(eq(s.users.id, 1));
    await expect(
      retryOutbox(id, { userId: 1, role: "cashier", branchId: 1 }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await row(id)).status).toBe("FAILED");
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects a custom non-owner administrator whose assigned role revokes the source operation", async () => {
    const id = await unknownConversation();
    await db()
      .insert(s.roles)
      .values({
        id: 1,
        key: "outbox-review-admin",
        label: "مراجع اختبار",
        baseRole: "admin",
        permissions: { channels: "FULL" },
        isActive: true,
        operationPolicy: {
          version: 1,
          grants: { "operation.conversations.retrySend": false },
        },
      });
    await db()
      .update(s.users)
      .set({ customRoleId: 1, isOwner: false })
      .where(eq(s.users.id, 1));
    await expect(
      caller().retrySend({
        outboxId: id,
        reconciliation: {
          outcome: "NOT_SENT",
          reason: "مراجعة عدم قبول مزود",
          evidence: "مرجع دليل لصلاحية دور جرى سحبها",
        },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await row(id)).status).toBe("UNKNOWN");
    expect(transport).not.toHaveBeenCalled();
  });

  it("allows an active custom non-owner administrator with the current operation grant", async () => {
    const id = await unknownConversation();
    await db()
      .insert(s.roles)
      .values({
        id: 1,
        key: "outbox-review-admin",
        label: "مراجع اختبار",
        baseRole: "admin",
        permissions: { channels: "FULL" },
        isActive: true,
        operationPolicy: {
          version: 1,
          grants: { "operation.conversations.retrySend": true },
        },
      });
    await db()
      .update(s.users)
      .set({
        customRoleId: 1,
        isOwner: false,
        accessExpiresAt: new Date(Date.now() + 3600_000),
      })
      .where(eq(s.users.id, 1));
    await caller().retrySend({
      outboxId: id,
      reconciliation: {
        outcome: "ACCEPTED",
        wamid: "wamid.valid-custom-review",
        reason: "مطابقة قبول المزود",
        evidence: "مرجع دليل لمراجع مفوض حالياً",
      },
    });
    expect((await row(id)).status).toBe("SENT");
    expect(transport).not.toHaveBeenCalled();
  });

  it("preserves the active owner's canonical administrative authority", async () => {
    const id = await unknownConversation();
    await db()
      .update(s.users)
      .set({
        role: "cashier",
        isOwner: true,
        branchId: 2,
        accessExpiresAt: new Date(Date.now() + 3600_000),
        operationPolicy: {
          version: 1,
          grants: { "operation.conversations.retrySend": false },
        },
      })
      .where(eq(s.users.id, 1));
    await caller().retrySend({
      outboxId: id,
      reconciliation: {
        outcome: "ACCEPTED",
        wamid: "wamid.valid-owner-review",
        reason: "مطابقة قبول المزود",
        evidence: "مرجع دليل بقرار المالك الفعال",
      },
    });
    expect((await row(id)).status).toBe("SENT");
    expect(transport).not.toHaveBeenCalled();
  });

  it("keeps authorized cashier retries while denying administrative reconciliation", async () => {
    const { id } = await queued();
    const cashier = { userId: 1, role: "cashier", branchId: 1 };
    await db()
      .update(s.users)
      .set({
        role: "cashier",
        operationPolicy: {
          version: 1,
          grants: { "operation.conversations.retrySend": true },
        },
      })
      .where(eq(s.users.id, 1));
    await db()
      .update(s.waOutbox)
      .set({ status: "FAILED" })
      .where(eq(s.waOutbox.id, id));
    await expect(retryOutbox(id, cashier)).resolves.toEqual({
      status: "QUEUED",
    });
    await db()
      .update(s.waOutbox)
      .set({ status: "UNKNOWN" })
      .where(eq(s.waOutbox.id, id));
    await expect(
      retryOutbox(id, cashier, {
        outcome: "NOT_SENT",
        reason: "طلب تسوية من الكاشير",
        evidence: "مرجع دليل دون سلطة إدارية",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await row(id)).status).toBe("UNKNOWN");
    await db().update(s.users).set({ branchId: 2 }).where(eq(s.users.id, 1));
    await db()
      .update(s.waOutbox)
      .set({ status: "FAILED" })
      .where(eq(s.waOutbox.id, id));
    await expect(
      retryOutbox(id, { ...cashier, branchId: 2 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await row(id)).status).toBe("FAILED");
    expect(transport).not.toHaveBeenCalled();
  });
});

describe("broadcast final send eligibility", () => {
  it("preserves customer identity on enqueue and rejects opt-out after enqueue", async () => {
    const { id, outboxId } = await campaign();
    expect((await row(outboxId)).customerId).toBe(1);
    await db()
      .update(s.customers)
      .set({ waConsent: "OPTED_OUT" })
      .where(eq(s.customers.id, 1));
    await dispatchOutboxRow(outboxId);
    expect(transport).not.toHaveBeenCalled();
    expect((await row(outboxId)).status).toBe("CANCELLED");
    const recipient = (
      await db()
        .select()
        .from(s.waBroadcastRecipients)
        .where(
          and(
            eq(s.waBroadcastRecipients.broadcastId, id),
            eq(s.waBroadcastRecipients.outboxId, outboxId),
          ),
        )
    )[0];
    expect(recipient.recipientStatus).toBe("SKIPPED_OPTOUT");
  });

  it("resolves a legacy queued customer's identity only through its exact recipient link", async () => {
    const { outboxId } = await campaign();
    await db()
      .update(s.waOutbox)
      .set({ customerId: null })
      .where(eq(s.waOutbox.id, outboxId));
    await db()
      .update(s.customers)
      .set({ waConsent: "UNKNOWN" })
      .where(eq(s.customers.id, 1));
    await dispatchOutboxRow(outboxId);
    expect(transport).not.toHaveBeenCalled();
    expect((await row(outboxId)).status).toBe("CANCELLED");
  });

  it("holds queued sends while paused and sends once after valid resume", async () => {
    const { id, outboxId } = await campaign();
    await pauseBroadcast(id, "اختبار الإيقاف", actor);
    await dispatchOutboxRow(outboxId);
    expect(transport).not.toHaveBeenCalled();
    expect((await row(outboxId)).status).toBe("QUEUED");
    await resumeBroadcast(id, actor);
    await db()
      .update(s.waOutbox)
      .set({ nextAttemptAt: sql`NOW()` })
      .where(eq(s.waOutbox.id, outboxId));
    await dispatchOutboxRow(outboxId);
    expect(transport).toHaveBeenCalledTimes(1);
    expect((await row(outboxId)).status).toBe("SENT");
  });

  it("cancels queued and retry sends permanently without consuming provider quota", async () => {
    const { id, outboxId } = await campaign();
    await db()
      .update(s.waOutbox)
      .set({ attempts: 2 })
      .where(eq(s.waOutbox.id, outboxId));
    await cancelBroadcast(id, actor);
    await sweepWaOutboxOnce();
    expect(transport).not.toHaveBeenCalled();
    expect((await row(outboxId)).status).toBe("CANCELLED");
    expect((await row(outboxId)).attempts).toBe(2);
  });

  it("lets an already-started provider attempt settle after campaign cancellation", async () => {
    const { id, outboxId } = await campaign();
    let finish!: (response: Response) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    transport.mockImplementation(() => {
      started();
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    });
    const sending = dispatchOutboxRow(outboxId);
    await ready;
    const attempt = (await row(outboxId)).providerAttemptId;
    await cancelBroadcast(id, actor);
    expect((await row(outboxId)).status).toBe("SENDING");
    finish(
      new Response(
        JSON.stringify({ messages: [{ id: "wamid.in-flight-before-cancel" }] }),
        { status: 200 },
      ),
    );
    await sending;
    expect((await row(outboxId)).status).toBe("SENT");
    expect((await row(outboxId)).providerAttemptId).toBe(attempt);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("shows capped unknown rows and unmatched recipients truthfully", async () => {
    const { id, outboxId } = await campaign();
    await db()
      .insert(s.waOutbox)
      .values(
        Array.from({ length: 55 }, (_, index) => ({
          dedupeKey: `unknown-${index}`,
          branchId: 1,
          campaignId: id,
          kind: "TEMPLATE" as const,
          payloadJson: {},
          status: "UNKNOWN" as const,
        })),
      );
    await db()
      .update(s.waBroadcastRecipients)
      .set({ recipientStatus: "UNKNOWN", outboxId: null })
      .where(eq(s.waBroadcastRecipients.outboxId, outboxId));
    const detail = await getBroadcast(id);
    expect(detail?.unresolvedOutbox).toHaveLength(50);
    expect(detail?.unresolvedOutboxTotal).toBe(55);
    expect(detail?.unresolvedRecipientMismatchCount).toBe(1);
  });
});
