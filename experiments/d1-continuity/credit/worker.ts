import { fixtureActor } from "./fixture";
import {
  CASH_SCHEMA_VERSION,
  readCashCommand,
  creditRecoveryStrategy,
} from "./actual";
import { creditHttpInput } from "./http-input";
import {
  createWithRecovery,
  committedRecordsPage,
  restoreRecords,
  LAB_ID,
  primary,
  assertIdentity,
} from "../cash/journal";
import {
  snapshotManifest,
  snapshotPage,
  boundedRows,
  pageInteger,
} from "../cash/pages";
import { cashProfiler } from "../cash/profile";
import { creditPage } from "./ui";
import { creditEvidence } from "./evidence";
export default {
  async fetch(request: Request, env: any) {
    const u = new URL(request.url);
    if (request.method === "GET" && u.pathname === "/")
      return new Response(creditPage, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    if (
      !env.LAB_TOKEN ||
      request.headers.get("authorization") !== "Bearer " + env.LAB_TOKEN
    )
      return Response.json({ code: "UNAUTHORIZED" }, { status: 401 });
    const profile =
      request.headers.get("x-cash-profile") === "1"
        ? cashProfiler(env, "CREDIT_SCOPED")
        : null;
    if (profile) env = profile.env;
    const json = (body: any, status = 200) =>
      Response.json(body, {
        status,
        headers: {
          "cache-control": "no-store",
          ...(profile
            ? { "x-cash-profile": JSON.stringify(profile.result()) }
            : {}),
        },
      });
    try {
      let value: any;
      if (
        request.method === "POST" &&
        ["/sale", "/payment"].includes(u.pathname)
      ) {
        const text = await request.text();
        if (text.length > 20000) throw Error("INVALID_REQUEST_SIZE");
        const input = creditHttpInput.safeParse(JSON.parse(text));
        if (
          !input.success ||
          input.data.commandType !==
            (u.pathname === "/sale" ? "SALE" : "COLLECT")
        )
          return json({ code: "INVALID_CREDIT_INPUT" }, 400);
        value = await createWithRecovery(
          env,
          input.data,
          env.TEST_ACTOR ?? fixtureActor,
          request.headers.get("x-cash-fault") ?? "",
          creditRecoveryStrategy,
        );
      } else if (request.method === "GET" && u.pathname === "/status")
        value = {
          labId: LAB_ID,
          schemaVersion: CASH_SCHEMA_VERSION,
          scope: "ORIGINAL_STOCKED_CREDIT_AND_CASH_COLLECTION",
          productionAuthentication: false,
        };
      else if (request.method === "GET" && u.pathname === "/evidence")
        value = await creditEvidence(
          env,
          pageInteger(u.searchParams.get("invoiceId")),
        );
      else if (
        request.method === "GET" &&
        u.pathname.startsWith("/operation/")
      ) {
        const db = primary(env.DB);
        await assertIdentity(db, "primary");
        const id = decodeURIComponent(u.pathname.slice(11)),
          command = await readCashCommand(db, id);
        const log = primary(env.RECOVERY_LOG);
        await assertIdentity(log, "journal");
        const ack = await log
          .prepare(
            "SELECT requestId FROM cashJournalCommitted WHERE requestId=?",
          )
          .bind(id)
          .first();
        value = {
          clientRequestId: id,
          state: command
            ? ack
              ? "CONFIRMED"
              : "PRIMARY_COMMITTED_RECOVERY_PENDING"
            : "UNCONFIRMED_RETRY_ORIGINAL_REQUEST",
          result: command?.result ?? null,
          recoveryAcknowledged: !!ack,
        };
      } else if (request.method === "GET" && u.pathname === "/snapshot")
        value = u.searchParams.has("table")
          ? await snapshotPage(env, u)
          : await snapshotManifest(env);
      else if (request.method === "GET" && u.pathname === "/recovery-log")
        value = await committedRecordsPage(
          env.RECOVERY_LOG,
          pageInteger(u.searchParams.get("afterEpoch"), 1),
          u.searchParams.has("throughEpoch")
            ? pageInteger(u.searchParams.get("throughEpoch"))
            : undefined,
          pageInteger(u.searchParams.get("limit"), 8),
          boundedRows,
        );
      else if (request.method === "POST" && u.pathname === "/restore") {
        const text = await request.text();
        if (text.length > 1000000) throw Error("INVALID_REQUEST_SIZE");
        value = await restoreRecords(env, JSON.parse(text).records);
      } else return json({ code: "UNSUPPORTED_TEST_ROUTE" }, 404);
      return json(value);
    } catch (e: any) {
      const messages = [];
      for (let x = e; x; x = x.cause) messages.push(x.message);
      const status =
        e.status ??
        {
          FORBIDDEN: 403,
          BAD_REQUEST: 400,
          CONFLICT: 409,
          PRECONDITION_FAILED: 412,
          NOT_FOUND: 404,
        }[e.code as string] ??
        (e instanceof SyntaxError ? 400 : 503);
      return json(
        {
          code: e.code ?? e.message,
          message: messages.join(" | "),
          retryWithOriginalRequest: status >= 500 || status === 409,
          trace: e.cashTrace,
        },
        status,
      );
    }
  },
};
