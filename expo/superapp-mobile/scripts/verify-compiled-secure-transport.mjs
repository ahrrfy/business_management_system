import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const stringsPath = resolve(root, "android/app/src/main/res/values/strings.xml");
const source = readFileSync(stringsPath, "utf8");
const match = source.match(/<string name="alrueya_secure_transport_configuration"[^>]*>([^<]+)<\/string>/);

if (!match) throw new Error("The generated Android project is missing the secure transport resource.");

const require = createRequire(import.meta.url);
const plugin = require("../plugins/withAlrueyaSecureTransport");
const raw = plugin.__testing.decodeAndroidConfiguration(match[1]);
const configuration = JSON.parse(raw);
const expectedEndpoint = (process.env.ERP_API_BASE_URL || "").trim();
const expectedPins = (process.env.ERP_TLS_SPKI_PINS || "")
  .split(",")
  .map((pin) => pin.trim())
  .filter(Boolean);

if (configuration.environment !== "production") throw new Error("The generated Android transport is not production-bound.");
if (configuration.baseUrl !== expectedEndpoint) throw new Error("The generated Android endpoint does not match the reviewed endpoint.");
if (JSON.stringify(configuration.spkiPins) !== JSON.stringify(expectedPins)) {
  throw new Error("The generated Android SPKI pins do not match the reviewed pins.");
}

console.log("[secure transport] Generated Android resource round-trips to the reviewed production endpoint and pins.");
