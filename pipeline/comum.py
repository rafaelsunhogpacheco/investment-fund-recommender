"""Caminhos, download e utilitarios compartilhados pelo pipeline.

Tudo que mais de uma etapa precisa mora aqui. As etapas sao scripts
numerados que rodam em ordem e se comunicam por parquet em `dados/`.
"""
from __future__ import annotations

import sys
import urllib.request
import zipfile
from datetime import date
from pathlib import Path

import polars as pl

RAIZ = Path(__file__).resolve().parent.parent
DADOS = RAIZ / "dados"
BRUTOS = DADOS / "brutos"
APP_DADOS = RAIZ / "app" / "dados"

URL_CADASTRO = "https://dados.cvm.gov.br/dados/FI/CAD/DADOS/registro_fundo_classe.zip"
URL_INF_DIARIO = "https://dados.cvm.gov.br/dados/FI/DOC/INF_DIARIO/DADOS/inf_diario_fi_{aaaamm}.zip"

# A CVM publica os CSV em latin-1, nao utf-8. Ler como utf-8 quebra em
# qualquer denominacao social com acento — que e a maioria delas.
ENCODING_CVM = "latin-1"

# Quantos meses de INF_DIARIO a volatilidade usa. O PLANO registra que
# 1 mes (~21 pregoes) serviu para validar o metodo mas e pouco para a
# versao final; 12 meses e o alvo.
MESES_JANELA = 12


def log(msg: str) -> None:
    print(f"  {msg}", flush=True)


def etapa(titulo: str) -> None:
    print(f"\n=== {titulo} ===", flush=True)


def meses_janela(n: int = MESES_JANELA, fim: date | None = None) -> list[str]:
    """Os `n` meses fechados mais recentes, como 'AAAAMM'.

    O mes corrente fica de fora: a CVM so publica o INF_DIARIO completo
    depois que o mes fecha, e um mes parcial enviesaria a volatilidade.
    """
    hoje = fim or date.today()
    ano, mes = hoje.year, hoje.month
    saida = []
    for _ in range(n):
        mes -= 1
        if mes == 0:
            ano, mes = ano - 1, 12
        saida.append(f"{ano}{mes:02d}")
    return sorted(saida)


def baixar(url: str, destino: Path) -> Path:
    """Baixa `url` para `destino`, pulando se o arquivo ja existe.

    Idempotente de proposito: reexecutar o pipeline nao deve rebaixar
    ~140 MB. Para forcar, apague `dados/brutos/`.
    """
    destino.parent.mkdir(parents=True, exist_ok=True)
    if destino.exists() and destino.stat().st_size > 0:
        log(f"ja existe, pulando: {destino.name} ({destino.stat().st_size / 1e6:.1f} MB)")
        return destino
    log(f"baixando {url}")
    try:
        urllib.request.urlretrieve(url, destino)
    except Exception as erro:
        # Um mes ausente nao e fatal (a CVM as vezes atrasa a publicacao);
        # quem chama decide. Mas nao deixa arquivo pela metade no disco.
        destino.unlink(missing_ok=True)
        raise RuntimeError(f"falha ao baixar {url}: {erro}") from erro
    log(f"ok: {destino.name} ({destino.stat().st_size / 1e6:.1f} MB)")
    return destino


def ler_csv_do_zip(caminho_zip: Path, nome_csv: str | None = None) -> pl.DataFrame:
    """Le um CSV de dentro do zip da CVM, sem descompactar no disco."""
    with zipfile.ZipFile(caminho_zip) as z:
        if nome_csv is None:
            csvs = [n for n in z.namelist() if n.lower().endswith(".csv")]
            if len(csvs) != 1:
                raise ValueError(f"{caminho_zip.name} tem {len(csvs)} CSVs; especifique qual")
            nome_csv = csvs[0]
        bruto = z.read(nome_csv)
    return pl.read_csv(
        bruto,
        separator=";",
        encoding=ENCODING_CVM,
        infer_schema_length=0,  # tudo string; a conversao e explicita em cada etapa
        null_values=[""],
    )


def normalizar_cnpj(coluna: str) -> pl.Expr:
    """So os digitos do CNPJ.

    ARMADILHA JA DESCOBERTA (ver PLANO.md): as duas bases formatam
    diferente. INF_DIARIO traz '00.017.024/0001-53'; registro_classe traz
    '00332266000131'. Join direto retorna ZERO linhas. Normalizar os dois
    lados leva o join a ~100% das classes que tem cota diaria.
    """
    return (
        pl.col(coluna)
        .str.replace_all(r"[^0-9]", "")
        .str.zfill(14)
        .alias("cnpj")
    )


def exigir(condicao: bool, mensagem: str) -> None:
    """Criterio de aceite explicito. Falha alto e cedo, nao silenciosamente."""
    if not condicao:
        print(f"\nFALHA NO CRITERIO DE ACEITE: {mensagem}", file=sys.stderr)
        raise SystemExit(1)
    log(f"OK: {mensagem}")
