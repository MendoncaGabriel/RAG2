#!/usr/bin/env bash
# Teste ponta a ponta pela API HTTP da aplicação em execução (docker compose up -d), no terminal do WSL2.
# Cria um notebook, envia um documento, faz perguntas numa conversa, reinicia os containers e confere que tudo persistiu.
# Uso: bash scripts/e2e.sh            (lê MASTER_USER/MASTER_PASSWORD/PORT do .env)
#      KEEP=1 bash scripts/e2e.sh     (não apaga o notebook de teste no final)
set -euo pipefail
cd "$(dirname "$0")/.."
env_get() { grep -E "^$1=" .env | tail -1 | cut -d= -f2-; }
BASE="http://127.0.0.1:$(env_get PORT || echo 3000)"
JAR="$(mktemp)"; trap 'rm -f "$JAR"' EXIT
api() { local m=$1 p=$2; shift 2; curl -sS -b "$JAR" -c "$JAR" -X "$m" "$BASE$p" -H 'content-type: application/json' "$@"; }
json() { python3 -c "import sys,json; d=json.load(sys.stdin); print(eval(sys.argv[1], {'d': d}))" "$1"; }
ok() { printf '  ✔ %s\n' "$1"; }
fail() { printf '  ✘ %s\n' "$1"; exit 1; }
wait_healthy() { for _ in $(seq 1 90); do [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/healthz")" = 200 ] && return 0; sleep 2; done; fail "aplicação não ficou saudável"; }

echo "1) Saúde das dependências"
wait_healthy; curl -s "$BASE/healthz"; echo; ok "SQLite, Qdrant e Ollama acessíveis"

echo "2) Login, notebook e documento"
api POST /api/auth/login -d "{\"username\":\"$(env_get MASTER_USER)\",\"password\":\"$(env_get MASTER_PASSWORD)\"}" >/dev/null
NB=$(api POST /api/notebooks -d '{"name":"E2E Qdrant"}' | json "d['id']")
python3 -c "import json,sys; print(json.dumps({'name':'Base_RAG_Verdanis.md','text':open('tests/fixtures/Base_RAG_Verdanis.md',encoding='utf8').read()}))" > /tmp/e2e-doc.json
DOC=$(api POST "/api/notebooks/$NB/text" --data-binary @/tmp/e2e-doc.json | json "d['id']")
for _ in $(seq 1 300); do
  ST=$(api GET "/api/notebooks/$NB/documents" | json "[x for x in d if x['id']=='$DOC'][0]['status']")
  [ "$ST" != processing ] && break; sleep 2
done
[ "$ST" = processed ] || fail "documento terminou como $ST"
ok "documento processado (SQLite + Qdrant)"
api GET /api/system/info | json "d['vectorStore']"

echo "3) Conversa: perguntas com histórico (busca híbrida + LLM do Windows)"
CONV=$(api POST "/api/notebooks/$NB/conversations" -d '{}' | json "d['id']")
ask() { api POST "/api/conversations/$CONV/messages" -d "{\"content\":\"$1\"}" | json "d['assistant']['content']"; }
A1=$(ask "Qual porta TCP o gateway industrial usa para OPC UA?"); echo "    → $A1"; grep -q 4840 <<<"$A1" && ok "resposta com a porta 4840" || fail "resposta sem 4840"
A2=$(ask "Quem é o patrocinador do PRJ-ESTUFA?"); echo "    → $A2"; grep -qi "caio menezes" <<<"$A2" && ok "resposta com Caio Menezes" || fail "resposta sem Caio Menezes"
A3=$(ask "E qual é o orçamento dele?"); echo "    → $A3"; ok "pergunta de acompanhamento respondida"
N=$(api GET "/api/conversations/$CONV/messages" | json "len(d)"); [ "$N" = 6 ] && ok "histórico com 6 mensagens no SQLite" || fail "histórico com $N mensagens"

echo "4) Reinicialização dos containers"
docker compose restart >/dev/null; wait_healthy
api POST /api/auth/login -d "{\"username\":\"$(env_get MASTER_USER)\",\"password\":\"$(env_get MASTER_PASSWORD)\"}" >/dev/null
N=$(api GET "/api/conversations/$CONV/messages" | json "len(d)"); [ "$N" = 6 ] && ok "histórico persistiu ($N mensagens)" || fail "histórico perdido ($N)"
A4=$(ask "Qual porta TCP o gateway industrial usa para OPC UA?"); grep -q 4840 <<<"$A4" && ok "busca funciona após reiniciar (vetores persistidos no Qdrant)" || fail "busca falhou após reiniciar: $A4"
api GET /api/system/sync | json "{k: d[k] for k in ('ok','orphanDocuments','repairedDocuments','resumedDocuments')}"

echo "5) Exclusão"
PTS_BEFORE=$(api GET /api/system/info | json "d['vectorStore']['points']")
api DELETE "/api/documents/$DOC" >/dev/null
sleep 1
PTS_AFTER=$(api GET /api/system/info | json "d['vectorStore']['points']")
[ "$PTS_AFTER" -lt "$PTS_BEFORE" ] && ok "pontos removidos do Qdrant ($PTS_BEFORE → $PTS_AFTER)" || fail "pontos não removidos ($PTS_BEFORE → $PTS_AFTER)"
[ "${KEEP:-0}" = 1 ] || { api DELETE "/api/notebooks/$NB" >/dev/null; ok "notebook de teste removido"; }
echo "E2E concluído."
