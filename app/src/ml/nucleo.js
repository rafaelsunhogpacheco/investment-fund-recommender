// Nucleo de ML: dataset, modelo e inferencia, SEM tocar em Worker, DOM ou
// rede. Espera `tf` como global (o worker carrega via CDN; o verificador em
// Node carrega o pacote npm).
//
// Por que separado do worker: e o unico jeito de rodar esta logica fora do
// browser e conferir a acuracia de verdade. `verificar/treino.node.mjs` faz
// exatamente isso, sobre os mesmos dados que o app consome.

const tf = globalThis.tf;

export const PARAMETROS = {
    // O caminho obvio seria o produto cartesiano cliente x classe. Aqui isso
    // daria 3.000 x 3.299 = 9,9 MILHOES de pares, 99,8% deles rotulo 0 — nao
    // cabe no browser e ainda produz um modelo que acerta quase tudo dizendo
    // "nao". Amostragem negativa reduz o volume e fixa a proporcao.
    negativosPorPositivo: 3,
    // Fracao de CLIENTES (nao de linhas) para validacao. Cortar por linha
    // vazaria: o vetor do usuario se repete nas linhas dele, e metade da
    // carteira cairia no treino e metade na validacao.
    fracaoValidacao: 0.2,
    epocas: 30,
    tamanhoLote: 256,
    semente: 20260915,
    // Rede deliberadamente pequena: comeca minima e cresce so se a validacao
    // pedir. Arquitetura grande sobre dataset pequeno e overfit garantido.
    camadas: [32, 16],
    taxaAprendizado: 0.005,
};

export const CAPITAL_MINIMO = {
    'Público Geral': 0,
    'Qualificado': 1_000_000,
    'Profissional': 10_000_000,
};

