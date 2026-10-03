import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const CERT_DIR = path.join(__dirname, ".e2e-certs");
const CERT_PATH = path.join(CERT_DIR, "cert.pem");
const KEY_PATH = path.join(CERT_DIR, "key.pem");

export default function globalSetup() {
  if (fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH)) {
    return;
  }
  fs.mkdirSync(CERT_DIR, { recursive: true });
  execSync(
    [
      "openssl req -x509 -newkey rsa:2048 -nodes",
      `-keyout ${KEY_PATH}`,
      `-out ${CERT_PATH}`,
      "-days 3650",
      '-subj "/CN=localhost"',
      '-addext "subjectAltName=DNS:localhost,IP:127.0.0.1"',
    ].join(" "),
    { stdio: "pipe" },
  );
}