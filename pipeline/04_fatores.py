"""Etapa 4 — Fatores e vetores.

Junta universo (etapa 2) com risco (etapa 3), deriva a faixa de risco por
percentil e codifica cada classe num vetor numerico normalizado.

Duas decisoes deliberadas, contra a abordagem mais obvia:

1. Os pesos vem de `pesos.py`, com justificativa regulatoria, em vez de um
   literal chutado junto do codigo de treino.
2. A codificacao acontece AQUI, no pipeline, nao no browser. O app recebe
   os vetores prontos com a versao do esquema carimbada. Isso fecha a
   armadilha "retreinou, reindexou": e impossivel o app codificar item com
   um esquema e usuario com outro, porque o app nao codifica item nenhum.

Saidas:
  dados/fatores.parquet   — tabela completa, formato de trabalho
  app/dados/classes.json  — recorte enxuto que o browser consome
"""
from __future__ import annotations

import json
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import polars as pl

from comum import APP_DADOS, DADOS, etapa, exigir, log
from pesos import (
    FAIXAS_RISCO,
    MIN_CLASSES_POR_ESTRATEGIA,
    PESOS,
    QUANTIS_RISCO,
    ROTULO_ESTRATEGIA_RESIDUAL,
    VERSAO_ESQUEMA,
)

# Reparticao DENTRO do bloco de risco. Volatilidade e o risco propriamente
# dito; retorno passado entra com intensidade menor porque nao e risco e
# nao deve conduzir adequacao — mas descreve o produto e ajuda a separar
# fundos de mesma volatilidade.
SUBPESOS_RISCO = {"volatilidade": 0.75, "retorno": 0.25}

# Reparticao dentro do bloco porte/liquidez.
SUBPESOS_PORTE = {"patrimonio": 0.5, "aberto": 0.3, "esg": 0.2}


def juntar() -> pl.DataFrame:
    etapa("Juncao universo + risco")
    classes = pl.read_parquet(DADOS / "classes.parquet")
    risco = pl.read_parquet(DADOS / "risco.parquet")
    df = classes.join(
        risco.select("cnpj", "volatilidade", "retorno_periodo", "observacoes"),
        on="cnpj",
        how="inner",
    )
    log(f"{df.height} de {classes.height} classes do universo tem serie de risco")
    exigir(df.height >= 2_000, f"{df.height} classes com risco calculado")
    return df


def faixa_por_percentil(df: pl.DataFrame) -> pl.DataFrame:
    """Faixa de risco 1..5 por quintil da volatilidade observada.

    PLANO: "as faixas de risco saem de percentis dessa distribuicao, nao de
    rotulo arbitrario".
    """
    etapa("Faixas de risco (quintis de volatilidade)")
    cortes = [df["volatilidade"].quantile(q) for q in QUANTIS_RISCO]
    for q, c in zip(QUANTIS_RISCO, cortes):
        log(f"p{int(q * 100)} = {c:.2f}% a.a.")

    faixa = pl.when(pl.col("volatilidade") <= cortes[0]).then(1)
    for i, corte in enumerate(cortes[1:], start=2):
        faixa = faixa.when(pl.col("volatilidade") <= corte).then(i)
    faixa = faixa.otherwise(len(FAIXAS_RISCO))

    rotulos = {n: r for n, r in FAIXAS_RISCO}
    df = df.with_columns(faixa.cast(pl.Int8).alias("faixa_risco")).with_columns(
        pl.col("faixa_risco").replace_strict(rotulos, return_dtype=pl.Utf8).alias("faixa_rotulo")
    )

    print(
        df.group_by("faixa_risco", "faixa_rotulo")
        .agg(pl.len().alias("n"), pl.col("volatilidade").median().round(2).alias("vol_mediana"))
        .sort("faixa_risco")
    )
    return df


def agrupar_estrategias(df: pl.DataFrame) -> pl.DataFrame:
    """Cauda longa da Anbima vira 'Outras' — ver MIN_CLASSES_POR_ESTRATEGIA."""
    etapa("Estrategias")
    contagem = df.group_by("estrategia").len()
    mantidas = set(
        contagem.filter(pl.col("len") >= MIN_CLASSES_POR_ESTRATEGIA)["estrategia"].to_list()
    )
    df = df.with_columns(
        pl.when(pl.col("estrategia").is_in(list(mantidas)))
        .then(pl.col("estrategia"))
        .otherwise(pl.lit(ROTULO_ESTRATEGIA_RESIDUAL))
        .alias("estrategia_cod")
    )
    residuais = df.filter(pl.col("estrategia_cod") == ROTULO_ESTRATEGIA_RESIDUAL).height
    log(f"{len(mantidas)} estrategias com categoria propria; {residuais} classes em 'Outras'")

    # Sinais binarios uteis que a etiqueta Anbima carrega em texto. Baratos
    # de extrair e diretamente ligados a complexidade percebida do produto.
    df = df.with_columns(
        pl.col("estrategia").str.contains("Exterior").cast(pl.Int8).alias("exterior"),
        pl.col("estrategia").str.contains("Indexado|Índice").cast(pl.Int8).alias("indexado"),
    )
    log(f"investem no exterior: {df['exterior'].sum()} | indexados: {df['indexado'].sum()}")
    return df


def normalizar(col: str) -> pl.Expr:
    """Min-max para 0-1.

    Divisor protegido: coluna constante viraria divisao por zero.
    """
    menor, maior = pl.col(col).min(), pl.col(col).max()
    return pl.when(maior == menor).then(0.5).otherwise((pl.col(col) - menor) / (maior - menor))


