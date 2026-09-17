"""Etapa 3 — Risco.

Volatilidade anualizada e retorno acumulado por classe, sobre 12 meses de
INF_DIARIO, gravados em `dados/risco.parquet`.

CRITERIO DE ACEITE (PLANO.md): a ordenacao por mediana de volatilidade tem
que sair renda fixa < multimercado < acoes. Ja confirmado com 1 mes; aqui
a janela vai a 12 meses, que e o que o PLANO pede para a versao final
(~21 pregoes era pouco para uma estimativa estavel).

DUAS FONTES DE LINHA DUPLICADA, as duas resolvidas em `escolher_serie_unica`:

1. SUBCLASSES. 265 CNPJs publicam varias linhas por data, uma por subclasse
   (ate 7). Cada subclasse tem a sua propria cota, em escala propria, entao
   media entre elas nao significa nada. Escolhe-se UMA serie por CNPJ: a do
   nivel classe (ID_SUBCLASSE vazio) quando existe, senao a subclasse com
   mais observacoes.

2. ESTRUTURA LEGADA SOBREPOSTA. Descoberto ao rodar esta etapa: algumas
   dezenas de CNPJs publicam DUAS linhas de nivel classe na mesma data, uma
   sob `TP_FUNDO_CLASSE = 'FI'` (estrutura antiga) e outra sob
   'CLASSES - FIF' (Res. CVM 175). Sao 88 linhas em 12 meses, concentradas
   em 2025-09..2026-01 — o rastro da migracao. Fica a estrutura nova, que e
   a mesma do cadastro usado na etapa 2.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import polars as pl

from comum import BRUTOS, DADOS, etapa, exigir, ler_csv_do_zip, log, meses_janela, normalizar_cnpj

# Pregoes por ano — fator padrao para anualizar desvio-padrao diario.
PREGOES_ANO = 252

# Minimo de observacoes para a estimativa valer. Com 12 meses o normal e
# ~250; exigir 120 descarta classes que so tem serie parcial (nasceram no
# meio da janela) sem ser rigido demais.
MIN_OBSERVACOES = 120


def carregar_series() -> pl.DataFrame:
    etapa("Series diarias (12 meses)")
    partes = []
    for aaaamm in meses_janela():
        caminho = BRUTOS / f"inf_diario_fi_{aaaamm}.zip"
        if not caminho.exists():
            log(f"AVISO: {aaaamm} ausente, fora da janela")
            continue
        partes.append(
            ler_csv_do_zip(caminho).select(
                "CNPJ_FUNDO_CLASSE", "ID_SUBCLASSE", "DT_COMPTC", "VL_QUOTA", "TP_FUNDO_CLASSE"
            )
        )
    df = pl.concat(partes).with_columns(
        normalizar_cnpj("CNPJ_FUNDO_CLASSE"),
        pl.col("DT_COMPTC").str.to_date(),
        pl.col("VL_QUOTA").cast(pl.Float64, strict=False),
    )
    # Cota nula ou <= 0 quebra o log-retorno e nao tem sentido economico.
    df = df.filter(pl.col("VL_QUOTA").is_not_null() & (pl.col("VL_QUOTA") > 0))
    log(f"{df.height} observacoes, {df['cnpj'].n_unique()} classes")
    return df


def escolher_serie_unica(df: pl.DataFrame) -> pl.DataFrame:
    """Uma serie por CNPJ — ver nota sobre subclasses no docstring."""
    etapa("Desambiguacao de subclasses")
    antes = df.height

    # Marca, por CNPJ, se existe serie de nivel classe.
    tem_nivel_classe = (
        df.group_by("cnpj")
        .agg(pl.col("ID_SUBCLASSE").is_null().any().alias("tem_classe"))
    )
    df = df.join(tem_nivel_classe, on="cnpj", how="left")

    # Onde existe nivel classe, fica so ele.
    df = df.filter(~pl.col("tem_classe") | pl.col("ID_SUBCLASSE").is_null())

    # Onde nao existe, escolhe a subclasse com mais observacoes (desempate
    # pelo menor id, para o resultado ser deterministico entre execucoes).
    escolhida = (
        df.filter(pl.col("ID_SUBCLASSE").is_not_null())
        .group_by("cnpj", "ID_SUBCLASSE")
        .len()
        .sort(["cnpj", "len", "ID_SUBCLASSE"], descending=[False, True, False])
        .group_by("cnpj")
        .first()
        .select("cnpj", pl.col("ID_SUBCLASSE").alias("subclasse_escolhida"))
    )
    df = (
        df.join(escolhida, on="cnpj", how="left")
        .filter(
            pl.col("ID_SUBCLASSE").is_null()
            | (pl.col("ID_SUBCLASSE") == pl.col("subclasse_escolhida"))
        )
        .drop("tem_classe", "subclasse_escolhida")
    )

    log(f"{antes - df.height} observacoes descartadas de subclasses nao escolhidas")

    # Duplicidade 2: estrutura legada sobreposta a nova (ver docstring).
    restantes = df.group_by("cnpj", "DT_COMPTC").len().filter(pl.col("len") > 1)
    if restantes.height:
        log(f"{restantes.height} datas ainda duplicadas apos subclasse — estrutura legada")
        df = (
            df.with_columns(
                # 0 = estrutura Res. 175 (preferida), 1 = legado 'FI'.
                (pl.col("TP_FUNDO_CLASSE") == "FI").cast(pl.Int8).alias("_legado")
            )
            .sort(["cnpj", "DT_COMPTC", "_legado", "VL_QUOTA"])
            .unique(subset=["cnpj", "DT_COMPTC"], keep="first", maintain_order=True)
            .drop("_legado")
        )

    duplicados = df.group_by("cnpj", "DT_COMPTC").len().filter(pl.col("len") > 1).height
    exigir(duplicados == 0, "uma unica observacao por (classe, data)")
    return df


def calcular_fatores(df: pl.DataFrame) -> pl.DataFrame:
    etapa("Volatilidade e retorno")
    df = df.sort("cnpj", "DT_COMPTC")

    # Log-retorno diario: ln(q_t / q_{t-1}). Log e nao variacao simples
    # porque log-retornos somam no tempo e sao simetricos, que e o que
    # justifica anualizar multiplicando por sqrt(252).
    retornos = df.with_columns(
        (pl.col("VL_QUOTA") / pl.col("VL_QUOTA").shift(1).over("cnpj")).log().alias("log_ret")
    ).filter(pl.col("log_ret").is_not_null() & pl.col("log_ret").is_finite())

    fatores = retornos.group_by("cnpj").agg(
        pl.len().alias("observacoes"),
        (pl.col("log_ret").std() * (PREGOES_ANO ** 0.5) * 100).alias("volatilidade"),
        # Retorno acumulado no periodo = exp(soma dos log-retornos) - 1.
        ((pl.col("log_ret").sum().exp() - 1) * 100).alias("retorno_periodo"),
        pl.col("DT_COMPTC").min().alias("inicio"),
        pl.col("DT_COMPTC").max().alias("fim"),
    )

    antes = fatores.height
    fatores = fatores.filter(
        (pl.col("observacoes") >= MIN_OBSERVACOES)
        & pl.col("volatilidade").is_not_null()
        & pl.col("volatilidade").is_finite()
    )
    log(f"{antes - fatores.height} classes descartadas por serie curta (< {MIN_OBSERVACOES} pregoes)")
    log(f"{fatores.height} classes com fatores de risco")
    return fatores


def validar_ordenacao(fatores: pl.DataFrame) -> None:
    """O criterio de aceite do PLANO: a teoria tem que aparecer nos dados."""
    etapa("Validacao: risco por classificacao")
    classes = pl.read_parquet(DADOS / "classes.parquet")
    juncao = classes.join(fatores, on="cnpj", how="inner")
    log(f"{juncao.height} das {classes.height} classes do universo tem risco")

    resumo = (
        juncao.group_by("classificacao")
        .agg(
            pl.len().alias("n"),
            pl.col("volatilidade").quantile(0.25).round(2).alias("p25"),
            pl.col("volatilidade").median().round(2).alias("mediana"),
            pl.col("volatilidade").quantile(0.75).round(2).alias("p75"),
            pl.col("retorno_periodo").median().round(2).alias("retorno_med"),
        )
        .sort("mediana", descending=True)
    )
    print(resumo)

    medianas = {l["classificacao"]: l["mediana"] for l in resumo.to_dicts()}
    exigir(
        medianas["Renda Fixa"] < medianas["Multimercado"] < medianas["Ações"],
        "renda fixa < multimercado < acoes (mediana de volatilidade)",
    )


def main() -> None:
    series = escolher_serie_unica(carregar_series())
    fatores = calcular_fatores(series)

    DADOS.mkdir(parents=True, exist_ok=True)
    saida = DADOS / "risco.parquet"
    fatores.write_parquet(saida)
    log(f"gravado {saida} ({saida.stat().st_size / 1e3:.0f} KB)")

    validar_ordenacao(fatores)
    etapa("Etapa 3 concluida")


if __name__ == "__main__":
    main()
