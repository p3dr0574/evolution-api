#!/usr/bin/env bash
# setup-dev.sh — Sobe Evolution + Chatwoot local e configura a integração
# Uso: ./Docker/dev/setup-dev.sh [--reset]
#
# --reset  Derruba tudo, apaga os dados e recomeça do zero

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EVO_URL="http://192.168.0.101:8081"
EVO_APIKEY="local-dev-key-123"
EVO_INSTANCE="Pedro"
CW_URL="http://192.168.0.101:3000"
CW_ADMIN_EMAIL="admin@local.dev"
CW_ADMIN_PASSWORD="Admin@123456"
CW_ACCOUNT_NAME="Evolution Dev"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
log()  { echo -e "${GREEN}[setup]${NC} $*"; }
warn() { echo -e "${YELLOW}[setup]${NC} $*"; }
err()  { echo -e "${RED}[setup]${NC} $*" >&2; }

# ─── Reset ────────────────────────────────────────────────────────────────────
if [[ "${1:-}" == "--reset" ]]; then
  warn "Reset solicitado — derrubando Chatwoot e apagando volumes..."
  docker compose -f "$SCRIPT_DIR/chatwoot-local.yaml" down -v 2>/dev/null || true
  docker volume rm chatwoot_local_pg_data chatwoot_local_storage 2>/dev/null || true
  log "Reset concluído. Rodando setup do zero..."
  echo
fi

# ─── 1. Evolution ─────────────────────────────────────────────────────────────
log "Verificando Evolution em $EVO_URL..."
if ! curl -sf "$EVO_URL/" -H "apikey: $EVO_APIKEY" > /dev/null 2>&1; then
  warn "Evolution não está respondendo em $EVO_URL."
  warn "Suba a Evolution primeiro:  ./Docker/dev/start-evo.sh"
  warn "Continuando com o setup do Chatwoot de qualquer forma..."
fi

# ─── 2. Chatwoot ─────────────────────────────────────────────────────────────
log "Iniciando Chatwoot v4.13.0..."
docker compose -f "$SCRIPT_DIR/chatwoot-local.yaml" up -d

# ─── 3. Aguarda o container web estar de pé ───────────────────────────────────
log "Aguardando Chatwoot subir (pode levar ~2min na primeira vez — DB prepare + migrations)..."
WAITED=0
until curl -sf "$CW_URL/auth/sign_in" > /dev/null 2>&1; do
  sleep 3; WAITED=$((WAITED + 3))
  if (( WAITED > 240 )); then
    err "Timeout esperando Chatwoot. Verifique: docker compose -f Docker/dev/chatwoot-local.yaml logs"
    exit 1
  fi
  echo -n "."
done
echo; log "Chatwoot respondendo!"

# ─── 4. Pega o container web ─────────────────────────────────────────────────
CW_WEB=$(docker compose -f "$SCRIPT_DIR/chatwoot-local.yaml" ps -q chatwoot_web)

