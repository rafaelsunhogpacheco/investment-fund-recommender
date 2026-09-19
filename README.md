# recomendador-fundos

Recomenda classes de fundos de investimento da base pública da CVM segundo o
perfil do investidor (idade, capital, apetite a risco, conhecimento), com uma
rede neural treinada no browser com TensorFlow.js.

> **Material educacional — não é recomendação de investimento.**
> Análise de perfil (*suitability*) é atividade regulada pela Resolução CVM 30
> e só pode ser feita por instituição autorizada. Os dados de fundos são reais;
> **a base de clientes que treina o modelo é simulada** — ver
> [A base simulada é o limite do projeto](#a-base-simulada-é-o-limite-do-projeto).

![Demonstração: perfil moderado recebendo classes ordenadas por aderência](demo/recomendador-fundos.gif)

## Duas peças

Séries temporais de 6,4 milhões de linhas não cabem no browser, então o projeto
se divide:

```
pipeline/   Python. CVM → limpeza → fatores → parquet → export JSON enxuto.
app/        Browser. TF.js em Web Worker, consome o JSON.
verificar/  Scripts que rodam o sistema de verdade e conferem os critérios.
```

## Pré-requisitos

| | Versão | Para quê |
|---|---|---|
| Python | 3.12+ | pipeline de dados |
| Node.js | 22+ | app e verificações |
| Chrome ou Chromium | qualquer | só para `verificar:app` |

`puppeteer-core` **não baixa navegador** — usa um já instalado. O script procura
nos caminhos usuais de Linux, macOS e Windows; se o seu estiver em outro lugar:

```bash
CHROME_PATH=/caminho/para/chrome npm run verificar:app
```

## Como rodar

```bash
# 1. Pipeline de dados — opcional, veja a nota abaixo
python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt
./pipeline/executar.sh          # baixa ~140 MB da CVM na primeira vez

# 2. App
npm install --prefix app && npm run app     # http://localhost:3000

# 3. Verificações
npm install
npm run verificar:treino    # treina em Node e mede a acurácia de validação
npm run verificar:app       # ciclo completo no Chrome headless (~3 min, porta 8173)
```

**O app não depende do pipeline.** Os exports em `app/dados/` são versionados de
propósito: basta o passo 2 para ver o projeto funcionando. O pipeline só é
necessário para atualizar os dados.

## Como treinar o modelo

O treino roda **no browser, dentro de um Web Worker**, e acontece de três formas:

| Quando | O que acontece |
|---|---|
| Ao abrir a página | dispara sozinho, **leva ~110s**, 30 épocas com progresso na UI |
| Botão "Treinar novamente" | descarta o modelo e retreina do zero |
| Recarregar a página | retreina do zero — o modelo **não** é persistido |

Trocar de perfil e pedir nova recomendação **não** retreina: reaproveita o modelo
em memória, e a resposta é imediata.

Para treinar fora do browser e medir — é o caminho usado no desenvolvimento:

```bash
npm run verificar:treino
```

Isso carrega o **mesmo** núcleo de ML que o Worker usa
([`app/src/ml/nucleo.js`](app/src/ml/nucleo.js)) sobre os mesmos JSON, treina em
Node e imprime acurácia de validação, ganho sobre a linha de base e a coerência
entre apetite e risco recomendado.

### Parâmetros de treino

Todos em `PARAMETROS`, no topo de [`app/src/ml/nucleo.js`](app/src/ml/nucleo.js):

| Parâmetro | Valor | Efeito |
|---|---|---|
| `camadas` | `[32, 16]` | densas ReLU + saída sigmoid; 3.009 parâmetros no total |
| `epocas` | `30` | além disso a validação para de melhorar |
| `tamanhoLote` | `256` | lotes menores deixam o treino no browser lento demais |
| `taxaAprendizado` | `0.005` | Adam; `binaryCrossentropy` como perda |
| `negativosPorPositivo` | `3` | fixa a linha de base em 75% (ver abaixo) |
| `fracaoValidacao` | `0.2` | fração de **clientes**, não de linhas |
| `semente` | `20260915` | ver a ressalva de reprodutibilidade |
| `MAX_REFERENCIAS` | `25` | clientes similares consultados no cold start |

### Reprodutibilidade: o que a semente cobre

`semente` alimenta um PRNG próprio que controla **a amostragem negativa e o
embaralhamento treino/validação**. Rodar duas vezes dá exatamente o mesmo
dataset.

**Ela não cobre a inicialização de pesos do TensorFlow.js**, que não é semeada.
Por isso cada treino converge para um modelo ligeiramente diferente: a acurácia
fica estável (85,2%–85,7% em 4 execuções medidas), mas o ranking do perfil
*moderado* oscila — ver [O que ainda incomoda](#o-que-ainda-incomoda).

## Os dados

Portal de Dados Abertos da CVM, dois datasets:

| Arquivo | Conteúdo |
|---|---|
| `FI/CAD/DADOS/registro_fundo_classe.zip` | cadastro atual (Res. CVM 175) |
| `FI/DOC/INF_DIARIO/DADOS/inf_diario_fi_AAAAMM.zip` | cota diária, 12 meses |

`cad_fi.csv` é legado e mostra só 22 fundos ativos — a base migrou para a
estrutura fundo/classe/subclasse. O certo é `registro_classe.csv`, com **33.708
classes em funcionamento normal**.

**A janela de 12 meses é relativa à data de execução** e sempre exclui o mês
corrente, porque a CVM só publica o INF_DIARIO completo depois que o mês fecha —
mês parcial enviesaria a volatilidade. Rodar o pipeline em outra data desloca a
janela e muda todos os números abaixo.

### Do cadastro ao universo investível

| Classes | Filtro |
|---:|---|
| 36.711 | cadastro completo |
| 33.708 | em funcionamento normal |
| 25.190 | com cota diária publicada |
| 3.515 | `NR_COTST > 100` (corte de varejo) |
| 3.372 | não exclusivo |
| 3.369 | campos obrigatórios preenchidos |
| **3.299** | **com série de risco de 12 meses** |

O corte de varejo é obrigatório: a mediana de cotistas de todas as classes é
**2**. Sem ele o recomendador sugere fundo exclusivo, o que não faz sentido.

### Risco calculado, não rotulado

Volatilidade anualizada dos log-retornos da cota sobre 12 meses:

| Classificação | n | p25 | mediana | p75 |
|---|---:|---:|---:|---:|
| FMP-FGTS | 53 | 24,93 | **25,23** | 28,51 |
| Ações | 722 | 16,31 | **18,07** | 20,83 |
| Cambial | 32 | 10,61 | **10,65** | 10,67 |
| Multimercado | 1.176 | 2,86 | **5,20** | 9,86 |
| Renda Fixa | 1.316 | 0,05 | **0,30** | 1,78 |

As faixas de risco 1–5 saem de **quintis dessa distribuição**, não de rótulo
arbitrário. A ordenação renda fixa < multimercado < ações é critério de aceite:
se inverter, o pipeline falha.

### Onde mexer em cada comportamento

| Constante | Arquivo | Efeito |
|---|---|---|
| `CORTE_COTISTAS = 100` | [`pipeline/02_universo.py`](pipeline/02_universo.py) | corte de varejo; `1000` reduz a 1.518 classes e desequilibra para renda fixa |
| `MESES_JANELA = 12` | [`pipeline/comum.py`](pipeline/comum.py) | tamanho da janela de cota diária |
| `MIN_OBSERVACOES = 120` | [`pipeline/03_risco.py`](pipeline/03_risco.py) | pregões mínimos por classe; exclui fundos novos |
| `PREGOES_ANO = 252` | [`pipeline/03_risco.py`](pipeline/03_risco.py) | fator de anualização da volatilidade |
| `PESOS` | [`pipeline/pesos.py`](pipeline/pesos.py) | peso de cada bloco no vetor; ordem vem da Res. CVM 30 |
| `QUANTIS_RISCO` | [`pipeline/pesos.py`](pipeline/pesos.py) | cortes das 5 faixas de risco |
| `VERSAO_ESQUEMA` | [`pipeline/pesos.py`](pipeline/pesos.py) | **suba a qualquer mudança nas duas linhas acima** |
| `N_CLIENTES = 3000` | [`pipeline/simulacao_clientes.py`](pipeline/simulacao_clientes.py) | tamanho da base simulada |
| `PROB_RUIDO = 0.18` | [`pipeline/simulacao_clientes.py`](pipeline/simulacao_clientes.py) | fração com adesão fora da faixa de risco |
| `MIN_ADESOES, MAX_ADESOES` | [`pipeline/simulacao_clientes.py`](pipeline/simulacao_clientes.py) | tamanho das carteiras (3 a 10) |

## O modelo

Par `(perfil, classe)` → probabilidade de aderência. Rede `32→16→1`, 3.009
parâmetros sobre 63.936 linhas de treino.

**Acurácia de validação: 85,7%**, contra linha de base de 75,0% — que é o
modelo que responde "não" para tudo, já que há 3 negativos por positivo. O ganho
de ~11 p.p. sobre a base é o número que importa: a acurácia sozinha engana.

Treino e validação separam por **cliente**, não por linha: o vetor do usuário se
repete nas linhas dele, e cortar por linha vazaria metade da carteira de cada
cliente para o outro lado.

### Amostragem negativa

O produto cartesiano cliente × classe daria 3.000 × 3.299 = **9,9 milhões** de
pares, 99,8% com rótulo 0. Não cabe no browser, e produziria um modelo que
acerta quase tudo dizendo "não". Cada positivo ganha 3 negativos sorteados —
79.840 linhas no total.

## A base simulada é o limite do projeto

Não existe base pública de quem investiu em quê, e "adequado ao perfil" não é
fato observável — é julgamento.
[`pipeline/simulacao_clientes.py`](pipeline/simulacao_clientes.py) gera 3.000
clientes com adesões sorteadas **com probabilidade proporcional ao número real
de cotistas** de cada fundo, filtradas por elegibilidade legal.

O que impede isso de ser o reflexo de um `if`:

- **popularidade real** — o sorteio segue `NR_COTST`, não um catálogo uniforme;
- **heterogeneidade** — Jaccard médio entre carteiras do mesmo balde: **0,008**;
- **ruído deliberado** — 16,1% dos conservadores carregam uma ponta em risco alto.

**Ressalva honesta:** o teto do que o modelo aprende é este processo gerador.
Ele não descobre conhecimento novo sobre o mercado. Qualquer leitura dos
resultados passa por aqui.

## Três armadilhas que custaram tempo

1. **O CNPJ tem formato diferente entre as duas bases.** `INF_DIARIO` traz
   `00.017.024/0001-53`; `registro_classe` traz `00332266000131`. O join direto
   devolve **zero linhas** — sem erro, só um dataframe vazio. Normalizado para
   dígitos, sobe para 25.529.

2. **A estrutura legada sobrepõe a nova.** Algumas dezenas de CNPJs publicam
   duas linhas de nível classe na mesma data, uma sob `TP_FUNDO_CLASSE = 'FI'`
   e outra sob `'CLASSES - FIF'` — rastro da migração da Res. 175. São 88 linhas
   em 12 meses, o bastante para duplicar log-retornos.

3. **Mediar vetores de usuários quebra a recomendação** — detalhe abaixo.

### O cold start, e por que a primeira solução estava errada

Perfil novo não tem histórico, logo não tem centroide. A primeira solução foi
herdar o **centroide médio** dos clientes simulados parecidos. Parece razoável e
está errado:

| apetite | carteira real | top-10 com vetor individual | top-10 com centroide do balde |
|---|---:|---:|---:|
| conservador | 1,39 | 1,20 | 1,00 |
| moderado | 2,72 | **2,72** | **3,80** |
| arrojado | 4,46 | 4,71 | 5,00 |

O moderado recebia fundos de ações a 13,8% de volatilidade quando os moderados
simulados carregam 3,0%. A causa não é a magnitude do vetor (a norma bate, razão
~0,95) — é a **forma**. O modelo treina com centroides individuais, que são
concentrados: um cliente tem 3 a 10 classes, então poucas posições one-hot
carregam massa. A média de centenas desses centroides espalha massa por quase
todas as posições, e o par resultante não se parece com nada visto no treino.

**A correção é mediar pontuações, não vetores:** o perfil novo pontua o catálogo
com o vetor de cada um dos 25 clientes parecidos — todos dentro da distribuição
de treino — e a nota final é a média. O moderado voltou para a faixa 2,5.
`verificar/treino.node.mjs` tem um critério que trava essa regressão.

## O que ainda incomoda

- **O ranking do perfil moderado varia entre treinos.** A acurácia é estável
  (85,2%–85,7%), mas a faixa média do top-10 do moderado oscila entre ~1,0 e
  ~3,3, pelo motivo explicado em [Reprodutibilidade](#reprodutibilidade-o-que-a-semente-cobre).
  Conservador e arrojado são estáveis; o moderado, por ficar entre dois modos, é
  sensível. A verificação trava a **ordenação** entre perfis, que vale sempre, e
  não a faixa absoluta.
- **O treino no browser leva ~110s.** Um modelo pré-treinado pelo pipeline
  resolveria, ao custo de perder a demonstração do treino acontecendo.
- **70 classes ficam de fora** (3.369 → 3.299) por série curta demais.

## Verificação

Nada aqui é declarado pronto sem evidência. Cada etapa do pipeline falha alto se
o critério dela não passar — foi assim que as armadilhas de CNPJ e de estrutura
legada apareceram, em vez de virarem número errado em silêncio.

- **`verificar/treino.node.mjs`** — treina em Node sobre o mesmo núcleo de ML do
  Worker e mede acurácia, ganho sobre a base e coerência apetite × risco.
- **`verificar/app.browser.mjs`** — sobe o app, abre no Chrome headless, espera o
  treino, pede recomendação para os três perfis e confere lista, ordenação,
  presença do aviso regulatório e ausência de erros no console.

## Licença

Código sob [MIT](LICENSE).

**Os dados não são cobertos pela licença do código.** `app/dados/classes.json`
embarca dados do [Portal de Dados Abertos da CVM](https://dados.cvm.gov.br/dados/FI/),
sujeitos aos termos de uso da CVM. O JSON carrega a data de extração em
`geradoEm`.
