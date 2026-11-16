#!/usr/bin/env bash
# Linux nativo (Fedora, Ubuntu…): faz o Ollama do host ser alcançável pelos containers do Compose.
# Ele escuta em 127.0.0.1, que o container não vê. Este script o põe também no IP do docker0 (ex.: 172.17.0.1),
# interface que só existe dentro do computador (não expõe o Ollama ao Wi-Fi/rede). Uso: sudo bash scripts/linux/ollama-docker-bridge.sh [--remove]
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Execute com sudo."; exit 1; }
DROP=/etc/systemd/system/ollama.service.d/docker-bridge.conf
if [ "${1:-}" = "--remove" ]; then rm -f "$DROP"; systemctl daemon-reload; systemctl restart ollama; echo "Ponte removida."; exit 0; fi
IP=$(ip -4 -o addr show docker0 | awk '{print $4}' | cut -d/ -f1 | head -1)
[ -n "$IP" ] || { echo "Interface docker0 não encontrada (o Docker está rodando?)."; exit 1; }
mkdir -p "$(dirname "$DROP")"
printf '[Service]\nEnvironment="OLLAMA_HOST=%s:11434"\n' "$IP" > "$DROP"
systemctl daemon-reload; systemctl restart ollama
# firewalld (Fedora): a zona docker já aceita o tráfego das bridges; garante isso.
if command -v firewall-cmd >/dev/null && systemctl is-active -q firewalld; then firewall-cmd --permanent --zone=docker --add-port=11434/tcp >/dev/null 2>&1 || true; firewall-cmd --reload >/dev/null || true; fi
echo "Pronto: Ollama em http://$IP:11434. Em Configurações, clique em Configurar automaticamente."
echo "Obs.: o Ollama deixa de responder em 127.0.0.1 (use http://$IP:11434 nas outras ferramentas)."
