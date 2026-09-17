const moeda = new Intl.NumberFormat('pt-BR', {
    style: 'currency', currency: 'BRL', notation: 'compact', maximumFractionDigits: 1,
});

export class RecomendacaoView {
    #lista = document.querySelector('#listaRecomendacoes');
    #resumo = document.querySelector('#resumoRecomendacoes');

    mostrarCarregando() {
        this.#resumo.textContent = 'Pontuando classes...';
        this.#lista.innerHTML = '';
    }

    renderizar({ recomendacoes, universo, referencias, perfil }) {
        this.#resumo.innerHTML =
            `<strong>${recomendacoes.length}</strong> classes mais aderentes, ` +
            `pontuadas entre <strong>${universo.toLocaleString('pt-BR')}</strong> elegíveis ` +
            `para capital de ${moeda.format(perfil.capital)}. ` +
            `Perfil sem histórico: nota média de ${referencias.toLocaleString('pt-BR')} ` +
            `clientes simulados de apetite <em>${perfil.apetite}</em> e idade próxima.`;

        this.#lista.innerHTML = recomendacoes.map((r, i) => `
            <article class="classe faixa-${r.faixaRisco}">
                <header>
                    <span class="posicao">${i + 1}</span>
                    <h3>${r.nome}</h3>
                    <span class="nota" title="Saída da rede (0–1)">${r.nota.toFixed(3)}</span>
                </header>
                <div class="etiquetas">
                    <span class="etiqueta classificacao">${r.classificacao}</span>
                    <span class="etiqueta risco">Risco ${r.faixaRotulo.toLowerCase()}</span>
                    <span class="etiqueta">${r.publicoAlvo}</span>
                    ${r.esg ? '<span class="etiqueta esg">ESG</span>' : ''}
                    ${r.exterior ? '<span class="etiqueta">Exterior</span>' : ''}
                </div>
                <p class="estrategia">${r.estrategia}</p>
                <dl class="numeros">
                    <div><dt>Volatilidade (12m)</dt><dd>${r.volatilidade.toFixed(2)}% a.a.</dd></div>
                    <div><dt>Retorno (12m)</dt><dd class="${r.retornoPeriodo >= 0 ? 'positivo' : 'negativo'}">${r.retornoPeriodo.toFixed(2)}%</dd></div>
                    <div><dt>Patrimônio</dt><dd>${moeda.format(r.patrimonioLiquido)}</dd></div>
                    <div><dt>Cotistas</dt><dd>${r.cotistas.toLocaleString('pt-BR')}</dd></div>
                </dl>
            </article>
        `).join('');
    }
}
