# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

Commits em português, escopo pequeno. `README.md` cobre como rodar, como treinar
e a tabela de parâmetros — este arquivo cobre **como o projeto é composto e por
que foi feito assim**.

## Comandos

```bash
# Ambiente Python (pipeline)
python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt

# Pipeline inteiro (baixa ~140 MB na primeira vez; cache em dados/brutos/)
./pipeline/executar.sh

# Uma etapa isolada (elas se comunicam por parquet em dados/, rode em ordem)
./.venv/bin/python pipeline/03_risco.py

# App em http://localhost:3000
npm install --prefix app && npm run app

# Verificacoes (precisam de `npm install` na raiz)
npm run verificar:treino    # treina em Node, mede acuracia de validacao
npm run verificar:app       # ciclo completo no Chrome headless (~3 min)
```

`verificar:app` usa um Chrome ja instalado (`puppeteer-core` nao baixa
navegador). Sobrescreva com `CHROME_PATH=/caminho/para/chrome` e a porta com
`PORTA_VERIFICACAO`.

O app **nao depende do pipeline**: `app/dados/*.json` sao versionados de
proposito. O pipeline so serve para atualizar os dados.

## Arquitetura

Duas pecas, porque parquet e 6,4 milhoes de linhas de serie temporal nao cabem
no browser:

```
pipeline/   Python/polars. CVM -> universo -> risco -> vetores -> JSON enxuto.
app/        Browser. TF.js em Worker, MVC + eventos, consome o JSON.
verificar/  Roda o sistema de verdade e confere criterios de aceite.
```

**Pipeline** (`pipeline/NN_*.py`, ordem fixa, comunicacao por parquet em `dados/`):
`01_ingestao` baixa e normaliza -> `02_universo` filtra o investivel
(`CORTE_COTISTAS = 100`, constante isolada) -> `03_risco` calcula volatilidade
anualizada de 12 meses -> `04_fatores` codifica os vetores -> `simulacao_clientes`
gera a base sintetica de adesoes. `comum.py` tem caminhos, download e `exigir()`;
`pesos.py` e a regra de negocio da codificacao.

**Cada etapa falha alto** se o criterio de aceite dela nao passar — foi assim que
apareceram as armadilhas de CNPJ e de estrutura legada duplicada. Ao mexer numa
etapa, mexa tambem no criterio; **nunca afrouxe um criterio para fazer a etapa
passar**.

**App**: `index.js` monta Worker + controllers + views; `AppController` so liga
eventos (nomes centralizados em `events/constants.js`, incluindo os que cruzam
`postMessage`); `workers/treinoWorker.js` e casca fina.

**`app/src/ml/nucleo.js` e o coracao**: dataset, modelo e inferencia sem tocar em
Worker, DOM ou rede — espera `tf` como global. E o que permite
`verificar/treino.node.mjs` rodar exatamente o mesmo codigo fora do browser e
**medir** a acuracia em vez de afirma-la. Logica de ML nova entra aqui, nunca no
worker.

## Invariantes que quebram em silencio

Todas foram descobertas rodando o sistema, e todas falham sem lancar erro.

- **`VERSAO_ESQUEMA` (`pipeline/pesos.py`)** — mudou peso, faixa ou conjunto de
  categorias, todo vetor gravado vira lixo sem erro nenhum. Suba a versao junto,
  rode o pipeline inteiro de novo; `montarContexto()` recusa versoes divergentes.
- **CNPJ em formatos diferentes entre as bases** — `INF_DIARIO` traz
  `00.017.024/0001-53`, o cadastro traz `00332266000131`. Join direto devolve
  zero linhas, sem erro. Normalizar para so digitos; `01_ingestao.py` testa as
  duas formas e exige que a crua devolva zero.
- **Estrutura legada sobreposta** — algumas dezenas de CNPJs publicam duas linhas
  de nivel classe na mesma data (`TP_FUNDO_CLASSE` 'FI' e 'CLASSES - FIF'),
  rastro da migracao da Res. 175. Duplica log-retornos. `03_risco.py` fica com a
  estrutura nova e exige uma observacao por (classe, data).
- **Split treino/validacao por CLIENTE, nao por linha** — o vetor do usuario se
  repete nas linhas dele; cortar por linha vaza metade da carteira.
- **Cold start media PONTUACOES, nao vetores** (`MAX_REFERENCIAS = 25` em
  `nucleo.js`) — mediar vetores de clientes parecidos produz uma forma que o
  modelo nunca viu e deforma o ranking (moderado ia de 2,7 para 3,8).
  `verificar/treino.node.mjs` trava essa regressao; ela ja aconteceu uma vez.
- **CSV da CVM e latin-1**, nao utf-8.
- **`fetch` relativo dentro do Worker** resolve contra a URL do worker, nao da
  pagina. Usar `new URL(..., import.meta.url)`.
- **A semente nao cobre a inicializacao de pesos do TF.js** — cobre so a
  amostragem negativa e o split. Nao prometa reprodutibilidade de ranking.

## Decisoes de modelagem, com o numero que as sustenta

- **Pesos por regra de negocio, nao chutados** (`pesos.py`). A ordem vem da Res.
  CVM 30: risco 0,40 > classificacao 0,20 > publico-alvo 0,15 = estrategia 0,15
  > porte/liquidez 0,10. Em e-commerce um peso errado gera recomendacao ruim; em
  investimento o peso do risco E a suitability.
- **Codificacao no pipeline, nao no browser.** O app recebe vetores prontos com
  a versao carimbada, entao e impossivel codificar item com um esquema e usuario
  com outro.
- **Rede pequena** (`32-16-1`, 3.009 parametros para 63.936 linhas). Cresce so se
  a validacao pedir — nao pediu.
- **Amostragem negativa 3:1.** O cartesiano daria 9,9 milhoes de pares com 99,8%
  de rotulo 0. Fixa a linha de base em 75%, que vai reportada junto da acuracia.
- **Corte de varejo `NR_COTST > 100`.** A mediana de cotistas de todas as classes
  e 2. Com `>1000` a renda fixa vira 50% do universo e as recomendacoes
  conservadoras ficam quase identicas entre si.
- **Faixas de risco por quintil da volatilidade observada**, nao por rotulo.

## Contexto

**Material educacional, nao recomendacao de investimento.** Suitability e
atividade regulada (CVM Res. 30) e **o aviso na UI nao sai** — ha criterio de
aceite em `verificar/app.browser.mjs` que falha se ele sumir.

A base de clientes e **simulada** (`pipeline/simulacao_clientes.py`) e e o limite
conceitual do projeto: o teto do que o modelo aprende e o processo gerador
escrito ali. Leia esse arquivo antes de confiar em qualquer numero que o modelo
produzir.

Licenca MIT para o codigo; os dados embarcados sao da CVM e seguem os termos
dela.
