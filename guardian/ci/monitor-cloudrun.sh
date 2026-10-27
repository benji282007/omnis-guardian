#!/bin/sh
# Scheduled production check (every four hours) (scheduled `monitor_production` job, google/cloud-sdk:slim):
#   1. keyless Google Cloud login (same as deploy)
#   2. read the live Cloud Run service and its serving revision
#   3. fetch deploy-result.json from the last successful, approved deploy_production job
#      (by job id via last-deploy.mjs; the "latest artifact on main" URL would hit this schedule)
#   4. node guardian/ci/monitor.mjs: drift checks against the release and runtime-config.json,
#      plus the five live smoke probes. Writes monitor-result.json; exits 1 on any failure,
#      which fails the pipeline and triggers the Omnis Guardian Duo flow (incident triage).
set -eu
SERVICE="${CLOUD_RUN_SERVICE:-$(jq -r .service guardian/gcp/runtime-config.json)}"

. guardian/ci/gcp-auth.sh

gcloud run services describe "$SERVICE" --format=json > service.json
REVISION="$(jq -r '[(.status.traffic // [])[] | select((.percent // 0) == 100)][0].revisionName // empty' service.json)"
if [ -n "$REVISION" ]; then
  gcloud run revisions describe "$REVISION" --format=json > revision.json
else
  echo '{}' > revision.json
fi

node guardian/ci/last-deploy.mjs --out deploy-result.json

KUTT_ADMIN_PASSWORD="$(gcloud secrets versions access latest --secret=kutt-admin-password)"
export KUTT_ADMIN_PASSWORD KUTT_ADMIN_EMAIL="${KUTT_ADMIN_EMAIL:-admin@omnis-guardian.dev}"

node guardian/ci/monitor.mjs --service service.json --revision revision.json \
  --deploy deploy-result.json --config guardian/gcp/runtime-config.json --out monitor-result.json
