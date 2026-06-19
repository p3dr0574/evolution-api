#!/usr/bin/env bash
# start-evo.sh — Sobe a Evolution local (rebuilda a imagem se --build for passado)
# Uso: ./Docker/dev/start-evo.sh [--build] [--no-cache]

set -euo pipefail

BUILD=false
NO_CACHE=""

for arg in "$@"; do
  case $arg in
    --build)    BUILD=true ;;
    --no-cache) NO_CACHE="--no-cache" ;;
  esac
done

if $BUILD; then
  echo "[evo] Buildando imagem evolution-api:local..."
  npm run build
  docker build $NO_CACHE -t evolution-api:local .
fi

docker rm -f evo_local 2>/dev/null || true

docker network create --driver bridge evo_dev_net 2>/dev/null || true

docker run -d --name evo_local \
  --network evo_dev_net -p 8081:8080 \
  -e SERVER_URL=http://192.168.0.101:8081 \
  -e DATABASE_PROVIDER=postgresql \
  -e "DATABASE_CONNECTION_URI=postgresql://postgres:ff2d47fae062ce9ba0cd978a12a3205c@192.168.0.101:5432/evolution_local" \
  -e DATABASE_CONNECTION_CLIENT_NAME=evolution_local \
  -e DATABASE_SAVE_DATA_INSTANCE=true \
  -e DATABASE_SAVE_DATA_NEW_MESSAGE=true \
  -e DATABASE_SAVE_MESSAGE_UPDATE=true \
  -e DATABASE_SAVE_DATA_CONTACTS=true \
  -e DATABASE_SAVE_DATA_CHATS=true \
  -e DATABASE_SAVE_DATA_HISTORIC=true \
  -e DATABASE_SAVE_DATA_LABELS=true \
  -e DATABASE_SAVE_IS_ON_WHATSAPP=true \
  -e DATABASE_SAVE_IS_ON_WHATSAPP_DAYS=7 \
  -e DATABASE_DELETE_MESSAGE=false \
  -e DATABASE_PRUNE_ENABLED=false \
  -e DEL_INSTANCE=false \
  -e CACHE_REDIS_ENABLED=true \
  -e "CACHE_REDIS_URI=redis://192.168.0.101:6379/8" \
  -e CACHE_REDIS_PREFIX_KEY=evolution_local \
  -e CACHE_REDIS_SAVE_INSTANCES=false \
  -e CACHE_LOCAL_ENABLED=false \
  -e RABBITMQ_ENABLED=false \
  -e SQS_ENABLED=false \
  -e WEBSOCKET_ENABLED=true \
  -e WEBHOOK_GLOBAL_ENABLED=false \
  -e WEBHOOK_DELIVERY_ENABLED=false \
  -e CHATWOOT_ENABLED=true \
  -e OPENAI_ENABLED=false \
  -e DIFY_ENABLED=false \
  -e TYPEBOT_ENABLED=false \
  -e AUTHENTICATION_API_KEY=local-dev-key-123 \
  -e AUTHENTICATION_EXPOSE_IN_FETCH_INSTANCES=true \
  -e LANGUAGE=pt-BR \
  -e "LOG_LEVEL=ERROR,WARN,DEBUG,INFO,LOG" \
  -e LOG_COLOR=true \
  -e LOG_BAILEYS=error \
  -e QRCODE_LIMIT=30 \
  evolution-api:local

echo "[evo] Aguardando Evolution subir..."
until curl -sf http://192.168.0.101:8081/ > /dev/null 2>&1; do
  sleep 2; echo -n "."
done
echo
echo "[evo] Evolution disponível em http://192.168.0.101:8081"
echo "[evo] API Key: local-dev-key-123"
