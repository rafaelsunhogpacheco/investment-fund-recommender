#!/usr/bin/env bash
# Roda o pipeline inteiro, na ordem. Cada etapa falha alto se o criterio de
# aceite dela nao passar, entao um erro aqui para tudo.
set -euo pipefail
cd "$(dirname "$0")/.."
PY=./.venv/bin/python

$PY pipeline/01_ingestao.py
$PY pipeline/02_universo.py
$PY pipeline/03_risco.py
$PY pipeline/04_fatores.py
$PY pipeline/simulacao_clientes.py

echo
echo "Pipeline concluido. Exports em app/dados/."
