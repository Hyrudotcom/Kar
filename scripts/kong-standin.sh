#!/usr/bin/env bash
# Runs scripts/dev-gateway.mjs as a stand-in for the local stack's Kong container when the kong image
# cannot be pulled. It joins the stack's docker network under Kong's container name, so GoTrue can
# fetch the e-mail templates from it (http://supabase_kong_<project>:8088/email/...), and publishes the
# API on 127.0.0.1:54321 like Kong. `npx supabase stop` removes it with the rest of the stack.
# Reuses an image the stack already has that contains node (storage-api).
#   npx supabase start --ignore-health-check -x kong,studio,imgproxy,storage-api,logflare,vector,edge-runtime,supavisor,postgres-meta
#   scripts/kong-standin.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="${GB_PROJECT_ID:-kar}"
NAME="supabase_kong_${PROJECT}"
IMAGE="${GB_STANDIN_IMAGE:-$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -m1 'supabase/storage-api')}"
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" \
  --network "supabase_network_${PROJECT}" --network-alias kong \
  --label "com.supabase.cli.project=${PROJECT}" \
  -p 54321:8000 \
  -e GB_GATEWAY_DNS=1 -e GB_TEMPLATES_DIR=/templates \
  -v "$ROOT/scripts/dev-gateway.mjs:/gateway.mjs:ro" -v "$ROOT/supabase/templates:/templates:ro" \
  --entrypoint node "$IMAGE" /gateway.mjs 8000 >/dev/null
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:54321/rest-admin/v1/ready >/dev/null 2>&1; then
    # GoTrue caches the e-mail templates it failed to fetch while Kong was missing: restart it so the
    # Dutch 6-digit code template (supabase/templates/otp.html) is used.
    docker restart "supabase_auth_${PROJECT}" >/dev/null
    for _ in $(seq 1 60); do
      if curl -fsS http://127.0.0.1:54321/auth/v1/health >/dev/null 2>&1; then echo "kong stand-in up on :54321 ($IMAGE)"; exit 0; fi
      sleep 0.5
    done
    echo "auth did not come back" >&2
    exit 1
  fi
  sleep 0.5
done
docker logs "$NAME" >&2
exit 1
