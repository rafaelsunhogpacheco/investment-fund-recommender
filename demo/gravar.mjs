// Grava a demonstracao dirigindo o app de verdade, headless.
//
//   node demo/gravar.mjs
//
// Produz:
//   demo/recomendador-fundos.mp4   ~28s, 1280x720 H.264 — para LinkedIn
//   demo/recomendador-fundos.gif   ~10s, 800px — para o README
//
// O treino leva ~110s e nao cabe numa demo de 30s. A gravacao acontece em
// tempo real e a aceleracao e aplicada DEPOIS, por trecho: 14x no treino,
// perto de 1x na interacao, que precisa continuar legivel. Por isso o script
// marca o instante de cada troca de fase enquanto dirige a pagina.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import puppeteer from 'puppeteer-core';
import ffmpeg from 'ffmpeg-static';

const aqui = dirname(fileURLToPath(import.meta.url));
const raizApp = join(aqui, '..', 'app');
const PORTA = Number(process.env.PORTA_DEMO ?? 8177);
const BRUTO = join(aqui, 'bruto.webm');
const MARCOS = join(aqui, '.marcos.json');
// `--pos` refaz so a pos-producao sobre o bruto ja gravado — util para ajustar
// velocidade ou formato sem esperar os ~2 minutos de gravacao de novo.
const SO_POS = process.argv.includes('--pos');
const MP4 = join(aqui, 'recomendador-fundos.mp4');
const GIF = join(aqui, 'recomendador-fundos.gif');

const CANDIDATOS_CHROME = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const chrome = CANDIDATOS_CHROME.find((c) => existsSync(c));
if (!chrome) {
    console.error('Nenhum Chrome encontrado. Defina CHROME_PATH.');
    process.exit(1);
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const ff = (args) => {
    const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args]);
    if (r.status !== 0) throw new Error(`ffmpeg falhou: ${(r.stderr || '').toString().slice(0, 400)}`);
};

let marcos = [];
let t0 = 0;
const marcar = (fase) => {
    const t = (Date.now() - t0) / 1000;
    marcos.push({ fase, t });
    console.log(`  ${t.toFixed(1).padStart(6)}s  ${fase}`);
};

if (SO_POS) {
    marcos = JSON.parse(readFileSync(MARCOS, 'utf-8'));
    console.log(`=== reaproveitando ${BRUTO} (${marcos.length} marcos) ===`);
}

const servidor = SO_POS ? null : spawn('python3',
    ['-m', 'http.server', String(PORTA), '--bind', '127.0.0.1'],
    { cwd: raizApp, stdio: 'ignore' });
if (!SO_POS) await esperar(1200);

const navegador = SO_POS ? null : await puppeteer.launch({
    executablePath: chrome,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
    protocolTimeout: 900_000,
});

if (!SO_POS) try {
    const pagina = await navegador.newPage();
    await pagina.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
    await pagina.goto(`http://127.0.0.1:${PORTA}/index.html`, { waitUntil: 'networkidle2', timeout: 60_000 });

    // Deixa a lista de epocas aberta: durante o treino e o que da sinal de
    // movimento na tela, e acelerado vira o "modelo aprendendo".
    await pagina.$eval('.epocas-caixa', (e) => e.setAttribute('open', ''));

    console.log('=== gravando ===');
    const rec = await pagina.screencast({ path: BRUTO, ffmpegPath: ffmpeg, fps: 30 });
    t0 = Date.now();

    marcar('abertura');
    await esperar(3000);

    marcar('treino');
    await pagina.waitForFunction(
        () => document.querySelector('#metricas')?.textContent?.includes('Acurácia'),
        { timeout: 300_000, polling: 1000 }
    );

    marcar('metricas');
    await esperar(4000);

    marcar('perfil');
    await pagina.$eval('#idade', (e) => { e.value = '40'; e.dispatchEvent(new Event('input', { bubbles: true })); });
    await esperar(900);
    await pagina.$eval('#capital', (e) => { e.value = '300000'; e.dispatchEvent(new Event('input', { bubbles: true })); });
    await esperar(900);
    await pagina.$eval('input[name="apetite"][value="moderado"]', (e) => e.click());
    await esperar(700);
    await pagina.$eval('input[name="conhecimento"][value="medio"]', (e) => e.click());
    await esperar(1200);

    marcar('recomendacao');
    await pagina.click('#btnRecomendar');
    await pagina.waitForFunction(
        () => document.querySelectorAll('#listaRecomendacoes .classe').length > 0,
        { timeout: 120_000, polling: 200 }
    );
    await esperar(2500);

    marcar('resultados');
    // O desfecho e a lista ordenada — e o que a demo existe para mostrar.
    // Rolagem lenta e longa o bastante para dar tempo de ler varios cartoes;
    // passo pequeno a cada quadro para nao sair truncada.
    await pagina.evaluate(async () => {
        const inicio = document.querySelector('.resultados').offsetTop - 30;
        const fim = Math.min(inicio + 3200, document.body.scrollHeight - window.innerHeight);
        const duracaoMs = 11_000;
        const t0 = performance.now();
        // easing suave nas pontas, para nao comecar nem parar bruscamente
        const suave = (x) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2);
        while (true) {
            const p = (performance.now() - t0) / duracaoMs;
            if (p >= 1) break;
            window.scrollTo(0, inicio + (fim - inicio) * suave(p));
            await new Promise((r) => requestAnimationFrame(r));
        }
        window.scrollTo(0, fim);
    });
    await esperar(1800);

    marcar('fim');
    await rec.stop();
    console.log('=== gravacao encerrada ===');
} finally {
    await navegador?.close().catch(() => {});
    servidor?.kill();
    writeFileSync(MARCOS, JSON.stringify(marcos, null, 2));
}

