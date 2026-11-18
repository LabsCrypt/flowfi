/**
 * OpenTelemetry SDK bootstrap.
 *
 * MUST be imported before any other module in the process: the auto-
 * instrumentations patch `http`, `express` and `pg` at require time, so
 * anything they wrap has to be loaded afterwards. `index.ts` imports this
 * module first, for that reason alone.
 *
 * Export configuration (all optional — with none set the SDK runs in-process
 * and simply drops spans, which is the right default for local development):
 *
 *  - `OTEL_SDK_DISABLED=true`         — skip initialisation entirely.
 *  - `OTEL_EXPORTER_OTLP_ENDPOINT`    — OTLP/HTTP traces endpoint.
 *  - `OTEL_SERVICE_NAME`              — service name (default `flowfi-backend`).
 */

// ES module imports are hoisted, so any `dotenv.config()` in the entrypoint's
// module body would run *after* this file. Load the env here to make sure the
// OTEL_* variables come from the same .env as everything else.
const { default: dotenv } = await import('dotenv');
dotenv.config();

if (process.env.OTEL_SDK_DISABLED !== 'true') {
  const { NodeSDK } = await import('@opentelemetry/sdk-node');
  const { getNodeAutoInstrumentations } = await import(
    '@opentelemetry/auto-instrumentations-node'
  );
  const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
  const { defaultResource, resourceFromAttributes } = await import(
    '@opentelemetry/resources'
  );
  const {
    ATTR_SERVICE_NAME,
    ATTR_SERVICE_VERSION,
    ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  } = await import('@opentelemetry/semantic-conventions');

  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const serviceName = process.env.OTEL_SERVICE_NAME ?? 'flowfi-backend';

  const sdk = new NodeSDK({
    resource: defaultResource().merge(
      resourceFromAttributes({
        [ATTR_SERVICE_NAME]: serviceName,
        [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? '1.0.0',
        [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: process.env.NODE_ENV ?? 'development',
      }),
    ),
    instrumentations: [
      getNodeAutoInstrumentations({
        // `fs` instrumentation is extremely noisy and offers no value here.
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
    // Only install a trace exporter when a collector is actually configured;
    // an undefined exporter would otherwise override the SDK default.
    ...(otlpEndpoint ? { traceExporter: new OTLPTraceExporter({ url: otlpEndpoint }) } : {}),
  });

  try {
    sdk.start();
  } catch (err) {
    // Telemetry must never prevent the API from booting.
    // eslint-disable-next-line no-console
    console.warn('[tracing] OpenTelemetry SDK failed to start; tracing disabled:', err);
  }

  process.once('SIGTERM', () => {
    void sdk.shutdown().catch(() => undefined);
  });
}
