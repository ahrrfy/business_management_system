const { defineConfig } = require("eslint/config");
const expoConfig = require("eslint-config-expo/flat.js");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/**", "dist-qa/**", ".tmp-route-export/**", ".tmp-android-export/**"],
  },
]);
