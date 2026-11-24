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
// libpq service files are plain `key=value` lines: values are taken verbatim
// (only surrounding whitespace is trimmed) and quotes are NOT stripped, so
// quoting them would make libpq read e.g. port as the literal "'5432'".
// Newlines are rejected above, which is the only way to break out of a line.
for (const [key, value] of entries) {
  if (value !== value.trim()) throw new Error(`PostgreSQL ${key} must not have leading/trailing whitespace`);
}
const contents = `[flowfi_backup]\n${entries.map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
writeFileSync(output, contents, { mode: 0o600, flag: "wx" });