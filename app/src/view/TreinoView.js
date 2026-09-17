export class TreinoView {
    #botao = document.querySelector('#btnTreinar');
    #barra = document.querySelector('#barraProgresso');
    #status = document.querySelector('#statusTreino');
    #metricas = document.querySelector('#metricas');
    #epocas = document.querySelector('#epocas');
    #aoTreinar;

    constructor() {
        this.#botao.addEventListener('click', () => {
            this.#epocas.innerHTML = '';
            this.#metricas.innerHTML = '';
            if (this.#aoTreinar) this.#aoTreinar();
        });
    }

    aoTreinar(cb) { this.#aoTreinar = cb; }

    atualizarProgresso({ progresso, mensagem }) {
        this.#botao.disabled = progresso < 100;
        this.#barra.style.width = `${progresso}%`;
        this.#status.textContent = mensagem ?? '';
    }

    registrarEpoca({ epoca, perda, acuracia, perdaValidacao, acuraciaValidacao }) {
        const linha = document.createElement('div');
        linha.className = 'epoca';
        linha.innerHTML =
            `<span>época ${String(epoca + 1).padStart(2, '0')}</span>` +
            `<span>perda ${perda.toFixed(4)}</span>` +
            `<span>acurácia ${(acuracia * 100).toFixed(1)}%</span>` +
            `<span class="val">val ${(acuraciaValidacao * 100).toFixed(1)}%</span>`;
        this.#epocas.prepend(linha);
    }

    mostrarResultado(r) {
        const ganho = (r.acuraciaValidacao - r.linhaBase) * 100;
        this.#metricas.innerHTML = `
            <div class="metrica destaque">
                <span class="rotulo">Acurácia na validação</span>
                <span class="valor">${(r.acuraciaValidacao * 100).toFixed(1)}%</span>
                <span class="nota">linha de base ${(r.linhaBase * 100).toFixed(1)}%
                    (responder "não" para tudo) · ganho ${ganho >= 0 ? '+' : ''}${ganho.toFixed(1)} p.p.</span>
            </div>
            <div class="metrica"><span class="rotulo">Perda (validação)</span><span class="valor">${r.perdaValidacao.toFixed(4)}</span></div>
            <div class="metrica"><span class="rotulo">Clientes treino / validação</span><span class="valor">${r.clientesTreino} / ${r.clientesValidacao}</span></div>
            <div class="metrica"><span class="rotulo">Linhas treino / validação</span><span class="valor">${r.linhasTreino.toLocaleString('pt-BR')} / ${r.linhasValidacao.toLocaleString('pt-BR')}</span></div>
            <div class="metrica"><span class="rotulo">Parâmetros treináveis</span><span class="valor">${r.parametros.toLocaleString('pt-BR')}</span></div>
            <div class="metrica"><span class="rotulo">Esquema de codificação</span><span class="valor">v${r.versaoEsquema}</span></div>
        `;
        this.#status.textContent = 'Treino concluído — selecione o perfil e peça a recomendação.';
    }

    mostrarErro(mensagem) {
        this.#status.innerHTML = `<span class="erro">Erro: ${mensagem}</span>`;
        this.#botao.disabled = false;
    }
}
