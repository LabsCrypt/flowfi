#!/usr/bin/env node
import { writeFileSync } from "node:fs";

const output = process.argv[2];
if (!output) throw new Error("Usage: pg-service.mjs <output-file>");
const url = new URL(process.env.DATABASE_URL ?? "");
if (!/^postgres(?:ql)?:$/.test(url.protocol)) throw new Error("DATABASE_URL must use the PostgreSQL protocol");
const params = url.searchParams;
params.delete("schema");
const entries = [
  ["host", url.hostname],
  ["port", url.port || "5432"],
  ["dbname", decodeURIComponent(url.pathname.replace(/^\//, ""))],
  ["user", decodeURIComponent(url.username)],
  ["password", decodeURIComponent(url.password)],
];
const sslmode = params.get("sslmode");
if (sslmode) entries.push(["sslmode", sslmode]);
for (const [key, value] of entries) {
  if (/[\r\n]/.test(value)) throw new Error(`Invalid newline in PostgreSQL ${key}`);
}
const escape = (value) => `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
const contents = `[flowfi_backup]\n${entries.map(([key, value]) => `${key}=${escape(value)}`).join("\n")}\n`;
writeFileSync(output, contents, { mode: 0o600, flag: "wx" });