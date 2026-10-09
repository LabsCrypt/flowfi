/**
 * OpenAPI "Try It Out" console (#1481).
 *
 * Embeds the live Swagger UI against the deployed backend's OpenAPI spec so
 * developers can execute real requests (against testnet/mock endpoints)
 * from the docs. Falls back to a static link when Swagger UI is unavailable.
 */
import React, { useEffect, useRef } from "react";

interface OpenApiConsoleProps {
  /** URL of the OpenAPI/Swagger JSON document. */
  specUrl: string;
}

declare global {
  interface Window {
    SwaggerUIBundle?: Record<string, unknown>;
  }
}

export default function OpenApiConsole({ specUrl }: OpenApiConsoleProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Load Swagger UI bundle lazily; the docs build stays fast and the
    // console only loads when a reader reaches this page.
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "https://unpkg.com/swagger-ui-dist@5/swagger-ui.css";
    document.head.appendChild(css);

    const script = document.createElement("script");
    script.src = "https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js";
    script.crossOrigin = "anonymous";
    script.onload = () => {
      if (window.SwaggerUIBundle && containerRef.current) {
        window.SwaggerUIBundle({
          url: specUrl,
          dom_id: "#openapi-console",
          deepLinking: true,
          tryItOutEnabled: true,
        });
      }
    };
    document.body.appendChild(script);

    return () => {
      css.remove();
      script.remove();
    };
  }, [specUrl]);

  return (
    <div>
      <div
        id="openapi-console"
        ref={containerRef}
        style={{ border: "1px solid #444", borderRadius: 12, padding: 8 }}
      >
        <p style={{ padding: 12 }}>
          Loading the interactive console… If it does not appear, open the
          spec directly:{" "}
          <a href={specUrl}>{specUrl}</a>
        </p>
      </div>
    </div>
  );
}
