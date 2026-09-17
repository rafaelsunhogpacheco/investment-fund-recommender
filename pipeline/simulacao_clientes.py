"""Etapa 5 — Base de clientes simulada.

ESTE ARQUIVO E A FONTE DA VERDADE DO PROJETO. Leia antes de confiar em
qualquer numero que o modelo produzir.

POR QUE SIMULAR
---------------
Nao existe base publica de quem investiu em que. O rotulo "adequado ao
perfil" nao e fato observavel — e julgamento. Esse e o bloqueio real do
projeto: sem definir de onde vem o rotulo, nao ha treino supervisionado.

A saida escolhida nao e rotular por regra deterministica (o
modelo so decoraria o `if`), e sim simular uma BASE DE CLIENTES COM
ADESOES, espelhando o e-commerce onde o usuario e o centroide das proprias
compras:

    cliente conservador aderiu ao fundo X -> X e candidato a outro
    cliente conservador

O QUE IMPEDE ISSO DE SER REFLEXO DE UM `if`
-------------------------------------------
1. POPULARIDADE REAL. A adesao e sorteada com probabilidade proporcional a
   NR_COTST — quantos investidores de verdade aquele fundo tem. O modelo
   passa a aprender sobre fundos que pessoas reais efetivamente detem, nao
   sobre um catalogo uniforme.
2. HETEROGENEIDADE. Dois clientes do mesmo balde de perfil nao tem a mesma
   carteira: o numero de adesoes varia, o sorteio e aleatorio e a faixa de
   risco tolerada tem folga.
3. RUIDO DELIBERADO. Uma fracao dos conservadores carrega uma ponta em
   renda variavel, como na vida real. Sem isso o modelo memoriza a regra
   em vez de generalizar.

RESSALVA HONESTA, REGISTRADA NO PLANO
-------------------------------------
O teto do que o modelo aprende e este processo gerador. Ele NAO descobre
conhecimento novo sobre o mercado. Com heterogeneidade e ruido vira um
problema de aprendizado real; sem, vira memorizacao. Qualquer leitura dos
resultados tem que passar por aqui.
"""
from __future__ import annotations

import json
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np
import polars as pl

from comum import APP_DADOS, DADOS, etapa, exigir, log
from pesos import APETITE_PARA_FAIXA, CAPITAL_MINIMO_PUBLICO, VERSAO_ESQUEMA

# Semente fixa: a base simulada precisa ser reproduzivel, senao o modelo
# muda de resultado a cada execucao por motivo nenhum.
SEMENTE = 20260915

N_CLIENTES = 3_000

# Quantas adesoes cada cliente tem. Faixa, nao valor fixo — carteira de
# tamanho constante e a primeira forma de degenerar a base.
MIN_ADESOES, MAX_ADESOES = 3, 10

# Fracao de clientes que recebe UMA adesao fora da propria faixa de risco.
# E o "ruido deliberado" do PLANO: o conservador com uma ponta em acoes.
PROB_RUIDO = 0.18

# Folga da faixa de risco tolerada em torno da faixa-alvo do apetite.
# Conservador com alvo 1 aceita ate 2; arrojado com alvo 5 aceita de 3 a 5.
FOLGA_FAIXA = 2

APETITES = ["conservador", "moderado", "arrojado"]
CONHECIMENTOS = ["baixo", "medio", "alto"]


def gerar_perfis(rng: np.random.Generator) -> pl.DataFrame:
    """Perfis com as 4 dimensoes do formulario de suitability.

    As correlacoes sao brandas de proposito. Fortes demais e o perfil vira
    funcao da idade, e o modelo aprende so isso.
    """
    etapa("Perfis")
    idade = rng.integers(21, 76, N_CLIENTES)

    # Capital cresce com a idade (lognormal deslocada por decada), com
    # dispersao alta: ha jovem com muito capital e idoso com pouco.
    base = np.log(20_000) + (idade - 21) * 0.035
    capital = np.exp(rng.normal(base, 1.1)).round(-2)

    # Apetite: mais jovem tende a arrojado, mais velho a conservador — mas
    # so tende. Os pesos nunca zeram nenhuma opcao.
    peso_jovem = np.clip((70 - idade) / 50, 0.05, 0.95)
    probs = np.stack([1 - peso_jovem, np.full_like(peso_jovem, 0.5), peso_jovem], axis=1)
    probs = probs / probs.sum(axis=1, keepdims=True)
    apetite = np.array([rng.choice(APETITES, p=p) for p in probs])

    # Conhecimento correlaciona com capital, nao com idade.
    faixa_cap = np.digitize(capital, [50_000, 500_000])
    conhecimento = np.array(
        [rng.choice(CONHECIMENTOS, p=[0.5, 0.35, 0.15] if f == 0
                    else [0.25, 0.45, 0.30] if f == 1
                    else [0.10, 0.35, 0.55])
         for f in faixa_cap]
    )

    perfis = pl.DataFrame(
        {
            "cliente_id": np.arange(1, N_CLIENTES + 1),
            "idade": idade,
            "capital": capital,
            "apetite": apetite,
            "conhecimento": conhecimento,
        }
    )
    print(perfis.group_by("apetite").len().sort("apetite"))
    print(perfis.group_by("conhecimento").len().sort("conhecimento"))
    log(f"capital: mediana R$ {perfis['capital'].median():,.0f}")
    return perfis


