#!/usr/bin/env bash
# Generates the disposable TLS fixture for the redis-tls compose service.
# A local CA and one server certificate with SANs for localhost and the
# compose service name. These are throwaway test artifacts, not secrets.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="docker/test-tls"
mkdir -p "$OUT"

openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
  -keyout "$OUT/ca.key" -out "$OUT/ca.crt" \
  -subj "/CN=azm-test-ca" >/dev/null 2>&1

openssl req -newkey rsa:2048 -nodes \
  -keyout "$OUT/server.key" -out "$OUT/server.csr" \
  -subj "/CN=redis-tls" >/dev/null 2>&1

cat > "$OUT/server.ext" <<'EXT'
subjectAltName=DNS:localhost,DNS:redis-tls,IP:127.0.0.1
EXT

openssl x509 -req -in "$OUT/server.csr" -CA "$OUT/ca.crt" -CAkey "$OUT/ca.key" \
  -CAcreateserial -days 2 -extfile "$OUT/server.ext" -out "$OUT/server.crt" >/dev/null 2>&1

rm -f "$OUT/server.csr" "$OUT/server.ext"
chmod 644 "$OUT/ca.crt" "$OUT/server.crt" "$OUT/server.key" "$OUT/ca.key"
echo "[gen-test-tls] fixture written to $OUT"
