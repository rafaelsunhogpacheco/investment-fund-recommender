// Formulario de perfil: as 4 dimensoes de suitability (idade, capital,
// apetite a risco, conhecimento).
export class PerfilView {
    #form = document.querySelector('#formPerfil');
    #idade = document.querySelector('#idade');
    #capital = document.querySelector('#capital');
    #botao = document.querySelector('#btnRecomendar');
    #elegibilidade = document.querySelector('#elegibilidade');
    #aoAlterar;
    #aoRecomendar;

    constructor() {
        this.#form.addEventListener('input', () => {
            this.#mostrarElegibilidade();
            if (this.#aoAlterar) this.#aoAlterar(this.lerPerfil());
        });
        this.#botao.addEventListener('click', (e) => {
            e.preventDefault();
            if (this.#aoRecomendar) this.#aoRecomendar();
        });
        this.#mostrarElegibilidade();
    }

    aoAlterar(cb) { this.#aoAlterar = cb; }
    aoRecomendar(cb) { this.#aoRecomendar = cb; }

    lerPerfil() {
        return {
            idade: Number(this.#idade.value),
            capital: Number(this.#capital.value),
            apetite: this.#form.querySelector('input[name="apetite"]:checked').value,
            conhecimento: this.#form.querySelector('input[name="conhecimento"]:checked').value,
        };
    }

    // Deixa visivel o que o capital libera — e por que. O PLANO e explicito
    // que a UI nao pode sugerir precisao que o dado nao tem.
    #mostrarElegibilidade() {
        const capital = Number(this.#capital.value);
        const niveis = ['Público Geral'];
        if (capital >= 1_000_000) niveis.push('Qualificado');
        if (capital >= 10_000_000) niveis.push('Profissional');
        this.#elegibilidade.textContent = niveis.join(' · ');
    }

    habilitarRecomendar() {
        this.#botao.disabled = false;
    }
}
