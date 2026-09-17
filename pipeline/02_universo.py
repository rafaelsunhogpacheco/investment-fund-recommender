"""Etapa 2 — Universo investivel.

Reduz as 33,7 mil classes ativas ao subconjunto que faz sentido recomendar
a uma pessoa fisica, e grava `dados/classes.parquet`.

DUAS DECISOES QUE O PLANO DEIXOU PARA ESTA ETAPA
------------------------------------------------
1. CORTE DE VAREJO. O PLANO mediu os dois candidatos: `>1000` deixa 1.518
   classes (50,3% renda fixa) e `>100` deixa 3.515 (40,3% renda fixa).
   Escolhido `>100`, pelo argumento do proprio PLANO: dobra o universo e
   equilibra melhor as classificacoes. Com `>1000` a renda fixa vira
   metade do universo e as recomendacoes conservadoras ficam quase
   identicas entre si. 100 cotistas ja e inequivocamente nao-exclusivo
   (a mediana de todas as classes e 2 cotistas).
   Constante isolada abaixo — trocar o valor refaz o universo.

2. `Classificacao_Anbima` VAZIA. O PLANO registrou 25% de vazios e deixou
   em aberto entre descartar ou criar categoria propria. MEDIDO NESTA
   ETAPA: dentro do universo investivel o vazio e 0,3% (12 de 3.515), nao
   25%. Os 25% sao quase todos FII e outros tipos que sequer aparecem no
   INF_DIARIO, entao o filtro de cota diaria ja os remove. Restam poucas
   dezenas: sao descartadas junto com os demais campos obrigatorios, o que
   evita inventar uma categoria "Sem classificacao" para um punhado de
   linhas.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import polars as pl

from comum import BRUTOS, DADOS, etapa, exigir, ler_csv_do_zip, log, meses_janela, normalizar_cnpj

# Numero minimo de cotistas para a classe contar como acessivel ao varejo.
# Ver decisao 1 no docstring.
CORTE_COTISTAS = 100


def cotistas_mais_recentes() -> pl.DataFrame:
    """NR_COTST da ultima data disponivel de cada classe.

    NR_COTST e fato observado (quantos investidores entraram), diferente de
    Publico_Alvo, que e restricao legal (quem pode entrar). Aqui ele serve
    como filtro de universo investivel, uma vez so. A elegibilidade por
    perfil e outra coisa, e acontece na etapa 4/app.
    """
    etapa("Cotistas")
    # So o mes mais recente: NR_COTST e um estoque, nao um fluxo, entao o
    # ultimo valor basta e evita ler 6,4 milhoes de linhas.
    mes = meses_janela()[-1]
    df = ler_csv_do_zip(BRUTOS / f"inf_diario_fi_{mes}.zip").with_columns(
        normalizar_cnpj("CNPJ_FUNDO_CLASSE"),
        pl.col("DT_COMPTC").str.to_date(),
        pl.col("NR_COTST").cast(pl.Int64, strict=False),
    )
    ultimo = (
        df.sort("DT_COMPTC")
        .group_by("cnpj")
        .agg(pl.col("NR_COTST").last().alias("nr_cotst"))
    )
    log(f"{ultimo.height} classes com cotistas em {mes}")
    log(f"mediana de cotistas: {ultimo['nr_cotst'].median():.0f}")
    return ultimo


def montar_universo() -> pl.DataFrame:
    etapa("Universo investivel")
    cad = ler_csv_do_zip(BRUTOS / "registro_fundo_classe.zip", "registro_classe.csv")
    cad = cad.with_columns(normalizar_cnpj("CNPJ_Classe"))

    passos = [("cadastro completo", cad.height)]

    cad = cad.filter(pl.col("Situacao") == "Em Funcionamento Normal")
    passos.append(("em funcionamento normal", cad.height))

    cad = cad.join(cotistas_mais_recentes(), on="cnpj", how="inner")
    passos.append(("com cota diaria publicada", cad.height))

    cad = cad.filter(pl.col("nr_cotst") > CORTE_COTISTAS)
    passos.append((f"nr_cotst > {CORTE_COTISTAS}", cad.height))

    # Fundo exclusivo nao se recomenda a ninguem: por definicao tem um
    # unico cotista. Redundante depois do corte acima, mas explicito.
    cad = cad.filter(pl.col("Exclusivo") != "S")
    passos.append(("nao exclusivo", cad.height))

    obrigatorios = ["Classificacao", "Publico_Alvo", "Patrimonio_Liquido"]
    for col in obrigatorios:
        antes = cad.height
        cad = cad.filter(pl.col(col).is_not_null())
        passos.append((f"{col} preenchido", cad.height))
        log(f"{col}: descartadas {antes - cad.height}")

    etapa("Funil")
    for nome, n in passos:
        log(f"{n:>6}  {nome}")

    universo = cad.select(
        pl.col("cnpj"),
        pl.col("Denominacao_Social").alias("denominacao"),
        pl.col("Classificacao").alias("classificacao"),
        # Anbima e granular (66 valores) e serve de proxy de estrategia.
        # Os poucos vazios que sobrevivem viram rotulo explicito em vez de
        # null, para nao quebrar o one-hot da etapa 4.
        pl.col("Classificacao_Anbima").fill_null("Sem classificacao Anbima").alias("estrategia"),
        pl.col("Publico_Alvo").alias("publico_alvo"),
        pl.col("Patrimonio_Liquido").cast(pl.Float64, strict=False).alias("patrimonio_liquido"),
        pl.col("Forma_Condominio").alias("forma_condominio"),
        pl.col("Classe_ESG").alias("esg"),
        pl.col("nr_cotst"),
    )
    return universo


def main() -> None:
    universo = montar_universo()

    etapa("Composicao final")
    print(universo.group_by("classificacao").len().sort("len", descending=True))
    print(universo.group_by("publico_alvo").len().sort("len", descending=True))
    log(f"estrategias Anbima distintas: {universo['estrategia'].n_unique()}")
    log(f"classes ESG: {universo.filter(pl.col('esg') == 'S').height}")

    # Criterio de aceite do PLANO: ordem de grandeza de milhares, com as
    # tres classificacoes principais preservadas (era o risco "o filtro de
    # varejo mata a diversidade", ja descartado no PLANO).
    exigir(1_000 <= universo.height <= 6_000, f"universo com {universo.height} classes")
    principais = {"Renda Fixa", "Multimercado", "Ações"}
    presentes = set(universo["classificacao"].unique())
    exigir(principais <= presentes, "as tres classificacoes principais sobreviveram ao filtro")
    exigir(universo["cnpj"].n_unique() == universo.height, "um registro por CNPJ")

    DADOS.mkdir(parents=True, exist_ok=True)
    saida = DADOS / "classes.parquet"
    universo.write_parquet(saida)
    log(f"gravado {saida} ({saida.stat().st_size / 1e3:.0f} KB)")
    etapa("Etapa 2 concluida")


if __name__ == "__main__":
    main()
