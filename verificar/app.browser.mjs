// Sobe o app num servidor estatico, abre no Chrome de verdade (headless) e
// confere o ciclo completo: treino no Worker, recomendacao e renderizacao.
//
//   node verificar/app.browser.mjs
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import puppeteer from 'puppeteer-core';

const aqui = dirname(fileURLToPath(import.meta.url));
const raizApp = join(aqui, '..', 'app');
const PORTA = Number(process.env.PORTA_VERIFICACAO ?? 8173);

const servidor = spawn('python3', ['-m', 'http.server', String(PORTA), '--bind', '127.0.0.1'], {
    cwd: raizApp, stdio: 'ignore',
});
const encerrar = (codigo) => { servidor.kill(); process.exit(codigo); };
process.on('SIGINT', () => encerrar(130));

await new Promise((r) => setTimeout(r, 1200));

// puppeteer-core nao baixa navegador: usa um Chrome ja instalado. Caminho
// fixo quebraria fora do Linux, entao a variavel CHROME_PATH tem precedencia
// e os candidatos cobrem os locais usuais de cada sistema.
const CANDIDATOS_CHROME = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

const caminhoChrome = CANDIDATOS_CHROME.find((c) => existsSync(c));
if (!caminhoChrome) {
    console.error(
        'Nenhum Chrome encontrado. Instale o Chrome/Chromium ou aponte CHROME_PATH:\n' +
        '  CHROME_PATH=/caminho/para/chrome node verificar/app.browser.mjs\n' +
        'Procurei em:\n  ' + CANDIDATOS_CHROME.join('\n  ')
    );
    encerrar(1);
}
console.log(`  navegador: ${caminhoChrome}`);

const navegador = await puppeteer.launch({
    executablePath: caminhoChrome,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    // O treino roda no Worker e segura a aba por minutos; o padrao de 180s
    // do puppeteer estoura antes de o modelo terminar.
    protocolTimeout: 900_000,
});

const falhas = [];
const checar = (ok, msg) => { console.log(`  ${ok ? 'OK  ' : 'FALHA'} ${msg}`); if (!ok) falhas.push(msg); };

