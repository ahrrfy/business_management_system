const {
  AndroidConfig,
  createRunOncePlugin,
  withAndroidStyles,
} = require("expo/config-plugins");

const PLUGIN_NAME = "with-android-splash-api-guard";

function withAndroidSplashApiGuard(config) {
  return withAndroidStyles(config, (mod) => {
    mod.modResults = AndroidConfig.Styles.assignStylesValue(mod.modResults, {
      add: true,
      name: "android:windowSplashScreenBehavior",
      value: "icon_preferred",
      targetApi: 33,
      parent: { name: "Theme.App.SplashScreen" },
    });
    return mod;
  });
}

module.exports = createRunOncePlugin(
  withAndroidSplashApiGuard,
  PLUGIN_NAME,
  "1.0.0",
);
