import { eventosWorker } from '../events/constants.js';

export class WorkerController {
    #worker;
    #eventos;
    // Pedido de recomendacao antes do treino terminar e descartado. Nao e
    // bug — e o que impede predict() sem modelo.
    #treinado = false;

    constructor({ worker, eventos }) {
        this.#worker = worker;
        this.#eventos = eventos;
        this.#configurar();
    }

    static init(deps) {
        return new WorkerController(deps);
    }

    #configurar() {
        this.#eventos.treinar.ouvir(() => {
            this.#treinado = false;
            this.#worker.postMessage({ acao: eventosWorker.treinar });
        });

        this.#eventos.recomendar.ouvir((perfil) => {
            if (!this.#treinado) return;
            this.#worker.postMessage({ acao: eventosWorker.recomendar, perfil });
        });

        const rotas = {
            [eventosWorker.progresso]: (d) => this.#eventos.progressoTreino.disparar(d),
            [eventosWorker.logTreino]: (d) => this.#eventos.logTreino.disparar(d),
            [eventosWorker.treinoConcluido]: (d) => {
                this.#treinado = true;
                this.#eventos.treinoConcluido.disparar(d.resultado);
            },
            [eventosWorker.recomendacoes]: (d) => this.#eventos.recomendacoesProntas.disparar(d),
            [eventosWorker.erro]: (d) => this.#eventos.erro.disparar(d.mensagem),
        };

        this.#worker.onmessage = (evento) => {
            const rota = rotas[evento.data.type];
            if (rota) rota(evento.data);
        };
        this.#worker.onerror = (e) => this.#eventos.erro.disparar(e.message);
    }
}
