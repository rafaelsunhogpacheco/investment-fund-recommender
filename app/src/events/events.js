import { eventos } from './constants.js';

// Ponte de eventos do DOM: os controllers conversam por CustomEvent em vez
// de referencia direta.
const criar = (nome) => ({
    ouvir: (callback) => document.addEventListener(nome, (e) => callback(e.detail)),
    disparar: (detalhe) => document.dispatchEvent(new CustomEvent(nome, { detail: detalhe })),
});

export default {
    perfilAlterado: criar(eventos.perfilAlterado),
    treinar: criar(eventos.treinar),
    treinoConcluido: criar(eventos.treinoConcluido),
    progressoTreino: criar(eventos.progressoTreino),
    logTreino: criar(eventos.logTreino),
    recomendar: criar(eventos.recomendar),
    recomendacoesProntas: criar(eventos.recomendacoesProntas),
    erro: criar(eventos.erro),
};
