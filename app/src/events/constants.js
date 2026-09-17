// Nomes de evento centralizados: quem dispara e quem ouve nunca repetem
// string solta.
export const eventos = {
    perfilAlterado: 'perfil:alterado',
    treinar: 'treino:iniciar',
    treinoConcluido: 'treino:concluido',
    progressoTreino: 'treino:progresso',
    logTreino: 'treino:log',
    recomendar: 'recomendar',
    recomendacoesProntas: 'recomendacoes:prontas',
    erro: 'app:erro',
};

// Eventos que atravessam a fronteira do Worker (postMessage).
export const eventosWorker = {
    treinar: 'worker:treinar',
    progresso: 'worker:progresso',
    logTreino: 'worker:log-treino',
    treinoConcluido: 'worker:treino-concluido',
    recomendar: 'worker:recomendar',
    recomendacoes: 'worker:recomendacoes',
    erro: 'worker:erro',
};