try {
    const pagina = await navegador.newPage();
    const errosConsole = [];
    pagina.on('console', (m) => { if (m.type() === 'error') errosConsole.push(m.text()); });
    pagina.on('pageerror', (e) => errosConsole.push(String(e)));

    console.log('=== Carregando a pagina ===');
    await pagina.goto(`http://127.0.0.1:${PORTA}/index.html`, { waitUntil: 'networkidle2', timeout: 60_000 });
    console.log(`  titulo: ${await pagina.title()}`);

    console.log('\n=== Treino no Worker (ate 5 min) ===');
    await pagina.waitForFunction(
        () => document.querySelector('#metricas')?.textContent?.includes('Acurácia'),
        { timeout: 300_000, polling: 2000 }
    );
    const metricas = await pagina.$eval('#metricas', (e) => e.innerText.replace(/\n+/g, ' | '));
    console.log(`  ${metricas}`);

    const epocas = await pagina.$$eval('.epoca', (n) => n.length);
    console.log(`  epocas registradas na UI: ${epocas}`);
    checar(epocas > 0, 'o Worker reportou progresso por epoca para a UI');

    console.log('\n=== Recomendacao ===');
    const desabilitado = await pagina.$eval('#btnRecomendar', (b) => b.disabled);
    checar(!desabilitado, 'botao de recomendar liberado depois do treino');

    // Os tres perfis sao pedidos sobre o MESMO modelo ja treinado: o que se
    // verifica e a ORDENACAO entre eles, nao a faixa absoluta de cada um.
    // Faixa absoluta varia entre treinos (a inicializacao de pesos do TF.js
    // nao e semeada) — medido: o moderado oscila entre ~1,0 e ~3,1. Ja a
    // ordem conservador < moderado < arrojado tem que valer sempre.
    const perfis = [
        { apetite: 'conservador', idade: 68, capital: 80_000 },
        { apetite: 'moderado', idade: 40, capital: 300_000 },
        { apetite: 'arrojado', idade: 28, capital: 2_000_000 },
    ];

    const faixas = {};
    for (const perfil of perfis) {
        await pagina.$eval('#idade', (e, v) => {
            e.value = String(v);
            e.dispatchEvent(new Event('input', { bubbles: true }));
        }, perfil.idade);
        await pagina.$eval('#capital', (e, v) => {
            e.value = String(v);
            e.dispatchEvent(new Event('input', { bubbles: true }));
        }, perfil.capital);
        await pagina.$eval(`input[name="apetite"][value="${perfil.apetite}"]`, (e) => e.click());

        await pagina.$eval('#listaRecomendacoes', (e) => { e.innerHTML = ''; });
        await pagina.click('#btnRecomendar');
        await pagina.waitForFunction(
            () => document.querySelectorAll('#listaRecomendacoes .classe').length > 0,
            { timeout: 120_000, polling: 500 }
        );

        const itens = await pagina.$$eval('#listaRecomendacoes .classe', (nos) => nos.map((n) => ({
            nome: n.querySelector('h3').textContent.trim(),
            nota: Number(n.querySelector('.nota').textContent),
            faixa: Number([...n.classList].find((c) => c.startsWith('faixa-')).split('-')[1]),
        })));

        faixas[perfil.apetite] = itens.slice(0, 10).reduce((a, r) => a + r.faixa, 0) / 10;
        console.log(`\n  ${perfil.apetite} (${perfil.idade}a, R$ ${perfil.capital.toLocaleString('pt-BR')})`);
        console.log(`    ${itens.length} classes | faixa media do top10: ${faixas[perfil.apetite].toFixed(2)}`);
        console.log(`    1. [${itens[0].nota.toFixed(3)}] faixa ${itens[0].faixa} — ${itens[0].nome.slice(0, 60)}`);

        if (perfil.apetite === 'moderado') {
            const resumo = await pagina.$eval('#resumoRecomendacoes', (e) => e.innerText.replace(/\s+/g, ' '));
            console.log(`    resumo: ${resumo}`);

            console.log('\n=== Criterios da lista ===');
            checar(itens.length === 20, `20 classes renderizadas (${itens.length})`);
            checar(itens.every((r) => r.nota >= 0 && r.nota <= 1), 'todas as notas entre 0 e 1');
            checar(
                itens.every((r, i) => i === 0 || itens[i - 1].nota >= r.nota),
                'lista ordenada por nota decrescente'
            );
        }
    }

    console.log('\n=== Criterios de perfil ===');
    checar(
        faixas.conservador < faixas.moderado && faixas.moderado < faixas.arrojado,
        `risco recomendado cresce com o apetite ` +
        `(${faixas.conservador.toFixed(2)} < ${faixas.moderado.toFixed(2)} < ${faixas.arrojado.toFixed(2)})`
    );
    checar(faixas.conservador <= 2.0, `conservador recebe risco baixo (faixa ${faixas.conservador.toFixed(2)})`);
    checar(faixas.arrojado >= 3.5, `arrojado recebe risco alto (faixa ${faixas.arrojado.toFixed(2)})`);

    // O aviso regulatorio nao pode sumir num refactor de CSS.
    const aviso = await pagina.$eval('.aviso', (e) => e.innerText);
    checar(/não é recomendação de investimento/i.test(aviso), 'aviso regulatorio visivel na pagina');
    checar(/simulada/i.test(aviso), 'aviso deixa claro que a base de clientes e simulada');

    checar(errosConsole.length === 0, `sem erros no console (${errosConsole.length})`);
    errosConsole.slice(0, 5).forEach((e) => console.log(`      ${e.slice(0, 160)}`));

    await pagina.setViewport({ width: 1280, height: 1600 });
    const tiro = join(aqui, 'app.png');
    await pagina.screenshot({ path: tiro, fullPage: false });
    console.log(`\n  screenshot: ${tiro}`);
} catch (erro) {
    console.error(`\n  ERRO: ${erro.message}`);
    falhas.push(erro.message);
} finally {
    await navegador.close().catch(() => {});
}

if (falhas.length) { console.error(`\n${falhas.length} criterio(s) falharam.`); encerrar(1); }
console.log('\nTodos os criterios passaram.');
encerrar(0);
