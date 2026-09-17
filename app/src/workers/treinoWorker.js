// Casca fina: carrega o TF.js, busca os JSON e delega tudo para o nucleo.
// A logica de ML vive em `../ml/nucleo.js` justamente para poder rodar fora
// do browser e ser conferida de verdade (ver verificar/treino.node.mjs).
import 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js';
import { eventosWorker } from '../events/constants.js';
import { montarContexto, montarDataset, treinar, avaliar, recomendar } from '../ml/nucleo.js';

let _ctx = null;
let _modelo = null;
let _dados = null;

// Caminho relativo A ESTE MODULO, nao a pagina. Dentro de um Worker o
// `fetch('./dados/x.json')` resolve contra a URL do worker
// (/src/workers/), nao contra a do documento — e da 404. Caminho absoluto
// ('/dados/classes.json') escaparia disso, mas so funciona se o app estiver
// servido na raiz do dominio.
const RAIZ_DADOS = new URL('../../dados/', import.meta.url);

async function carregarJson(nome) {
    const url = new URL(nome, RAIZ_DADOS);
    const resposta = await fetch(url);
    if (!resposta.ok) throw new Error(`falha ao carregar ${nome} (${resposta.status})`);
    return resposta.json();
}

async function acaoTreinar() {
    postMessage({ type: eventosWorker.progresso, progresso: 5, mensagem: 'Carregando dados...' });
    const [classes, clientes] = await Promise.all([
        carregarJson('classes.json'),
        carregarJson('clientes.json'),
    ]);

    postMessage({ type: eventosWorker.progresso, progresso: 20, mensagem: 'Montando dataset...' });
    _ctx = montarContexto({ classes, clientes });
    if (_dados) Object.values(_dados).forEach((t) => t?.dispose?.());
    _dados = montarDataset(_ctx);

    postMessage({ type: eventosWorker.progresso, progresso: 35, mensagem: 'Treinando...' });
    _modelo?.dispose();
    _modelo = await treinar(_dados, {
        aoFimDaEpoca: (epoca, logs) => {
            postMessage({
                type: eventosWorker.logTreino,
                epoca,
                perda: logs.loss,
                acuracia: logs.acc,
                perdaValidacao: logs.val_loss,
                acuraciaValidacao: logs.val_acc,
            });
        },
    });

    // Acuracia da VALIDACAO, nao a do treino — criterio de aceite do PLANO.
    const resultado = await avaliar(_modelo, _dados);

    postMessage({ type: eventosWorker.progresso, progresso: 100, mensagem: 'Concluído' });
    postMessage({
        type: eventosWorker.treinoConcluido,
        resultado: { ...resultado, versaoEsquema: _ctx.versaoEsquema },
    });
}

function acaoRecomendar({ perfil }) {
    if (!_modelo || !_ctx) return;
    const saida = recomendar({ modelo: _modelo, ctx: _ctx, perfil });
    postMessage({ type: eventosWorker.recomendacoes, ...saida });
}

const acoes = {
    [eventosWorker.treinar]: acaoTreinar,
    [eventosWorker.recomendar]: acaoRecomendar,
};

self.onmessage = async (evento) => {
    const { acao, ...dados } = evento.data;
    const executor = acoes[acao];
    if (!executor) return;
    try {
        await executor(dados);
    } catch (erro) {
        postMessage({ type: eventosWorker.erro, mensagem: erro.message });
    }
};
