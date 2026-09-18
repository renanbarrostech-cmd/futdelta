(() => {
  "use strict";

  const ELENCO = [
    "Douglas", "Bruno", "Lidis", "Fabio", "Caue", "David",
    "Melke", "Jhonata", "Flavio", "Mateus", "Kauã", "Gabriel",
    "Renan", "Henry", "Lucas"
  ];

  const COLETES = [
    { nome: "Time 1", colete: "Colete laranja", cor: "var(--colete-1)" },
    { nome: "Time 2", colete: "Colete azul",    cor: "var(--colete-2)" },
    { nome: "Time 3", colete: "Sem colete",     cor: "var(--colete-3)" },
    { nome: "Time 4", colete: "Colete verde",   cor: "var(--colete-4)" }
  ];

  const CHAVE = "fut-de-sexta:v4";
  const PADRAO_POR_TIME = 6;      // 1 no gol + 5 na linha
  const MINIMO = 4;               // dois times de dois, o menor jogo possível
  const TENTATIVAS = 240;         // candidatos avaliados para fugir da repetição

  /* =========================================================
     2. Estado e armazenamento
     ========================================================= */
  let estado = {
    jogadores: [],            // { id, nome, vem, gol }
    porTime: PADRAO_POR_TIME,
    sorteio: null             // { em, times: [{ gol, linha[] }], proximos[] }
  };

  let tela = "lista";
  let desfazer = null;

  const $ = (sel) => document.querySelector(sel);

  const ui = {
    lista:      $("#lista"),
    quantos:    $("#quantos"),
    total:      $("#total"),
    previsao:   $("#previsao"),
    porTime:    $("#por-time"),
    acao:       $("#btn-sortear"),
    acaoTexto:  $("#acao-texto"),
    voltar:     $("#btn-voltar"),
    telaLista:  $("#tela-lista"),
    telaTimes:  $("#tela-times"),
    times:      $("#times"),
    carimbo:    $("#carimbo"),
    incluir:    $("#form-incluir"),
    campoNome:  $("#novo-nome"),
    recado:     $("#recado"),
    recadoTxt:  $("#recado-texto"),
    recadoAcao: $("#recado-acao")
  };

  const identificador = () =>
    crypto.randomUUID ? crypto.randomUUID()
      : "j" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  const novoJogador = (nome) => ({ id: identificador(), nome, vem: true, gol: false });
  const elencoPadrao = () => ELENCO.map(novoJogador);

  function carregar() {
    try {
      const salvo = JSON.parse(localStorage.getItem(CHAVE) || "null");
      if (salvo && Array.isArray(salvo.jogadores) && salvo.jogadores.length) {
        estado = {
          jogadores: salvo.jogadores.map((j) => ({
            id: j.id || identificador(),
            nome: String(j.nome || "").slice(0, 22),
            vem: j.vem !== false,
            gol: j.gol === true
          })),
          porTime: [4, 5, 6, 7].includes(salvo.porTime) ? salvo.porTime : PADRAO_POR_TIME,
          sorteio: salvo.sorteio?.times?.length ? salvo.sorteio : null
        };
        return;
      }
    } catch (erro) {
      console.warn("Dados salvos ilegíveis, começando do elenco padrão.", erro);
    }
    estado.jogadores = elencoPadrao();
  }

  function salvar() {
    try {
      localStorage.setItem(CHAVE, JSON.stringify(estado));
    } catch (erro) {
      console.warn("Não foi possível salvar no aparelho.", erro);
    }
  }

  /** Inteiro de 0 a max-1, sem o viés do módulo simples. */
  function aleatorio(max) {
    if (!crypto.getRandomValues) return Math.floor(Math.random() * max);
    const buf = new Uint32Array(1);
    const limite = Math.floor(0x100000000 / max) * max;
    do { crypto.getRandomValues(buf); } while (buf[0] >= limite);
    return buf[0] % max;
  }

  /** Fisher-Yates com fonte criptográfica: embaralhamento sem viés. */
  function embaralhar(lista) {
    const arr = lista.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = aleatorio(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /**
   * Quantos times entram em quadra e de que tamanho.
   * Só vale time completo; a sobra fica de próximo.
   * Se não dá nem dois times completos, divide todo mundo em dois
   * para o jogo acontecer.
   */
  function formato(total, porTime) {
    if (total < MINIMO) return null;
    const completos = Math.floor(total / porTime);

    if (completos >= 2) {
      return { tamanhos: Array(completos).fill(porTime), sobra: total % porTime };
    }
    return {
      tamanhos: [Math.ceil(total / 2), Math.floor(total / 2)],
      sobra: 0,
      ajustado: true
    };
  }

  /** Monta os times a partir de uma ordem já sorteada. */
  function montar(jogadores, tamanhos) {
    const times = tamanhos.map(() => []);
    const goleiros = jogadores.filter((j) => j.gol);
    const resto = jogadores.filter((j) => !j.gol);

    // Um goleiro marcado por time, para não cair tudo no mesmo lado.
    times.forEach((time, i) => { if (goleiros[i]) time.push(goleiros[i]); });
    const banco = goleiros.slice(times.length).concat(resto);

    let i = 0;
    for (const jogador of banco) {
      let voltas = 0;
      while (times[i].length >= tamanhos[i] && voltas++ <= times.length) {
        i = (i + 1) % times.length;
      }
      times[i].push(jogador);
      i = (i + 1) % times.length;
    }
    return times;
  }

  /** Conjunto de duplas que jogaram juntas, para medir repetição. */
  function duplas(times) {
    const set = new Set();
    if (!times) return set;
    for (const time of times) {
      const nomes = time.linha ? [time.gol, ...time.linha] : time;
      for (let a = 0; a < nomes.length; a++) {
        for (let b = a + 1; b < nomes.length; b++) {
          set.add([nomes[a], nomes[b]].sort().join("|"));
        }
      }
    }
    return set;
  }

  /**
   * Aleatório puro repete as mesmas duplas com frequência incômoda.
   * Gera vários sorteios possíveis e fica com o que menos repete
   * duplas do sorteio anterior.
   */
  function sortear(jogadores, porTime, anterior) {
    const plano = formato(jogadores.length, porTime);
    if (!plano) return null;

    const antigas = duplas(anterior);
    let melhor = null;
    let melhorNota = Infinity;

    for (let t = 0; t < TENTATIVAS; t++) {
      const ordem = embaralhar(jogadores);
      const emQuadra = ordem.slice(0, plano.tamanhos.reduce((a, b) => a + b, 0));
      const proximos = ordem.slice(emQuadra.length);
      const times = montar(emQuadra, plano.tamanhos);

      const candidato = {
        times: times.map(escolherGoleiro),
        proximos: proximos.map((j) => j.nome)
      };

      if (!antigas.size) return candidato;

      let nota = 0;
      for (const dupla of duplas(candidato.times)) if (antigas.has(dupla)) nota++;
      if (nota < melhorNota) {
        melhorNota = nota;
        melhor = candidato;
        if (nota === 0) break;
      }
    }
    return melhor;
  }

  /** Quem marcou que pega no gol tem preferência; senão, sorte. */
  function escolherGoleiro(time) {
    const marcados = time.filter((j) => j.gol);
    const escolhido = marcados.length
      ? marcados[aleatorio(marcados.length)]
      : time[aleatorio(time.length)];
    return {
      gol: escolhido.nome,
      linha: time.filter((j) => j.id !== escolhido.id).map((j) => j.nome)
    };
  }

  function descrever(total, porTime) {
    if (total < MINIMO) return `Marque pelo menos ${MINIMO} jogadores para sortear.`;
    const plano = formato(total, porTime);

    if (plano.ajustado) {
      const [a, b] = plano.tamanhos;
      return `Não fecha dois times de ${porTime}. Vão sair ${a === b ? `dois times de ${a}` : `um time de ${a} e um de ${b}`}, com goleiro nos dois.`;
    }

    const qtd = plano.tamanhos.length;
    const base = `${qtd} times de ${porTime} — 1 no gol e ${porTime - 1} na linha`;
    return plano.sobra
      ? `${base}. ${plano.sobra} ${plano.sobra === 1 ? "fica" : "ficam"} de próximo.`
      : `${base}. Ninguém fica de fora.`;
  }

  function escalacaoEmTexto(sorteio) {
    const linhas = ["⚽ Times de hoje", ""];
    sorteio.times.forEach((time, i) => {
      const meta = COLETES[i] || { nome: `Time ${i + 1}`, colete: "" };
      linhas.push(`*${meta.nome}* — ${meta.colete}`);
      linhas.push(`Gol: ${time.gol}`);
      time.linha.forEach((nome, k) => linhas.push(`${k + 1}. ${nome}`));
      linhas.push("");
    });
    if (sorteio.proximos.length) {
      linhas.push("*Próximos*");
      sorteio.proximos.forEach((nome) => linhas.push(`• ${nome}`));
    }
    return linhas.join("\n").trim();
  }

  /* =========================================================
     4. Telas e desenho
     ========================================================= */
  const vemHoje = () => estado.jogadores.filter((j) => j.vem);

  function recado(texto, acao) {
    ui.recadoTxt.textContent = texto;
    ui.recadoAcao.hidden = !acao;
    ui.recadoAcao.onclick = acao || null;
    ui.recado.classList.add("recado--visivel");
    clearTimeout(recado._t);
    recado._t = setTimeout(esconderRecado, acao ? 5200 : 2600);
  }

  function esconderRecado() {
    ui.recado.classList.remove("recado--visivel");
    desfazer = null;
  }

  const vibrar = (ms) => { if (navigator.vibrate) navigator.vibrate(ms); };

  function irPara(nova) {
    tela = nova;
    const emTimes = nova === "times";

    ui.telaLista.hidden = emTimes;
    ui.telaTimes.hidden = !emTimes;
    ui.telaLista.classList.toggle("tela--ativa", !emTimes);
    ui.telaTimes.classList.toggle("tela--ativa", emTimes);
    ui.voltar.hidden = !emTimes;
    ui.acaoTexto.textContent = emTimes ? "Sortear de novo" : "Sortear times";

    atualizarCabecalho();
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  function desenharLista() {
    const fragmento = document.createDocumentFragment();
    let posicao = 0;

    for (const jogador of estado.jogadores) {
      const li = document.createElement("li");
      li.className = "jogador" + (jogador.vem ? "" : " jogador--fora");

      const toque = document.createElement("button");
      toque.type = "button";
      toque.className = "jogador__toque";
      toque.setAttribute("aria-pressed", String(jogador.vem));

      const numero = document.createElement("span");
      numero.className = "numero";
      numero.setAttribute("aria-hidden", "true");
      numero.textContent = jogador.vem ? String(++posicao).padStart(2, "0") : "–";

      const nome = document.createElement("span");
      nome.className = "jogador__nome";
      nome.textContent = jogador.nome;

      toque.append(numero, nome);
      toque.addEventListener("click", () => {
        jogador.vem = !jogador.vem;
        vibrar(8);
        salvar();
        desenharLista();
      });

      const gol = document.createElement("button");
      gol.type = "button";
      gol.className = "jogador__gol";
      gol.textContent = "Gol";
      gol.title = `${jogador.nome} pega no gol`;
      gol.setAttribute("aria-label", `${jogador.nome} pega no gol`);
      gol.setAttribute("aria-pressed", String(jogador.gol));
      gol.addEventListener("click", () => {
        jogador.gol = !jogador.gol;
        vibrar(8);
        salvar();
        desenharLista();
      });

      const apagar = document.createElement("button");
      apagar.type = "button";
      apagar.className = "jogador__apagar";
      apagar.setAttribute("aria-label", `Apagar ${jogador.nome} da lista`);
      apagar.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>';
      apagar.addEventListener("click", () => apagarJogador(jogador));

      li.append(toque, gol, apagar);
      fragmento.appendChild(li);
    }

    ui.lista.replaceChildren(fragmento);
    atualizarCabecalho();
  }

  function apagarJogador(jogador) {
    const indice = estado.jogadores.findIndex((j) => j.id === jogador.id);
    if (indice < 0) return;

    estado.jogadores.splice(indice, 1);
    desfazer = { jogador, indice };
    vibrar(12);
    salvar();
    desenharLista();

    recado(`${jogador.nome} saiu da lista.`, () => {
      if (!desfazer) return;
      estado.jogadores.splice(desfazer.indice, 0, desfazer.jogador);
      salvar();
      desenharLista();
      esconderRecado();
    });
  }

  function atualizarCabecalho() {
    const n = vemHoje().length;
    ui.quantos.textContent = n;
    ui.total.textContent = estado.jogadores.length;
    ui.previsao.textContent = descrever(n, estado.porTime);
    ui.acao.disabled = tela === "lista" && n < MINIMO;
  }

  function desenharTimes(sorteio, animando) {
    const data = new Date(sorteio.em);
    const hoje = new Date().toDateString() === data.toDateString();
    ui.carimbo.textContent =
      (hoje
        ? "Sorteado hoje às "
        : "Sorteado em " + data.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) + " às ") +
      data.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

    const fragmento = document.createDocumentFragment();
    const vagas = [];

    sorteio.times.forEach((time, i) => {
      const meta = COLETES[i] || { nome: `Time ${i + 1}`, colete: "", cor: "var(--cal)" };
      const card = criarCard(meta.nome, meta.colete, meta.cor);

      vagas.push(criarLinha(card.ol, "G", time.gol, animando, true));
      time.linha.forEach((nome, k) => {
        vagas.push(criarLinha(card.ol, String(k + 1), nome, animando, false));
      });

      fragmento.appendChild(card.artigo);
    });

    if (sorteio.proximos.length) {
      const card = criarCard("Próximos", "Entram na próxima partida", "var(--cal-2)", true);
      sorteio.proximos.forEach((nome, k) => {
        vagas.push(criarLinha(card.ol, String(k + 1), nome, animando, false));
      });
      fragmento.appendChild(card.artigo);
    }

    ui.times.replaceChildren(fragmento);

    if (animando) {
      const todos = sorteio.times.flatMap((t) => [t.gol, ...t.linha]).concat(sorteio.proximos);
      revelar(vagas, todos);
    }
  }

  function criarCard(titulo, subtitulo, cor, deFora = false) {
    const artigo = document.createElement("article");
    artigo.className = "time" + (deFora ? " time--fora" : "");
    artigo.style.setProperty("--cor", cor);

    const cabeca = document.createElement("div");
    cabeca.className = "time__cabeca";

    const h3 = document.createElement("h3");
    h3.className = "time__nome";
    h3.textContent = titulo;

    const span = document.createElement("span");
    span.className = "time__colete";
    span.textContent = subtitulo;

    cabeca.append(h3, span);

    const ol = document.createElement("ol");
    ol.className = "time__jogadores";

    artigo.append(cabeca, ol);
    return { artigo, ol };
  }

  function criarLinha(ol, marcador, nome, animando, ehGoleiro) {
    const li = document.createElement("li");
    li.className = "escalado" + (ehGoleiro ? " escalado--gol" : "");

    const num = document.createElement("span");
    num.className = "escalado__num";
    num.textContent = marcador;

    const quem = document.createElement("span");
    quem.className = "escalado__nome";
    if (!animando) {
      quem.textContent = nome;
      li.classList.add("escalado--visivel");
    }

    li.append(num, quem);
    if (ehGoleiro) {
      const tag = document.createElement("span");
      tag.className = "escalado__tag";
      tag.textContent = "goleiro";
      li.appendChild(tag);
    }

    ol.appendChild(li);
    return { li, campo: quem, nome };
  }

  /** Único momento com movimento: os nomes giram e travam um a um. */
  function revelar(vagas, nomes) {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      for (const v of vagas) {
        v.campo.textContent = v.nome;
        v.li.classList.add("escalado--visivel");
      }
      return;
    }

    for (const v of vagas) v.li.classList.add("escalado--visivel", "escalado--girando");

    const giro = setInterval(() => {
      for (const v of vagas) {
        if (!v.travado) v.campo.textContent = nomes[Math.floor(Math.random() * nomes.length)];
      }
    }, 55);

    vagas.forEach((v, i) => {
      setTimeout(() => {
        v.travado = true;
        v.li.classList.remove("escalado--girando");
        v.campo.textContent = v.nome;
      }, 380 + i * 70);
    });

    setTimeout(() => clearInterval(giro), 460 + vagas.length * 70);
  }

  /* =========================================================
     5. Eventos
     ========================================================= */
  function rodarSorteio() {
    const gente = vemHoje();
    if (gente.length < MINIMO) {
      recado(`Marque pelo menos ${MINIMO} jogadores.`);
      return;
    }

    const resultado = sortear(gente, estado.porTime, estado.sorteio?.times);
    if (!resultado) {
      recado("Não deu para montar os times.");
      return;
    }

    estado.sorteio = { em: new Date().toISOString(), ...resultado };
    salvar();
    vibrar([14, 40, 22]);
    irPara("times");
    desenharTimes(estado.sorteio, true);
  }

  async function copiar(texto, aviso) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(texto);
      } else {
        const area = document.createElement("textarea");
        area.value = texto;
        area.setAttribute("readonly", "");
        area.style.cssText = "position:fixed;top:0;opacity:0";
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        area.remove();
      }
      recado(aviso);
    } catch {
      recado("O navegador bloqueou a cópia.");
    }
  }

  function ligarEventos() {
    ui.acao.addEventListener("click", rodarSorteio);
    ui.voltar.addEventListener("click", () => irPara("lista"));

    ui.incluir.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const nome = ui.campoNome.value.trim().replace(/\s+/g, " ");
      if (!nome) return;

      if (estado.jogadores.some((j) => j.nome.toLowerCase() === nome.toLowerCase())) {
        recado(`${nome} já está na lista.`);
        return;
      }

      estado.jogadores.push(novoJogador(nome));
      ui.campoNome.value = "";
      salvar();
      desenharLista();
      recado(`${nome} entrou na lista.`);
    });

    for (const botao of document.querySelectorAll("[data-acao]")) {
      botao.addEventListener("click", () => {
        const acao = botao.dataset.acao;
        if (acao === "todos") estado.jogadores.forEach((j) => (j.vem = true));
        if (acao === "ninguem") estado.jogadores.forEach((j) => (j.vem = false));
        if (acao === "restaurar") {
          const anterior = estado.jogadores;
          estado.jogadores = elencoPadrao();
          recado("Lista original restaurada.", () => {
            estado.jogadores = anterior;
            salvar();
            desenharLista();
            esconderRecado();
          });
        }
        salvar();
        desenharLista();
      });
    }

    ui.porTime.addEventListener("click", (ev) => {
      const botao = ev.target.closest("button[data-valor]");
      if (!botao) return;
      estado.porTime = Number(botao.dataset.valor);
      for (const b of ui.porTime.children) b.classList.toggle("ativo", b === botao);
      salvar();
      atualizarCabecalho();
    });

    $("#btn-copiar").addEventListener("click", () => {
      if (estado.sorteio) copiar(escalacaoEmTexto(estado.sorteio), "Escalação copiada.");
    });

    $("#btn-whats").addEventListener("click", () => {
      if (!estado.sorteio) return;
      const texto = encodeURIComponent(escalacaoEmTexto(estado.sorteio));
      window.open(`https://wa.me/?text=${texto}`, "_blank", "noopener");
    });

    document.addEventListener("keydown", (ev) => {
      const foco = document.activeElement?.tagName;
      const ocupado = ["INPUT", "TEXTAREA", "BUTTON"].includes(foco);
      if (ev.code === "Space" && !ocupado && !ui.acao.disabled) {
        ev.preventDefault();
        rodarSorteio();
      }
    });
  }

  /* =========================================================
     6. Início
     ========================================================= */
  document.addEventListener("DOMContentLoaded", () => {
    carregar();
    desenharLista();

    for (const b of ui.porTime.children) {
      b.classList.toggle("ativo", Number(b.dataset.valor) === estado.porTime);
    }

    if (estado.sorteio) desenharTimes(estado.sorteio, false);
    ligarEventos();
    irPara("lista");
  });
})();