#!/usr/bin/env bash
# Deploys the shop API and the agent to Cloud Run, with Postgres on Cloud SQL.
# Idempotent: safe to re-run after code changes. Run from the repo root, in
# Cloud Shell or anywhere with an authenticated gcloud:
#
#   PROJECT_ID=my-project ./deploy/cloudrun.sh
#
# Provider keys are read from your shell (ANTHROPIC_API_KEY, OPENAI_API_KEY,
# XAI_API_KEY) and stored in Secret Manager; nothing secret is written to disk.
# Cost note: Cloud SQL db-f1-micro is billed while it exists (~USD 10/month).
# Tear down with ./deploy/teardown.sh.
set -euo pipefail

: "${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-europe-west1}"
SQL_INSTANCE="${SQL_INSTANCE:-shop-pg}"
REPO="${REPO:-order-agent}"
DEFAULT_PROVIDER="${DEFAULT_PROVIDER:-anthropic}"
SA_NAME="order-agent-runtime"
SA="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
IMAGES="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}"

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
gcloud config set project "$PROJECT_ID" >/dev/null

log "Enabling APIs"
gcloud services enable run.googleapis.com sqladmin.googleapis.com artifactregistry.googleapis.com \
  cloudbuild.googleapis.com secretmanager.googleapis.com

log "Artifact Registry"
gcloud artifacts repositories describe "$REPO" --location "$REGION" >/dev/null 2>&1 ||
  gcloud artifacts repositories create "$REPO" --repository-format docker --location "$REGION"

log "Runtime service account"
gcloud iam service-accounts describe "$SA" >/dev/null 2>&1 ||
  gcloud iam service-accounts create "$SA_NAME" --display-name "order agent runtime"
for role in roles/cloudsql.client roles/secretmanager.secretAccessor; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:$SA" --role "$role" --condition None >/dev/null
done

# put_secret NAME VALUE: creates the secret or adds a version if the value changed.
put_secret() {
  if ! gcloud secrets describe "$1" >/dev/null 2>&1; then
    printf '%s' "$2" | gcloud secrets create "$1" --data-file - --replication-policy automatic >/dev/null
  elif [ "$(gcloud secrets versions access latest --secret "$1" 2>/dev/null)" != "$2" ]; then
    printf '%s' "$2" | gcloud secrets versions add "$1" --data-file - >/dev/null
  fi
}
# ensure_random_secret NAME: generated once, then reused.
ensure_random_secret() {
  gcloud secrets describe "$1" >/dev/null 2>&1 || put_secret "$1" "$(openssl rand -hex 24)"
}

log "Cloud SQL (Postgres 17, db-f1-micro)"
if ! gcloud sql instances describe "$SQL_INSTANCE" >/dev/null 2>&1; then
  gcloud sql instances create "$SQL_INSTANCE" --database-version POSTGRES_17 --edition ENTERPRISE \
    --tier db-f1-micro --region "$REGION" --storage-size 10
fi
gcloud sql databases describe shop --instance "$SQL_INSTANCE" >/dev/null 2>&1 ||
  gcloud sql databases create shop --instance "$SQL_INSTANCE"
CONN="$(gcloud sql instances describe "$SQL_INSTANCE" --format 'value(connectionName)')"
if ! gcloud secrets describe shop-db-url >/dev/null 2>&1; then
  DB_PASS="$(openssl rand -hex 20)"
  gcloud sql users set-password postgres --instance "$SQL_INSTANCE" --password "$DB_PASS"
  put_secret shop-db-url "postgres://postgres:${DB_PASS}@/shop?host=/cloudsql/${CONN}"
fi

log "Secrets"
ensure_random_secret shop-api-token
ensure_random_secret shop-admin-token
ensure_random_secret agent-token
PROVIDER_SECRETS=""
for pair in ANTHROPIC_API_KEY:anthropic-api-key OPENAI_API_KEY:openai-api-key XAI_API_KEY:xai-api-key; do
  var="${pair%%:*}"; secret="${pair##*:}"
  if [ -n "${!var:-}" ]; then put_secret "$secret" "${!var}"; fi
  if gcloud secrets describe "$secret" >/dev/null 2>&1; then PROVIDER_SECRETS+=",${var}=${secret}:latest"; fi
done

log "Building images"
TAG="$(git rev-parse --short HEAD 2>/dev/null || date +%s)"
gcloud builds submit api --tag "${IMAGES}/api:${TAG}"
gcloud builds submit agent --tag "${IMAGES}/agent:${TAG}"

log "Deploying shop-api"
gcloud run deploy shop-api --image "${IMAGES}/api:${TAG}" --region "$REGION" \
  --service-account "$SA" --add-cloudsql-instances "$CONN" \
  --set-secrets DATABASE_URL=shop-db-url:latest,API_TOKEN=shop-api-token:latest,ADMIN_TOKEN=shop-admin-token:latest \
  --set-env-vars ALLOW_RESET="${ALLOW_RESET:-false}" \
  --allow-unauthenticated --min-instances 0 --max-instances 2 --memory 256Mi
API_URL="$(gcloud run services describe shop-api --region "$REGION" --format 'value(status.url)')"

log "Deploying order-agent"
gcloud run deploy order-agent --image "${IMAGES}/agent:${TAG}" --region "$REGION" \
  --service-account "$SA" \
  --set-env-vars "SHOP_API_URL=${API_URL},TRACE_STDOUT=1,TRACE_DIR=off,DEFAULT_PROVIDER=${DEFAULT_PROVIDER}" \
  --set-secrets "SHOP_API_TOKEN=shop-api-token:latest,AGENT_TOKEN=agent-token:latest${PROVIDER_SECRETS}" \
  --allow-unauthenticated --min-instances 0 --max-instances 2 --memory 512Mi --timeout 120
AGENT_URL="$(gcloud run services describe order-agent --region "$REGION" --format 'value(status.url)')"

cat <<EOF

Deployed.
  Agent demo page : ${AGENT_URL}
  Shop API        : ${API_URL}/graphql
  Agent token     : gcloud secrets versions access latest --secret agent-token
  Traces          : Cloud Logging, jsonPayload.message="agent_run"

  curl -s ${AGENT_URL}/v1/tickets -H "authorization: Bearer \$(gcloud secrets versions access latest --secret agent-token)" \\
    -H 'content-type: application/json' -d '{"customerEmail":"alice@example.com","message":"Where is SM-1001?"}'
EOF