def construir_vetores(df: pl.DataFrame) -> tuple[pl.DataFrame, list[str]]:
    etapa("Vetorizacao")

    # Rank percentual em vez de min-max cru nos fatores de risco: a cauda de
    # volatilidade e longissima (FMP-FGTS a 25% contra renda fixa a 0,05%) e
    # o min-max jogaria 90% das classes num amontoado perto de zero.
    df = df.with_columns(
        (pl.col("volatilidade").rank() / pl.len()).alias("vol_rank"),
        (pl.col("retorno_periodo").rank() / pl.len()).alias("ret_rank"),
        # Patrimonio em log: a distribuicao anda em ordens de grandeza, de
        # alguns milhoes a dezenas de bilhoes.
        pl.col("patrimonio_liquido").log1p().alias("log_pl"),
    )
    df = df.with_columns(normalizar("log_pl").alias("pl_norm"))

    classificacoes = sorted(df["classificacao"].unique().to_list())
    publicos = sorted(df["publico_alvo"].unique().to_list())
    estrategias = sorted(df["estrategia_cod"].unique().to_list())

    nomes: list[str] = []
    colunas: list[pl.Expr] = []

    # Bloco 1 — risco (peso 0.40)
    colunas.append((pl.col("vol_rank") * PESOS["risco"] * SUBPESOS_RISCO["volatilidade"]).alias("v_vol"))
    nomes.append("risco:volatilidade")
    colunas.append((pl.col("ret_rank") * PESOS["risco"] * SUBPESOS_RISCO["retorno"]).alias("v_ret"))
    nomes.append("risco:retorno")

    # Bloco 2 — classificacao (one-hot, peso 0.20)
    for c in classificacoes:
        colunas.append(
            ((pl.col("classificacao") == c).cast(pl.Float64) * PESOS["classificacao"]).alias(f"v_cl_{c}")
        )
        nomes.append(f"classificacao:{c}")

    # Bloco 3 — publico-alvo (one-hot, peso 0.15)
    for p in publicos:
        colunas.append(
            ((pl.col("publico_alvo") == p).cast(pl.Float64) * PESOS["publico_alvo"]).alias(f"v_pa_{p}")
        )
        nomes.append(f"publico_alvo:{p}")

    # Bloco 4 — estrategia (one-hot, peso 0.15)
    for e in estrategias:
        colunas.append(
            ((pl.col("estrategia_cod") == e).cast(pl.Float64) * PESOS["estrategia"]).alias(f"v_es_{e}")
        )
        nomes.append(f"estrategia:{e}")

    # Bloco 5 — porte e liquidez (peso 0.10)
    colunas.append(
        (pl.col("pl_norm") * PESOS["porte_liquidez"] * SUBPESOS_PORTE["patrimonio"]).alias("v_pl")
    )
    nomes.append("porte:patrimonio")
    colunas.append(
        ((pl.col("forma_condominio") == "Aberto").cast(pl.Float64)
         * PESOS["porte_liquidez"] * SUBPESOS_PORTE["aberto"]).alias("v_aberto")
    )
    nomes.append("porte:aberto")
    colunas.append(
        ((pl.col("esg") == "S").cast(pl.Float64)
         * PESOS["porte_liquidez"] * SUBPESOS_PORTE["esg"]).alias("v_esg")
    )
    nomes.append("porte:esg")

    df = df.with_columns(colunas)
    log(f"vetor com {len(nomes)} dimensoes")
    exigir(len(nomes) == len(set(nomes)), "nomes de dimensao unicos")
    return df, nomes


def exportar(df: pl.DataFrame, nomes: list[str]) -> None:
    etapa("Export")
    colunas_vetor = [c for c in df.columns if c.startswith("v_")]
    exigir(len(colunas_vetor) == len(nomes), "uma coluna por dimensao declarada")

    DADOS.mkdir(parents=True, exist_ok=True)
    df.write_parquet(DADOS / "fatores.parquet")
    log(f"gravado dados/fatores.parquet ({(DADOS / 'fatores.parquet').stat().st_size / 1e3:.0f} KB)")

    registros = []
    for linha in df.iter_rows(named=True):
        registros.append(
            {
                "cnpj": linha["cnpj"],
                "nome": linha["denominacao"],
                "classificacao": linha["classificacao"],
                "estrategia": linha["estrategia"],
                "publicoAlvo": linha["publico_alvo"],
                "patrimonioLiquido": round(linha["patrimonio_liquido"], 2),
                "cotistas": linha["nr_cotst"],
                "volatilidade": round(linha["volatilidade"], 2),
                "retornoPeriodo": round(linha["retorno_periodo"], 2),
                "faixaRisco": linha["faixa_risco"],
                "faixaRotulo": linha["faixa_rotulo"],
                "formaCondominio": linha["forma_condominio"],
                "esg": linha["esg"] == "S",
                "exterior": bool(linha["exterior"]),
                # 6 casas bastam: os pesos ja sao <= 0.4 e o JSON encolhe.
                "vetor": [round(linha[c], 6) for c in colunas_vetor],
            }
        )

    saida = {
        "versaoEsquema": VERSAO_ESQUEMA,
        "dimensoes": nomes,
        "pesos": PESOS,
        "geradoEm": date.today().isoformat(),
        "classes": registros,
    }
    APP_DADOS.mkdir(parents=True, exist_ok=True)
    destino = APP_DADOS / "classes.json"
    destino.write_text(json.dumps(saida, ensure_ascii=False), encoding="utf-8")
    log(f"gravado app/dados/classes.json ({destino.stat().st_size / 1e6:.2f} MB, {len(registros)} classes)")


def main() -> None:
    df = juntar()
    df = faixa_por_percentil(df)
    df = agrupar_estrategias(df)
    df, nomes = construir_vetores(df)
    exportar(df, nomes)
    etapa("Etapa 4 concluida")


if __name__ == "__main__":
    main()
