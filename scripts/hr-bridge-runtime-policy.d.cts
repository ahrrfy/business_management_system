declare const policy: Readonly<{
  pm2Version: string;
  startupTimeoutMs: number;
  databaseReadinessTimeoutMs: number;
  tcpListenTimeoutMs: number;
  pm2ListenTimeoutMs: number;
  runtimeGateTimeoutMs: number;
  runtimeStableSamples: number;
  runtimeSampleIntervalMs: number;
  shutdownTimeoutMs: number;
  pm2KillTimeoutMs: number;
  minUptimeMs: number;
  disabledExitCode: number;
  allowedEnvironmentKeys: readonly string[];
  pm2EnvironmentMetadataKeys: readonly string[];
}>;

export = policy;