def publicos_elegiveis(capital: float) -> list[str]:
    """Elegibilidade legal por capital.

    APROXIMACAO ASSUMIDA: os dados abertos nao trazem aporte minimo, que
    esta no regulamento de cada fundo. Publico_Alvo e o proxy, com os
    limites da Res. CVM 30. A UI nao pode sugerir precisao que o dado nao
    tem — ver PLANO, "O que a base NAO tem".
    """
    return [p for p, minimo in CAPITAL_MINIMO_PUBLICO.items() if capital >= minimo]


def sortear_adesoes(perfis: pl.DataFrame, classes: pl.DataFrame, rng: np.random.Generator) -> pl.DataFrame:
    etapa("Adesoes")
    cnpjs = classes["cnpj"].to_numpy()
    faixa = classes["faixa_risco"].to_numpy()
    publico = classes["publico_alvo"].to_numpy()
    exterior = classes["exterior"].to_numpy()
    cotistas = classes["nr_cotst"].to_numpy().astype(float)

    # Popularidade em raiz: NR_COTST cru e tao concentrado que meia duzia de
    # fundos gigantes levaria quase toda adesao, e o resto do universo nunca
    # apareceria no treino. A raiz preserva a ordem e achata a cauda.
    popularidade = np.sqrt(cotistas)

    linhas = []
    for p in perfis.iter_rows(named=True):
        alvo = APETITE_PARA_FAIXA[p["apetite"]]
        elegivel_publico = np.isin(publico, publicos_elegiveis(p["capital"]))
        dentro_faixa = np.abs(faixa - alvo) <= FOLGA_FAIXA

        peso = popularidade * elegivel_publico * dentro_faixa
        # Proximidade da faixa-alvo: dentro da folga, o que esta mais perto
        # do alvo pesa mais. Evita carteira uniformemente espalhada.
        peso = peso * (1.0 / (1.0 + np.abs(faixa - alvo)))
        # Conhecimento baixo evita (nao proibe) produto com risco cambial.
        if p["conhecimento"] == "baixo":
            peso = peso * np.where(exterior == 1, 0.25, 1.0)

        if peso.sum() <= 0:
            continue

        n = rng.integers(MIN_ADESOES, MAX_ADESOES + 1)
        n = min(n, int((peso > 0).sum()))
        escolhidas = rng.choice(len(cnpjs), size=n, replace=False, p=peso / peso.sum())

        # Ruido: uma adesao fora da faixa tolerada, ainda respeitando a
        # elegibilidade legal (que nao se viola nem por ruido).
        if rng.random() < PROB_RUIDO:
            fora = np.where(elegivel_publico & ~dentro_faixa)[0]
            if len(fora):
                peso_fora = popularidade[fora]
                extra = rng.choice(fora, p=peso_fora / peso_fora.sum())
                escolhidas = np.append(escolhidas, extra)

        for i in escolhidas:
            linhas.append({"cliente_id": p["cliente_id"], "cnpj": cnpjs[i]})

    adesoes = pl.DataFrame(linhas).unique(subset=["cliente_id", "cnpj"])
    log(f"{adesoes.height} adesoes de {adesoes['cliente_id'].n_unique()} clientes")
    log(f"{adesoes['cnpj'].n_unique()} classes distintas aderidas de {len(cnpjs)} do universo")
    return adesoes