// PRNG com semente: o treino precisa ser reproduzivel entre execucoes, e
// Math.random() nao aceita semente.
export function criarRng(semente) {
    let s = semente >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

export function montarContexto({ classes, clientes }) {
    // ARMADILHA "RETREINOU, REINDEXOU": os vetores sao
    // produzidos pelo pipeline sob uma versao de esquema. Misturar versoes
    // nao daria erro — so recomendacao ruim, em silencio.
    if (classes.versaoEsquema !== clientes.versaoEsquema) {
        throw new Error(
            `Versao de esquema divergente: classes=${classes.versaoEsquema} ` +
            `clientes=${clientes.versaoEsquema}. Rode o pipeline inteiro de novo.`
        );
    }
    return {
        versaoEsquema: classes.versaoEsquema,
        dimensoes: classes.dimensoes,
        dim: classes.dimensoes.length,
        classes: classes.classes,
        vetores: classes.classes.map((c) => Float32Array.from(c.vetor)),
        porCnpj: new Map(classes.classes.map((c, i) => [c.cnpj, i])),
        clientes: clientes.clientes,
    };
}

// Usuario = centroide dos vetores das classes que ele tem. Mesma ideia do
// ideia de que "um usuario E a media do proprio historico".
export function codificarCliente(adesoes, ctx) {
    const v = new Float32Array(ctx.dim);
    let n = 0;
    for (const cnpj of adesoes) {
        const idx = ctx.porCnpj.get(cnpj);
        if (idx === undefined) continue;
        const vetor = ctx.vetores[idx];
        for (let i = 0; i < ctx.dim; i++) v[i] += vetor[i];
        n++;
    }
    if (n > 0) for (let i = 0; i < ctx.dim; i++) v[i] /= n;
    return v;
}

export function montarDataset(ctx, parametros = PARAMETROS) {
    const rng = criarRng(parametros.semente);
    const total = ctx.classes.length;

    const clientes = [...ctx.clientes];
    for (let i = clientes.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [clientes[i], clientes[j]] = [clientes[j], clientes[i]];
    }
    const corte = Math.floor(clientes.length * (1 - parametros.fracaoValidacao));

    const construir = (grupo) => {
        const entradas = [];
        const rotulos = [];
        for (const cliente of grupo) {
            const vetorCliente = codificarCliente(cliente.adesoes, ctx);
            const tem = new Set(cliente.adesoes);

            for (const cnpj of cliente.adesoes) {
                const idx = ctx.porCnpj.get(cnpj);
                if (idx === undefined) continue;
                entradas.push([...vetorCliente, ...ctx.vetores[idx]]);
                // Rotulo 1/0 NUMERICO, nunca booleano: um ternario dentro de
                // um `.some()` devolveria `true`/`false` e o tf.tensor2d
                // inferiria dtype 'bool' em vez de float32, silenciosamente.
                rotulos.push(1);
            }

            const alvo = tem.size * parametros.negativosPorPositivo;
            let postos = 0;
            let tentativas = 0;
            while (postos < alvo && tentativas < alvo * 10) {
                tentativas++;
                const idx = Math.floor(rng() * total);
                if (tem.has(ctx.classes[idx].cnpj)) continue;
                entradas.push([...vetorCliente, ...ctx.vetores[idx]]);
                rotulos.push(0);
                postos++;
            }
        }
        return { entradas, rotulos };
    };

    const treino = construir(clientes.slice(0, corte));
    const validacao = construir(clientes.slice(corte));

    return {
        xsTreino: tf.tensor2d(treino.entradas, undefined, 'float32'),
        ysTreino: tf.tensor2d(treino.rotulos, [treino.rotulos.length, 1], 'float32'),
        xsValidacao: tf.tensor2d(validacao.entradas, undefined, 'float32'),
        ysValidacao: tf.tensor2d(validacao.rotulos, [validacao.rotulos.length, 1], 'float32'),
        dimensaoEntrada: ctx.dim * 2,
        resumo: {
            clientesTreino: corte,
            clientesValidacao: clientes.length - corte,
            linhasTreino: treino.rotulos.length,
            linhasValidacao: validacao.rotulos.length,
            positivosTreino: treino.rotulos.reduce((a, b) => a + b, 0),
            positivosValidacao: validacao.rotulos.reduce((a, b) => a + b, 0),
        },
    };
}

export function construirModelo(dimensaoEntrada, parametros = PARAMETROS) {
    const modelo = tf.sequential();
    parametros.camadas.forEach((unidades, i) => {
        modelo.add(tf.layers.dense({
            ...(i === 0 ? { inputShape: [dimensaoEntrada] } : {}),
            units: unidades,
            activation: 'relu',
        }));
    });
    modelo.add(tf.layers.dense({ units: 1, activation: 'sigmoid' }));
    modelo.compile({
        optimizer: tf.train.adam(parametros.taxaAprendizado),
        loss: 'binaryCrossentropy',
        metrics: ['accuracy'],
    });
    return modelo;
}

export async function treinar(dados, { aoFimDaEpoca, parametros = PARAMETROS } = {}) {
    const modelo = construirModelo(dados.dimensaoEntrada, parametros);
    await modelo.fit(dados.xsTreino, dados.ysTreino, {
        epochs: parametros.epocas,
        batchSize: parametros.tamanhoLote,
        shuffle: true,
        // Separacao treino/validacao, por cliente (ver montarDataset).
        validationData: [dados.xsValidacao, dados.ysValidacao],
        callbacks: aoFimDaEpoca ? { onEpochEnd: aoFimDaEpoca } : undefined,
    });
    return modelo;
}

export async function avaliar(modelo, dados) {
    const avaliacao = modelo.evaluate(dados.xsValidacao, dados.ysValidacao);
    const [perda, acuracia] = await Promise.all(avaliacao.map((t) => t.data()));
    avaliacao.forEach((t) => t.dispose());

    // A acuracia sozinha engana: com 3 negativos por positivo, responder
    // "nao" para tudo ja acerta 75%. A linha de base vai junto do numero.
    const linhaBase = 1 - dados.resumo.positivosValidacao / dados.resumo.linhasValidacao;
    return {
        ...dados.resumo,
        perdaValidacao: perda[0],
        acuraciaValidacao: acuracia[0],
        linhaBase,
        parametros: modelo.countParams(),
    };
}

export function elegiveis(perfil, ctx) {
    return ctx.classes
        .map((c, i) => ({ c, i }))
        .filter(({ c }) => perfil.capital >= CAPITAL_MINIMO[c.publicoAlvo]);
}

// COLD START — a armadilha mais sutil do projeto.
//
// A saida ingenua e codificar o usuario sem historico com zeros nas posicoes
// que dependem da carteira. Nao funciona: vizinho de vetor quase-zero nao
// significa nada, e o par (usuario, classe) nao se parece com nada do treino.
//
// A PRIMEIRA TENTATIVA AQUI TAMBEM FALHOU, e o motivo ficou registrado
// porque e instrutivo. A ideia era: perfil novo herda o CENTROIDE MEDIO dos
// clientes simulados parecidos. Medido, dava errado — o moderado recebia
// top-10 na faixa 3,8 quando os moderados simulados carregam faixa 2,7:
//
//   apetite      carteira real   top10 com vetor individual   top10 com centroide do balde
//   conservador     1,39                 1,20                          1,00
//   moderado        2,72                 2,72                          3,80
//   arrojado        4,46                 4,71                          5,00
//
// A causa nao e a magnitude do vetor (a norma bate, razao ~0,95): e a FORMA.
// O modelo treinou com centroides INDIVIDUAIS, que sao concentrados — um
// cliente tem 3 a 10 classes, entao poucas posicoes one-hot carregam massa.
// A media de centenas desses centroides espalha massa por quase todas as
// posicoes. O par (usuario, classe) resultante nao se parece com nada que o
// modelo viu no treino, e a pontuacao deixa de valer.
//
// SOLUCAO: em vez de mediar VETORES, mediar PONTUACOES. O perfil novo pega
// K clientes parecidos, pontua o catalogo com o vetor de CADA um — todos
// dentro da distribuicao de treino — e a nota final e a media. Cada entrada
// que chega ao modelo continua sendo um par plausivel.
const MAX_REFERENCIAS = 25;

export function referenciasDoPerfil(perfil, ctx, limite = MAX_REFERENCIAS) {
    const mesmoApetite = ctx.clientes.filter((c) => c.apetite === perfil.apetite);

    // Preferencia por idade proxima e, em segundo lugar, por capital da
    // mesma faixa de elegibilidade: um cliente que so acessa Publico Geral
    // tem carteira estruturalmente diferente de um qualificado.
    const faixaCapital = (capital) =>
        capital >= 10_000_000 ? 2 : capital >= 1_000_000 ? 1 : 0;
    const alvoFaixa = faixaCapital(perfil.capital);

    const ordenados = [...mesmoApetite].sort((a, b) => {
        const fa = Math.abs(faixaCapital(a.capital) - alvoFaixa);
        const fb = Math.abs(faixaCapital(b.capital) - alvoFaixa);
        if (fa !== fb) return fa - fb;
        return Math.abs(a.idade - perfil.idade) - Math.abs(b.idade - perfil.idade);
    });

    return ordenados.slice(0, limite).map((c) => codificarCliente(c.adesoes, ctx));
}

export function recomendar({ modelo, ctx, perfil, limite = 20 }) {
    const referencias = referenciasDoPerfil(perfil, ctx);
    const candidatos = elegiveis(perfil, ctx);
    if (!referencias.length || !candidatos.length) {
        return { recomendacoes: [], universo: candidatos.length, referencias: 0, perfil };
    }

    // Predicao em LOTE: um tensor e um predict por cliente de referencia, nao
    // uma chamada por item. Importa com catalogo de milhares de classes.
    const soma = new Float64Array(candidatos.length);
    for (const vetor of referencias) {
        const entradas = candidatos.map(({ i }) => [...vetor, ...ctx.vetores[i]]);
        const tensor = tf.tensor2d(entradas, undefined, 'float32');
        const previsao = modelo.predict(tensor);
        const notas = previsao.dataSync();
        for (let k = 0; k < candidatos.length; k++) soma[k] += notas[k];
        tensor.dispose();
        previsao.dispose();
    }

    const recomendacoes = candidatos
        .map(({ c }, k) => ({ ...c, nota: soma[k] / referencias.length }))
        .sort((a, b) => b.nota - a.nota)
        .slice(0, limite);

    return {
        recomendacoes,
        universo: candidatos.length,
        referencias: referencias.length,
        perfil,
    };
}