# ─── 5. Cria SuperAdmin ──────────────────────────────────────────────────────
log "Criando superadmin $CW_ADMIN_EMAIL..."
docker exec "$CW_WEB" sh -c "
  bundle exec rails runner '
    unless SuperAdmin.exists?(email: \"$CW_ADMIN_EMAIL\")
      SuperAdmin.create!(name: \"Admin Local\", email: \"$CW_ADMIN_EMAIL\", password: \"$CW_ADMIN_PASSWORD\", password_confirmation: \"$CW_ADMIN_PASSWORD\")
      puts \"SuperAdmin criado\"
    else
      puts \"SuperAdmin já existe\"
    end
  '
"

# ─── 6b. Cria Account + User regular via Rails (login API não funciona com SuperAdmin) ──
log "Criando conta '$CW_ACCOUNT_NAME' e usuário regular..."
cat > /tmp/cw_setup.rb << RUBY
account = Account.find_by(name: '$CW_ACCOUNT_NAME') ||
          Account.create!(name: '$CW_ACCOUNT_NAME', locale: :pt_BR)

user = User.find_by(email: '$CW_ADMIN_EMAIL')
unless user
  user = User.new(
    name: 'Admin Local',
    email: '$CW_ADMIN_EMAIL',
    password: '$CW_ADMIN_PASSWORD',
    password_confirmation: '$CW_ADMIN_PASSWORD'
  )
  user.skip_confirmation!
  user.save!
end

# Confirma o email caso esteja pendente (ex: SuperAdmin criado sem confirmação)
unless user.confirmed?
  user.update_columns(confirmed_at: Time.current, confirmation_token: nil)
end

unless AccountUser.exists?(account: account, user: user)
  AccountUser.create!(account: account, user: user, role: :administrator)
end

puts 'ACCOUNT_ID=' + account.id.to_s
token = user.access_token&.token || user.reload.access_token&.token
puts 'USER_TOKEN=' + token.to_s
RUBY

docker cp /tmp/cw_setup.rb "$CW_WEB":/tmp/cw_setup.rb
SETUP_RESULT=$(docker exec "$CW_WEB" bundle exec rails runner /tmp/cw_setup.rb 2>/dev/null)

CW_ACCOUNT_ID=$(echo "$SETUP_RESULT" | grep "ACCOUNT_ID=" | cut -d= -f2)
CW_USER_TOKEN=$(echo "$SETUP_RESULT" | grep "USER_TOKEN=" | cut -d= -f2)

if [[ -z "$CW_ACCOUNT_ID" || -z "$CW_USER_TOKEN" ]]; then
  err "Falha ao criar conta/usuário. Output: $SETUP_RESULT"
  exit 1
fi
log "Account ID: $CW_ACCOUNT_ID"
log "User token: ${CW_USER_TOKEN:0:12}..."

# ─── 7. Faz login para confirmar ─────────────────────────────────────────────
log "Confirmando login via API..."
LOGIN_RESP=$(curl -sf -X POST "$CW_URL/auth/sign_in" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$CW_ADMIN_EMAIL\",\"password\":\"$CW_ADMIN_PASSWORD\"}" 2>/dev/null || echo "{}")

CW_TOKEN_API=$(echo "$LOGIN_RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('data',{}).get('access_token',''))" 2>/dev/null || echo "")

if [[ -n "$CW_TOKEN_API" ]]; then
  CW_USER_TOKEN="$CW_TOKEN_API"
  log "Login confirmado via API!"
else
  warn "Login API falhou, usando token do Rails diretamente"
fi

# ─── 10. Configura Evolution → Chatwoot ──────────────────────────────────────
log "Configurando Chatwoot na instância '$EVO_INSTANCE' da Evolution..."
EVO_SET=$(curl -sf -X POST "$EVO_URL/chatwoot/set/$EVO_INSTANCE" \
  -H "apikey: $EVO_APIKEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"enabled\": true,
    \"accountId\": \"$CW_ACCOUNT_ID\",
    \"token\": \"$CW_USER_TOKEN\",
    \"url\": \"$CW_URL\",
    \"signMsg\": false,
    \"reopenConversation\": true,
    \"conversationPending\": false,
    \"importContacts\": true,
    \"importMessages\": false,
    \"daysLimitImportMessages\": 0,
    \"organization\": \"$CW_ACCOUNT_NAME\",
    \"logo\": \"\",
    \"ignoreJids\": [],
    \"autoCreate\": true
  }" 2>/dev/null || echo "{}")

log "Resposta Evolution: $(echo $EVO_SET | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('enabled','?'))" 2>/dev/null)"

# ─── Resumo ───────────────────────────────────────────────────────────────────
echo
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Setup concluído!${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "  Chatwoot:  ${YELLOW}$CW_URL${NC}"
echo -e "  Login:     ${YELLOW}$CW_ADMIN_EMAIL${NC} / ${YELLOW}$CW_ADMIN_PASSWORD${NC}"
echo -e "  Account:   ${YELLOW}$CW_ACCOUNT_ID${NC}"
echo -e "  Evolution: ${YELLOW}$EVO_URL${NC}  (instância: $EVO_INSTANCE)"
echo -e "  API Key:   ${YELLOW}$EVO_APIKEY${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo
log "Para parar o Chatwoot:  docker compose -f Docker/dev/chatwoot-local.yaml down"
log "Para resetar tudo:      ./Docker/dev/setup-dev.sh --reset"
