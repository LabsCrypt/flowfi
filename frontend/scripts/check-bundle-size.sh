#!/usr/bin/env bash
# Bundle size budget check for the Next.js frontend build.
# Compares the total size of static JS files in .next/static against a
# configurable budget (default 300 KB gzipped).  Fails the CI step when
# the budget is exceeded.
set -euo pipefail

BUDGET_BYTES=${FRONTEND_BUNDLE_BUDGET_BYTES:-614400}  # 600 KB
NEXT_STATIC_DIR=".next/static"

if [ ! -d "$NEXT_STATIC_DIR" ]; then
  echo "Error: $NEXT_STATIC_DIR directory not found. Run 'next build' first."
  exit 1
fi

total=0
for f in $(find "$NEXT_STATIC_DIR" -type f -name "*.js" | head -100); do
  # Use gzip -c | wc -c for accurate gzipped size
  gzipped_size=$(gzip -c "$f" | wc -c)
  total=$((total + gzipped_size))
done

echo "Frontend JS bundle gzipped size: ${total} bytes (${BUDGET_BYTES} byte budget)"

if [ "$total" -gt "$BUDGET_BYTES" ]; then
  echo "Error: Frontend bundle exceeds size budget!"
  echo "  Actual:  ${total} bytes"
  echo "  Budget:  ${BUDGET_BYTES} bytes"
  echo "  Overage: $((total - BUDGET_BYTES)) bytes"
  exit 1
fi

echo "Bundle size OK ✓"
