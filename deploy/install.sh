#!/usr/bin/env bash
# Устанавливает мост CC Pocket (форк) как системную службу за nginx с TLS.
# Запускать от root на сервере, где лежит /root/ccpocket и выполнен вход в claude.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE=/etc/ccpocket-bridge.env
PUBLIC_WS_URL="${PUBLIC_WS_URL:-wss://167.104.102.253:8766}"

if [ ! -f "$HERE/../packages/bridge/dist/index.js" ]; then
  echo "Мост не собран. Выполните: cd /root/ccpocket && npm install --no-audit --no-fund && npm run bridge:build" >&2
  exit 1
fi

echo "==> nginx: конфиг порта 8766"
install -m 644 "$HERE/nginx-ccpocket-bridge.conf" /etc/nginx/sites-available/ccpocket-bridge
ln -sf /etc/nginx/sites-available/ccpocket-bridge /etc/nginx/sites-enabled/ccpocket-bridge
# Порт 80 нужен acme.sh для продления сертификата на IP, дефолтный сайт nginx там лишний.
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

echo "==> файл окружения $ENV_FILE"
if [ ! -f "$ENV_FILE" ]; then
  KEY="$(openssl rand -hex 24)"
  umask 077
  cat > "$ENV_FILE" <<EOF
HOME=/root
PATH=/usr/local/bin:/usr/bin:/bin
BRIDGE_HOST=127.0.0.1
BRIDGE_PORT=8765
BRIDGE_API_KEY=$KEY
BRIDGE_PUBLIC_WS_URL=$PUBLIC_WS_URL
BRIDGE_DISABLE_MDNS=1
BRIDGE_ALLOW_CLAUDE_OAUTH=1
BRIDGE_ALLOWED_DIRS=/root
BRIDGE_IDLE_SESSION_TTL_MINUTES=30
EOF
  umask 022
  echo "    создан, ключ доступа сгенерирован"
else
  echo "    уже есть, оставлен как есть"
fi

echo "==> systemd: служба моста и перезагрузка nginx при продлении сертификата"
install -m 644 "$HERE/ccpocket-bridge.service" /etc/systemd/system/ccpocket-bridge.service
install -m 644 "$HERE/ccpocket-nginx-reload.path" /etc/systemd/system/ccpocket-nginx-reload.path
install -m 644 "$HERE/ccpocket-nginx-reload.service" /etc/systemd/system/ccpocket-nginx-reload.service
systemctl daemon-reload
systemctl enable --now ccpocket-nginx-reload.path
systemctl enable ccpocket-bridge
systemctl restart ccpocket-bridge
sleep 5
systemctl --no-pager --lines=0 status ccpocket-bridge | head -5

KEY="$(sed -n 's/^BRIDGE_API_KEY=//p' "$ENV_FILE")"
echo
echo "==> Ссылка для подключения приложения CC Pocket (ввести вручную или показать QR из журнала):"
echo "    адрес: $PUBLIC_WS_URL"; echo "    ключ:  $KEY"
echo "    QR-код и подробности: journalctl -u ccpocket-bridge -n 80"
