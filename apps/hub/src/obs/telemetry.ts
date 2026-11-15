/**
 * OpenTelemetry for the hub (decision 0021), on the official `@opentelemetry/*`
 * packages and the GenAI semantic conventions.
 *
 * - A `TracerProvider` always runs, so every turn, model call, tool call and
 *   tool RPC has a real W3C trace id and span id: the trajectory records them
 *   and the tool RPC carries them to the box (`traceparent`, protocol 1.2).
 * - **Export is off by default.** Spans and metrics leave the hub only when
 *   `OTEL_EXPORTER_OTLP_ENDPOINT` (or the per-signal
 *   `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`) is set; any
 *   OTLP/HTTP backend works (Jaeger, Grafana, Langfuse, Phoenix). Without
 *   one, ended spans go nowhere.
 * - Spans carry ids, names, models, token counts and timings, never message
 *   text, tool arguments or tool output (the GenAI content attributes are
 *   opt-in and Hearth does not opt in), and every string attribute and status
 *   message passes through the hub's redactor before it is set.
 */

import { formatTraceparent } from "@hearth/protocol";
import {
  type Attributes,
  type Context,
  context,
  type Span,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  MeterProvider,
  type MetricReader,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
} from "@opentelemetry/sdk-metrics";
import {
  BatchSpanProcessor,
  type SpanExporter,
  type SpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import {
  METRIC_GEN_AI_CLIENT_OPERATION_DURATION,
  METRIC_GEN_AI_CLIENT_TOKEN_USAGE,
} from "@opentelemetry/semantic-conventions/incubating";

export const HUB_SERVICE_NAME = "hearth-hub";

/** How long `shutdown()` waits for the last export. */
export const SHUTDOWN_TIMEOUT_MS = 5_000;

export interface ShutdownResult {
  readonly ok: boolean;
  readonly error?: string;
}

export interface TelemetryOptions {
  readonly serviceVersion?: string;
  /** Span exporter (an OTLP one from `telemetryFromEnv`, or a test's). None: no export. */
  readonly spanExporter?: SpanExporter;
  /** Metric exporter; none: metrics are recorded but never leave the hub. */
  readonly metricExporter?: PushMetricExporter;
  readonly metricIntervalMs?: number;
  /** Redacts string attributes and status messages. */
  readonly redact?: (text: string) => string;
}

/** The hub's instruments (issue #80, "Metrics"). */
export interface HubMetrics {
  /** `gen_ai.client.token.usage`, by `gen_ai.token.type` (input/output). */
  readonly tokenUsage: ReturnType<ReturnType<MeterProvider["getMeter"]>["createHistogram"]>;
  /** `gen_ai.client.operation.duration`, seconds per model call. */
  readonly modelDuration: ReturnType<ReturnType<MeterProvider["getMeter"]>["createHistogram"]>;
  readonly cost: ReturnType<ReturnType<MeterProvider["getMeter"]>["createCounter"]>;
  readonly turns: ReturnType<ReturnType<MeterProvider["getMeter"]>["createCounter"]>;
  readonly toolCalls: ReturnType<ReturnType<MeterProvider["getMeter"]>["createCounter"]>;
  readonly toolFailures: ReturnType<ReturnType<MeterProvider["getMeter"]>["createCounter"]>;
  /** Time a tool call waited for its box lease: box start or wake latency. */
  readonly boxWait: ReturnType<ReturnType<MeterProvider["getMeter"]>["createHistogram"]>;
}

export class Telemetry {
  readonly exporting: boolean;
  readonly metrics: HubMetrics;
  readonly #tracerProvider: TracerProvider;
  readonly #meterProvider: MeterProvider;
  readonly #redact: (text: string) => string;

  constructor(options: TelemetryOptions = {}) {
    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: HUB_SERVICE_NAME,
      ...(options.serviceVersion === undefined
        ? {}
        : { [ATTR_SERVICE_VERSION]: options.serviceVersion }),
    });
    const spanProcessors: SpanProcessor[] =
      options.spanExporter === undefined
        ? []
        : [new BatchSpanProcessor({ exporter: options.spanExporter })];
    this.#tracerProvider = new TracerProvider({ resource, spanProcessors });
    const readers: MetricReader[] =
      options.metricExporter === undefined
        ? []
        : [
            new PeriodicExportingMetricReader({
              exporter: options.metricExporter,
              exportIntervalMillis: options.metricIntervalMs ?? 60_000,
            }),
          ];
    this.#meterProvider = new MeterProvider({ resource, readers });
    this.exporting = options.spanExporter !== undefined || options.metricExporter !== undefined;
    this.#redact = options.redact ?? ((t) => t);
    const meter = this.#meterProvider.getMeter("hearth-hub");
    this.metrics = {
      tokenUsage: meter.createHistogram(METRIC_GEN_AI_CLIENT_TOKEN_USAGE, { unit: "{token}" }),
      modelDuration: meter.createHistogram(METRIC_GEN_AI_CLIENT_OPERATION_DURATION, { unit: "s" }),
      cost: meter.createCounter("hearth.model.cost", { unit: "USD" }),
      turns: meter.createCounter("hearth.turns", { unit: "{turn}" }),
      toolCalls: meter.createCounter("hearth.tool.calls", { unit: "{call}" }),
      toolFailures: meter.createCounter("hearth.tool.failures", { unit: "{call}" }),
      boxWait: meter.createHistogram("hearth.box.wait.duration", { unit: "s" }),
    };
  }

  /** Start a span; `parent` is a span or nothing (a new trace). */
  startSpan(name: string, attributes: Attributes, parent?: Span, startTime?: number): Span {
    const ctx: Context =
      parent === undefined ? context.active() : trace.setSpan(context.active(), parent);
    return this.#tracerProvider
      .getTracer("hearth-hub")
      .startSpan(
        name,
        { attributes: this.#clean(attributes), ...(startTime === undefined ? {} : { startTime }) },
        ctx,
      );
  }

  /** End `span`, marking it failed with a redacted message when `error` is set. */
  endSpan(
    span: Span,
    attributes: Attributes = {},
    error?: { type: string; message: string },
  ): void {
    span.setAttributes(this.#clean(attributes));
    if (error !== undefined) {
      span.setAttribute("error.type", error.type);
      span.setStatus({ code: SpanStatusCode.ERROR, message: this.#redact(error.message) });
    }
    span.end();
  }

  #clean(attributes: Attributes): Attributes {
    const out: Attributes = {};
    for (const [k, v] of Object.entries(attributes)) {
      if (v === undefined) continue;
      out[k] = typeof v === "string" ? this.#redact(v) : v;
    }
    return out;
  }

  async flush(): Promise<void> {
    await this.#tracerProvider.forceFlush();
    await this.#meterProvider.forceFlush();
  }

  /**
   * Flush and stop export. Never rejects and never waits more than
   * `timeoutMs`: a collector that is down or hangs must not keep the hub from
   * exiting. Says whether everything was exported.
   */
  async shutdown(timeoutMs = SHUTDOWN_TIMEOUT_MS): Promise<ShutdownResult> {
    const run = Promise.allSettled([
      this.#tracerProvider.shutdown(),
      this.#meterProvider.shutdown(),
    ]).then((results): ShutdownResult => {
      const failed = results.find((r) => r.status === "rejected");
      return failed === undefined ? { ok: true } : { ok: false, error: String(failed.reason) };
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const result = await Promise.race([run, timeout]);
    clearTimeout(timer);
    return result === "timeout"
      ? { ok: false, error: `telemetry shutdown took longer than ${timeoutMs} ms` }
      : result;
  }
}

/** The ids of a span, as the trajectory and the tool RPC carry them. */
export function spanIds(span: Span): { traceId: string; spanId: string; traceparent: string } {
  const c = span.spanContext();
  return {
    traceId: c.traceId,
    spanId: c.spanId,
    traceparent: formatTraceparent({ traceId: c.traceId, spanId: c.spanId, flags: c.traceFlags }),
  };
}

type Env = Readonly<Record<string, string | undefined>>;

function signalUrl(env: Env, signal: "traces" | "metrics"): string | undefined {
  const specific = env[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_ENDPOINT`];
  if (specific !== undefined && specific !== "") return specific;
  const base = env["OTEL_EXPORTER_OTLP_ENDPOINT"];
  if (base === undefined || base === "") return undefined;
  return `${base.replace(/\/+$/, "")}/v1/${signal}`;
}

/**
 * Telemetry from the standard OpenTelemetry variables. Nothing is exported
 * unless an OTLP endpoint is set; `OTEL_SDK_DISABLED=true` turns export off
 * even then. Headers (`OTEL_EXPORTER_OTLP_HEADERS`) are read by the exporter.
 */
export function telemetryFromEnv(
  env: Env,
  options: Omit<TelemetryOptions, "spanExporter" | "metricExporter"> = {},
): Telemetry {
  const disabled = env["OTEL_SDK_DISABLED"] === "true";
  const traces = disabled ? undefined : signalUrl(env, "traces");
  const metrics = disabled ? undefined : signalUrl(env, "metrics");
  return new Telemetry({
    ...options,
    ...(traces === undefined ? {} : { spanExporter: new OTLPTraceExporter({ url: traces }) }),
    ...(metrics === undefined ? {} : { metricExporter: new OTLPMetricExporter({ url: metrics }) }),
  });
}
