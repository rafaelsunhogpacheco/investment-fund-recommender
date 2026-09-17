export class AppController {
    #perfilView;
    #treinoView;
    #recomendacaoView;
    #eventos;
    #perfilAtual = null;
    #treinado = false;

    constructor({ perfilView, treinoView, recomendacaoView, eventos }) {
        this.#perfilView = perfilView;
        this.#treinoView = treinoView;
        this.#recomendacaoView = recomendacaoView;
        this.#eventos = eventos;
        this.#configurar();
    }

    static init(deps) {
        return new AppController(deps);
    }

    #configurar() {
        this.#perfilView.aoAlterar((perfil) => {
            this.#perfilAtual = perfil;
            if (this.#treinado) this.#perfilView.habilitarRecomendar();
        });

        this.#perfilView.aoRecomendar(() => {
            if (!this.#perfilAtual) return;
            this.#recomendacaoView.mostrarCarregando();
            this.#eventos.recomendar.disparar(this.#perfilAtual);
        });

        this.#treinoView.aoTreinar(() => this.#eventos.treinar.disparar({}));

        this.#eventos.progressoTreino.ouvir((d) => this.#treinoView.atualizarProgresso(d));
        this.#eventos.logTreino.ouvir((d) => this.#treinoView.registrarEpoca(d));

        this.#eventos.treinoConcluido.ouvir((resultado) => {
            this.#treinado = true;
            this.#treinoView.mostrarResultado(resultado);
            if (this.#perfilAtual) this.#perfilView.habilitarRecomendar();
        });

        this.#eventos.recomendacoesProntas.ouvir((d) => this.#recomendacaoView.renderizar(d));
        this.#eventos.erro.ouvir((msg) => this.#treinoView.mostrarErro(msg));
    }

    iniciar() {
        this.#perfilAtual = this.#perfilView.lerPerfil();
        this.#eventos.treinar.disparar({});
    }
}
