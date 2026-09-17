"""Regra de negocio da codificacao: pesos, faixas de risco e versao do esquema.

POR QUE ESTE ARQUIVO EXISTE
---------------------------
O caminho ingenuo, comum em tutorial de recomendacao, e um literal no topo
do codigo:

    const PESOS = { categoria: 0.4, cor: 0.3, preco: 0.2, idade: 0.1 }

Num recomendador de e-commerce, errar o peso da cor gera recomendacao ruim.
Em investimento, o peso do risco E a suitability — que e atividade regulada.
Numero chutado ali vira risco regulatorio. Entao cada peso abaixo tem
justificativa escrita e ordem derivada de regra publica, nao de chute.

ORDEM DE RELEVANCIA (CVM Res. 30, art. 2 — verificacao de adequacao)
A norma manda o intermediario verificar, nesta ordem de materialidade:
  1. se o produto e adequado aos OBJETIVOS e ao PERFIL DE RISCO do cliente;
  2. se a situacao financeira do cliente e compativel (capacidade/elegibilidade);
  3. se o cliente tem CONHECIMENTO para entender os riscos do produto.
Os pesos espelham essa ordem. Nao sao "o que funciona melhor no treino" —
sao o que a regra diz que importa. Se mudarem, muda por decisao de negocio
registrada, e a VERSAO_ESQUEMA sobe junto.

ARMADILHA: "RETREINOU, REINDEXOU"
Os vetores sao produzidos por esta regra. Se um peso ou o conjunto de
categorias mudar, todo vetor ja gravado vira lixo SILENCIOSAMENTE — sem
erro, so recomendacao ruim. Por isso `VERSAO_ESQUEMA` viaja junto com os
vetores no JSON, e o app recusa carregar um export de versao diferente.
"""
from __future__ import annotations

# Suba esta versao a QUALQUER mudanca em pesos, faixas ou categorias.
VERSAO_ESQUEMA = "1.0.0"

PESOS = {
    # 1o criterio da Res. 30: adequacao ao perfil de risco. E o fator que
    # a norma trata como essencial, e leva o maior peso isolado.
    "risco": 0.40,
    # A classe de ativo e a familia do produto: define a natureza do risco
    # (credito, mercado, cambial), nao so a intensidade.
    "classificacao": 0.20,
    # 2o criterio: elegibilidade. Publico_Alvo e restricao LEGAL de acesso
    # e, na falta de aporte minimo nos dados abertos, tambem o unico proxy
    # de capital exigido (ver "O que a base NAO tem", no PLANO).
    "publico_alvo": 0.15,
    # 3o criterio: complexidade que o cliente precisa entender. A
    # estrategia Anbima e o proxy disponivel (exterior, alavancagem,
    # long/short exigem mais repertorio que um DI simples).
    "estrategia": 0.15,
    # Robustez operacional e liquidez. Importa, mas e o de menor
    # materialidade para adequacao: um fundo grande e aberto nao deixa de
    # ser inadequado a um conservador por ser grande e aberto.
    "porte_liquidez": 0.10,
}

assert abs(sum(PESOS.values()) - 1.0) < 1e-9, "os pesos precisam somar 1"

# Faixas de risco. O PLANO e explicito: saem de PERCENTIS da distribuicao
# real de volatilidade do universo, nao de rotulo arbitrario. Quintis dao
# cinco faixas com massa parecida, o que evita faixa vazia.
FAIXAS_RISCO = [
    (1, "Muito baixo"),
    (2, "Baixo"),
    (3, "Medio"),
    (4, "Alto"),
    (5, "Muito alto"),
]
QUANTIS_RISCO = [0.20, 0.40, 0.60, 0.80]

# Perfil declarado -> faixa de risco alvo. Tambem regra de negocio: e o
# mapa que liga "apetite a risco" do formulario a um numero comparavel com
# a faixa do produto.
APETITE_PARA_FAIXA = {
    "conservador": 1,
    "moderado": 3,
    "arrojado": 5,
}

# Elegibilidade legal por publico-alvo. Aproximacao honesta e assumida: os
# dados abertos NAO trazem aporte minimo (esta no regulamento). Os valores
# sao os limites da Res. CVM 30 para investidor qualificado/profissional.
# A UI precisa dizer que isso e proxy, nao o minimo real do fundo.
CAPITAL_MINIMO_PUBLICO = {
    "Público Geral": 0.0,
    "Qualificado": 1_000_000.0,
    "Profissional": 10_000_000.0,
}

# Estrategias Anbima com pelo menos este numero de classes viram categoria
# propria no one-hot; o resto cai em "Outras". Sem isso o vetor ganha 48
# posicoes, quase todas quase sempre zero.
MIN_CLASSES_POR_ESTRATEGIA = 20
ROTULO_ESTRATEGIA_RESIDUAL = "Outras"
