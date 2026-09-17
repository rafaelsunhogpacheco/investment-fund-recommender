import Eventos from './events/events.js';
import { WorkerController } from './controller/WorkerController.js';
import { AppController } from './controller/AppController.js';
import { PerfilView } from './view/PerfilView.js';
import { TreinoView } from './view/TreinoView.js';
import { RecomendacaoView } from './view/RecomendacaoView.js';

// Worker em modulo: o treino nao pode travar a UI.
const worker = new Worker(new URL('./workers/treinoWorker.js', import.meta.url), { type: 'module' });

WorkerController.init({ worker, eventos: Eventos });

const app = AppController.init({
    perfilView: new PerfilView(),
    treinoView: new TreinoView(),
    recomendacaoView: new RecomendacaoView(),
    eventos: Eventos,
});

// Treina assim que a pagina carrega (~110s). Ver README, "Como treinar".
app.iniciar();
