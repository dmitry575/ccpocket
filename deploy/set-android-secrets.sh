#!/usr/bin/env bash
# Загружает ключ подписи Android форка в секреты GitHub-репозитория.
# Ключ создан на сервере: /root/ccpocket-secrets/android-fork.p12 (PKCS12),
# пароль и алиас в /root/ccpocket-secrets/android-fork.txt. Без этих секретов
# workflow all-platforms-release.yml подписывает APK отладочным ключом
# (ставится, но обновление поверх требует удаления приложения).
set -euo pipefail

REPO="${REPO:-dmitry575/ccpocket}"
DIR="${SECRETS_DIR:-/root/ccpocket-secrets}"
P12="$DIR/android-fork.p12"
META="$DIR/android-fork.txt"

[ -f "$P12" ] && [ -f "$META" ] || { echo "Нет $P12 или $META" >&2; exit 1; }
PASS="$(sed -n 's/^storePassword=//p' "$META")"
ALIAS="$(sed -n 's/^keyAlias=//p' "$META")"
KEYPASS="$(sed -n 's/^keyPassword=//p' "$META")"

base64 -w0 "$P12"      | gh secret set FORK_KEYSTORE_BASE64     -R "$REPO"
printf '%s' "$PASS"    | gh secret set FORK_KEYSTORE_PASSWORD   -R "$REPO"
printf '%s' "$ALIAS"   | gh secret set FORK_KEY_ALIAS           -R "$REPO"
printf '%s' "$KEYPASS" | gh secret set FORK_KEY_PASSWORD        -R "$REPO"
echo "Секреты загружены в $REPO:"
gh secret list -R "$REPO" | grep -E '^FORK_'
