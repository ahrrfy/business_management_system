import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { DestinationStream } from "pino";
import { pinoHttp } from "pino-http";
import { describe, expect, it } from "vitest";
import { createLogger } from "./logger";

describe("HTTP log secret containment", () => {
  it("يحجب حقول الرؤوس بالكامل ويبقي بيانات الطلب التشغيلية", async () => {
    const previousProxySecret = process.env.INTERNAL_PROXY_SECRET;
    const previousRotatedProxySecret =
      process.env.INTERNAL_PROXY_SECRET_PREVIOUS;
    const previousEncryptionKey = process.env.INTEGRATIONS_ENCRYPTION_KEY;
    const previousServiceAccount = process.env.FCM_SERVICE_ACCOUNT_JSON;
    const previousR2AccessKeyId = process.env.R2_ACCESS_KEY_ID;
    process.env.INTERNAL_PROXY_SECRET = "known-runtime-secret";
    process.env.INTERNAL_PROXY_SECRET_PREVIOUS = "known-previous-runtime-secret";
    process.env.INTEGRATIONS_ENCRYPTION_KEY = "encryption-runtime-secret";
    process.env.FCM_SERVICE_ACCOUNT_JSON = "service-account-runtime-secret";
    process.env.R2_ACCESS_KEY_ID = "r2-access-id-runtime-secret";
    const lines: string[] = [];
    const destination: DestinationStream = {
      write(chunk) {
        lines.push(String(chunk));
      },
    };
    const applicationLogger = createLogger({ destination, pretty: false });
    const httpLogger = pinoHttp({
      logger: applicationLogger,
      genReqId: () => "request-safe-id",
    });
    const server = createServer((req, res) => {
      httpLogger(req, res, () => {
        res.statusCode = 204;
        res.setHeader("set-cookie", "session=response-secret; HttpOnly");
        res.end();
      });
    });

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(
        `http://127.0.0.1:${port}/healthz?verbose=1`,
        {
          headers: {
            authorization: "Bearer authorization-secret",
            cookie: "session=request-cookie-secret",
            "x-csrf-token": "csrf-secret",
            "x-internal-proxy-secret": "internal-proxy-secret",
          },
        },
      );
      expect(response.status).toBe(204);
      applicationLogger.info(
        {
          operation: "catalog-sync",
          nested: {
            deep: {
              refreshToken: "nested-refresh-token",
              clientSecret: "nested-client-secret",
              databaseUrl: "mysql://user:database-password@db.internal/erp",
              futureCredential: "known-runtime-secret",
              rotationNote: "known-previous-runtime-secret",
              integrationsEncryptionKey: "nested-encryption-key",
              fcmServiceAccountJson: "nested-service-account",
              r2AccessKeyId: "nested-r2-access-id",
              remote: new URL(
                "https://url-user:url-password@storage.internal/object",
              ),
            },
          },
        },
        "operation stayed useful",
      );
      const loggedError = new Error(
        "upstream failed token=error-token known-runtime-secret encryption-runtime-secret service-account-runtime-secret r2-access-id-runtime-secret mysql://user:error-password@db.internal/erp",
      );
      loggedError.name = "encryption-runtime-secret";
      applicationLogger.error(loggedError, "request failed safely");
      const circular: Record<string, unknown> = {
        operation: "circular-safe",
        nested: { token: "circular-token" },
      };
      circular.self = circular;
      applicationLogger.info(circular);
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      if (previousProxySecret === undefined) {
        delete process.env.INTERNAL_PROXY_SECRET;
      } else {
        process.env.INTERNAL_PROXY_SECRET = previousProxySecret;
      }
      if (previousRotatedProxySecret === undefined) {
        delete process.env.INTERNAL_PROXY_SECRET_PREVIOUS;
      } else {
        process.env.INTERNAL_PROXY_SECRET_PREVIOUS =
          previousRotatedProxySecret;
      }
      if (previousEncryptionKey === undefined) {
        delete process.env.INTEGRATIONS_ENCRYPTION_KEY;
      } else {
        process.env.INTEGRATIONS_ENCRYPTION_KEY = previousEncryptionKey;
      }
      if (previousServiceAccount === undefined) {
        delete process.env.FCM_SERVICE_ACCOUNT_JSON;
      } else {
        process.env.FCM_SERVICE_ACCOUNT_JSON = previousServiceAccount;
      }
      if (previousR2AccessKeyId === undefined) {
        delete process.env.R2_ACCESS_KEY_ID;
      } else {
        process.env.R2_ACCESS_KEY_ID = previousR2AccessKeyId;
      }
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }

    const output = lines.join("");
    expect(output).not.toContain("authorization-secret");
    expect(output).not.toContain("request-cookie-secret");
    expect(output).not.toContain("response-secret");
    expect(output).not.toContain("csrf-secret");
    expect(output).not.toContain("internal-proxy-secret");
    expect(output).not.toContain("nested-refresh-token");
    expect(output).not.toContain("nested-client-secret");
    expect(output).not.toContain("database-password");
    expect(output).not.toContain("known-runtime-secret");
    expect(output).not.toContain("known-previous-runtime-secret");
    expect(output).not.toContain("encryption-runtime-secret");
    expect(output).not.toContain("service-account-runtime-secret");
    expect(output).not.toContain("r2-access-id-runtime-secret");
    expect(output).not.toContain("nested-encryption-key");
    expect(output).not.toContain("nested-service-account");
    expect(output).not.toContain("nested-r2-access-id");
    expect(output).not.toContain("url-password");
    expect(output).not.toContain("error-token");
    expect(output).not.toContain("error-password");
    expect(output).not.toContain("circular-token");
    expect(output).toContain("request-safe-id");
    expect(output).toContain("GET");
    expect(output).toContain("/healthz?verbose=1");
    expect(output).toContain('"statusCode":204');
    expect(output).toContain('"responseTime"');
    expect(output).toContain("catalog-sync");
    expect(output).toContain("request failed safely");
    expect(output).toContain("circular-safe");
  });
});
