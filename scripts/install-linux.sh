#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/SilverioSG/qwengate.git"
BRANCH="native-local-mcp"
VALIDATED_BASE="1556912f938cc0f006303c84fa1fd7a9b84d27cf"

USER_NAME="${SUDO_USER:-$USER}"
USER_HOME="$(getent passwd "$USER_NAME" | cut -d: -f6)"
APP_DIR="${QWENGATE_DIR:-$USER_HOME/Apps/qwen-gate}"
BUN="$USER_HOME/.bun/bin/bun"
PORT="26405"

echo "======================================"
echo " QwenGate Linux installer"
echo "======================================"
echo "USER=$USER_NAME"
echo "HOME=$USER_HOME"
echo "APP_DIR=$APP_DIR"
echo

# 1. Prerequisites
for cmd in git curl jq python3; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "ERROR: falta dependencia: $cmd"
        echo "Instálala con el gestor de paquetes de tu distribución."
        exit 1
    fi
done

# 2. Bun
if [[ ! -x "$BUN" ]]; then
    echo "[2/10] Instalando Bun..."
    curl -fsSL https://bun.sh/install | bash
fi

export PATH="$USER_HOME/.bun/bin:$PATH"

echo "BUN=$("$BUN" --version)"

# 3. Clone / source validation
mkdir -p "$USER_HOME/Apps"

if [[ ! -d "$APP_DIR/.git" ]]; then
    echo "[3/10] Clonando QwenGate..."
    git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
else
    echo "[3/10] Repo ya existente: $APP_DIR"
fi

cd "$APP_DIR"

git fetch origin "$BRANCH"
git switch "$BRANCH"

HEAD_COMMIT="$(git rev-parse HEAD)"

if ! git merge-base --is-ancestor "$VALIDATED_BASE" HEAD; then
    echo "ERROR: la rama instalada no contiene el commit funcional validado."
    echo "VALIDATED_BASE=$VALIDATED_BASE"
    echo "HEAD=$HEAD_COMMIT"
    exit 1
fi

echo "VALIDATED_BASE_PRESENT=YES"
echo "HEAD=$HEAD_COMMIT"

# 4. Dependencies
echo "[4/10] Instalando dependencias..."
"$BUN" install --frozen-lockfile

# 5. Validation
echo "[5/10] Tests/build..."
"$BUN" test
"$BUN" x tsc --noEmit
"$BUN" run lint:check
"$BUN" run build

# 6. IPv4 bind
echo "[6/10] Configurando HOST=127.0.0.1..."

python3 - <<'PY'
import json
from pathlib import Path

p = Path("config.json")
cfg = json.loads(p.read_text())
cfg["HOST"] = "127.0.0.1"
p.write_text(json.dumps(cfg, indent=2) + "\n")
PY

# 7-8. systemd
echo "[7/10] Instalando servicio systemd..."

sudo tee /etc/systemd/system/qwen-gate.service >/dev/null <<EOF_SERVICE
[Unit]
Description=QwenGate OpenAI-compatible gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER_NAME
WorkingDirectory=$APP_DIR
Environment=HOME=$USER_HOME
Environment=PATH=$USER_HOME/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=$BUN start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF_SERVICE

sudo systemctl daemon-reload
sudo systemctl enable --now qwen-gate.service

echo "[8/10] Validando servicio..."

sleep 2

systemctl is-enabled qwen-gate.service
systemctl is-active qwen-gate.service

curl -fsS "http://127.0.0.1:$PORT/health" | jq .
curl -fsS "http://127.0.0.1:$PORT/v1/models" | jq .

# 9-10. Manual account setup
echo
echo "======================================"
echo " QWENGATE_INSTALLATION=PASS"
echo "======================================"
echo
echo "Servicio:"
echo "  qwen-gate.service"
echo
echo "API:"
echo "  http://127.0.0.1:$PORT/v1"
echo
echo "Dashboard:"
echo "  http://127.0.0.1:$PORT/dashboard/accounts"
echo
echo "SIGUIENTE PASO MANUAL:"
echo "  Abre el dashboard y añade las cuentas Qwen"
echo "  mediante Login/Add Account."
echo
echo "QwenGate validará las cuentas desde el propio dashboard."
echo
