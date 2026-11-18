import express from "express";
// Import the CommonJS build explicitly so it shares the single `graphql`
// instance that `nexus` loads internally. Importing the ESM entry here creates
// a second module realm and GraphQL rejects schemas built by the other one.
import { graphql as executeGraphQL } from "graphql/index.js";
import { prisma } from "../lib/prisma.js";
import { createContext } from "./context.js";
import { schema } from "./schema.js";

export const graphqlRoutes = express.Router();

const PLAYGROUND_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>FlowFi GraphQL</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 2rem; }
      textarea { width: 100%; height: 12rem; font-family: monospace; }
      pre { background: #f5f5f5; padding: 1rem; overflow: auto; }
    </style>
  </head>
  <body>
    <h1>FlowFi GraphQL</h1>
    <textarea id="query">{ __schema { types { name } } }</textarea>
    <button id="run">Run</button>
    <pre id="result"></pre>
    <script>
      document.getElementById("run").addEventListener("click", async () => {
        const response = await fetch("/graphql", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: document.getElementById("query").value }),
        });
        document.getElementById("result").textContent = JSON.stringify(
          await response.json(),
          null,
          2,
        );
      });
    </script>
  </body>
</html>`;

async function execute(request: express.Request, response: express.Response): Promise<void> {
  const body = request.body ?? {};
  try {
    const result = await executeGraphQL({
      schema,
      source: typeof body.query === "string" ? body.query : "",
      variableValues: body.variables ?? null,
      operationName: body.operationName ?? undefined,
      contextValue: createContext(prisma),
    });
    response.status(200).json(result);
  } catch (error) {
    response.status(200).json({
      errors: [{ message: error instanceof Error ? error.message : "GraphQL execution failed" }],
    });
  }
}

graphqlRoutes.post("/", execute);

graphqlRoutes.get("/", (request: express.Request, response: express.Response) => {
  if (process.env.NODE_ENV === "production") {
    response.status(200).json({
      data: { message: "FlowFi GraphQL endpoint. Send queries via POST /graphql." },
    });
    return;
  }
  // The global CSP forbids inline scripts; relax it for the local playground only.
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
  );
  response.type("html").send(PLAYGROUND_HTML);
});
