"""Etapa 1 — Ingestao.

Baixa os dois datasets da CVM, normaliza o CNPJ dos dois lados e confirma
que o cruzamento funciona.

CRITERIO DE ACEITE (PLANO.md): o join tem que devolver ~24,7 mil classes.
Se vier zero, o culpado e o formato do CNPJ — nao a ausencia de dados.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import polars as pl

from comum import (
    BRUTOS,
    URL_CADASTRO,
    URL_INF_DIARIO,
    baixar,
    etapa,
    exigir,
    ler_csv_do_zip,
    log,
    meses_janela,
    normalizar_cnpj,
)


def baixar_tudo() -> tuple[Path, list[Path]]:
    etapa("Download")
    cadastro = baixar(URL_CADASTRO, BRUTOS / "registro_fundo_classe.zip")

    diarios = []
    for aaaamm in meses_janela():
        destino = BRUTOS / f"inf_diario_fi_{aaaamm}.zip"
        try:
            diarios.append(baixar(URL_INF_DIARIO.format(aaaamm=aaaamm), destino))
        except RuntimeError as erro:
            # Mes ausente nao derruba o pipeline; a janela so fica menor.
            log(f"AVISO: {aaaamm} indisponivel ({erro})")
    exigir(len(diarios) >= 1, f"{len(diarios)} meses de INF_DIARIO disponiveis")
    return cadastro, diarios


def carregar_cadastro(caminho: Path) -> pl.DataFrame:
    etapa("Cadastro (registro_classe.csv)")
    # cad_fi.csv e legado e mostra so 22 fundos ativos: a base migrou para a
    # estrutura fundo/classe/subclasse da Res. CVM 175. Usar registro_classe.
    df = ler_csv_do_zip(caminho, "registro_classe.csv")
    log(f"{df.height} classes, {df.width} colunas")

    df = df.with_columns(normalizar_cnpj("CNPJ_Classe"))
    exigir(
        df.filter(pl.col("cnpj").str.len_chars() != 14).height == 0,
        "todo CNPJ do cadastro tem 14 digitos apos normalizar",
    )

    ativas = df.filter(pl.col("Situacao") == "Em Funcionamento Normal")
    log(f"em funcionamento normal: {ativas.height}")
    return df


def carregar_diarios(caminhos: list[Path]) -> pl.DataFrame:
    etapa("INF_DIARIO")
    partes = []
    for caminho in caminhos:
        mes = ler_csv_do_zip(caminho).select(
            "CNPJ_FUNDO_CLASSE", "ID_SUBCLASSE", "DT_COMPTC", "VL_QUOTA", "NR_COTST"
        )
        log(f"{caminho.stem[-6:]}: {mes.height} linhas")
        partes.append(mes)

    df = pl.concat(partes).with_columns(
        normalizar_cnpj("CNPJ_FUNDO_CLASSE"),
        pl.col("DT_COMPTC").str.to_date(),
        pl.col("VL_QUOTA").cast(pl.Float64, strict=False),
        pl.col("NR_COTST").cast(pl.Int64, strict=False),
    )
    log(f"total: {df.height} linhas, {df['cnpj'].n_unique()} CNPJs distintos")
    return df


def conferir_cruzamento(cadastro: pl.DataFrame, diario: pl.DataFrame) -> None:
    etapa("Cruzamento")

    # A demonstracao da armadilha, medida e nao assumida: o join no CNPJ
    # cru (com pontuacao de um lado e sem do outro) devolve zero.
    cru = cadastro.join(
        diario.select(pl.col("CNPJ_FUNDO_CLASSE").unique()),
        left_on="CNPJ_Classe",
        right_on="CNPJ_FUNDO_CLASSE",
        how="inner",
    )
    log(f"join no CNPJ CRU: {cru.height} linhas  <- a armadilha do PLANO")

    cnpjs_com_cota = diario.select("cnpj").unique()
    normalizado = cadastro.join(cnpjs_com_cota, on="cnpj", how="inner")
    log(f"join no CNPJ NORMALIZADO: {normalizado.height} linhas")

    exigir(cru.height == 0, "join cru devolve zero (armadilha do CNPJ confirmada)")
    exigir(
        20_000 <= normalizado.height <= 30_000,
        f"join normalizado devolve {normalizado.height} classes (~24,7 mil esperadas)",
    )

    cobertura = normalizado.height / max(cnpjs_com_cota.height, 1)
    log(f"cobertura: {cobertura:.1%} dos CNPJs com cota estao no cadastro")


def main() -> None:
    cadastro_zip, diarios_zip = baixar_tudo()
    cadastro = carregar_cadastro(cadastro_zip)
    diario = carregar_diarios(diarios_zip)
    conferir_cruzamento(cadastro, diario)
    etapa("Etapa 1 concluida")


if __name__ == "__main__":
    main()
