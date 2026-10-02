#!/usr/bin/env bash
# Removes everything cloudrun.sh created. Destructive: deletes the Cloud SQL
# instance and its data. Asks before doing anything.
set -euo pipefail
: "${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-europe-west1}"
SQL_INSTANCE="${SQL_INSTANCE:-shop-pg}"
REPO="${REPO:-order-agent}"

read -r -p "Delete Cloud Run services, Cloud SQL instance '${SQL_INSTANCE}', images and secrets in ${PROJECT_ID}? [y/N] " ok
[ "$ok" = "y" ] || exit 1
gcloud config set project "$PROJECT_ID" >/dev/null
gcloud run services delete order-agent --region "$REGION" --quiet || true
gcloud run services delete shop-api --region "$REGION" --quiet || true
gcloud sql instances delete "$SQL_INSTANCE" --quiet || true
gcloud artifacts repositories delete "$REPO" --location "$REGION" --quiet || true
for s in shop-db-url shop-api-token shop-admin-token agent-token anthropic-api-key openai-api-key xai-api-key; do
  gcloud secrets delete "$s" --quiet 2>/dev/null || true
done
