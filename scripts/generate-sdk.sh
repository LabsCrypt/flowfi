#!/usr/bin/env bash
#
# Generate the FlowFi typed SDK client (packages/flowfi-sdk) from the committed
# OpenAPI spec (backend/swagger/flowfi.openapi.json) using openapi-generator.
#
#   ./scripts/generate-sdk.sh
#
# Requires Java 8+ (or a JRE available in PATH) on the first run so it can
# launch the OpenAPI Generator. npx will download a pinned generator JAR
# automatically.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SPEC_PATH="${SPEC_PATH:-$ROOT/backend/swagger/flowfi.openapi.json}"
OUT_DIR="$ROOT/packages/flowfi-sdk"
GENERATOR_VERSION="${OPENAPI_GENERATOR_VERSION:-7.11.0}"

if [[ ! -f "$SPEC_PATH" ]]; then
  echo "Error: OpenAPI spec not found at $SPEC_PATH"
  echo "Re-export it first with: cd backend && npm run codegen:openapi"
  exit 1
fi

mkdir -p "$OUT_DIR"
echo "Generating typed SDK from $SPEC_PATH into $OUT_DIR ..."
npx --yes "@openapitools/openapi-generator-cli@v${GENERATOR_VERSION}" generate \
  -i "$SPEC_PATH" \
  -g typescript-fetch \
  -o "$OUT_DIR" \
  --additional-properties=useSingleRequestParameter=true,supportsES6=true,modelPropertyNaming=original,enumPropertyNaming=original,withSeparateModelsAndApi=true,apiPackage=api,modelPackage=models

echo "SDK regeneration complete -> $OUT_DIR"
echo "Next: cd packages/flowfi-sdk && npm install && npm run build"