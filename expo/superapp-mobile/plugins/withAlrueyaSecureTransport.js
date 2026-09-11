const {
  createRunOncePlugin,
  withInfoPlist,
  withStringsXml,
} = require("expo/config-plugins");

const PLUGIN_NAME = "with-alrueya-secure-transport";
const RESOURCE_NAME = "alrueya_secure_transport_configuration";
const INFO_PLIST_KEY = "AlrueyaSecureTransportConfiguration";
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
  const encoded = normalize(options);

  config = withStringsXml(config, (mod) => {
    mod.modResults.resources ??= {};
    upsertAndroidString(mod.modResults.resources, encoded);
    return mod;
  });

  return withInfoPlist(config, (mod) => {
    mod.modResults[INFO_PLIST_KEY] = encoded;
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
plugin.__testing = { normalize };
module.exports = plugin;
