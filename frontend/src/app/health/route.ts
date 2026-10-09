/**
 * Lightweight liveness endpoint used by the container HEALTHCHECK
 * (issue #1335). Intentionally dependency-free so it stays fast and always
 * available, even while other routes are still warming up.
 */
export function GET() {
  return Response.json({ status: "ok" });
}