// --- pos-producao: acelera cada trecho no seu proprio fator ---------------

// Orcamento de ~29s. O treino e comprimido ao maximo porque e espera pura;
// a lista de resultados fica com a maior fatia porque e o desfecho.
const VELOCIDADE = {
    abertura: 1.6,
    treino: 16,      // ~114s viram ~7s
    metricas: 1.5,
    perfil: 1.6,
    recomendacao: 1.3,
    resultados: 1.2, // quase tempo real: precisa dar para ler
};

console.log('\n=== pos-producao ===');
const partes = [];
for (let i = 0; i < marcos.length - 1; i++) {
    const { fase, t } = marcos[i];
    const fim = marcos[i + 1].t;
    const fator = VELOCIDADE[fase] ?? 1;
    const saida = join(aqui, `.parte-${i}-${fase}.mp4`);
    ff([
        '-y', '-i', BRUTO, '-ss', String(t), '-to', String(fim),
        '-filter:v', `setpts=PTS/${fator},scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2`,
        '-r', '30', '-c:v', 'libx264', '-preset', 'medium', '-crf', '23',
        '-pix_fmt', 'yuv420p', '-an', saida,
    ]);
    partes.push(saida);
    console.log(`  ${fase.padEnd(13)} ${(fim - t).toFixed(1).padStart(6)}s -> ${((fim - t) / fator).toFixed(1)}s  (${fator}x)`);
}

const lista = join(aqui, '.partes.txt');
writeFileSync(lista, partes.map((p) => `file '${p}'`).join('\n'));
ff(['-y', '-f', 'concat', '-safe', '0', '-i', lista,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', '-an', MP4]);

// GIF do README: so o trecho de recomendacao e resultados, mais estreito.
// DUAS PASSAGENS de proposito: gerar a paleta e aplica-la no mesmo comando,
// com split/filter_complex, falha ao escrever o trailer neste ffmpeg.
const iRec = marcos.findIndex((m) => m.fase === 'recomendacao');
const iniGif = String(marcos[iRec].t);
const fimGif = String(marcos[marcos.length - 1].t);
const CADEIA_GIF = 'setpts=PTS/1.8,fps=12,scale=800:-1:flags=lanczos';
const paleta = join(aqui, '.paleta.png');

ff(['-y', '-ss', iniGif, '-to', fimGif, '-i', BRUTO,
    '-vf', `${CADEIA_GIF},palettegen=max_colors=128`, paleta]);
ff(['-y', '-ss', iniGif, '-to', fimGif, '-i', BRUTO, '-i', paleta,
    '-lavfi', `${CADEIA_GIF}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3`,
    '-loop', '0', GIF]);
unlinkSync(paleta);

partes.forEach((p) => unlinkSync(p));
unlinkSync(lista);

// Folha de contato: 9 quadros espalhados pela duracao, numa grade 3x3. Serve
// para conferir o video inteiro de relance, sem assistir os 28s.
// `fps=1/N` em vez de `select=not(mod(n,N))`: a virgula dentro da expressao do
// select precisa de escape e quebra dependendo de como o comando e montado.
const CONTATO = join(aqui, '.contato.png');
const duracao = Number(
    spawnSync(ffmpeg.replace(/ffmpeg$/, 'ffprobe'), ['-v', 'error', '-show_entries',
        'format=duration', '-of', 'csv=p=0', MP4]).stdout?.toString().trim()
) || 28;
ff(['-y', '-i', MP4, '-vf', `fps=1/${(duracao / 9).toFixed(2)},scale=420:-1,tile=3x3`,
    '-frames:v', '1', CONTATO]);

const tamanho = (p) => (spawnSync('stat', ['-c', '%s', p]).stdout.toString().trim() / 1e6).toFixed(2);
console.log(`\nMP4: ${MP4} (${tamanho(MP4)} MB)`);
console.log(`GIF: ${GIF} (${tamanho(GIF)} MB)`);
console.log(`bruto (nao versionado): ${BRUTO} (${tamanho(BRUTO)} MB)`);
console.log(`folha de contato: ${CONTATO}`);
