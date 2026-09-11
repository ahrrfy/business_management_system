const {
  createRunOncePlugin,
  withInfoPlist,
  withStringsXml,
} = require("expo/config-plugins");
const { Buffer } = require("node:buffer");

const PLUGIN_NAME = "with-alrueya-secure-transport";
const RESOURCE_NAME = "alrueya_secure_transport_configuration";
const INFO_PLIST_KEY = "AlrueyaSecureTransportConfiguration";
const ANDROID_ENCODING_PREFIX = "base64url-v1:";
const PIN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DEVELOPMENT_HTTP_HOSTS = new Set(["10.0.2.2", "127.0.0.1", "localhost"]);

function hasSafeEndpoint(baseUrl, environment) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) return false;
  if (url.protocol === "https:") return Boolean(url.hostname);
  return environment === "development" && url.protocol === "http:" && DEVELOPMENT_HTTP_HOSTS.has(url.hostname);
}

function normalize(options = {}) {
  const environment = options.environment === "production" ? "production" : "development";
  const baseUrl = typeof options.baseUrl === "string" ? options.baseUrl.trim() : "";
  const spkiPins = Array.isArray(options.spkiPins)
    ? [...new Set(options.spkiPins.filter((pin) => typeof pin === "string" && PIN_PATTERN.test(pin)))]
    : [];

  if (baseUrl === "" && environment === "development") {
    return JSON.stringify({ environment, baseUrl, spkiPins });
  }

  if (!hasSafeEndpoint(baseUrl, environment)) {
    throw new Error("The Super Arabia transport endpoint must be HTTPS (or development-only loopback HTTP) without a path, query, credentials, or fragment.");
  }

  if (environment === "production" && spkiPins.length === 0) {
    throw new Error(
      "A production Super Arabia build requires a compiled HTTPS endpoint and at least one SPKI pin.",
    );
  }

  return JSON.stringify({ environment, baseUrl, spkiPins });
}

// Android string resources treat unescaped quote characters as formatting
// syntax. Embedding JSON directly therefore changes the value returned by
// Context#getString even though strings.xml looks correct. A versioned,
// URL-safe Base64 envelope gives the native parser the exact reviewed bytes.
function encodeAndroidConfiguration(value) {
  return `${ANDROID_ENCODING_PREFIX}${Buffer.from(value, "utf8").toString("base64url")}`;
}

function decodeAndroidConfiguration(value) {
  if (!value.startsWith(ANDROID_ENCODING_PREFIX)) throw new Error("Unsupported Android secure transport configuration encoding.");
  return Buffer.from(value.slice(ANDROID_ENCODING_PREFIX.length), "base64url").toString("utf8");
}

function upsertAndroidString(resources, value) {
  const strings = Array.isArray(resources.string) ? resources.string : [];
  const next = strings.filter((item) => item?.$?.name !== RESOURCE_NAME);
  next.push({
    $: { name: RESOURCE_NAME, translatable: "false" },
    _: value,
  });
  resources.string = next;
}

function withAlrueyaSecureTransport(config, options) {
  const normalized = normalize(options);

  config = withStringsXml(config, (mod) => {
    mod.modResults.resources ??= {};
    upsertAndroidString(mod.modResults.resources, encodeAndroidConfiguration(normalized));
    return mod;
  });

  return withInfoPlist(config, (mod) => {
    // Info.plist preserves the JSON string byte-for-byte, so iOS keeps the
    // existing audited representation.
    mod.modResults[INFO_PLIST_KEY] = normalized;
    return mod;
  });
}

const plugin = createRunOncePlugin(
  withAlrueyaSecureTransport,
  PLUGIN_NAME,
  "1.0.0",
);

// Kept non-public and used only by the local contract test; the Expo runtime
// still receives the run-once config plugin function above.
plugin.__testing = { decodeAndroidConfiguration, encodeAndroidConfiguration, normalize };
module.exports = plugin;