def validar(perfis: pl.DataFrame, adesoes: pl.DataFrame, classes: pl.DataFrame) -> None:
    """Criterio de aceite do PLANO: rotulos nao degenerados e carteiras nao
    identicas dentro do mesmo perfil."""
    etapa("Validacao da base simulada")

    por_cliente = adesoes.group_by("cliente_id").len()
    log(f"adesoes por cliente: min {por_cliente['len'].min()}, "
        f"mediana {por_cliente['len'].median():.0f}, max {por_cliente['len'].max()}")

    enriquecidas = adesoes.join(classes, on="cnpj").join(perfis, on="cliente_id")

    etapa("Faixa de risco aderida por apetite")
    resumo = (
        enriquecidas.group_by("apetite")
        .agg(
            pl.len().alias("adesoes"),
            pl.col("faixa_risco").mean().round(2).alias("faixa_media"),
            pl.col("volatilidade").median().round(2).alias("vol_mediana"),
        )
        .sort("faixa_media")
    )
    print(resumo)
    medias = {l["apetite"]: l["faixa_media"] for l in resumo.to_dicts()}
    exigir(
        medias["conservador"] < medias["moderado"] < medias["arrojado"],
        "faixa de risco media cresce do conservador ao arrojado",
    )

    # Heterogeneidade: dentro do mesmo balde de perfil, carteiras diferentes.
    # Jaccard medio entre pares sorteados do mesmo balde. Perto de 1 seria
    # base degenerada (todo mundo com a mesma carteira).
    rng = np.random.default_rng(SEMENTE)
    carteiras = {
        l["cliente_id"]: set(l["cnpj"])
        for l in adesoes.group_by("cliente_id").agg(pl.col("cnpj")).iter_rows(named=True)
    }
    baldes = (
        perfis.group_by("apetite", "conhecimento")
        .agg(pl.col("cliente_id"))
        .iter_rows(named=True)
    )
    jaccards = []
    for b in baldes:
        ids = [i for i in b["cliente_id"] if i in carteiras]
        for _ in range(min(300, len(ids))):
            a, c = rng.choice(ids, size=2, replace=False)
            ca, cc = carteiras[a], carteiras[c]
            jaccards.append(len(ca & cc) / len(ca | cc))
    jaccard_medio = float(np.mean(jaccards))
    log(f"Jaccard medio entre carteiras do mesmo balde: {jaccard_medio:.3f}")
    exigir(jaccard_medio < 0.35, "carteiras nao sao identicas dentro do mesmo perfil")

    # Ruido: conservadores com alguma adesao de risco alto.
    conservadores = enriquecidas.filter(pl.col("apetite") == "conservador")
    com_ponta = (
        conservadores.filter(pl.col("faixa_risco") >= 4)["cliente_id"].n_unique()
        / max(perfis.filter(pl.col("apetite") == "conservador").height, 1)
    )
    log(f"conservadores com ponta em risco alto: {com_ponta:.1%}")
    exigir(0.02 < com_ponta < 0.50, "ruido presente sem dominar a base")

    # Cobertura: o sorteio por popularidade nao pode colapsar num punhado
    # de fundos gigantes.
    top = adesoes.group_by("cnpj").len().sort("len", descending=True)
    concentracao = top.head(20)["len"].sum() / adesoes.height
    log(f"20 classes mais aderidas concentram {concentracao:.1%} das adesoes")
    exigir(concentracao < 0.35, "adesoes nao colapsam num punhado de fundos")


def exportar(perfis: pl.DataFrame, adesoes: pl.DataFrame) -> None:
    etapa("Export")
    DADOS.mkdir(parents=True, exist_ok=True)
    perfis.write_parquet(DADOS / "clientes.parquet")
    adesoes.write_parquet(DADOS / "adesoes.parquet")

    agrupadas = adesoes.group_by("cliente_id").agg(pl.col("cnpj").alias("adesoes"))
    juncao = perfis.join(agrupadas, on="cliente_id", how="inner")
    registros = [
        {
            "id": l["cliente_id"],
            "idade": int(l["idade"]),
            "capital": float(l["capital"]),
            "apetite": l["apetite"],
            "conhecimento": l["conhecimento"],
            "adesoes": l["adesoes"],
        }
        for l in juncao.iter_rows(named=True)
    ]
    saida = {
        "versaoEsquema": VERSAO_ESQUEMA,
        "geradoEm": date.today().isoformat(),
        "semente": SEMENTE,
        "aviso": "Base SIMULADA por pipeline/simulacao_clientes.py. Nao sao investidores reais.",
        "clientes": registros,
    }
    APP_DADOS.mkdir(parents=True, exist_ok=True)
    destino = APP_DADOS / "clientes.json"
    destino.write_text(json.dumps(saida, ensure_ascii=False), encoding="utf-8")
    log(f"gravado app/dados/clientes.json ({destino.stat().st_size / 1e6:.2f} MB, {len(registros)} clientes)")


def main() -> None:
    rng = np.random.default_rng(SEMENTE)
    classes = pl.read_parquet(DADOS / "fatores.parquet").select(
        "cnpj", "faixa_risco", "publico_alvo", "nr_cotst", "volatilidade", "exterior"
    )
    log(f"universo: {classes.height} classes")

    perfis = gerar_perfis(rng)
    adesoes = sortear_adesoes(perfis, classes, rng)
    validar(perfis, adesoes, classes)
    exportar(perfis, adesoes)
    etapa("Etapa 5 concluida")


if __name__ == "__main__":
    main()
