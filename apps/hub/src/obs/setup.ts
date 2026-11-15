/**
 * Observability config from the environment (decision 0021), kept out of
 * `main.ts`:
 *
 * - `HEARTH_LOG_LEVEL`: `debug`, `info` (default), `warn`, `error`. Logs are
 *   JSON lines on stderr, redacted at the sink.
 * - `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` /
 *   `..._METRICS_ENDPOINT`), `OTEL_EXPORTER_OTLP_HEADERS`,
 *   `OTEL_SDK_DISABLED`: the standard OpenTelemetry variables. Unset: no
 *   export, nothing leaves the hub.
 */

import { Logger, parseLogLevel } from "@hearth/core";
import { redactHub } from "./redaction";
import { type Telemetry, telemetryFromEnv } from "./telemetry";
import { HUB_VERSION } from "./version";

export interface Observability {
  readonly logger: Logger;
  readonly telemetry: Telemetry;
}

export function observabilityFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  sink?: (line: string) => void,
): Observability {
  const logger = new Logger({
    component: "hub",
    level: parseLogLevel(env["HEARTH_LOG_LEVEL"]),
    redact: redactHub,
    ...(sink === undefined ? {} : { sink }),
  });
  const telemetry = telemetryFromEnv(env, { serviceVersion: HUB_VERSION, redact: redactHub });
  return { logger, telemetry };
}
