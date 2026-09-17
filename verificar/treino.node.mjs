// Roda o MESMO nucleo de ML que o worker do browser usa, sobre os MESMOS
// JSON que o app consome, fora do browser — para a acuracia de validacao
// ser um numero medido, nao uma promessa.
//
//   node verificar/treino.node.mjs
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as tf from '@tensorflow/tfjs';

// O nucleo espera `tf` global, como no worker (que o carrega via CDN).
globalThis.tf = tf;

const aqui = dirname(fileURLToPath(import.meta.url));
const dados = join(aqui, '..', 'app', 'dados');

const { montarContexto, montarDataset, treinar, avaliar, recomendar } =
    await import('../app/src/ml/nucleo.js');

const ler = async (nome) => JSON.parse(await readFile(join(dados, nome), 'utf-8'));

console.log('=== Carregando ===');
const [classes, clientes] = await Promise.all([ler('classes.json'), ler('clientes.json')]);
console.log(`  ${classes.classes.length} classes, ${clientes.clientes.length} clientes`);
console.log(`  esquema v${classes.versaoEsquema}, ${classes.dimensoes.length} dimensoes`);

console.log('\n=== Dataset ===');
const ctx = montarContexto({ classes, clientes });
const ds = montarDataset(ctx);
console.log(`  treino:    ${ds.resumo.linhasTreino} linhas (${ds.resumo.positivosTreino} positivos) de ${ds.resumo.clientesTreino} clientes`);
console.log(`  validacao: ${ds.resumo.linhasValidacao} linhas (${ds.resumo.positivosValidacao} positivos) de ${ds.resumo.clientesValidacao} clientes`);
console.log(`  entrada:   ${ds.dimensaoEntrada} features (usuario + classe)`);

console.log('\n=== Treino ===');
const inicio = Date.now();
const modelo = await treinar(ds, {
    aoFimDaEpoca: (epoca, logs) => {
        if ((epoca + 1) % 5 === 0 || epoca === 0) {
            console.log(
                `  epoca ${String(epoca + 1).padStart(2)}  perda ${logs.loss.toFixed(4)}` +
                `  acc ${(logs.acc * 100).toFixed(1)}%` +
                `  val_perda ${logs.val_loss.toFixed(4)}  val_acc ${(logs.val_acc * 100).toFixed(1)}%`
            );
        }
    },
});
console.log(`  ${((Date.now() - inicio) / 1000).toFixed(1)}s`);

console.log('\n=== Avaliacao (validacao) ===');
const r = await avaliar(modelo, ds);
const ganho = (r.acuraciaValidacao - r.linhaBase) * 100;
console.log(`  acuracia validacao: ${(r.acuraciaValidacao * 100).toFixed(2)}%`);
console.log(`  linha de base:      ${(r.linhaBase * 100).toFixed(2)}%  ("nao" para tudo)`);
console.log(`  ganho sobre a base: ${ganho >= 0 ? '+' : ''}${ganho.toFixed(2)} p.p.`);
console.log(`  perda validacao:    ${r.perdaValidacao.toFixed(4)}`);
console.log(`  parametros:         ${r.parametros}`);

console.log('\n=== Recomendacoes por perfil ===');
const perfis = [
    { nome: 'conservador 68a, R$ 80 mil', perfil: { idade: 68, capital: 80_000, apetite: 'conservador', conhecimento: 'baixo' } },
    { nome: 'moderado 40a, R$ 300 mil', perfil: { idade: 40, capital: 300_000, apetite: 'moderado', conhecimento: 'medio' } },
    { nome: 'arrojado 28a, R$ 2 mi', perfil: { idade: 28, capital: 2_000_000, apetite: 'arrojado', conhecimento: 'alto' } },
];

// Faixa que os clientes SIMULADOS de cada apetite realmente carregam. E a
// referencia contra a qual a recomendacao tem que bater: se o top-10 de um
// moderado sai muito acima da carteira de um moderado, alguma coisa entre o
// perfil e a pontuacao esta deformando o sinal.
const faixaPorCnpj = new Map(classes.classes.map((c) => [c.cnpj, c.faixaRisco]));
const faixaCarteiraReal = (apetite) => {
    const faixas = clientes.clientes
        .filter((c) => c.apetite === apetite)
        .flatMap((c) => c.adesoes.map((cn) => faixaPorCnpj.get(cn)))
        .filter(Boolean);
    return faixas.reduce((a, b) => a + b, 0) / faixas.length;
};

const medias = {};
const reais = {};
for (const { nome, perfil } of perfis) {
    const saida = recomendar({ modelo, ctx, perfil, limite: 10 });
    const faixaMedia = saida.recomendacoes.reduce((a, r) => a + r.faixaRisco, 0) / saida.recomendacoes.length;
    const volMedia = saida.recomendacoes.reduce((a, r) => a + r.volatilidade, 0) / saida.recomendacoes.length;
    medias[perfil.apetite] = faixaMedia;
    reais[perfil.apetite] = faixaCarteiraReal(perfil.apetite);
    console.log(`\n  ${nome}`);
    console.log(`    universo elegivel: ${saida.universo} | faixa media do top10: ${faixaMedia.toFixed(2)} | vol media: ${volMedia.toFixed(2)}%`);
    console.log(`    carteira real dos ${perfil.apetite}s simulados: faixa ${reais[perfil.apetite].toFixed(2)}`);
    saida.recomendacoes.slice(0, 3).forEach((rec, i) => {
        console.log(`    ${i + 1}. [${rec.nota.toFixed(3)}] ${rec.classificacao} / faixa ${rec.faixaRisco} / vol ${rec.volatilidade.toFixed(2)}%`);
        console.log(`       ${rec.nome.slice(0, 72)}`);
    });
}

console.log('\n=== Criterios de aceite ===');
const falhas = [];
const checar = (ok, msg) => { console.log(`  ${ok ? 'OK  ' : 'FALHA'} ${msg}`); if (!ok) falhas.push(msg); };

checar(r.acuraciaValidacao > r.linhaBase, 'acuracia de validacao supera a linha de base');
checar(r.acuraciaValidacao > 0.80, `acuracia de validacao acima de 80% (${(r.acuraciaValidacao * 100).toFixed(2)}%)`);
checar(
    medias.conservador < medias.moderado && medias.moderado < medias.arrojado,
    `faixa de risco recomendada cresce com o apetite (${medias.conservador.toFixed(2)} < ${medias.moderado.toFixed(2)} < ${medias.arrojado.toFixed(2)})`
);

// REGRESSAO QUE JA ACONTECEU (ver o comentario de COLD START no nucleo): a
// primeira versao mediava VETORES entre clientes parecidos e jogava o
// moderado de 2,7 para 3,8 sem que nenhum criterio acusasse. Este criterio
// acusa.
for (const apetite of Object.keys(medias)) {
    const desvio = Math.abs(medias[apetite] - reais[apetite]);
    checar(
        desvio <= 1.0,
        `top-10 do ${apetite} fica a menos de 1 faixa da carteira simulada ` +
        `(top10 ${medias[apetite].toFixed(2)} vs real ${reais[apetite].toFixed(2)}, desvio ${desvio.toFixed(2)})`
    );
}

if (falhas.length) {
    console.error(`\n${falhas.length} criterio(s) falharam.`);
    process.exit(1);
}
console.log('\nTodos os criterios passaram.');
