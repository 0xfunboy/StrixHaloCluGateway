"use strict";
(() => {
  // web/api.ts
  var ApiError = class extends Error {
    status;
    code;
    constructor(message2, status, code = "request_failed") {
      super(message2);
      this.status = status;
      this.code = code;
    }
  };
  function createApi(win = window) {
    const nativeWindow = win;
    if (typeof nativeWindow.acquireVsCodeApi === "function") return createNativeApi(win, nativeWindow.acquireVsCodeApi());
    return createBrowserApi(win);
  }
  function createBrowserApi(win) {
    return {
      native: false,
      async request(method, path, body) {
        assertApiPath(path);
        const response = await win.fetch(path, {
          method,
          credentials: "same-origin",
          redirect: "error",
          headers: { Accept: "application/json", ...body === void 0 ? {} : { "Content-Type": "application/json" } },
          ...body === void 0 ? {} : { body: JSON.stringify(body) }
        });
        const data = await response.json();
        if (!response.ok) throw new ApiError(
          typeof data.error === "string" ? data.error : `Richiesta non riuscita (${response.status}).`,
          response.status,
          typeof data.code === "string" ? data.code : void 0
        );
        return data;
      },
      subscribe(onEvent, onState) {
        let lastEventId = 0;
        let closed = false;
        const source = new win.EventSource("/api/events");
        source.onopen = () => onState?.(true);
        source.onerror = () => {
          if (!closed) onState?.(false);
        };
        source.onmessage = (event) => {
          try {
            const parsed = JSON.parse(event.data);
            if (!parsed || typeof parsed.type !== "string" || !Number.isSafeInteger(parsed.id)) return;
            if (parsed.id <= lastEventId && parsed.id !== 0) return;
            if (parsed.id > 0) lastEventId = parsed.id;
            onEvent(parsed);
          } catch {
          }
        };
        return () => {
          closed = true;
          source.close();
        };
      }
    };
  }
  function createNativeApi(win, host) {
    let sequence = 0;
    const requests = /* @__PURE__ */ new Map();
    const events = /* @__PURE__ */ new Set();
    const selections = /* @__PURE__ */ new Set();
    const configured = /* @__PURE__ */ new Set();
    const states = /* @__PURE__ */ new Set();
    let saving;
    const listener = (message2) => {
      const value2 = message2.data;
      if (!value2 || typeof value2 !== "object") return;
      if (value2.type === "api.result" && typeof value2.id === "string") {
        const pending = requests.get(value2.id);
        if (!pending) return;
        requests.delete(value2.id);
        clearTimeout(pending.timeout);
        if (value2.ok) pending.resolve(value2.data);
        else pending.reject(new ApiError(value2.data?.error ?? value2.error ?? "Richiesta non riuscita.", Number(value2.status) || 500, value2.data?.code));
      } else if (value2.type === "event" && value2.event && typeof value2.event.type === "string") {
        for (const handler of events) handler(value2.event);
        for (const handler of states) handler(true);
      } else if (value2.type === "configured") {
        for (const handler of configured) handler();
      } else if (value2.type === "selection" && typeof value2.name === "string" && typeof value2.content === "string") {
        for (const handler of selections) handler({ name: value2.name, content: value2.content });
      } else if (value2.type === "connection" && typeof value2.connected === "boolean") {
        for (const handler of states) handler(value2.connected);
      } else if (value2.type === "savedFile" && saving) {
        const pending = saving;
        saving = void 0;
        if (value2.ok) pending.resolve();
        else pending.reject(new Error(value2.error ?? "Esportazione non riuscita."));
      }
    };
    win.addEventListener("message", listener);
    return {
      native: true,
      request(method, path, body) {
        assertApiPath(path);
        const id = `ui-${++sequence}`;
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            requests.delete(id);
            reject(new ApiError("Il server non ha risposto in tempo. Verifica lo stato prima di ripetere un\u2019operazione.", 504, "timeout"));
          }, 12e4);
          requests.set(id, { resolve: (value2) => resolve(value2), reject, timeout });
          host.postMessage({ type: "api", id, method, path, ...body === void 0 ? {} : { body } });
        });
      },
      subscribe(onEvent, onState) {
        events.add(onEvent);
        if (onState) states.add(onState);
        host.postMessage({ type: "subscribe" });
        return () => {
          events.delete(onEvent);
          if (onState) states.delete(onState);
          if (!events.size) host.postMessage({ type: "unsubscribe" });
        };
      },
      configure: () => host.postMessage({ type: "configure" }),
      attachSelection: () => host.postMessage({ type: "attachSelection" }),
      openAuth: (url) => host.postMessage({ type: "openAuth", url }),
      saveFile(name, content, mime) {
        if (saving) return Promise.reject(new Error("Completa prima l\u2019esportazione in corso."));
        return new Promise((resolve, reject) => {
          saving = { resolve, reject };
          host.postMessage({ type: "saveFile", name, content, mime });
        });
      },
      onSelection(handler) {
        selections.add(handler);
        return () => selections.delete(handler);
      },
      onConfigured(handler) {
        configured.add(handler);
        return () => configured.delete(handler);
      },
      dispose() {
        win.removeEventListener("message", listener);
        for (const request of requests.values()) {
          clearTimeout(request.timeout);
          request.reject(new ApiError("La vista \xE8 stata chiusa.", 499, "closed"));
        }
        requests.clear();
        events.clear();
        selections.clear();
        states.clear();
        configured.clear();
        saving?.reject(new Error("La vista \xE8 stata chiusa."));
        saving = void 0;
        host.postMessage({ type: "unsubscribe" });
      }
    };
  }
  function assertApiPath(path) {
    if (!path.startsWith("/api/") || path.startsWith("//") || path.includes("\\") || /[\u0000-\u001f]/.test(path)) throw new Error("Percorso API non valido.");
  }

  // web/markdown.ts
  function renderMarkdown(document2, text) {
    const fragment = document2.createDocumentFragment();
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    let index = 0;
    while (index < lines.length) {
      const line = lines[index];
      if (line.startsWith("```")) {
        const language = line.slice(3).trim();
        const body2 = [];
        index++;
        while (index < lines.length && !lines[index].startsWith("```")) body2.push(lines[index++]);
        if (index < lines.length) index++;
        const pre = document2.createElement("pre");
        const code = document2.createElement("code");
        if (/^[a-z0-9+-]{1,25}$/i.test(language)) code.dataset.language = language;
        code.textContent = body2.join("\n");
        pre.append(code);
        fragment.append(pre);
        continue;
      }
      if (!line.trim()) {
        index++;
        continue;
      }
      const heading = /^(#{1,4})\s+(.+)$/.exec(line);
      if (heading) {
        const element = document2.createElement(`h${Math.min(4, heading[1].length + 1)}`);
        inline(document2, element, heading[2]);
        fragment.append(element);
        index++;
        continue;
      }
      const list = /^(?:[-*+]\s+|\d+[.)]\s+)(.+)$/.exec(line);
      if (list) {
        const ordered = /^\d/.test(line);
        const element = document2.createElement(ordered ? "ol" : "ul");
        while (index < lines.length) {
          const match = /^(?:[-*+]\s+|\d+[.)]\s+)(.+)$/.exec(lines[index]);
          if (!match) break;
          const item = document2.createElement("li");
          inline(document2, item, match[1]);
          element.append(item);
          index++;
        }
        fragment.append(element);
        continue;
      }
      if (line.startsWith("> ")) {
        const quote = document2.createElement("blockquote");
        inline(document2, quote, line.slice(2));
        fragment.append(quote);
        index++;
        continue;
      }
      const paragraph = document2.createElement("p");
      const body = [line];
      index++;
      while (index < lines.length && lines[index].trim() && !/^(?:```|#{1,4}\s|>\s|[-*+]\s|\d+[.)]\s)/.test(lines[index])) body.push(lines[index++]);
      inline(document2, paragraph, body.join("\n"));
      fragment.append(paragraph);
    }
    return fragment;
  }
  function inline(document2, parent, text) {
    const expression = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^\s)]+\))/g;
    let previous = 0;
    let match;
    while (match = expression.exec(text)) {
      parent.append(document2.createTextNode(text.slice(previous, match.index)));
      const token = match[0];
      if (token.startsWith("`")) {
        const code = document2.createElement("code");
        code.textContent = token.slice(1, -1);
        parent.append(code);
      } else if (token.startsWith("**")) {
        const strong = document2.createElement("strong");
        strong.textContent = token.slice(2, -2);
        parent.append(strong);
      } else {
        const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
        try {
          const url = new URL(link[2]);
          if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Unsafe URL");
          const anchor = document2.createElement("a");
          anchor.textContent = link[1];
          anchor.href = url.href;
          anchor.target = "_blank";
          anchor.rel = "noopener noreferrer";
          parent.append(anchor);
        } catch {
          parent.append(document2.createTextNode(token));
        }
      }
      previous = expression.lastIndex;
    }
    parent.append(document2.createTextNode(text.slice(previous)));
  }

  // web/activity.ts
  var working = /* @__PURE__ */ new Set(["planning", "executing", "reviewing", "verifying", "deploying"]);
  var phases = {
    queued: "In attesa di risorse",
    planning: "Organizza il lavoro",
    executing: "Attivit\xE0 in esecuzione",
    reviewing: "Revisione del risultato",
    verifying: "Verifiche in corso",
    deploying: "Rilascio in corso",
    awaiting_release: "Consegna pronta",
    succeeded: "Attivit\xE0 completata",
    failed: "Serve un intervento",
    paused: "Attivit\xE0 in pausa",
    interrupted: "Attivit\xE0 interrotta",
    cancelled: "Attivit\xE0 annullata"
  };
  function activityView(document2, data, options) {
    const create = (tag, className = "", text) => {
      const element = document2.createElement(tag);
      element.className = className;
      if (text !== void 0) element.textContent = text;
      return element;
    };
    const run = options.run;
    const waiting = !!run?.phase.startsWith("Attesa modello") && !run.tasks.some((task) => task.status === "running");
    const active = !!run && working.has(run.status) && !waiting;
    const sources = new Set(run?.tasks.flatMap((task) => task.context?.sources.filter((source) => source.included).map((source) => source.id) ?? []) ?? []);
    const memories = data.memories.filter((memory) => memory.projectId === options.project?.id && memory.status === "approved").length;
    const files = data.artifacts.filter((artifact) => artifact.projectId === options.project?.id && artifact.kind === "attachment").length;
    const running = run?.tasks.filter((task) => task.status === "running").length ?? 0;
    const done = run?.tasks.filter((task) => task.status === "succeeded").length ?? 0;
    const evidence = data.evidence.filter((item) => item.runId === run?.id);
    const usedRoutes = [...new Set(run?.tasks.filter((task) => task.status === "running").map((task) => task.routeId) ?? [])];
    const modelLabels = usedRoutes.map((id) => data.models.find((model) => model.id === id)?.label ?? "Modello precedente");
    const title = waiting ? run.phase : run ? phases[run.status] ?? run.phase : "Il tuo sistema, pronto a lavorare";
    const section = create("section", `hud-activity ${options.expanded ? "expanded" : ""}`);
    section.dataset.phase = waiting ? "queued" : run?.status ?? "idle";
    section.setAttribute("aria-label", "Flusso osservato di contesto, orchestratore, modelli, agenti ed evidenze");
    const head = create("header", "hud-section-head");
    const caption = create("span", "hud-section-label", options.expanded ? "SEC.01 / COMMAND FABRIC" : "LIVE / COMMAND FABRIC");
    const state = create("span", "hud-phase", title);
    state.prepend(create("i", `status-dot ${active ? "active" : run?.status === "failed" ? "error" : ""}`));
    head.append(caption, state);
    const flow = create("div", "activity-flow");
    const nodes = [
      { id: "knowledge", index: "01", label: "KNOWLEDGE", value: sources.size ? `${sources.size} fonti incluse` : `${memories + files} risorse`, detail: `${memories} metodi \xB7 ${files} documenti`, state: sources.size ? "linked" : "", glyph: "\u25A4" },
      { id: "orchestrator", index: "02", label: "ORCHESTRATORE", value: options.serviceReply ? "Risposta del servizio" : waiting ? "Attende una risorsa" : run ? run.mode === "chat" ? "Risposta diretta" : "Coordina la squadra" : "In ascolto", detail: title, state: active ? "live" : waiting || run?.status === "queued" ? "waiting" : "", glyph: "\u25C8" },
      { id: "models", index: "03", label: "INFERENZA", value: options.serviceReply ? "Nessuna inferenza" : modelLabels[0] ?? options.routeLabel ?? "Scegli un modello", detail: options.serviceReply ? "Risposta deterministica del servizio" : modelLabels.length > 1 ? `${modelLabels.length} modelli coinvolti` : "Modello e account selezionati", state: "", glyph: "\u2B21" },
      { id: "team", index: "04", label: "AGENTI", value: running ? `${running} al lavoro` : run?.tasks.length ? `${done}/${run.tasks.length} completati` : "Su richiesta", detail: run?.mode === "chat" ? "Chat diretta, senza pianificazione" : "Dipendenze e controllo dei task", state: active && running ? "live" : "", glyph: "\u2318" },
      { id: "evidence", index: "05", label: "EVIDENZE", value: evidence.length ? `${evidence.filter((item) => item.ok).length}/${evidence.length} positive` : "Nessuna verifica", detail: run?.releasedAt ? "Rilascio registrato" : "Test, review e risultati reali", state: run?.status === "verifying" || run?.status === "deploying" ? "live" : "", glyph: "\u2713" }
    ];
    for (const node of nodes) {
      const button = create("button", `activity-node ${node.state}`);
      button.type = "button";
      button.dataset.activityNode = node.id;
      button.setAttribute("aria-label", `${node.label}: ${node.value}. ${node.detail}`);
      const label = create("span", "activity-node-label", node.label);
      label.prepend(create("span", "activity-index", node.index));
      const symbol = create("span", "activity-glyph", node.glyph);
      symbol.setAttribute("aria-hidden", "true");
      const copy = create("span", "activity-copy");
      copy.append(create("strong", "", node.value), create("small", "", node.detail));
      button.append(label, symbol, copy);
      button.addEventListener("click", () => options.onSelect(node.id));
      flow.append(button);
    }
    const footer = create("footer", "activity-caption");
    footer.append(create("span", "", data.demo ? "DATI DI ESEMPIO" : "STATO OSSERVATO DAL COORDINATOR"), create("span", "", run ? `RUN ${run.id.slice(-8).toUpperCase()}` : "L\u2019attivit\xE0 compare quando avvii una richiesta"));
    section.append(head, flow, footer);
    return section;
  }

  // web/connections.ts
  var presets = [
    { id: "codex", label: "Codex", detail: "Accedi con il tuo account", mark: ">_", url: "" },
    { id: "antigravity", label: "Antigravity", detail: "Collega la CLI ufficiale", mark: "A", url: "" },
    { id: "openai", label: "OpenAI API", detail: "Basta la tua API key", mark: "OAI", url: "https://api.openai.com/v1" },
    { id: "gemini", label: "Gemini API", detail: "Basta la tua API key", mark: "\u2726", url: "https://generativelanguage.googleapis.com/v1beta" },
    { id: "ollama", label: "Ollama", detail: "Modelli sulla tua rete", mark: "OL", url: "http://127.0.0.1:11434" },
    { id: "lmstudio", label: "LM Studio", detail: "Modelli sulla tua rete", mark: "LM", url: "http://127.0.0.1:1234/v1" },
    { id: "gemrouter", label: "GemRouter", detail: "Un altro fornitore di inferenza", mark: "GR", url: "" },
    { id: "custom", label: "Altro endpoint", detail: "API compatibile OpenAI", mark: "API", url: "" }
  ];
  function mountConnectionWizard(options) {
    const { body, dialog, api, data } = options, document2 = body.ownerDocument;
    const operator = ["admin", "operator"].includes(data.user.role);
    const element = (tag, className = "", text) => {
      const node = document2.createElement(tag);
      node.className = className;
      if (text !== void 0) node.textContent = text;
      return node;
    };
    const input = (type, placeholder = "") => {
      const node = element("input");
      node.type = type;
      node.placeholder = placeholder;
      return node;
    };
    const field = (label, control, help) => {
      const wrapper = element("label", "form-field");
      wrapper.append(element("span", "field-label", label), control);
      if (help) wrapper.append(element("span", "fine-print", help));
      return wrapper;
    };
    const form = element("form", "connection-wizard");
    body.append(form);
    const choice = element("select", "provider-select");
    choice.setAttribute("aria-label", "Servizio da collegare");
    for (const provider of data.providers.filter((item) => operator || !["codex", "antigravity"].includes(item.kind))) {
      const option = element("option", "", `${provider.label} \xB7 altro account`);
      option.value = `existing:${provider.id}`;
      choice.append(option);
    }
    if (operator) for (const preset of presets) {
      const option = element("option", "", preset.label);
      option.value = preset.id;
      choice.append(option);
    }
    const choices = element("div", "provider-tiles");
    choices.setAttribute("aria-label", "Scegli il provider");
    if (operator) for (const preset of presets) {
      const button = element("button", "provider-tile");
      button.type = "button";
      button.dataset.preset = preset.id;
      const copy = element("span");
      copy.append(element("strong", "", preset.label), element("small", "", preset.detail));
      button.append(element("span", "provider-mark", preset.mark), copy);
      button.setAttribute("aria-pressed", "false");
      button.addEventListener("click", () => {
        choice.value = preset.id;
        apply();
      });
      choices.append(button);
    }
    choice.value = options.existing ? `existing:${options.existing.id}` : operator ? "codex" : choice.options[0]?.value ?? "";
    const selected = element("div", "connect-selected");
    const existingChoices = element("details", "advanced existing-connections");
    existingChoices.append(element("summary", "", "Usa una connessione gi\xE0 configurata"), field("Connessione", choice));
    existingChoices.open = !!options.existing || !operator;
    if (!data.providers.length && operator) existingChoices.hidden = true;
    form.append(element("p", "wizard-step", "01 / SCEGLI LA CONNESSIONE"), choices, existingChoices, selected);
    const detection = element("div", "connection-detection");
    const detect = element("button", "button subtle full", "Rileva servizi locali e configurati");
    detect.type = "button";
    const detected = element("div", "detected-services");
    detected.setAttribute("aria-live", "polite");
    if (operator) {
      detection.append(detect, detected);
      selected.before(detection);
    }
    const url = input("url", "http://macchina:porta/v1");
    url.setAttribute("aria-label", "Indirizzo del servizio");
    const urlField = field("Indirizzo del servizio", url, "Raggiungibile dal coordinator yed1z, anche quando usi VS Code.");
    const secret = input("password", "Incolla la API key");
    secret.autocomplete = "off";
    secret.setAttribute("aria-label", "API key");
    const requestSecret = input("checkbox");
    requestSecret.checked = api.native;
    const secretField = api.native ? field("API key", requestSecret, "Richiedi la chiave nella finestra protetta di VS Code.") : field("API key, se richiesta", secret, "Salvata in forma cifrata sul coordinator.");
    const accountLabel = input("text", "Personale, Lavoro, Account 2\u2026");
    accountLabel.maxLength = 80;
    const providerLabel = input("text");
    providerLabel.maxLength = 120;
    const modelIds = input("text", "modello-a, modello-b");
    const shared = input("checkbox");
    const advanced = element("details", "advanced connect-advanced");
    advanced.append(element("summary", "", "Personalizza nome, modelli e risorse"));
    advanced.append(field("Nome account facoltativo", accountLabel, "Se lo lasci vuoto viene creato un nome automatico."), field("Nome connessione", providerLabel), field("ID modelli manuali, facoltativi", modelIds, "Solo per servizi senza discovery. Gli ID restano dichiarati e non verificati."));
    const nodeChecks = element("div", "resource-checkboxes");
    const groupChecks = element("div", "resource-checkboxes");
    for (const node of data.nodes) {
      const check = input("checkbox");
      check.value = node.id;
      nodeChecks.append(field(node.label, check));
    }
    for (const group of data.resourceGroups) {
      const check = input("checkbox");
      check.value = group.id;
      groupChecks.append(field(group.label, check));
    }
    if (operator) advanced.append(field("Account condiviso con gli utenti autorizzati", shared), element("p", "fine-print", "Nodi di inferenza"), nodeChecks, element("p", "fine-print", "Risorse esclusive da prenotare"), groupChecks);
    const error = element("p", "form-error");
    error.hidden = true;
    error.setAttribute("role", "alert");
    const progress = element("div", "connection-progress");
    progress.hidden = true;
    progress.setAttribute("role", "status");
    const resultPanel = element("section", "connection-result");
    resultPanel.hidden = true;
    resultPanel.setAttribute("aria-live", "polite");
    const submit = element("button", "button primary full", "Continua");
    submit.type = "submit";
    form.append(element("p", "wizard-step", "02 / COLLEGA E TROVA I MODELLI"), urlField, secretField, advanced, progress, resultPanel, error, submit);
    let requestId = newId(), accountId, providerId, pending = false, detecting = false, generation = 0, nodesChanged = false, groupsChanged = false;
    const current = (attempt) => dialog.isConnected && dialog.open && generation === attempt;
    dialog.addEventListener("close", () => {
      generation++;
    });
    nodeChecks.addEventListener("change", () => {
      nodesChanged = true;
    });
    groupChecks.addEventListener("change", () => {
      groupsChanged = true;
    });
    function apply() {
      if (pending) return;
      generation++;
      nodesChanged = false;
      groupsChanged = false;
      detected.replaceChildren();
      const existing = data.providers.find((provider) => choice.value === `existing:${provider.id}`);
      const preset = presets.find((preset2) => preset2.id === choice.value);
      const kind = existing?.kind ?? choice.value, native = ["codex", "antigravity"].includes(kind);
      requestId = newId();
      accountId = void 0;
      providerId = existing?.id;
      secret.value = "";
      resultPanel.hidden = true;
      error.hidden = true;
      for (const tile of choices.querySelectorAll("[data-preset]")) {
        const active = tile.dataset.preset === choice.value;
        tile.classList.toggle("selected", active);
        tile.setAttribute("aria-pressed", String(active));
      }
      selected.replaceChildren(element("strong", "", existing?.label ?? preset?.label ?? "Scegli un servizio"), element("p", "", kind === "codex" ? "Usa il login ufficiale. Non servono URL o API key." : kind === "antigravity" ? "Verifichiamo la CLI e il profilo sul coordinator. Se serve il login, qui troverai il comando ufficiale." : "Una connessione, tutti i modelli rilevati."));
      url.value = existing?.baseUrl ?? preset?.url ?? "";
      url.required = !native && !existing;
      urlField.hidden = native || !!existing || ["openai", "gemini"].includes(choice.value);
      secretField.hidden = native;
      shared.disabled = native;
      if (native) shared.checked = false;
      nodeChecks.hidden = native || !!existing;
      groupChecks.hidden = native || !!existing;
      for (const check of nodeChecks.querySelectorAll("input")) check.checked = existing?.nodeIds.includes(check.value) ?? false;
      for (const check of groupChecks.querySelectorAll("input")) check.checked = existing?.resourceGroupIds.includes(check.value) ?? false;
      modelIds.closest("label").hidden = native;
      providerLabel.disabled = !!existing;
      providerLabel.value = existing?.label ?? preset?.label ?? "";
      if (existing) accountLabel.value = `Account ${data.accounts.filter((account) => account.providerId === existing.id).length + 1}`;
      submit.textContent = kind === "codex" ? "Accedi con Codex" : kind === "antigravity" ? "Collega Antigravity" : "Collega e trova modelli";
      submit.disabled = !choice.value;
    }
    choice.addEventListener("change", apply);
    apply();
    url.addEventListener("input", () => {
      if (pending) return;
      generation++;
      requestId = newId();
      accountId = void 0;
      providerId = data.providers.find((provider) => choice.value === `existing:${provider.id}`)?.id;
      resultPanel.hidden = true;
    });
    detect.addEventListener("click", () => {
      if (pending || detecting) return;
      detecting = true;
      const attempt = generation;
      detect.disabled = true;
      detected.replaceChildren(element("p", "fine-print", "Verifico gli indirizzi locali noti e le connessioni configurate dal coordinator\u2026"));
      void api.request("POST", "/api/connections/detect", {}).then((result) => {
        if (!current(attempt) || pending) return;
        detected.replaceChildren(element("p", "fine-print", result.scope));
        for (const candidate of result.candidates.filter((candidate2) => candidate2.status !== "unavailable")) {
          const button = element("button", "detected-service");
          button.type = "button";
          button.append(element("strong", "", candidate.label), element("span", "", `${candidate.modelCount} modelli \xB7 ${candidate.status === "standby" ? "In standby" : "Rilevato"}`), element("small", "", candidate.baseUrl));
          button.addEventListener("click", () => {
            if (pending) return;
            choice.value = candidate.providerId && data.providers.some((provider) => provider.id === candidate.providerId) ? `existing:${candidate.providerId}` : candidate.preset;
            apply();
            url.value = candidate.baseUrl;
            selected.scrollIntoView?.({ block: "nearest" });
          });
          detected.append(button);
        }
        if (!result.candidates.some((candidate) => candidate.status !== "unavailable")) detected.append(element("p", "fine-print", "Nessun servizio rilevato. Puoi inserire l\u2019indirizzo del tuo nodo scegliendo un provider locale."));
      }).catch((reason) => {
        if (current(attempt) && !pending) detected.replaceChildren(element("p", "fine-print", message(reason)));
      }).finally(() => {
        detecting = false;
        if (dialog.isConnected && dialog.open) detect.disabled = pending;
      });
    });
    async function showResult(result) {
      accountId = result.account.id;
      providerId = result.provider.id;
      resultPanel.replaceChildren();
      resultPanel.hidden = false;
      const success = result.status === "ready" || result.status === "standby";
      resultPanel.classList.toggle("success", success);
      resultPanel.append(element("h3", "", success ? `${result.models.length} modelli collegati` : "Completa il collegamento"), element("p", "", result.message));
      for (const warning of result.warnings ?? []) resultPanel.append(element("p", "fine-print", warning));
      if (result.status === "login-required" && result.nextAction?.kind === "login") {
        dialog.close();
        await options.login(result.account.id);
        return;
      }
      if (result.nextAction?.command) {
        const code = element("pre", "connect-command", result.nextAction.command);
        code.setAttribute("aria-label", "Comando ufficiale da eseguire sul coordinator");
        resultPanel.append(code);
      }
      if (result.nextAction?.docsUrl) {
        try {
          const url2 = new URL(result.nextAction.docsUrl);
          if (url2.protocol === "https:" && !url2.username && !url2.password) {
            const link = element("a", "text-button", "Istruzioni ufficiali");
            link.href = url2.href;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            resultPanel.append(link);
          }
        } catch {
        }
      }
      if (result.models.length) {
        const list = element("div", "connected-models");
        for (const model of result.models) {
          const button = element("button", "connected-model");
          button.type = "button";
          button.dataset.connectedModel = model.id;
          button.append(element("span", "", model.label), element("small", "", result.status === "unverified" ? "Dichiarato \xB7 da verificare" : model.capabilities.includes("embedding") && !model.capabilities.includes("chat") ? "Embedding" : "Usa questo modello \u2197"));
          button.addEventListener("click", () => {
            button.disabled = true;
            void options.connected(result, model.id).then(() => dialog.close()).catch((reason) => {
              error.textContent = message(reason);
              error.hidden = false;
              button.disabled = false;
            });
          });
          list.append(button);
        }
        resultPanel.append(list);
        const done = element("button", "button full", "Fatto, torna al progetto");
        done.type = "button";
        done.addEventListener("click", () => {
          done.disabled = true;
          void options.connected(result).then(() => dialog.close()).catch((reason) => {
            error.textContent = message(reason);
            error.hidden = false;
            done.disabled = false;
          });
        });
        resultPanel.append(done);
      }
      submit.textContent = result.nextAction?.label ?? "Verifica di nuovo";
      resultPanel.scrollIntoView?.({ block: "nearest" });
    }
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (pending) return;
      pending = true;
      const attempt = generation;
      const controls = Array.from(form.querySelectorAll("input, select, button")).map((control) => ({ control, disabled: control.disabled }));
      for (const { control } of controls) control.disabled = true;
      error.hidden = true;
      progress.hidden = false;
      progress.textContent = ["codex", "antigravity"].includes(choice.value) ? "Controllo della CLI e dell\u2019accesso in corso\u2026" : "Verifica della connessione e ricerca dei modelli\u2026";
      for (const button of choices.querySelectorAll("button")) button.disabled = true;
      choice.disabled = true;
      const existing = data.providers.find((provider) => choice.value === `existing:${provider.id}`);
      const preset = existing ? existing.kind === "openai-responses" ? "openai" : ["openai-compatible", "cluster"].includes(existing.kind) ? existing.tag === "gemrouter" ? "gemrouter" : "custom" : existing.kind : choice.value;
      const native = ["codex", "antigravity"].includes(preset);
      const payload = { preset, requestId, ...providerId ? { providerId } : {}, ...accountId ? { accountId } : {}, label: providerLabel.value.trim(), accountLabel: accountLabel.value.trim(), ...!native ? { baseUrl: url.value.trim(), modelIds: modelIds.value.split(",").map((value2) => value2.trim()).filter(Boolean) } : {}, shared: operator && !native && shared.checked };
      if (operator && !nodeChecks.hidden && nodesChanged) payload.nodeIds = Array.from(nodeChecks.querySelectorAll("input:checked")).map((input2) => input2.value);
      if (operator && !groupChecks.hidden && groupsChanged) payload.resourceGroupIds = Array.from(groupChecks.querySelectorAll("input:checked")).map((input2) => input2.value);
      if (!native && api.native && requestSecret.checked) payload.requestSecret = true;
      else if (!native && !api.native && secret.value) payload.secret = secret.value;
      secret.value = "";
      void api.request("POST", "/api/connections", payload).then((result) => current(attempt) ? showResult(result) : void 0).catch((reason) => {
        if (current(attempt)) {
          error.textContent = message(reason);
          error.hidden = false;
        }
      }).finally(() => {
        if (!current(attempt)) return;
        pending = false;
        for (const { control, disabled } of controls) control.disabled = disabled;
        detect.disabled = detecting;
        progress.hidden = true;
      });
    });
  }
  function newId() {
    return globalThis.crypto?.randomUUID?.() ?? `connect-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
  function message(error) {
    return error instanceof Error ? error.message : "Collegamento non riuscito.";
  }

  // src/intent.ts
  function classifyRequest(text, options = {}) {
    if (options.mode === "mission") return { mode: "mission", kind: "work", reason: "Squadra selezionata esplicitamente." };
    const value2 = text.normalize("NFKC").trim().toLocaleLowerCase("it-IT").replace(/[?!.,;:]+$/u, "").replace(/\s+/gu, " ");
    if (!options.attachmentCount && value2.length < 160) {
      const patterns = [
        ["greeting", /^(?:(?:ciao|salve|buongiorno|buonasera|hey|ehi|hello|hi)(?: yed1z)?(?:[,! ]+)?(?:come (?:stai|va)|how are you)?|come (?:stai|va)|how are you)$/u],
        ["thanks", /^(?:grazie(?: mille| di tutto)?|thank you|thanks|perfetto grazie)$/u],
        ["presence", /^(?:ci sei|sei (?:qui|online|disponibile)|are you there|are you online)$/u],
        ["help", /^(?:aiuto|help|cosa (?:puoi|sai) fare|come funzioni|what can you do)$/u],
        ["status", /^(?:a che punto (?:sei|siamo)|stato(?: della missione| dei lavori| degli agenti)?|come procede|che cosa stai facendo|cosa stai facendo|status|what are you working on)$/u],
        ["models", /^(?:quali modelli (?:hai|ci sono|sono disponibili|sono liberi)|modelli disponibili|which models are available)$/u]
      ];
      for (const [service, pattern] of patterns) if (pattern.test(value2)) return { mode: "chat", kind: "service", service, reason: "Risposta diretta del servizio: nessuna inferenza o esecuzione." };
    }
    if (options.mode === "chat") return { mode: "chat", kind: "conversation", reason: "Conversazione selezionata esplicitamente." };
    const directive = /^(?:(?:per favore|per piacere|please)\s+)?(?:(?:puoi|potresti|riesci a|can you|could you)\s+)?(?:implement(?:a|are)?|crea(?:mi|re)?|realizza(?:re)?|sviluppa(?:re)?|corregg(?:i|ere)|sistema(?:re)?|ripara(?:re)?|aggiorna(?:re)?|rifai|riprogetta(?:re)?|refactor(?:izza|are)?|aggiung(?:i|ere)|rimuov(?:i|ere)|modifica(?:re)?|esegui|testa|rilascia|pubblica|distribuisci|deploy|build|fix|create|develop|update|add|remove|ship)\b/u;
    const desiredWork = /^(?:voglio|vorrei|ho bisogno di)\s+(?:che tu\s+)?(?:creare|realizzare|sviluppare|implementare|correggere|aggiornare|rifare|riprogettare|rilasciare)\b/u;
    if (directive.test(value2) || desiredWork.test(value2)) return { mode: "mission", kind: "work", reason: "Richiesta esplicita di modifica o esecuzione." };
    return { mode: "chat", kind: "conversation", reason: "Domanda o conversazione: una risposta, senza pianificazione della squadra." };
  }

  // web/app.ts
  var labels = { queued: "In coda", planning: "Pianificazione", executing: "In esecuzione", reviewing: "Revisione", verifying: "Verifica", awaiting_release: "Pronto al rilascio", deploying: "Rilascio in corso", succeeded: "Completato", failed: "Errore", paused: "In pausa", cancelled: "Annullato", interrupted: "Interrotto", blocked: "Bloccato", running: "Al lavoro", online: "Online", offline: "Offline", stale: "Dato non recente", unknown: "Non rilevato", ready: "Disponibile", cooldown: "In attesa quota", approved: "Approvata", candidate: "Da confermare", retired: "Archiviata", pending: "Da approvare", denied: "Negata", expired: "Scaduta" };
  var roleLabels = { primary: "Orchestratore", coder: "Sviluppatore", researcher: "Ricercatore", reviewer: "Revisore", tester: "Verificatore", release: "Release", admin: "Amministratore", operator: "Operatore", member: "Membro", viewer: "Osservatore" };
  var paths = { grid: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z", activity: "M2 12h4l3-8 5 16 3-8h5", layers: "m12 3 10 6-10 6L2 9zM2 15l10 6 10-6M2 12l10 6 10-6", plug: "M8 3v5M16 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v5", rocket: "M14 4c3-2 6-2 6-2s0 3-2 6l-6 6-5-5zM8 8l-4 1-2 4 5-1M14 14l-1 5-4 2 1-6M5 16l-2 5 5-2M14 6h.01", plus: "M12 5v14M5 12h14", close: "m6 6 12 12M6 18 18 6", menu: "M4 6h16M4 12h16M4 18h16", down: "m6 9 6 6 6-6", up: "m6 15 6-6 6 6M12 9v12", arrow: "M5 12h14m-6-6 6 6-6 6", refresh: "M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 2M18 18A8 8 0 0 1 5 16", server: "M4 3h16v7H4zM4 14h16v7H4zM7 6h.01M7 17h.01M11 6h6M11 17h6", chip: "M6 6h12v12H6zM9 9h6v6H9zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4", cloud: "M6 18a4 4 0 0 1-1-8 7 7 0 0 1 13-2 5 5 0 0 1 0 10z", people: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-4M16 3a4 4 0 0 1 0 8", code: "m8 6-6 6 6 6M16 6l6 6-6 6M14 3l-4 18", check: "m5 12 4 4L19 6", checkSquare: "M9 11l3 3L22 4M21 12v8H3V2h12", file: "M14 2H5v20h14V7zM14 2v6h5M8 12h8M8 16h6", upload: "M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5", download: "M12 3v13m-5-5 5 5 5-5M4 16v5h16v-5", search: "M21 21l-6-6M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0", settings: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2", logout: "M9 3H3v18h6M9 12h13m-4-4 4 4-4 4", paperclip: "m8 13 7-7a3 3 0 0 1 4 4l-9 9a5 5 0 0 1-7-7l9-9M6 15l9-9", pause: "M7 4v16M17 4v16", play: "m6 3 15 9-15 9z", stop: "M5 5h14v14H5z", edit: "m15 4 5 5M3 21l6-1L21 8a3 3 0 0 0-5-5L4 15z", trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7", info: "M12 8h.01M12 11v6M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0", book: "M3 3h6a3 3 0 0 1 3 3v15a3 3 0 0 0-3-3H3zM21 3h-6a3 3 0 0 0-3 3v15a3 3 0 0 1 3-3h6z", terminal: "m4 5 6 7-6 7M12 19h8", share: "M6 12h12M12 6v12M6 3h.01M18 3h.01", shield: "m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6zM8 12l3 3 5-6" };
  var activeRunStatuses = /* @__PURE__ */ new Set(["queued", "planning", "executing", "reviewing", "verifying", "deploying"]);
  var closedRunStatuses = /* @__PURE__ */ new Set(["succeeded", "failed", "cancelled"]);
  function mountApp(root, api) {
    return new ControlRoom(root, api);
  }
  var ControlRoom = class {
    root;
    api;
    document;
    win;
    data;
    projectId = "";
    conversationId = "";
    routeId = "";
    runId = "";
    taskId = "";
    view = "control";
    knowledgeTab = "memories";
    taskTab = "output";
    selectedAttachments = [];
    events = [];
    taskProgress = /* @__PURE__ */ new Map();
    telemetryHistory = /* @__PURE__ */ new Map();
    drafts = /* @__PURE__ */ new Map();
    disposers = [];
    subscription;
    refreshTimer;
    loading;
    loginDialog;
    disposed = false;
    sending = false;
    connected = false;
    searchQuery = "";
    searchResults;
    autonomy = { write: false, commands: false, deploy: false, maxIterations: 3, maxParallel: 3 };
    accountLoginDialog;
    routingOverrides = /* @__PURE__ */ new Map();
    streamFrame;
    packetTimer;
    motionEnabled = true;
    messageLimit = 80;
    modelPickerRender;
    constructor(root, api) {
      this.root = root;
      this.api = api;
      this.document = root.ownerDocument;
      this.win = this.document.defaultView;
      root.innerHTML = `<a class="skip-link" href="#message-input">All'orchestratore</a>
      <div class="shell" id="shell"><aside class="sidebar" aria-label="Progetti e conversazioni">
      <div class="brand-row"><a href="#control" class="brand" aria-label="yed1z Control Room">yed1z<span class="brand-dot">.</span></a><span class="brand-tag">QUANTUM<br>// HALO</span></div>
      <div class="project-label"><span class="eyebrow">IL TUO PROGETTO</span><button id="new-project" class="icon-button" title="Nuovo progetto" aria-label="Nuovo progetto"></button></div>
      <label class="sr-only" for="project-select">Progetto attivo</label><select id="project-select" class="project-switch"><option value="">Scegli un progetto</option></select>
      <nav class="nav" aria-label="Sezioni"><button class="nav-item active" data-view="control" aria-current="page">Chat e squadra</button><button class="nav-item" data-view="infrastructure">Dashboard cluster</button><button class="nav-item" data-view="knowledge">Conoscenza</button><button class="nav-item" data-view="connections">Modelli e account</button><button class="nav-item" data-view="releases">Consegne e rilasci</button></nav>
      <div class="sidebar-line"></div><div class="history-heading"><span class="eyebrow">CONVERSAZIONI</span><button id="new-conversation" class="icon-button" title="Nuova conversazione" aria-label="Nuova conversazione"></button></div>
      <label class="sr-only" for="history-search">Cerca una conversazione</label><input id="history-search" class="history-search" type="search" placeholder="Cerca nelle tue conversazioni\u2026" autocomplete="off"><div class="history" id="history"></div>
      <div class="sidebar-footer"><div class="avatar" id="user-avatar">y</div><div class="user-copy"><strong id="user-name">Il tuo spazio</strong><small id="user-role">Connessione\u2026</small></div><button class="icon-button" id="user-action" aria-label="Esci" title="Esci"></button></div></aside>
      <button class="sidebar-backdrop" id="sidebar-backdrop" aria-label="Chiudi navigazione"></button>
      <main class="workspace"><header class="topbar"><div class="row"><button class="icon-button mobile-menu" id="mobile-menu" aria-label="Apri navigazione"></button><div><div class="breadcrumb" id="breadcrumb">DISTRIBUTED AGENT WORKSTATION</div><h1 id="page-title">Chat e squadra</h1></div></div><div class="topbar-actions"><button class="button subtle fx-toggle" id="fx-toggle" aria-label="Disattiva animazioni" aria-pressed="true">FX ON</button><button class="button subtle" id="quick-connect"><span>Collega modello</span></button><span class="connection-state" id="connection-state"><i class="status-dot"></i>COLLEGAMENTO</span><button class="button primary" id="guest-login-btn" hidden style="font-weight:700">Accedi</button><button class="button subtle" id="project-settings"><span>Progetto</span></button><button class="button subtle mobile-team-button" id="show-team"><span>Squadra</span></button></div></header>
      <section class="fleet-ribbon" id="fleet-ribbon" aria-label="Stato dell'infrastruttura"></section><div class="banner" id="banner" role="status" hidden><span></span><button class="icon-button" id="close-banner" aria-label="Chiudi avviso"></button></div>
      <div class="content" id="content"><section class="control-room" id="control-view" aria-label="Control room"><section class="conversation" aria-label="Orchestratore e conversazione"><header class="conversation-heading"><div><h2><i class="role-orb"></i>Il tuo orchestratore</h2><p id="conversation-subtitle">Un obiettivo. Una squadra. Tutto sotto controllo.</p></div><div class="conversation-actions"><button id="export-conversation" class="icon-button export-button" aria-label="Esporta conversazione" title="Esporta conversazione"></button><button id="context-info" class="icon-button" aria-label="Contesto dell'ultima attivit\xE0" title="Contesto dell'ultima attivit\xE0"></button></div></header>
      <div id="activity-strip" class="activity-strip"></div><div id="messages" class="messages" role="log" aria-label="Messaggi" aria-live="off"></div><div class="composer-wrap"><form id="composer" class="composer"><div id="attachments-preview" class="attachments-preview" hidden></div><label class="sr-only" for="message-input">Parla con il tuo orchestratore</label><textarea id="message-input" rows="3" maxlength="100000" placeholder="Descrivi il risultato che vuoi ottenere. Al resto lavoriamo insieme." required></textarea><div class="composer-tools"><button id="attach-file" class="icon-button" type="button" aria-label="Allega un documento" title="Allega un documento"></button><button id="model-picker" class="model-button" type="button" aria-haspopup="dialog"><span id="model-label">Scegli modello e account</span></button><label class="sr-only" for="mode-select">Modalit\xE0</label><select id="mode-select"><option value="auto">Auto</option><option value="chat">Chat diretta</option><option value="mission">Squadra</option></select><button id="routing-policy" class="routing-button" type="button" title="Disponibilit\xE0 e alternative autorizzate">Auto</button><button id="mission-settings" class="icon-button" type="button" aria-label="Autonomia e limiti" title="Autonomia e limiti"></button><button id="send" class="send" type="submit" aria-label="Invia all'orchestratore"></button><button id="stop" class="send stop" type="button" aria-label="Interrompi attivit\xE0" hidden></button></div></form><div class="composer-caption"><span id="composer-status">Il contesto resta nel progetto.</span><span class="keyboard-hint">Invio \u21B5 \xB7 A capo \u21E7\u21B5</span></div></div></section>
      <aside class="team-panel" aria-label="Squadra di agenti"><header class="team-header"><div class="row spread"><h2 class="row" id="team-title">La tua squadra</h2><button class="icon-button close-team" id="close-team" aria-label="Chiudi squadra"></button></div><p id="team-subtitle">Agenti, modelli e avanzamento in tempo reale.</p></header><div class="team-body" id="team-body"></div><div class="task-detail" id="task-detail" hidden></div><footer class="team-footer"><span id="team-footer-left">Nessuna attivit\xE0 in corso</span><span id="team-footer-right"></span></footer></aside></section><section id="page-view" class="page" hidden></section></div></main></div><div class="toast-stack" id="toasts" role="status" aria-live="polite"></div><input id="file-input" type="file" accept=".md,.txt,.json,.csv,.ts,.tsx,.js,.py,.go,.rs,.yaml,.yml,.toml,.log,text/*,application/json" multiple hidden>`;
      this.installIcons();
      this.bind();
      this.syncNavigation();
      try {
        this.motionEnabled = this.win.localStorage.getItem("yed1z.motion") !== "off" && !this.win.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      } catch {
      }
      this.applyMotion();
      if (api.onSelection) this.disposers.push(api.onSelection((selection) => {
        void this.uploadText(selection.name, selection.content, true);
      }));
      if (api.onConfigured) this.disposers.push(api.onConfigured(() => {
        this.loginDialog?.close();
        void this.refresh(true);
      }));
      void this.refresh(true);
    }
    q(selector) {
      const node = this.root.querySelector(selector);
      if (!node) throw new Error(`UI node missing: ${selector}`);
      return node;
    }
    el(tag, className = "", text) {
      const node = this.document.createElement(tag);
      if (className) node.className = className;
      if (text !== void 0) node.textContent = text;
      return node;
    }
    icon(name) {
      const svg = this.document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("class", "icon");
      svg.setAttribute("aria-hidden", "true");
      const path = this.document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", paths[name] ?? paths.info);
      svg.append(path);
      return svg;
    }
    button(label, action, options = {}) {
      const button = this.el("button", options.className ?? "button", label);
      button.type = "button";
      if (options.icon) button.prepend(this.icon(options.icon));
      if (options.disabled) button.disabled = true;
      if (options.title) {
        button.title = options.title;
        if (!label) button.setAttribute("aria-label", options.title);
      }
      button.addEventListener("click", () => {
        void this.perform(button, action);
      });
      return button;
    }
    pill(status, text) {
      return this.el("span", `pill ${statusTone(status)}`, text ?? labels[status] ?? status);
    }
    field(label, input, note) {
      const field = this.el("div", "form-field");
      input.id ||= `field-${Math.random().toString(36).slice(2)}`;
      const labelNode = this.el("label", "", label);
      labelNode.htmlFor = input.id;
      field.append(labelNode, input);
      if (note) field.append(this.el("p", "fine-print", note));
      return field;
    }
    input(type, value2 = "", placeholder = "") {
      const input = this.el("input");
      input.type = type;
      input.value = value2;
      input.placeholder = placeholder;
      return input;
    }
    select(options, value2 = "") {
      const select = this.el("select");
      for (const item of options) {
        const option = this.el("option", "", item.label);
        option.value = item.value;
        select.append(option);
      }
      select.value = value2;
      return select;
    }
    installIcons() {
      const ids = { "new-project": "plus", "new-conversation": "plus", "user-action": this.api.native ? "settings" : "logout", "mobile-menu": "menu", "project-settings": "settings", "show-team": "people", "close-banner": "close", "export-conversation": "download", "context-info": "layers", "attach-file": "paperclip", "mission-settings": "settings", send: "up", stop: "stop", "close-team": "close", "guest-login-btn": "shield", "quick-connect": "plug" };
      for (const [id, icon] of Object.entries(ids)) this.q(`#${id}`).prepend(this.icon(icon));
      this.q("#team-title").prepend(this.icon("people"));
      const navigation = { control: "grid", infrastructure: "activity", knowledge: "book", connections: "plug", releases: "rocket" };
      for (const [view, icon] of Object.entries(navigation)) this.q(`[data-view="${view}"]`).prepend(this.icon(icon));
      this.q("#model-picker").append(this.icon("down"));
      this.q("#quick-connect").setAttribute("aria-label", "Collega un modello");
      this.q("#project-settings").setAttribute("aria-label", "Impostazioni del progetto");
      this.q("#show-team").setAttribute("aria-label", "Apri squadra");
      this.q(".sidebar").id = "navigation-sidebar";
      this.q("#mobile-menu").setAttribute("aria-controls", "navigation-sidebar");
    }
    bind() {
      this.q(".brand").addEventListener("click", (event) => {
        event.preventDefault();
        this.setView("control");
      });
      this.q(".skip-link").addEventListener("click", (event) => {
        event.preventDefault();
        this.setView("control");
        this.q("#message-input").focus();
      });
      if (this.api.native) {
        this.q("#user-action").setAttribute("aria-label", "Configura connessione");
        this.q("#user-action").title = "Configura connessione";
      }
      for (const item of this.root.querySelectorAll("[data-view]")) item.addEventListener("click", () => this.setView(item.dataset.view));
      this.q("#project-select").addEventListener("change", (event) => {
        this.saveDraft();
        this.projectId = event.target.value;
        this.conversationId = "";
        this.runId = "";
        this.taskId = "";
        this.chooseConversation();
        this.restoreDraft();
        this.render();
      });
      this.q("#history-search").addEventListener("input", () => this.renderHistory());
      this.q("#new-project").addEventListener("click", () => this.projectDialog());
      this.q("#project-settings").addEventListener("click", () => this.projectDialog(this.project));
      this.q("#new-conversation").addEventListener("click", () => {
        void this.newConversation();
      });
      this.q("#model-picker").addEventListener("click", () => this.modelDialog());
      this.q("#routing-policy").addEventListener("click", () => this.modelDialog());
      this.q("#quick-connect").addEventListener("click", () => this.data?.user.id === "guest" ? this.showLogin() : this.connectionDialog());
      this.q("#fx-toggle").addEventListener("click", () => {
        this.motionEnabled = !this.motionEnabled;
        this.applyMotion();
        try {
          this.win.localStorage.setItem("yed1z.motion", this.motionEnabled ? "on" : "off");
        } catch {
        }
      });
      this.q("#composer").addEventListener("submit", (event) => {
        event.preventDefault();
        void this.send();
      });
      this.q("#message-input").addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          this.q("#composer").requestSubmit();
        }
      });
      this.q("#message-input").addEventListener("input", () => this.updateComposer());
      this.q("#message-input").addEventListener("click", () => {
        if (this.data?.user.id === "guest") this.showLogin();
      });
      this.q("#mode-select").addEventListener("change", () => this.updateComposer());
      this.q("#stop").addEventListener("click", () => {
        const run = this.currentRun;
        if (run) void this.runAction(run, "cancel");
      });
      this.q("#attach-file").addEventListener("click", () => this.attachmentDialog());
      this.q("#file-input").addEventListener("change", (event) => {
        const input = event.target;
        const files = Array.from(input.files ?? []);
        input.value = "";
        void this.uploadFiles(files);
      });
      this.q("#mission-settings").addEventListener("click", () => this.autonomyDialog());
      this.q("#context-info").addEventListener("click", () => {
        const task = this.currentRun?.tasks.findLast((item) => item.context);
        if (task?.context) this.contextDialog(task.context);
        else this.toast("Il contesto sar\xE0 visibile dopo la prima chiamata a un agente.");
      });
      this.q("#export-conversation").addEventListener("click", () => {
        if (this.conversation) void this.downloadJson(`${safeFilename(this.conversation.title)}.json`, this.conversation).catch((error) => this.showBanner(errorMessage(error), true));
      });
      this.q("#user-action").addEventListener("click", () => {
        if (this.api.native) this.api.configure?.();
        else if (this.data?.user.id === "guest") this.showLogin();
        else void this.logout();
      });
      this.q("#guest-login-btn").addEventListener("click", () => this.showLogin());
      this.q("#mobile-menu").addEventListener("click", () => {
        this.q("#shell").classList.toggle("sidebar-open");
        this.syncNavigation();
        if (this.q("#shell").classList.contains("sidebar-open")) this.q('.sidebar [aria-current="page"]').focus();
      });
      this.q("#sidebar-backdrop").addEventListener("click", () => {
        this.q("#shell").classList.remove("sidebar-open");
        this.syncNavigation();
      });
      const resize = () => this.syncNavigation();
      this.win.addEventListener("resize", resize);
      this.disposers.push(() => this.win.removeEventListener("resize", resize));
      const escape = (event) => {
        if (event.key === "Escape" && this.win.innerWidth <= 720 && this.q("#shell").classList.contains("sidebar-open") && !this.root.querySelector("dialog[open]")) {
          event.preventDefault();
          this.q("#shell").classList.remove("sidebar-open");
          this.syncNavigation();
        }
      };
      this.document.addEventListener("keydown", escape);
      this.disposers.push(() => this.document.removeEventListener("keydown", escape));
      this.q("#show-team").addEventListener("click", () => {
        this.setView("control");
        this.q("#shell").classList.toggle("team-open");
      });
      this.q("#close-team").addEventListener("click", () => this.q("#shell").classList.remove("team-open"));
      this.q("#close-banner").addEventListener("click", () => {
        this.q("#banner").hidden = true;
      });
    }
    syncNavigation() {
      const sidebar = this.q(".sidebar"), hidden = this.win.innerWidth <= 720 && !this.q("#shell").classList.contains("sidebar-open");
      if (hidden && sidebar.contains(this.document.activeElement)) this.q("#mobile-menu").focus();
      sidebar.inert = hidden;
      sidebar.setAttribute("aria-hidden", String(hidden));
      this.q("#mobile-menu").setAttribute("aria-expanded", String(this.win.innerWidth <= 720 && !hidden));
    }
    get ready() {
      return this.loading ?? Promise.resolve();
    }
    get project() {
      return this.data?.projects.find((item) => item.id === this.projectId);
    }
    get conversation() {
      return this.data?.conversations.find((item) => item.id === this.conversationId);
    }
    get currentRun() {
      return this.data?.runs.find((item) => item.id === this.runId) ?? this.data?.runs.filter((item) => item.conversationId === this.conversationId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    }
    get canWrite() {
      return !!this.data && this.data.user.role !== "viewer";
    }
    get operator() {
      return !!this.data && ["admin", "operator"].includes(this.data.user.role);
    }
    route(id) {
      return this.data?.models.find((item) => item.id === id);
    }
    account(id) {
      return this.data?.accounts.find((item) => item.id === id);
    }
    provider(id) {
      return this.data?.providers.find((item) => item.id === id);
    }
    usableRoute(route, _writeRole = false) {
      const kind = this.provider(route.providerId)?.kind;
      return route.enabled && !(route.capabilities.includes("embedding") && !route.capabilities.includes("chat")) && (this.operator || !["codex", "antigravity"].includes(kind ?? ""));
    }
    get routing() {
      return this.routingOverrides.get(this.projectId) ?? this.project?.routing ?? { strategy: "auto", fallbackRouteIds: [] };
    }
    availability(routeId) {
      return this.data?.routeAvailability?.find((item) => item.routeId === routeId);
    }
    applyMotion() {
      this.root.dataset.motion = this.motionEnabled ? "on" : "off";
      const button = this.q("#fx-toggle");
      button.textContent = this.motionEnabled ? "FX ON" : "FX OFF";
      button.setAttribute("aria-pressed", String(this.motionEnabled));
      button.setAttribute("aria-label", this.motionEnabled ? "Disattiva animazioni" : "Attiva animazioni");
    }
    paintStream() {
      if (this.streamFrame !== void 0 || this.disposed) return;
      this.streamFrame = this.win.requestAnimationFrame(() => {
        this.streamFrame = void 0;
        if (this.disposed) return;
        this.renderMessages();
        if (this.taskId) this.renderTaskDetail();
      });
    }
    pulseActivity(destination) {
      if (!this.motionEnabled || this.disposed) return;
      for (const node of this.root.querySelectorAll("[data-activity-node]")) node.classList.toggle("packet", node.dataset.activityNode === destination);
      if (this.packetTimer) clearTimeout(this.packetTimer);
      this.packetTimer = setTimeout(() => {
        this.packetTimer = void 0;
        for (const node of this.root.querySelectorAll(".activity-node.packet")) node.classList.remove("packet");
      }, 650);
    }
    createActivity(expanded = false) {
      const run = this.currentRun;
      return activityView(this.document, this.data, { project: this.project, run, routeLabel: this.route(run?.routeId ?? this.routeId)?.label, expanded, serviceReply: this.conversation?.messages.some((message2) => message2.runId === run?.id && message2.source === "service"), onSelect: (destination) => {
        if (destination === "knowledge") this.setView("knowledge");
        else if (destination === "models") this.data?.user.id === "guest" ? this.showLogin() : this.modelDialog();
        else if (destination === "evidence") this.setView("releases");
        else {
          this.setView("control");
          if (destination === "team") this.q("#shell").classList.add("team-open");
          else this.q("#message-input").focus();
        }
      } });
    }
    renderActivity() {
      if (this.data) this.q("#activity-strip").replaceChildren(this.createActivity());
    }
    routingEditor(initial, onChange) {
      const wrapper = this.el("details", "routing-editor advanced");
      wrapper.append(this.el("summary", "", "Se il modello \xE8 occupato"));
      const strategy = this.select([{ value: "auto", label: "Usa un\u2019alternativa autorizzata disponibile" }, { value: "pinned", label: "Attendi il modello selezionato" }], initial.strategy);
      strategy.setAttribute("aria-label", "Instradamento quando il modello \xE8 occupato");
      wrapper.append(this.field("Comportamento", strategy));
      const choices = this.el("div", "fallback-choices");
      for (const route of this.data?.models.filter((route2) => this.usableRoute(route2)) ?? []) {
        const checkbox = this.input("checkbox");
        checkbox.value = route.id;
        checkbox.checked = initial.fallbackRouteIds.includes(route.id);
        const label = this.el("label", "fallback-choice");
        label.append(checkbox, this.el("span", "", `${route.label} \xB7 ${this.account(route.accountId)?.label ?? ""}`));
        choices.append(label);
      }
      const help = this.el("p", "fine-print", "Solo i modelli che autorizzi qui. Il servizio non sposta il contesto su altri provider senza questa scelta.");
      wrapper.append(this.el("p", "field-label", "Alternative autorizzate"), choices, help);
      const update = () => {
        choices.hidden = strategy.value === "pinned";
        onChange({ strategy: strategy.value, fallbackRouteIds: Array.from(choices.querySelectorAll("input:checked")).map((input) => input.value), ...initial.maxWaitMs ? { maxWaitMs: initial.maxWaitMs } : {} });
      };
      strategy.addEventListener("change", update);
      choices.addEventListener("change", update);
      choices.hidden = strategy.value === "pinned";
      return wrapper;
    }
    async refresh(initial = false) {
      if (this.disposed) return;
      if (this.loading) return this.loading;
      this.loading = (async () => {
        try {
          const data = await this.api.request("GET", "/api/bootstrap");
          if (this.disposed) return;
          const wasGuest = this.data?.user.id === "guest";
          this.data = data;
          if (wasGuest && data.user.id !== "guest") {
            this.view = "control";
            this.q("#mode-select").value = ["admin", "operator"].includes(data.user.role) ? "auto" : "chat";
          }
          if (!data.projects.some((item) => item.id === this.projectId)) this.projectId = data.projects[0]?.id ?? "";
          this.chooseConversation();
          if (!data.models.some((item) => item.id === this.routeId && this.usableRoute(item))) {
            const suggested = this.conversation?.routeId ?? this.project?.routes.primary;
            this.routeId = data.models.find((item) => item.id === suggested && this.usableRoute(item))?.id ?? data.models.find((item) => this.usableRoute(item))?.id ?? "";
          }
          this.loginDialog?.close();
          this.loginDialog = void 0;
          if (initial && data.user.id === "guest") {
            this.view = "infrastructure";
          }
          this.render();
          if (!this.subscription) this.subscription = this.api.subscribe((event) => this.onEvent(event), (connected) => {
            this.connected = connected;
            this.renderConnection();
            if (!connected) this.scheduleRefresh();
          });
          if (initial && data.demo) this.showBanner("MODALIT\xC0 DEMO \xB7 Dati di esempio dichiarati. Nessuna connessione ai nodi reali.");
        } catch (error) {
          if (error instanceof ApiError && (error.status === 401 || error.status === 403)) this.showLogin();
          else {
            this.showBanner(errorMessage(error), true);
            if (initial && this.api.native) this.showLogin();
          }
        } finally {
          this.loading = void 0;
        }
      })();
      return this.loading;
    }
    chooseConversation() {
      if (!this.data) return;
      const conversations = this.data.conversations.filter((item) => item.projectId === this.projectId);
      if (!conversations.some((item) => item.id === this.conversationId)) this.conversationId = conversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id ?? "";
      if (this.runId && !this.data.runs.some((item) => item.id === this.runId && item.conversationId === this.conversationId)) this.runId = "";
    }
    scheduleRefresh() {
      if (this.refreshTimer || this.disposed) return;
      this.refreshTimer = setTimeout(() => {
        this.refreshTimer = void 0;
        void this.refresh();
      }, 250);
    }
    onEvent(event) {
      if (event.type === "account.login") {
        this.loginEvent(event);
        return;
      }
      if ((event.type === "telemetry" || event.type === "routing.updated") && this.data && event.data) {
        const observation = event.data;
        if (Array.isArray(observation.telemetry)) this.data.telemetry = observation.telemetry;
        if (Array.isArray(observation.routeAvailability)) this.data.routeAvailability = observation.routeAvailability;
        if (Array.isArray(observation.providerLoads)) this.data.providerLoads = observation.providerLoads;
        if (observation.resourceUsage && typeof observation.resourceUsage === "object" && !Array.isArray(observation.resourceUsage)) this.data.resourceUsage = observation.resourceUsage;
        if (event.type === "telemetry") {
          this.renderFleet();
          if (this.view === "infrastructure") this.renderPage();
        } else if (this.view === "infrastructure") {
          const table = this.root.querySelector("#route-availability");
          if (table) this.renderRouteAvailability(table);
          for (const pool of this.root.querySelectorAll("[data-resource-group]")) {
            const group = this.data.resourceGroups.find((item) => item.id === pool.dataset.resourceGroup), usage = pool.querySelector(".pool-usage");
            if (group && usage) usage.textContent = `${this.data.resourceUsage[group.id] ?? 0}/${group.capacity} slot occupati nel coordinator. Le attivit\xE0 in eccesso attendono la disponibilit\xE0 delle risorse.`;
          }
        }
        this.modelPickerRender?.();
        this.updateComposer();
        return;
      }
      if (event.type.endsWith(".delta")) this.pulseActivity(event.type === "message.delta" ? "orchestrator" : "models");
      else if (event.type.startsWith("context.") || event.type.startsWith("memory.")) this.pulseActivity("knowledge");
      else if (event.type.startsWith("tool.")) this.pulseActivity("team");
      else if (event.type === "evidence.created") this.pulseActivity("evidence");
      if (!event.type.endsWith(".delta")) {
        this.events.push(event);
        if (this.events.length > 300) this.events.splice(0, this.events.length - 300);
      }
      if (event.type === "message.delta" && event.data && this.data) {
        const { messageId, delta, offset } = event.data;
        if (typeof messageId === "string" && typeof delta === "string") {
          let found = false;
          for (const conversation of this.data.conversations) {
            const message2 = conversation.messages.find((item) => item.id === messageId);
            if (message2) {
              found = true;
              if (typeof offset === "number" && Number.isSafeInteger(offset)) {
                if (offset > message2.text.length) {
                  this.scheduleRefresh();
                  break;
                }
                if (offset + delta.length <= message2.text.length) break;
                message2.text += delta.slice(message2.text.length - offset);
              } else message2.text += delta;
              message2.status = "streaming";
              if (conversation.id === this.conversationId) this.paintStream();
              break;
            }
          }
          if (!found) this.scheduleRefresh();
        }
      } else if (event.type === "task.delta" && event.taskId && typeof event.data?.delta === "string") {
        const progress = this.taskProgress.get(event.taskId) ?? { text: "", cursor: 0, incomplete: false };
        const offset = typeof event.data.offset === "number" ? event.data.offset : progress.cursor;
        const delta = event.data.delta;
        if (offset > progress.cursor) {
          progress.incomplete = true;
          progress.cursor = offset;
        }
        if (offset + delta.length > progress.cursor) {
          progress.text += delta.slice(Math.max(0, progress.cursor - offset));
          progress.cursor = offset + delta.length;
        }
        this.taskProgress.set(event.taskId, progress);
        if (this.taskId === event.taskId) this.paintStream();
      } else this.scheduleRefresh();
      if (this.taskId && this.taskTab === "events") this.renderTaskDetail();
    }
    render() {
      if (!this.data) return;
      const isGuest = this.data.user.id === "guest";
      const guestBtn = this.q("#guest-login-btn");
      if (guestBtn) guestBtn.hidden = !isGuest;
      const projectSelect = this.q("#project-select");
      projectSelect.replaceChildren();
      if (!this.data.projects.length) {
        const option = this.el("option", "", isGuest ? "Modalit\xE0 ospite" : "Crea un progetto");
        option.value = "";
        projectSelect.append(option);
      }
      for (const project of this.data.projects) {
        const option = this.el("option", "", project.name);
        option.value = project.id;
        projectSelect.append(option);
      }
      projectSelect.value = this.projectId;
      this.q("#user-name").textContent = isGuest ? "Ospite (Cluster)" : this.data.user.name;
      this.q("#user-role").textContent = isGuest ? `Sola lettura \xB7 v${this.data.version}` : `${roleLabels[this.data.user.role]} \xB7 v${this.data.version}`;
      this.q("#user-avatar").textContent = isGuest ? "\u26A1" : initials(this.data.user.name);
      this.q("#user-action").setAttribute("aria-label", isGuest ? "Accedi" : "Esci");
      this.q("#user-action").title = isGuest ? "Accedi alla control room" : "Esci";
      this.q("#breadcrumb").textContent = `yed1z / ${this.project?.name ?? (isGuest ? "infrastruttura cluster" : "il tuo workspace")}`;
      this.q("#quick-connect").disabled = !isGuest && !this.canWrite;
      this.q("#new-project").disabled = !this.canWrite;
      this.q("#project-settings").disabled = !this.project || !this.canWrite || this.project.ownerId !== this.data.user.id && this.data.user.role !== "admin";
      this.q("#new-conversation").disabled = !this.project || !this.canWrite;
      for (const view of ["knowledge", "releases"]) {
        const nav = this.q(`[data-view="${view}"]`);
        nav.querySelector(".dot-badge")?.remove();
        const count = view === "knowledge" ? this.data.memories.filter((item) => item.projectId === this.projectId && item.status === "candidate").length : this.data.runs.filter((item) => item.projectId === this.projectId && item.status === "awaiting_release").length;
        if (count) {
          const badge = this.el("span", "dot-badge", String(count));
          badge.setAttribute("aria-label", `${count} elementi in attesa`);
          nav.append(badge);
        }
      }
      this.renderConnection();
      this.renderFleet();
      this.renderHistory();
      this.renderMessages();
      this.renderTeam();
      this.renderActivity();
      this.updateComposer();
      this.renderAttachments();
      this.syncView();
      this.renderPage();
      this.modelPickerRender?.();
    }
    renderConnection() {
      const target = this.q("#connection-state");
      target.replaceChildren();
      const dot = this.el("i", `status-dot ${this.connected ? "good" : ""}`);
      target.append(dot, this.document.createTextNode(this.data?.demo ? "DEMO" : this.connected ? "LIVE" : "RICONNESSIONE"));
    }
    renderFleet() {
      const ribbon = this.q("#fleet-ribbon");
      ribbon.replaceChildren();
      for (const node of this.data?.nodes ?? []) {
        const telemetry = this.data?.telemetry.find((item) => item.nodeId === node.id);
        if (telemetry?.quality === "measured" && telemetry.observedAt && typeof telemetry.gpuPercent === "number" && Number.isFinite(telemetry.gpuPercent)) {
          const history = this.telemetryHistory.get(node.id) ?? [];
          if (!history.length || new Date(history.at(-1).observedAt).getTime() < new Date(telemetry.observedAt).getTime()) history.push({ observedAt: telemetry.observedAt, gpuPercent: telemetry.gpuPercent });
          if (history.length > 60) history.splice(0, history.length - 60);
          this.telemetryHistory.set(node.id, history);
        }
        const cell2 = this.el("button", "fleet-mini");
        cell2.type = "button";
        cell2.title = `Apri infrastruttura: ${node.label}`;
        const symbol = this.el("span", "fleet-mini-icon");
        symbol.append(this.icon(node.kind === "cloud" ? "cloud" : node.kind === "server" ? "server" : "chip"));
        const copy2 = this.el("div");
        const title = this.el("strong");
        title.append(this.el("i", `status-dot ${statusTone(telemetry?.status ?? "unknown")}`), this.document.createTextNode(node.label));
        const metrics = this.el("p", "", `${value(telemetry?.gpuPercent, "%")} GPU \xB7 ${value(telemetry?.gpuTempC, "\xB0C")} \xB7 ${value(telemetry?.gpuPowerW, " W")}`);
        if (!telemetry || telemetry.status !== "online") metrics.textContent = `${labels[telemetry?.status ?? "unknown"]} \xB7 ultimo dato ${relativeTime(telemetry?.observedAt)}`;
        copy2.append(title, metrics);
        cell2.append(symbol, copy2);
        cell2.addEventListener("click", () => this.setView("infrastructure"));
        ribbon.append(cell2);
      }
      const active = this.data?.runs.filter((item) => activeRunStatuses.has(item.status)).length ?? 0;
      const cell = this.el("button", "fleet-mini badged");
      cell.type = "button";
      const copy = this.el("div");
      copy.append(this.el("strong", "", `${active} ${active === 1 ? "missione attiva" : "missioni attive"}`), this.el("p", "", `${this.data?.models.filter((item) => item.enabled).length ?? 0} modelli \xB7 ${this.data?.approvals.filter((item) => item.status === "pending").length ?? 0} approvazioni`));
      cell.append(copy);
      cell.addEventListener("click", () => this.runsDialog());
      ribbon.append(cell);
    }
    renderHistory() {
      const history = this.q("#history");
      const query = this.q("#history-search").value.toLocaleLowerCase();
      history.replaceChildren();
      const conversations = this.data?.conversations.filter((item) => item.projectId === this.projectId && item.title.toLocaleLowerCase().includes(query)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) ?? [];
      for (const conversation of conversations) {
        const button = this.el("button", `history-item ${conversation.id === this.conversationId ? "active" : ""}`);
        button.type = "button";
        button.dataset.conversationId = conversation.id;
        const title = this.el("strong", "truncate", conversation.title);
        button.append(title, this.el("small", "", `${relativeTime(conversation.updatedAt)} \xB7 ${conversation.messages.length} messaggi`));
        if (conversation.id === this.conversationId) button.setAttribute("aria-current", "true");
        button.addEventListener("click", () => {
          this.saveDraft();
          this.conversationId = conversation.id;
          this.runId = "";
          this.taskId = "";
          this.restoreDraft();
          this.setView("control");
          this.render();
        });
        history.append(button);
      }
      if (!conversations.length) history.append(this.el("p", "empty", query ? "Nessuna conversazione trovata." : "Le conversazioni di questo progetto compariranno qui."));
    }
    renderMessages() {
      const messages = this.q("#messages");
      const scrollAtBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 100;
      messages.replaceChildren();
      const conversation = this.conversation;
      this.q("#conversation-subtitle").textContent = conversation?.title ?? "Un obiettivo. Una squadra. Tutto sotto controllo.";
      if (!conversation?.messages.length) {
        const welcome = this.el("div", "welcome");
        welcome.append(this.el("div", "welcome-eyebrow", "DAL TUO OBIETTIVO ALLA CONSEGNA"));
        const heading = this.el("h2", "", "Guida il lavoro.");
        heading.append(this.el("br"), this.el("span", "", "La squadra \xE8 qui per te."));
        welcome.append(heading, this.el("p", "", this.project ? `Descrivi ci\xF2 che vuoi realizzare in ${this.project.name}. L\u2019orchestratore organizza il lavoro, coordina modelli e agenti e rende visibili risultati, verifiche e decisioni.` : "Crea un progetto per riunire conversazioni, contesto, documenti e agenti. La tua infrastruttura resta sempre visibile."));
        const starters = this.el("div", "welcome-grid");
        for (const entry of [{ title: "Costruiamo una funzionalit\xE0", text: "Definisci il risultato e i criteri di verifica.", icon: "code", prompt: "Voglio realizzare una nuova funzionalit\xE0 in questo progetto. Aiutami a definire il risultato, poi organizza sviluppo e verifica." }, { title: "Analizziamo il progetto", text: "Comprendi il codice, trova ci\xF2 che manca.", icon: "layers", prompt: "Analizza questo progetto: individua architettura, problemi e interventi prioritari. Presentami un piano verificabile." }, { title: "Risolviamo un problema", text: "Diagnosi, correzione e test di regressione.", icon: "activity", prompt: "Aiutami a diagnosticare e risolvere questo problema. Prima cerca la causa, poi prepara una correzione con una verifica riproducibile." }, { title: "Prepariamo una consegna", text: "Revisione, evidenze e rilascio controllato.", icon: "rocket", prompt: "Controlla cosa manca per consegnare questo progetto. Verifica il lavoro ed evidenzia ci\xF2 che blocca il rilascio." }]) {
          const button = this.el("button", "starter");
          button.type = "button";
          const copy = this.el("span");
          copy.append(this.el("strong", "", entry.title), this.el("small", "", entry.text));
          button.append(this.icon(entry.icon), copy);
          button.addEventListener("click", () => {
            this.q("#message-input").value = entry.prompt;
            this.q("#message-input").focus();
            this.updateComposer();
          });
          starters.append(button);
        }
        welcome.append(starters);
        if (!this.project) welcome.append(this.button("Crea il primo progetto", () => this.projectDialog(), { className: "button primary", icon: "plus", disabled: !this.canWrite }));
        messages.append(welcome);
      } else {
        if (conversation.messages.length > this.messageLimit) messages.append(this.button(`Mostra ${Math.min(80, conversation.messages.length - this.messageLimit)} messaggi precedenti`, () => {
          this.messageLimit += 80;
          this.renderMessages();
        }, { className: "history-more" }));
        for (const message2 of conversation.messages.slice(-this.messageLimit)) messages.append(this.messageElement(message2));
      }
      if (scrollAtBottom) messages.scrollTop = messages.scrollHeight;
    }
    messageElement(message2) {
      const article = this.el("article", `message ${message2.role} ${message2.status === "streaming" ? "pending" : ""}`);
      article.dataset.messageId = message2.id;
      const meta = this.el("div", "message-meta");
      meta.append(this.el("span", "message-avatar", message2.role === "user" ? initials(this.data.user.name) : "y"), this.el("strong", "", message2.role === "user" ? this.data.user.name : message2.role === "system" ? "Progetto" : message2.source === "service" ? "Servizio yed1z" : "Orchestratore"));
      if (message2.source === "service") meta.append(this.el("span", "service-label", "Nessuna inferenza"));
      if (message2.routeId) meta.append(this.el("span", "message-model truncate", this.route(message2.routeId)?.label ?? "Modello precedente"));
      meta.append(this.el("time", "timestamp", time(message2.createdAt)));
      article.append(meta);
      const body = this.el("div", "message-body");
      body.append(renderMarkdown(this.document, message2.text || (message2.status === "streaming" ? "Preparazione della risposta\u2026" : "")));
      article.append(body);
      if (message2.attachmentIds?.length) {
        const files = this.el("div", "response-metrics");
        for (const id of message2.attachmentIds) {
          const artifact = this.data?.artifacts.find((item) => item.id === id);
          files.append(this.button(artifact?.name ?? "Allegato", () => this.openArtifact(id), { className: "context-chip", icon: "file" }));
        }
        article.append(files);
      }
      if (message2.metrics) article.append(this.metricsElement(message2.metrics));
      if (message2.runId) {
        const run = this.data?.runs.find((item) => item.id === message2.runId);
        if (run) {
          const row = this.el("div", "response-metrics");
          row.append(this.button(`${run.mode === "mission" ? "Squadra" : "Attivit\xE0"} \xB7 ${labels[run.status]}`, () => {
            this.runId = run.id;
            this.taskId = "";
            this.renderTeam();
            this.q("#shell").classList.add("team-open");
          }, { className: "context-chip", icon: "people" }));
          article.append(row);
        }
      }
      if (message2.status === "error" || message2.status === "cancelled") {
        const row = this.el("div", "response-metrics");
        row.append(this.pill(message2.status, message2.status === "error" ? "Risposta incompleta" : "Risposta interrotta"));
        article.append(row);
      }
      return article;
    }
    metricsElement(metrics) {
      const row = this.el("div", "response-metrics");
      if (!metrics) return row;
      const values = [["in", metrics.inputTokens, " token"], ["out", metrics.outputTokens, " token"], ["cache", metrics.cachedInputTokens, " token"], ["velocit\xE0", metrics.decodeTokensPerSecond, " tok/s"], ["TTFT", metrics.ttftMs === void 0 ? void 0 : metrics.ttftMs / 1e3, " s"], ["prefill", metrics.prefillMs === void 0 ? void 0 : metrics.prefillMs / 1e3, " s"]];
      for (const [label, amount, suffix] of values) {
        const text = this.el("span", "", `${label} `);
        text.append(this.el("b", "", value(amount, suffix)));
        row.append(text);
      }
      if (metrics.contextWindow !== void 0) row.append(this.el("span", "", `contesto ${value(metrics.contextUsed)} / ${formatNumber(metrics.contextWindow)}${metrics.contextSource === "estimated" ? " \xB7 stimato" : ""}`));
      row.title = `Fonte: ${metrics.source}. TTFT osservato dal gateway comprende attesa e rete. Le misure assenti non sono stimate.`;
      return row;
    }
    updateComposer() {
      const input = this.q("#message-input");
      const mode = this.q("#mode-select");
      const mission = mode.querySelector('[value="mission"]');
      mission.disabled = !this.operator;
      mission.textContent = this.operator ? "Squadra" : "Squadra \xB7 solo operatori";
      if (!this.operator) mode.value = "chat";
      const intent = classifyRequest(input.value, { mode: mode.value, attachmentCount: this.selectedAttachments.length });
      const service = intent.kind === "service";
      const active = !!this.currentRun && !closedRunStatuses.has(this.currentRun.status);
      const guide = active && !service;
      const route = this.route(this.routeId), account = this.account(route?.accountId), availability = this.availability(this.routeId);
      input.maxLength = guide ? 12e3 : 1e5;
      this.q("#mission-settings").disabled = !this.operator;
      mode.title = "Auto distingue domande e lavoro operativo. Chat risponde direttamente; Squadra pianifica ed esegue.";
      this.q("#model-label").textContent = route ? `${route.label} \xB7 ${account?.label ?? "account"}` : "Collega un modello";
      this.q("#routing-policy").textContent = this.routing.strategy === "pinned" ? "Fisso" : this.routing.fallbackRouteIds.length ? `Auto \xB7 ${this.routing.fallbackRouteIds.length} alternative` : "Auto";
      this.q("#send").hidden = false;
      this.q("#stop").hidden = !active;
      this.q("#send").setAttribute("aria-label", guide ? "Invia una nuova istruzione alla squadra" : service ? "Invia al servizio yed1z" : "Invia all\u2019orchestratore");
      this.q("#send").disabled = this.sending || !this.canWrite || !this.project || !service && (!route || !this.usableRoute(route)) || !input.value.trim();
      this.q("#stop").disabled = this.sending;
      this.q("#attach-file").disabled = !this.project || !this.canWrite;
      this.q("#composer-status").textContent = this.sending ? "Richiesta ricevuta, avvio\u2026" : !this.project ? "Crea un progetto per iniziare." : service ? "Risposta immediata del servizio \xB7 nessuna inferenza." : guide ? `${labels[this.currentRun.status]} \xB7 questo messaggio guider\xE0 la squadra.` : !route ? "Collega un modello. Saluti, aiuto e stato sono gi\xE0 disponibili." : availability?.status === "busy" ? `${availability.reason}${this.routing.strategy === "auto" && this.routing.fallbackRouteIds.length ? " \xB7 alternative autorizzate attive" : " \xB7 attesa limitata, annullabile"}` : account?.status === "cooldown" ? "Quota in attesa. Scegli un altro account o autorizza un\u2019alternativa." : intent.mode === "mission" ? "Squadra \xB7 piano, esecuzione e verifiche." : "Chat diretta \xB7 una risposta, senza avviare una missione.";
    }
    renderTeam() {
      const body = this.q("#team-body");
      body.replaceChildren();
      const run = this.currentRun;
      const pending = this.data?.approvals.filter((item) => item.status === "pending" && item.projectId === this.projectId && (!run || item.runId === run.id)) ?? [];
      for (const approval of pending) body.append(this.approvalElement(approval));
      if (!run) {
        const empty = this.el("div", "team-empty");
        empty.append(this.icon("people"), this.el("strong", "", "Dai una direzione alla squadra."), this.el("p", "", "Quando avvii una missione, qui vedi chi lavora, con quale modello, da cosa dipende ogni attivit\xE0 e cosa ha prodotto."));
        body.append(empty);
        this.q("#task-detail").hidden = true;
        this.q("#team-footer-left").textContent = "Nessuna attivit\xE0 in corso";
        this.q("#team-footer-right").textContent = "";
        return;
      }
      const card = this.el("div", "run-card");
      const header = this.el("div", "row spread");
      header.append(this.el("span", "eyebrow", run.mode === "mission" ? "MISSIONE" : "CONVERSAZIONE"), this.pill(run.status));
      card.append(header, this.el("h3", "", run.goal));
      const complete = run.tasks.filter((item) => item.status === "succeeded").length;
      if (run.tasks.length) {
        const meter = this.progress(complete / run.tasks.length * 100);
        meter.classList.add("progress-line");
        const copy = this.el("div", "progress-copy");
        copy.append(this.el("span", "", `${complete}/${run.tasks.length} attivit\xE0`), this.el("span", "", `Iterazione ${run.iteration}/${run.maxIterations}`));
        card.append(meter, copy);
      }
      const controls = this.el("div", "run-controls");
      if (activeRunStatuses.has(run.status)) controls.append(this.button("Pausa", () => this.runAction(run, "pause"), { className: "button small subtle", icon: "pause", disabled: !this.canWrite }), this.button("Guida", () => this.steerDialog(run), { className: "button small subtle", icon: "edit", disabled: !this.canWrite }), this.button("Stop", () => this.runAction(run, "cancel"), { className: "button small danger", icon: "stop", disabled: !this.canWrite }));
      else if (["paused", "interrupted"].includes(run.status)) controls.append(this.button("Riprendi", () => this.runAction(run, "resume"), { className: "button small primary", icon: "play", disabled: !this.canWrite }), this.button("Annulla", () => this.runAction(run, "cancel"), { className: "button small danger", disabled: !this.canWrite }));
      else if (run.status === "awaiting_release") controls.append(this.button("Esamina la consegna", () => this.setView("releases"), { className: "button small primary", icon: "rocket" }), this.button("Annulla", () => this.runAction(run, "cancel"), { className: "button small subtle", disabled: !this.canWrite }));
      else if (!closedRunStatuses.has(run.status)) controls.append(this.button("Metti in pausa", () => this.runAction(run, "pause"), { className: "button small", icon: "pause", disabled: !this.canWrite }), this.button("Annulla", () => this.runAction(run, "cancel"), { className: "button small danger", disabled: !this.canWrite }));
      if (run.phase && run.phase !== run.status) card.append(this.el("p", "run-phase", run.phase));
      if (run.error) card.append(this.el("p", "fine-print", run.error));
      if (controls.childElementCount) card.append(controls);
      body.append(card);
      const heading = this.el("div", "section-heading");
      heading.append(this.el("span", "eyebrow", "AGENTI E DIPENDENZE"), this.el("span", "fine-print", `max ${run.maxParallel} in parallelo`));
      body.append(heading);
      if (run.tasks.length > 1) body.append(this.taskGraph(run));
      const list = this.el("div", "task-list");
      for (const [index, task] of run.tasks.entries()) {
        const visibleStatus = taskPaused(task) ? "paused" : task.status;
        const button = this.el("button", `task-card ${visibleStatus} ${task.id === this.taskId ? "selected" : ""}`);
        button.type = "button";
        button.dataset.taskId = task.id;
        const role = this.el("div", "task-role");
        role.append(this.el("i", `status-dot ${statusTone(visibleStatus)}`), this.document.createTextNode(roleLabels[task.role] ?? task.role), this.el("span", "task-number", String(index + 1).padStart(2, "0")));
        const footer = this.el("div", "task-footer");
        footer.append(this.el("span", "task-model", task.role === "tester" ? "Verifiche eseguibili" : task.role === "release" ? "Ricetta di rilascio" : this.route(task.routeId)?.label ?? task.routeId), this.el("span", "", labels[visibleStatus] ?? visibleStatus));
        button.append(role, this.el("p", "task-title", task.label), footer);
        if (task.dependencies.length) button.append(this.el("p", "task-deps", `Dopo: ${task.dependencies.map((id) => run.tasks.find((item) => item.id === id)?.label ?? id).join(" \xB7 ")}`));
        button.addEventListener("click", () => {
          this.taskId = task.id;
          this.renderTeam();
        });
        list.append(button);
      }
      if (!run.tasks.length) list.append(this.el("p", "empty", run.mode === "chat" ? closedRunStatuses.has(run.status) ? "Risposta diretta. Nessuna squadra avviata." : "Risposta diretta, senza pianificazione della squadra." : "L\u2019orchestratore sta preparando il piano di lavoro."));
      body.append(list);
      this.q("#team-footer-left").textContent = `${run.budget.callsUsed}/${run.budget.maxModelCalls} chiamate`;
      this.q("#team-footer-right").textContent = `${formatNumber(run.budget.outputTokensUsed)} token output`;
      this.renderTaskDetail();
    }
    renderTaskDetail() {
      const target = this.q("#task-detail");
      const task = this.currentRun?.tasks.find((item) => item.id === this.taskId);
      target.replaceChildren();
      target.hidden = !task;
      if (!task) return;
      const heading = this.el("div", "row spread");
      heading.append(this.el("h3", "", task.label), this.button("", () => {
        this.taskId = "";
        this.renderTeam();
      }, { className: "icon-button", icon: "close", title: "Chiudi dettaglio agente" }));
      target.append(heading);
      const route = this.route(task.routeId);
      const account = this.account(route?.accountId);
      const meta = this.el("dl", "detail-meta");
      const deterministic = ["tester", "release"].includes(task.role);
      const targetConfig = this.data?.targets.find((item) => item.id === this.project?.targetId);
      for (const [label, text] of [["Agente", roleLabels[task.role] ?? task.role], [deterministic ? "Motore" : "Modello", deterministic ? task.role === "tester" ? "Verifica eseguibile" : "Controller di rilascio" : route?.label ?? task.routeId], ["Account", deterministic ? "\u2014" : account?.label ?? "\u2014"], ["Nodi", deterministic ? this.data?.nodes.find((item) => item.id === targetConfig?.nodeId)?.label ?? targetConfig?.nodeId ?? "\u2014" : route?.nodeIds.map((id) => this.data?.nodes.find((item) => item.id === id)?.label ?? id).join(", ") || "Provider remoto"], ["Stato", taskPaused(task) ? "In pausa" : labels[task.status] ?? task.status]]) meta.append(this.el("dt", "", label), this.el("dd", "", text));
      target.append(meta);
      if (task.routing) target.append(this.el("p", "routing-decision", `${task.routing.switched ? "Alternativa selezionata" : "Modello selezionato"} \xB7 ${task.routing.reason} \xB7 attesa osservata ${value(task.routing.waitMs / 1e3, " s")}`));
      if (!deterministic && (task.status === "queued" || taskPaused(task))) target.append(this.button("Cambia modello / account", () => this.modelDialog(task), { className: "text-button", disabled: !this.operator }));
      const individualControl = this.operator && ["researcher", "coder"].includes(task.role) && this.currentRun?.mode === "mission" && activeRunStatuses.has(this.currentRun.status) && (taskPaused(task) || ["queued", "running"].includes(task.status));
      if (individualControl) {
        const controls = this.el("div", "run-controls agent-controls");
        controls.append(this.button(taskPaused(task) ? "Riprendi agente" : "Pausa agente", () => this.taskAction(task, taskPaused(task) ? "resume" : "pause"), { className: `button small ${taskPaused(task) ? "primary" : "subtle"}`, icon: taskPaused(task) ? "play" : "pause" }), this.button("Istruzione", () => this.taskSteerDialog(task), { className: "button small subtle", icon: "edit" }), this.button("Annulla", () => this.taskAction(task, "cancel"), { className: "button small danger", icon: "stop", title: "Annulla questa attivit\xE0 e ferma le attivit\xE0 dipendenti" }));
        target.append(controls);
      }
      const tabs = this.el("div", "detail-tabs");
      for (const [id, title] of [["output", "Risultato"], ["events", "Attivit\xE0"], ["context", "Contesto"]]) tabs.append(this.button(title, () => {
        this.taskTab = id;
        this.renderTaskDetail();
      }, { className: this.taskTab === id ? "active" : "" }));
      target.append(tabs);
      if (this.taskTab === "output") {
        const progress = this.taskProgress.get(task.id);
        const content = this.el("div", "message-body");
        content.style.paddingLeft = "0";
        content.append(renderMarkdown(this.document, task.output ?? task.error ?? progress?.text ?? "Il risultato sar\xE0 disponibile al termine dell\u2019attivit\xE0."));
        target.append(content);
        if (!task.output && progress?.incomplete) target.append(this.el("p", "fine-print", "Flusso ripreso dopo una disconnessione. Il risultato completo sar\xE0 disponibile al termine."));
      } else if (this.taskTab === "events") {
        const events = this.events.filter((item) => item.taskId === task.id).slice(-40);
        for (const event of events) {
          const row = this.el("div", "event-line");
          row.append(this.el("time", "", time(event.createdAt)), this.el("strong", "", event.text ?? event.type));
          target.append(row);
        }
        if (!events.length) target.append(this.el("p", "fine-print", "Nessun evento ricevuto per questo agente. Il flusso conserva solo gli eventi autorizzati."));
      } else if (task.context) target.append(this.contextElement(task.context));
      else target.append(this.el("p", "fine-print", "Il contesto viene compilato quando l\u2019agente parte."));
      const evidence = this.data?.evidence.filter((item) => task.evidenceIds.includes(item.id)) ?? [];
      if (evidence.length) {
        target.append(this.el("div", "eyebrow", "EVIDENZE"));
        for (const item of evidence) target.append(this.button(`${item.ok ? "\u2713" : "!"} ${item.title}`, () => this.textDialog(item.title, item.output), { className: "text-button" }));
      }
    }
    approvalElement(approval) {
      const card = this.el("div", "approval-card");
      card.dataset.approvalId = approval.id;
      card.append(this.el("h3", "", approval.title), this.el("p", "", `${approval.kind === "release" ? "Rilascio" : "Azione"} in attesa \xB7 scade ${relativeTime(approval.expiresAt)}`), this.el("pre", "tool-code", approval.detail));
      const buttons = this.el("div", "row");
      for (const approved of [false, true]) buttons.append(this.button(approved ? "Approva" : "Nega", async () => {
        await this.api.request("POST", `/api/approvals/${encodeURIComponent(approval.id)}`, { approved });
        await this.refresh();
      }, { className: `button small ${approved ? "primary" : "subtle"}`, disabled: !this.canWrite || approval.kind === "release" && !this.operator }));
      card.append(buttons);
      return card;
    }
    taskGraph(run) {
      const wrapper = this.el("div", "task-graph");
      const ns = "http://www.w3.org/2000/svg";
      const svg = this.document.createElementNS(ns, "svg");
      svg.setAttribute("role", "group");
      svg.setAttribute("aria-label", "Mappa delle dipendenze della squadra");
      const markerId = `task-arrow-${run.id.replace(/[^a-z0-9_-]/gi, "")}`;
      const defs = this.document.createElementNS(ns, "defs");
      const marker = this.document.createElementNS(ns, "marker");
      marker.setAttribute("id", markerId);
      marker.setAttribute("viewBox", "0 0 8 8");
      marker.setAttribute("refX", "7");
      marker.setAttribute("refY", "4");
      marker.setAttribute("markerWidth", "5");
      marker.setAttribute("markerHeight", "5");
      marker.setAttribute("orient", "auto");
      const arrow = this.document.createElementNS(ns, "path");
      arrow.setAttribute("d", "M0 0L8 4L0 8z");
      arrow.setAttribute("fill", "#3d5c67");
      marker.append(arrow);
      defs.append(marker);
      svg.append(defs);
      const depths = /* @__PURE__ */ new Map();
      const visiting = /* @__PURE__ */ new Set();
      const depth = (task) => {
        if (depths.has(task.id)) return depths.get(task.id);
        if (visiting.has(task.id)) return 0;
        visiting.add(task.id);
        const parents = task.dependencies.map((id) => run.tasks.find((item) => item.id === id)).filter((item) => !!item);
        const level = parents.length ? Math.max(...parents.map((item) => depth(item))) + 1 : 0;
        visiting.delete(task.id);
        depths.set(task.id, level);
        return level;
      };
      for (const task of run.tasks) depth(task);
      const levels = Array.from(new Set(depths.values())).sort((a, b) => a - b);
      const positions = /* @__PURE__ */ new Map();
      let y = 8;
      for (const level of levels) {
        const items = run.tasks.filter((task) => depths.get(task.id) === level);
        for (let index = 0; index < items.length; index++) {
          const row = Math.floor(index / 3);
          const rowCount = Math.min(3, items.length - row * 3);
          const x = (280 - rowCount * 84 - (rowCount - 1) * 8) / 2 + index % 3 * 92;
          positions.set(items[index].id, { x, y: y + row * 47 });
        }
        y += Math.ceil(items.length / 3) * 47 + 9;
      }
      svg.setAttribute("viewBox", `0 0 280 ${y}`);
      for (const task of run.tasks) for (const dependency of task.dependencies) {
        const from = positions.get(dependency);
        const to = positions.get(task.id);
        if (!from || !to) continue;
        const line = this.document.createElementNS(ns, "path");
        line.setAttribute("d", `M${from.x + 42},${from.y + 30} C${from.x + 42},${from.y + 42} ${to.x + 42},${to.y - 12} ${to.x + 42},${to.y}`);
        line.setAttribute("class", "graph-edge");
        line.setAttribute("marker-end", `url(#${markerId})`);
        svg.append(line);
      }
      for (const [index, task] of run.tasks.entries()) {
        const visibleStatus = taskPaused(task) ? "paused" : task.status;
        const position = positions.get(task.id);
        const group = this.document.createElementNS(ns, "g");
        group.setAttribute("class", `graph-task ${statusTone(visibleStatus)} ${task.id === this.taskId ? "selected" : ""}`);
        group.setAttribute("transform", `translate(${position.x},${position.y})`);
        group.setAttribute("role", "button");
        group.setAttribute("tabindex", "0");
        group.setAttribute("aria-label", `${roleLabels[task.role]}: ${task.label}. ${labels[visibleStatus]}`);
        const title = this.document.createElementNS(ns, "title");
        title.textContent = `${task.label} \xB7 ${labels[visibleStatus]}`;
        const rect = this.document.createElementNS(ns, "rect");
        rect.setAttribute("width", "84");
        rect.setAttribute("height", "30");
        rect.setAttribute("rx", "5");
        const text = this.document.createElementNS(ns, "text");
        text.setAttribute("x", "42");
        text.setAttribute("y", "13");
        text.textContent = `${String(index + 1).padStart(2, "0")} ${roleLabels[task.role] ?? task.role}`;
        const status = this.document.createElementNS(ns, "text");
        status.setAttribute("x", "42");
        status.setAttribute("y", "24");
        status.setAttribute("class", "graph-status");
        status.textContent = labels[visibleStatus] ?? visibleStatus;
        group.append(title, rect, text, status);
        const select = () => {
          this.taskId = task.id;
          this.renderTeam();
        };
        group.addEventListener("click", select);
        group.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            select();
          }
        });
        svg.append(group);
      }
      wrapper.append(svg);
      return wrapper;
    }
    progress(percent) {
      const meter = this.el("div", "meter");
      if (percent !== void 0 && Number.isFinite(percent)) {
        const fill = this.el("div", `meter-fill ${percent >= 90 ? "hot" : ""}`);
        fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
        meter.append(fill);
      }
      return meter;
    }
    setView(view) {
      this.view = view;
      this.q("#shell").classList.remove("sidebar-open");
      this.syncNavigation();
      this.syncView();
      this.renderPage();
    }
    syncView() {
      const titles = { control: "Chat e squadra", infrastructure: "Dashboard cluster", knowledge: "Conoscenza del progetto", connections: "Modelli e account", releases: "Consegne e rilasci" };
      this.q("#page-title").textContent = titles[this.view];
      for (const item of this.root.querySelectorAll("[data-view]")) {
        const selected = item.dataset.view === this.view;
        item.classList.toggle("active", selected);
        if (selected) item.setAttribute("aria-current", "page");
        else item.removeAttribute("aria-current");
      }
      this.q("#control-view").hidden = this.view !== "control";
      this.q("#page-view").hidden = this.view === "control";
    }
    renderPage() {
      const page = this.q("#page-view");
      if (this.view === "control" || !this.data) return;
      const active = this.document.activeElement;
      const activeId = active && page.contains(active) ? active.id : "";
      const selection = activeId && active?.tagName === "INPUT" ? [active.selectionStart, active.selectionEnd] : void 0;
      page.replaceChildren();
      if (this.view === "infrastructure") this.renderInfrastructure(page);
      else if (this.view === "knowledge") this.renderKnowledge(page);
      else if (this.view === "connections") this.renderConnections(page);
      else this.renderReleases(page);
      if (activeId) {
        const replacement = page.querySelector(`#${activeId}`);
        if (replacement) {
          replacement.focus();
          if (selection && replacement.type === "search") replacement.setSelectionRange(selection[0] ?? 0, selection[1] ?? 0);
        }
      }
    }
    pageIntro(title, subtitle, eyebrow, action) {
      const intro = this.el("header", "page-intro");
      const copy = this.el("div");
      copy.append(this.el("div", "eyebrow", eyebrow), this.el("h2", "", title), this.el("p", "", subtitle));
      intro.append(copy);
      if (action) intro.append(action);
      return intro;
    }
    renderInfrastructure(page) {
      page.append(this.pageIntro("Cluster / sistema distribuito", "Nodi fisici, motori distribuiti e provider restano distinti. Vedi dove gira ogni modello e quali risorse condivide.", "INFRASTRUTTURA DISTRIBUITA", this.button("Aggiorna telemetria", async () => {
        await this.api.request("POST", "/api/telemetry/refresh", {});
        await this.refresh();
      }, { icon: "refresh" })));
      page.append(this.createActivity(true));
      const grid = this.el("div", "cards-grid");
      for (const node of this.data.nodes) {
        const telemetry = this.data.telemetry.find((item) => item.nodeId === node.id);
        const card = this.el("article", "card node-card");
        card.dataset.nodeId = node.id;
        const head = this.el("div", "row spread");
        const copy = this.el("div");
        const title = this.el("h3", "node-title");
        title.append(this.icon(node.kind === "cloud" ? "cloud" : "chip"), this.document.createTextNode(node.label));
        copy.append(title, this.el("p", "node-subtitle mono", node.host ?? "Indirizzo gestito dal server"));
        head.append(copy, this.pill(telemetry?.status ?? "unknown"));
        card.append(head);
        card.append(this.el("p", "node-hardware", node.kind === "strix" ? "AMD Strix Halo \xB7 inferenza distribuita" : node.kind === "cuda" ? "NVIDIA CUDA \xB7 nodo di accelerazione" : node.kind === "cloud" ? "Provider esterno \xB7 metriche fornite dal servizio" : "Nodo di coordinamento / esecuzione"));
        const metrics = this.el("div", "metrics-grid");
        for (const [name, amount, suffix] of [["Utilizzo GPU", telemetry?.gpuPercent, "%"], ["Temperatura GPU", telemetry?.gpuTempC, "\xB0C"], ["Potenza GPU", telemetry?.gpuPowerW, "W"], ["Utilizzo CPU", telemetry?.cpuPercent, "%"]]) {
          const item = this.el("div");
          const number = this.el("div", "metric-value", value(amount));
          if (amount !== void 0) number.append(this.el("small", "", suffix));
          item.append(number, this.el("div", "metric-label", name));
          metrics.append(item);
        }
        card.append(metrics);
        const history = this.telemetryHistory.get(node.id) ?? [];
        const chart = this.el("div", "telemetry-history");
        if (history.length >= 2) {
          const svg = this.document.createElementNS("http://www.w3.org/2000/svg", "svg");
          svg.setAttribute("viewBox", "0 0 250 45");
          svg.setAttribute("role", "img");
          svg.setAttribute("aria-label", `Utilizzo GPU: ultime ${history.length} misure della sessione`);
          const start = new Date(history[0].observedAt).getTime();
          const end = new Date(history.at(-1).observedAt).getTime();
          const line = this.document.createElementNS("http://www.w3.org/2000/svg", "polyline");
          line.setAttribute("points", history.map((point) => `${2 + (new Date(point.observedAt).getTime() - start) / Math.max(1, end - start) * 246},${42 - Math.max(0, Math.min(100, point.gpuPercent)) * 0.39}`).join(" "));
          line.setAttribute("fill", "none");
          line.setAttribute("stroke", "currentColor");
          line.setAttribute("stroke-width", "1.5");
          svg.append(line);
          chart.append(svg, this.el("p", "fine-print", `GPU \xB7 ${history.length} misure di questa sessione \xB7 scala 0\u2013100%`));
        } else chart.append(this.el("p", "fine-print", "Il grafico GPU compare dopo due misure reali."));
        card.append(chart);
        for (const [name, used, total] of [["RAM", telemetry?.ramUsedBytes, telemetry?.ramTotalBytes], ["Memoria GPU", telemetry?.gpuMemoryUsedBytes, telemetry?.gpuMemoryTotalBytes]]) {
          const row = this.el("div", "quota-meter");
          const label = this.el("div", "meter-label");
          label.append(this.el("span", "", name), this.el("span", "mono", `${bytes(used)} / ${bytes(total)}`));
          row.append(label, this.progress(used === void 0 || !total ? void 0 : used / total * 100));
          card.append(row);
        }
        const detail = this.el("div", "node-detail");
        detail.append(this.el("div", "", node.capabilities.length ? node.capabilities.join(" \xB7 ") : "Capacit\xE0 non dichiarate"));
        if (telemetry && telemetry.status !== "online") detail.append(this.el("p", "fine-print", "Sono mostrate le ultime misure disponibili, non uno stato live."));
        if (telemetry?.quality === "legacy-unverified") detail.append(this.el("p", "fine-print", "Fonte legacy: alcune misure non sono verificate."));
        if (telemetry?.error) detail.append(this.el("p", "fine-print", telemetry.error));
        card.append(detail, this.el("p", "node-time", `Osservato: ${telemetry?.observedAt ? new Date(telemetry.observedAt).toLocaleString("it-IT") : "mai"} \xB7 ${telemetry?.quality === "measured" ? "misurato" : "non verificato"}`));
        grid.append(card);
        const interfaces = telemetry?.details?.network;
        const network = this.el("details", "advanced network-details");
        network.append(this.el("summary", "", "Interfacce e traffico di rete"));
        if (Array.isArray(interfaces) && interfaces.length) {
          const rows = interfaces.filter((item) => item && typeof item === "object").map((item) => {
            const n = item;
            return [typeof n.name === "string" ? n.name : "\u2014", typeof n.up === "boolean" ? n.up ? "UP" : "DOWN" : "\u2014", Array.isArray(n.addresses) ? n.addresses.filter((value2) => typeof value2 === "string").join(", ") : "\u2014", value(n.speedMbps, " Mbps"), typeof n.rxBytesPerSecond === "number" ? `${bytes(n.rxBytesPerSecond)}/s` : "\u2014", typeof n.txBytesPerSecond === "number" ? `${bytes(n.txBytesPerSecond)}/s` : "\u2014", `${value(n.rxErrors)} / ${value(n.txErrors)}`];
          });
          network.append(this.table(["Interfaccia", "Stato", "Indirizzi", "Link", "RX", "TX", "Errori RX/TX"], rows), this.el("p", "fine-print", "RX/TX derivano da contatori osservati. Il valore Link \xE8 la velocit\xE0 dichiarata dall\u2019interfaccia, non un test di banda."));
        } else network.append(this.el("p", "fine-print", "Nessun campione di rete disponibile per questo nodo."));
        if (typeof telemetry?.details?.probeMs === "number") network.append(this.el("p", "fine-print", `Tempo della richiesta di telemetria: ${value(telemetry.details.probeMs, " ms")}. Include servizio e trasporto.`));
        card.append(network);
      }
      if (!this.data.nodes.length) grid.append(this.el("p", "empty", "Nessun nodo configurato. L\u2019operatore registra i nodi e gli endpoint nel file di configurazione del servizio."));
      page.append(grid);
      const section = this.el("section", "page-section");
      const heading = this.el("div", "section-heading");
      heading.append(this.el("h3", "", "Risorse condivise e parallelismo"), this.el("span", "fine-print", "Un modello distribuito riserva tutti i nodi dichiarati"));
      section.append(heading);
      const pools = this.el("div", "topology");
      for (const group of this.data.resourceGroups) {
        const card = this.el("article", "pool-card");
        card.dataset.resourceGroup = group.id;
        const title = this.el("h3");
        title.append(this.icon("layers"), this.document.createTextNode(group.label));
        const used = this.data.resourceUsage[group.id] ?? 0;
        card.append(title, this.el("p", "pool-usage", `${used}/${group.capacity} slot occupati nel coordinator. Le attivit\xE0 in eccesso attendono la disponibilit\xE0 delle risorse.`));
        const nodes = this.el("div", "pool-nodes");
        for (const nodeId of group.nodeIds) nodes.append(this.pill("unknown", this.data.nodes.find((item) => item.id === nodeId)?.label ?? nodeId));
        card.append(nodes);
        pools.append(card);
      }
      if (!this.data.resourceGroups.length) pools.append(this.el("p", "empty", "Nessun gruppo di risorse configurato."));
      section.append(pools);
      page.append(section);
      if (this.data.links.length) {
        const network = this.el("section", "page-section");
        network.append(this.el("div", "section-heading", "Collegamenti di rete"));
        network.append(this.table(["Da", "A", "Collegamento", "Indirizzo", "Fonte"], this.data.links.map((link) => [this.data.nodes.find((node) => node.id === link.from)?.label ?? link.from, this.data.nodes.find((node) => node.id === link.to)?.label ?? link.to, link.label, link.address ?? "\u2014", link.status === "observed" ? "Osservato" : link.status === "configured" ? "Configurato, da verificare" : "Da verificare"])));
        page.append(network);
      }
      const routes = this.el("section", "page-section");
      routes.append(this.el("div", "section-heading", "Dove vengono eseguiti i modelli"));
      const availability = this.el("section", "page-section");
      availability.id = "route-availability";
      this.renderRouteAvailability(availability);
      page.append(availability);
      routes.append(this.table(["Modello", "Fornitore / account", "Nodi", "Risorse", "Contesto"], this.data.models.map((model) => [model.label, `${this.provider(model.providerId)?.label ?? model.providerId} \xB7 ${this.account(model.accountId)?.label ?? ""}`, model.nodeIds.map((id) => this.data.nodes.find((node) => node.id === id)?.label ?? id).join(" + ") || "Provider remoto", model.resourceGroupIds.map((id) => this.data.resourceGroups.find((group) => group.id === id)?.label ?? id).join(", ") || "Nessuna risorsa locale riservata", model.contextWindow ? formatNumber(model.contextWindow) : "Non dichiarato"])));
      page.append(routes);
      page.append(this.info("Le connessioni di rete mostrate descrivono la topologia configurata. Non vengono dedotte latenza, banda o raggiungibilit\xE0 da un semplice nome host. Una metrica assente resta sconosciuta."));
    }
    renderRouteAvailability(section) {
      section.replaceChildren();
      section.hidden = !this.data?.routeAvailability?.length;
      if (section.hidden) return;
      section.append(this.el("div", "section-heading", "Disponibilit\xE0 di inferenza"), this.table(
        ["Modello / account", "Stato", "Coordinator \xB7 attive / in coda", "Motore \xB7 attive / in coda", "Motivo", "Fonte"],
        this.data.routeAvailability.map((item) => [
          this.route(item.routeId)?.label ?? item.routeId,
          { available: "Slot libero", busy: "Occupato", cooldown: "Quota in attesa", disabled: "Disabilitato", unavailable: "Non disponibile", unknown: "Da verificare" }[item.status],
          `${item.activeCount} / ${item.queueCount}`,
          `${item.externalActiveRequests ?? "\u2014"} / ${item.externalQueuedRequests ?? "\u2014"}`,
          item.reason,
          item.source === "provider" ? "Provider" : item.source === "coordinator" ? "Coordinator" : "Configurazione"
        ])
      ), this.el("p", "fine-print", "Le misure del motore possono includere richieste avviate dal coordinator: i conteggi non si sommano. \u2014 indica un dato non osservato."));
    }
    renderKnowledge(page) {
      page.append(this.pageIntro("Il progetto ricorda come lavori.", "Documenti, decisioni e metodi hanno una fonte e uno stato. Il contesto usa soltanto ci\xF2 che \xE8 autorizzato e pertinente al compito.", "MEMORIA E CONTESTO", this.button("Aggiungi conoscenza", () => this.memoryDialog(), { className: "button primary", icon: "plus", disabled: !this.project || !this.canWrite })));
      const tabs = this.el("div", "knowledge-tabs");
      for (const [id, text] of [["memories", "Metodi e decisioni"], ["files", "Allegati e documenti"], ["search", "Cerca nel contesto"]]) tabs.append(this.button(text, () => {
        this.knowledgeTab = id;
        this.renderPage();
      }, { className: this.knowledgeTab === id ? "active" : "" }));
      page.append(tabs);
      if (!this.project) {
        page.append(this.el("p", "empty", "Scegli o crea un progetto per gestirne la conoscenza."));
        return;
      }
      if (this.knowledgeTab === "memories") {
        const memories = this.data.memories.filter((item) => item.projectId === this.projectId);
        if (!memories.length) page.append(this.info("Aggiungi una procedura, una decisione o il brief del progetto. Le nuove voci vengono proposte come candidate: le rendi disponibili agli agenti quando le approvi."));
        for (const memory of memories.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) page.append(this.memoryCard(memory));
      } else if (this.knowledgeTab === "files") {
        const toolbar = this.el("div", "page-toolbar");
        toolbar.append(this.el("span", "grow fine-print", "Testo e Markdown \xB7 massimo 1 MiB per documento"), this.button("Carica documenti", () => this.q("#file-input").click(), { icon: "upload", disabled: !this.canWrite }));
        page.append(toolbar);
        const artifacts = this.data.artifacts.filter((item) => item.projectId === this.projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        for (const artifact of artifacts) {
          const card = this.el("article", "file-card");
          const info = this.el("div", "grow");
          info.append(this.el("h3", "", artifact.name), this.el("p", "", `${bytes(artifact.bytes)} \xB7 ${relativeTime(artifact.createdAt)} \xB7 ${artifact.kind === "attachment" ? "Documento" : artifact.kind === "evidence" ? "Evidenza" : "Consegna"}`));
          const actions = this.el("div", "file-actions");
          actions.append(this.button("", () => this.openArtifact(artifact.id), { className: "icon-button", icon: "file", title: "Apri documento" }), this.button("", () => this.downloadArtifact(artifact), { className: "icon-button", icon: "download", title: "Scarica documento" }));
          if (artifact.kind === "attachment") actions.append(this.button("", () => this.confirm("Dimentica questo allegato?", `Il file \u201C${artifact.name}\u201D verr\xE0 eliminato con il suo indice. Un utilizzo attivo ne impedisce la rimozione.`, async () => {
            await this.api.request("DELETE", `/api/artifacts/${encodeURIComponent(artifact.id)}`);
            this.selectedAttachments = this.selectedAttachments.filter((item) => item.id !== artifact.id);
            await this.refresh();
          }), { className: "icon-button", icon: "trash", title: "Elimina documento", disabled: !this.canWrite }));
          card.append(this.el("div", "file-icon", artifact.name.split(".").pop()?.slice(0, 4).toUpperCase() ?? "TXT"), info, actions);
          page.append(card);
        }
        if (!artifacts.length) page.append(this.el("p", "empty", "Nessun documento. Carica un Markdown, un brief o un file di testo."));
      } else {
        const form = this.el("form", "page-toolbar");
        const input = this.input("search", this.searchQuery, "Cerca una procedura, una decisione, un metodo\u2026");
        input.id = "memory-search";
        input.setAttribute("aria-label", "Cerca nella memoria del progetto");
        input.addEventListener("input", () => {
          this.searchQuery = input.value;
        });
        const submit = this.el("button", "button primary", "Cerca");
        submit.type = "submit";
        form.append(input, submit);
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          void this.perform(submit, async () => {
            const result = await this.api.request("POST", "/api/memories/search", { projectId: this.projectId, query: input.value });
            this.searchResults = result.results;
            this.searchQuery = input.value;
            this.renderPage();
          });
        });
        page.append(form);
        const embedding = this.route(this.project.routes.embedding);
        page.append(this.info(embedding ? `Ricerca lessicale e vettoriale tramite ${embedding.label}. Gli embedding vengono calcolati dal provider configurato; la selezione rispetta sempre i permessi del progetto.` : "La ricerca lessicale \xE8 attiva. Per aggiungere la ricerca vettoriale, scegli una route di embedding nelle impostazioni del progetto. Non vengono generati vettori artificiali."));
        if (embedding) page.append(this.button("Aggiorna indice vettoriale", async () => {
          const result = await this.api.request("POST", `/api/projects/${encodeURIComponent(this.projectId)}/reindex`, {});
          this.toast(`${result.indexed} voci indicizzate \xB7 ${result.skipped} saltate.`);
          await this.refresh();
        }, { icon: "refresh", disabled: !this.canWrite }));
        if (this.searchResults) {
          page.append(this.el("p", "search-count", `${this.searchResults.length} risultati`));
          for (const item of this.searchResults) {
            const card = this.memoryCard(item.memory);
            card.append(this.el("p", "provenance", `${item.method} \xB7 punteggio ${value(item.score, "", 3)}`));
            page.append(card);
          }
          if (!this.searchResults.length) page.append(this.el("p", "empty", "Nessuna memoria pertinente trovata."));
        }
      }
    }
    memoryCard(memory) {
      const card = this.el("article", "knowledge-card");
      card.dataset.memoryId = memory.id;
      const head = this.el("div", "row spread");
      head.append(this.el("h3", "", memory.title), this.pill(memory.status));
      card.append(head, this.el("div", "body", memory.content));
      const sources = memory.sourceIds.map((id) => this.data.artifacts.find((item) => item.id === id)?.name ?? this.data.runs.find((item) => item.id === id)?.goal ?? id);
      card.append(this.el("p", "provenance", `Revisione ${memory.revision} \xB7 ${memory.kind === "method" ? "Metodo di lavoro" : memory.kind === "decision" ? "Decisione" : memory.kind === "brief" ? "Brief" : "Documento"} \xB7 ${memory.indexed ? "Indicizzata" : "Indice lessicale"}${sources.length ? ` \xB7 Fonti: ${sources.join(", ")}` : " \xB7 Fonte: inserimento esplicito"}`));
      const actions = this.el("div", "card-actions");
      if (memory.status === "candidate") actions.append(this.button("Approva per il contesto", async () => {
        await this.api.request("PATCH", `/api/memories/${encodeURIComponent(memory.id)}`, { status: "approved" });
        await this.refresh();
      }, { className: "button small primary", icon: "check", disabled: !this.canWrite }));
      actions.append(this.button("Modifica", () => this.memoryDialog(memory), { className: "button small subtle", icon: "edit", disabled: !this.canWrite }), this.button("Dimentica", () => this.confirm("Dimentica questa memoria?", "Testo, revisioni e vettori di questa voce verranno rimossi. La cronologia della conversazione resta separata.", async () => {
        await this.api.request("DELETE", `/api/memories/${encodeURIComponent(memory.id)}`);
        this.searchResults = void 0;
        await this.refresh();
      }), { className: "button small subtle", icon: "trash", disabled: !this.canWrite }), this.el("span", "memory-scope", memory.scope === "project" ? "Condivisa nel progetto" : "Privata"));
      card.append(actions);
      return card;
    }
    renderConnections(page) {
      page.append(this.pageIntro("Scegli la risorsa giusta per ogni agente.", "Collega un provider, trova i suoi modelli e assegna gli account. GemRouter \xE8 un fornitore di inferenza selezionabile come gli altri.", "MODELLI \xB7 ACCOUNT \xB7 QUOTE", this.button("Collega un account", () => this.connectionDialog(), { className: "button primary", icon: "plus", disabled: !this.canWrite })));
      const grid = this.el("div", "cards-grid");
      for (const provider of this.data.providers) {
        const card = this.el("article", "card connection-card");
        const heading = this.el("div", "row");
        const copy = this.el("div", "grow");
        copy.append(this.el("h3", "", provider.label), this.el("p", "provider-kind", `${provider.tag === "gemrouter" ? "GemRouter \xB7 " : ""}${provider.kind}`));
        heading.append(this.el("div", "provider-logo", initials(provider.label)), copy, this.pill(provider.enabled ? "ready" : "unknown", provider.enabled ? "Configurato" : "Disabilitato"));
        card.append(heading);
        card.append(this.el("p", "provider-url", provider.baseUrl ?? "CLI ufficiale sul server \xB7 configurazione dell\u2019operatore"));
        const accounts = this.data.accounts.filter((item) => item.providerId === provider.id);
        for (const account of accounts) {
          const accountRow = this.el("div", "account-row");
          accountRow.append(this.el("span", "", `${account.label}${account.shared ? " \xB7 condiviso" : ""}`), this.pill(account.status));
          card.append(accountRow, this.quotaElement(account));
          const models = this.data.models.filter((item) => item.accountId === account.id);
          const tags = this.el("div", "model-tags");
          for (const model of models) tags.append(this.button(model.label, () => this.modelSettingsDialog(model), { className: "model-tag", disabled: !this.operator, title: this.operator ? "Configura capacit\xE0 del modello" : model.model }));
          card.append(tags);
          const actions = this.el("div", "card-actions");
          actions.append(this.button("Trova modelli", async () => {
            const result = await this.api.request("POST", `/api/accounts/${encodeURIComponent(account.id)}/discover`, {});
            this.toast(`${result.models.length} modelli rilevati.`);
            await this.refresh();
          }, { className: "button small", icon: "search", disabled: !this.canWrite || ["codex", "antigravity"].includes(provider.kind) && !this.operator }));
          if (provider.kind === "codex") actions.append(this.button("Accedi a Codex", async () => {
            await this.api.request("POST", `/api/accounts/${encodeURIComponent(account.id)}/login`, {});
            this.toast("Accesso avviato. Attendi le istruzioni del servizio ufficiale.");
          }, { className: "button small subtle", disabled: !this.operator }));
          if (provider.kind === "antigravity") actions.append(this.button("Login Antigravity", () => {
            const modal = this.modal("Accesso ad Antigravity", "Esegui il login ufficiale sul coordinator per autorizzare la CLI.");
            modal.body.append(
              this.el("p", "", "Sul server o nel terminale del coordinator, con l\u2019utente funboy, esegui:"),
              this.el("pre", "connect-command", "agy acp --login"),
              this.el("p", "fine-print", 'Apri il link restituito nel browser, completa il login con il tuo account Google, e incolla il codice nel terminale. Al termine premi "Verifica modelli".'),
              this.button("Verifica modelli", async () => {
                modal.dialog.close();
                const result = await this.api.request("POST", `/api/accounts/${encodeURIComponent(account.id)}/discover`, {});
                this.toast(`${result.models.length} modelli verificati.`);
                await this.refresh();
              }, { className: "button primary full" })
            );
          }, { className: "button small subtle", disabled: !this.operator }));
          card.append(actions);
        }
        if (!accounts.length) card.append(this.el("p", "fine-print", "Nessun account collegato."));
        card.append(this.button("Aggiungi account", () => this.connectionDialog(provider), { className: "text-button", disabled: !this.canWrite || provider.kind === "antigravity" || provider.kind === "codex" && !this.operator }));
        if (provider.kind === "antigravity") card.append(this.el("p", "fine-print", "CLI ufficiale Antigravity sul coordinator: disponibile per conversazione, orchestratore e task di sviluppo nel workspace autorizzato."));
        grid.append(card);
      }
      if (!this.data.providers.length) grid.append(this.el("p", "empty", "Collega il primo provider. I modelli del cluster si registrano dalla configurazione dell\u2019operatore."));
      page.append(grid, this.info("Le quote sono quelle osservate dal provider, con la data dell\u2019ultimo aggiornamento. Una quota sconosciuta non significa illimitata. Il cambio account conserva la conversazione e non ripete automaticamente azioni gi\xE0 eseguite."));
      if (this.data.user.role === "admin") {
        const section = this.el("section", "page-section");
        const heading = this.el("div", "section-heading");
        heading.append(this.el("h3", "", "Utenti della control room"), this.button("Gestisci utenti", () => this.usersDialog(), { icon: "people" }));
        section.append(heading, this.el("p", "fine-print", "Identit\xE0, accessi e ruoli sono verificati sul server. Le conversazioni personali restano separate."));
        page.append(section);
      }
    }
    quotaElement(account) {
      const element = this.el("div", "quota-meter");
      const quota = account.quota;
      if (!quota) {
        element.append(this.el("p", "fine-print", "Quota: non comunicata dal provider"));
        return element;
      }
      if (quota.windows?.length) for (const window2 of quota.windows) {
        const label = this.el("div", "meter-label");
        label.append(this.el("span", "", window2.label), this.el("span", "mono", window2.usedPercent === void 0 ? "\u2014" : `${value(Math.max(0, 100 - window2.usedPercent), "%")} disponibile`));
        element.append(label, this.progress(window2.usedPercent === void 0 ? void 0 : 100 - window2.usedPercent));
        if (window2.resetAt) element.append(this.el("p", "fine-print", `Reset ${relativeTime(window2.resetAt)}`));
      }
      if (quota.remainingRequests !== void 0) element.append(this.el("p", "fine-print", `${formatNumber(quota.remainingRequests)} richieste residue`));
      if (quota.remainingTokens !== void 0) element.append(this.el("p", "fine-print", `${formatNumber(quota.remainingTokens)} token residui`));
      if (quota.cooldownUntil) element.append(this.el("p", "fine-print", `Nuovo tentativo ${relativeTime(quota.cooldownUntil)}`));
      const stale = Date.now() - new Date(quota.observedAt).getTime() > 3e5;
      element.append(this.el("p", "fine-print", `Osservata ${relativeTime(quota.observedAt)}${stale ? " \xB7 dato non recente" : ""}`));
      return element;
    }
    renderReleases(page) {
      page.append(this.pageIntro("Una consegna dimostrabile.", "Risultati, verifiche e rilascio sono passi distinti. Ogni missione conserva le evidenze che permettono di decidere cosa portare in produzione.", "CONSEGNE E PRODUZIONE"));
      const runs = this.data.runs.filter((item) => item.projectId === this.projectId && item.mode === "mission").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      for (const run of runs) {
        const card = this.el("article", "release-card");
        const heading = this.el("div", "row spread");
        heading.append(this.el("h3", "", run.goal), this.pill(run.status));
        card.append(heading);
        if (run.summary || run.error) card.append(this.el("p", "release-goal", run.summary ?? run.error));
        const evidence = this.data.evidence.filter((item) => item.runId === run.id);
        const evidenceList = this.el("div", "release-evidence");
        for (const item of evidence) {
          const element = this.el("article", "evidence-item");
          const title = this.el("div", "row");
          title.append(this.el("i", `status-dot ${item.ok ? "good" : "error"}`), this.el("strong", "", item.title));
          element.append(title, this.el("p", "", `${item.kind} \xB7 ${relativeTime(item.createdAt)}`), this.button("Leggi risultato", () => this.textDialog(item.title, item.output), { className: "text-button" }));
          evidenceList.append(element);
        }
        if (!evidence.length) evidenceList.append(this.el("p", "fine-print", "Nessuna evidenza registrata. La consegna non \xE8 ancora verificata."));
        card.append(evidenceList);
        const actions = this.el("div", "row actions");
        actions.append(this.button("Apri missione", () => {
          this.saveDraft();
          this.conversationId = run.conversationId;
          this.runId = run.id;
          this.taskId = "";
          this.restoreDraft();
          this.setView("control");
          this.render();
        }, { icon: "people", className: "button small" }));
        if (run.status === "awaiting_release") actions.append(this.button("Esamina e rilascia", () => this.releaseDialog(run), { icon: "rocket", className: "button small primary", disabled: !this.operator || !run.verificationPassed }));
        const label = run.releasedAt ? `Rilascio registrato ${relativeTime(run.releasedAt)}` : run.verificationPassed ? "Verifica superata" : "Verifica di produzione non superata";
        actions.append(this.el("span", "fine-print", label));
        card.append(actions);
        page.append(card);
      }
      if (!runs.length) page.append(this.el("p", "empty", "Le missioni del progetto compariranno qui con i risultati e le verifiche."));
      const project = this.project;
      if (project) page.append(this.info(project.deploymentRecipeId ? `Ricetta di rilascio configurata: ${project.deploymentRecipeId}. Il rilascio richiede verifiche riuscite e un\u2019autorizzazione esplicita.` : "Nessuna ricetta di rilascio configurata per questo progetto. Puoi preparare e verificare il lavoro; l\u2019operatore deve definire un percorso di deploy e controllo dell\u2019esito."));
    }
    table(headers, rows) {
      const wrapper = this.el("div", "table-wrap");
      const table = this.el("table", "data-table");
      const thead = this.el("thead");
      const header = this.el("tr");
      for (const text of headers) header.append(this.el("th", "", text));
      thead.append(header);
      const tbody = this.el("tbody");
      for (const values of rows) {
        const row = this.el("tr");
        for (const text of values) row.append(this.el("td", "", text));
        tbody.append(row);
      }
      if (!rows.length) {
        const row = this.el("tr");
        const cell = this.el("td", "empty", "Nessun dato disponibile.");
        cell.colSpan = headers.length;
        row.append(cell);
        tbody.append(row);
      }
      table.append(thead, tbody);
      wrapper.append(table);
      return wrapper;
    }
    info(text) {
      const info = this.el("div", "info-card");
      info.append(this.icon("info"), this.el("p", "", text));
      return info;
    }
    modal(title, description = "", className = "") {
      const active = this.document.activeElement;
      const dialog = this.el("dialog", `dialog ${className}`);
      dialog.setAttribute("aria-label", title);
      const header = this.el("header", "dialog-header");
      const copy = this.el("div");
      copy.append(this.el("h2", "", title));
      if (description) copy.append(this.el("p", "", description));
      const close = this.button("", () => dialog.close(), { className: "icon-button", icon: "close", title: "Chiudi" });
      close.setAttribute("aria-label", "Chiudi");
      header.append(copy, close);
      const body = this.el("div", "dialog-body");
      dialog.append(header, body);
      this.root.append(dialog);
      dialog.addEventListener("close", () => {
        dialog.remove();
        if (active?.isConnected) active.focus();
      });
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
      return { dialog, body };
    }
    showLogin() {
      if (this.loginDialog?.isConnected) return;
      const guest = this.data?.user.id === "guest";
      this.subscription?.();
      this.subscription = void 0;
      const { dialog, body } = this.modal("La tua control room.", "", "login-dialog");
      this.loginDialog = dialog;
      dialog.querySelector(".dialog-header")?.remove();
      body.append(this.el("div", "login-symbol", "y"), this.el("div", "eyebrow", "YED1Z CONTROL ROOM"), this.el("h1", "", "Tutto il lavoro, connesso."), this.el("p", "login-note", "Accedi al tuo spazio per ritrovare progetti, conversazioni e la tua squadra di agenti."));
      const dismiss = () => {
        dialog.close();
        this.loginDialog = void 0;
        this.setView("infrastructure");
        void this.refresh();
      };
      dialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        if (guest) dismiss();
      });
      if (guest) body.append(this.button("Torna al monitor pubblico", dismiss, { className: "button subtle full" }));
      if (this.api.native) {
        body.append(this.el("p", "fine-print", "Indirizzo e chiave del gateway si configurano nella finestra sicura di VS Code."), this.button("Configura connessione", () => this.api.configure?.(), { className: "button primary full", icon: "plug" }));
        return;
      }
      const form = this.el("form");
      const token = this.input("password", "", "Chiave personale del gateway");
      token.autocomplete = "current-password";
      token.required = true;
      const submit = this.el("button", "button primary full", "Accedi");
      submit.type = "submit";
      const error = this.el("p", "form-error");
      error.hidden = true;
      error.setAttribute("role", "alert");
      form.append(this.field("Chiave di accesso", token), error, submit);
      body.append(form);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const secret = token.value;
        token.value = "";
        error.hidden = true;
        submit.disabled = true;
        void this.api.request("POST", "/api/login", { token: secret }).then(async () => {
          dialog.close();
          this.loginDialog = void 0;
          await this.refresh(true);
        }).catch((reason) => {
          error.textContent = errorMessage(reason);
          error.hidden = false;
        }).finally(() => {
          submit.disabled = false;
        });
      });
      token.focus();
    }
    async logout() {
      try {
        await this.api.request("POST", "/api/logout", {});
        this.subscription?.();
        this.subscription = void 0;
        this.data = void 0;
        this.projectId = "";
        this.conversationId = "";
        this.runId = "";
        this.taskId = "";
        this.events = [];
        this.selectedAttachments = [];
        this.taskProgress.clear();
        this.telemetryHistory.clear();
        this.drafts.clear();
        this.searchResults = void 0;
        this.searchQuery = "";
        this.root.querySelectorAll("dialog").forEach((dialog) => dialog.close());
        for (const id of ["history", "messages", "team-body", "page-view", "fleet-ribbon", "task-detail", "project-select", "attachments-preview"]) this.q(`#${id}`).replaceChildren();
        this.q("#message-input").value = "";
        this.q("#user-name").textContent = "Il tuo spazio";
        this.q("#user-role").textContent = "Non connesso";
        this.q("#user-avatar").textContent = "y";
        this.q("#breadcrumb").textContent = "yed1z / il tuo workspace";
        this.q("#conversation-subtitle").textContent = "";
        this.q("#team-footer-left").textContent = "";
        this.q("#team-footer-right").textContent = "";
        this.q("#banner").hidden = true;
        this.updateComposer();
        this.showLogin();
      } catch (error) {
        this.showBanner(errorMessage(error), true);
      }
    }
    projectDialog(project) {
      if (!this.data || !this.canWrite) return;
      const { dialog, body } = this.modal(project ? "Impostazioni del progetto" : "Un posto per il tuo prossimo risultato.", project ? "Obiettivo, squadra e destinazione restano legati al progetto." : "Inizia con un nome e un orchestratore. Le impostazioni avanzate possono aspettare.");
      const form = this.el("form");
      const name = this.input("text", project?.name ?? "", "Per esempio: AIR3, Portale clienti, Nuova API");
      name.required = true;
      name.maxLength = 100;
      const description = this.el("textarea");
      description.value = project?.description ?? "";
      description.rows = 3;
      description.placeholder = "Scopo, convenzioni e criteri di riuscita del progetto";
      const options = [{ value: "", label: "Scegli al primo messaggio" }, ...this.data.models.filter((item) => this.usableRoute(item)).map((item) => ({ value: item.id, label: `${item.label} \xB7 ${this.account(item.accountId)?.label ?? ""}` }))];
      const primary = this.select(options, project?.routes.primary ?? this.routeId);
      form.append(this.field("Nome del progetto", name), this.field("Orchestratore primario", primary));
      let routing = { ...project?.routing ?? { strategy: "auto", fallbackRouteIds: [] }, fallbackRouteIds: [...project?.routing?.fallbackRouteIds ?? []] };
      form.append(this.routingEditor(routing, (value2) => {
        routing = value2;
      }));
      const advanced = this.el("details", "advanced");
      advanced.append(this.el("summary", "", "Squadra, contesto e destinazione"));
      advanced.append(this.field("Obiettivo e convenzioni", description));
      const roleInputs = {};
      const roles = this.el("div", "form-grid");
      for (const [role, label] of [["coder", "Sviluppatore"], ["reviewer", "Revisore"], ["researcher", "Ricercatore"], ["embedding", "Embedding per la memoria"]]) {
        const choices = role === "embedding" ? this.data.models.filter((item) => item.enabled && item.capabilities.includes("embedding")).map((item) => ({ value: item.id, label: `${item.label} \xB7 ${this.account(item.accountId)?.label ?? ""}` })) : role === "coder" ? this.data.models.filter((item) => this.usableRoute(item, true)).map((item) => ({ value: item.id, label: `${item.label} \xB7 ${this.account(item.accountId)?.label ?? ""}` })) : options.slice(1);
        const input = this.select([{ value: "", label: role === "embedding" ? "Solo ricerca lessicale" : "Come l\u2019orchestratore" }, ...choices], project?.routes[role] ?? "");
        roleInputs[role] = input;
        roles.append(this.field(label, input));
      }
      advanced.append(roles);
      const target = this.select([{ value: "", label: "Nessuna esecuzione su filesystem" }, ...this.data.targets.map((item) => ({ value: item.id, label: item.label }))], project?.targetId ?? "");
      const workspace = this.input("text", project?.workspace ?? "", "Percorso relativo alla radice autorizzata");
      if (this.operator) advanced.append(this.field("Macchina di esecuzione", target, "La macchina che esegue i tool pu\xF2 essere diversa da quella che fornisce inferenza."), this.field("Workspace", workspace, "Percorso relativo alla radice configurata dall\u2019operatore. Vuoto = radice del target."));
      else if (project?.targetId) advanced.append(this.info("La destinazione di esecuzione e le verifiche di questo progetto sono gestite da un operatore."));
      const recipes = this.el("div");
      const deployments = this.select([{ value: "", label: "Nessun rilascio configurato" }], project?.deploymentRecipeId ?? "");
      const renderRecipes = () => {
        recipes.replaceChildren();
        const targetConfig = this.data.targets.find((item) => item.id === target.value);
        for (const recipe of targetConfig?.commands ?? []) {
          const label = this.el("label", "row fine-print");
          const checkbox = this.input("checkbox");
          checkbox.value = recipe.id;
          checkbox.checked = project?.verifyRecipeIds.includes(recipe.id) ?? false;
          checkbox.disabled = !this.operator;
          label.append(checkbox, this.document.createTextNode(recipe.label));
          recipes.append(label);
        }
        deployments.replaceChildren();
        const none = this.el("option", "", "Nessun rilascio configurato");
        none.value = "";
        deployments.append(none);
        for (const recipe of targetConfig?.deployments ?? []) {
          const option = this.el("option", "", recipe.label);
          option.value = recipe.id;
          deployments.append(option);
        }
        deployments.value = project?.deploymentRecipeId ?? "";
        deployments.disabled = !this.operator;
      };
      target.addEventListener("change", renderRecipes);
      renderRecipes();
      if (this.operator || project?.verifyRecipeIds.length || project?.deploymentRecipeId) {
        advanced.append(this.el("p", "field-label", "Verifiche obbligatorie"), recipes, this.field("Ricetta di rilascio", deployments));
      }
      const members = this.input("text", project?.memberIds.join(", ") ?? "", "ID utenti separati da virgola");
      if (project && this.operator && (project.ownerId === this.data.user.id || this.data.user.role === "admin")) advanced.append(this.field("Membri del progetto", members, "I membri condividono risorse e memorie pubblicate del progetto. Le conversazioni personali restano separate."));
      form.append(advanced);
      const submit = this.el("button", "button primary full", project ? "Salva progetto" : "Crea progetto");
      submit.type = "submit";
      const error = this.el("p", "form-error");
      error.hidden = true;
      form.append(error, submit);
      body.append(form);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        void this.formAction(submit, error, async () => {
          const routes = { primary: primary.value };
          for (const [role, input] of Object.entries(roleInputs)) routes[role] = input.value;
          const value2 = { name: name.value.trim(), description: description.value.trim(), routes, routing };
          if (this.operator) {
            value2.targetId = target.value;
            value2.workspace = workspace.value.trim();
            value2.verifyRecipeIds = Array.from(recipes.querySelectorAll("input:checked")).map((item) => item.value);
            value2.deploymentRecipeId = deployments.value;
          }
          if (project && this.operator && (project.ownerId === this.data.user.id || this.data.user.role === "admin")) value2.memberIds = members.value.split(",").map((item) => item.trim()).filter(Boolean);
          const saved = await this.api.request(project ? "PATCH" : "POST", project ? `/api/projects/${encodeURIComponent(project.id)}` : "/api/projects", value2);
          this.routingOverrides.delete(saved.id);
          const changed = saved.id !== this.projectId;
          if (changed) this.saveDraft();
          this.projectId = saved.id;
          this.routeId = saved.routes.primary ?? this.routeId;
          if (changed) {
            this.conversationId = "";
            this.runId = "";
          }
          await this.refresh();
          dialog.close();
          if (changed) this.restoreDraft();
          this.setView("control");
          this.updateComposer();
        });
      });
      name.focus();
    }
    modelDialog(task, accountId) {
      const { dialog, body } = this.modal(task ? `Modello per ${task.label}` : "Scegli modello e disponibilit\xE0", task ? "Riassegna un\u2019attivit\xE0 in coda o in pausa." : "Il contesto resta nel progetto. Vedi subito le risorse occupate e le alternative autorizzate.");
      body.className = "";
      const searchWrap = this.el("div", "model-search");
      const search = this.input("search", "", "Cerca modello, account o macchina\u2026");
      search.setAttribute("aria-label", "Cerca un modello o un account");
      searchWrap.append(search);
      const list = this.el("div", "model-options");
      body.append(searchWrap);
      if (!task) {
        const policy = this.el("div", "picker-policy");
        policy.append(this.routingEditor(this.routing, (value2) => {
          this.routingOverrides.set(this.projectId, value2);
          this.updateComposer();
        }));
        body.append(policy);
      }
      body.append(list);
      const render = () => {
        const focusedRoute = list.contains(this.document.activeElement) ? this.document.activeElement?.closest("[data-route-id]")?.dataset.routeId : void 0;
        const scrollTop = list.scrollTop;
        list.replaceChildren();
        const query = search.value.toLocaleLowerCase();
        const allModels = this.data?.models.filter((model) => (!accountId || model.accountId === accountId) && this.usableRoute(model, task?.role === "coder") && `${model.label} ${model.model} ${this.account(model.accountId)?.label} ${this.provider(model.providerId)?.label} ${model.nodeIds.join(" ")}`.toLocaleLowerCase().includes(query)) ?? [];
        const rank = (model) => {
          const avail = this.availability(model.id);
          const status = avail?.status ?? this.account(model.accountId)?.status ?? "unknown";
          if (status === "available" || status === "ready") return 0;
          if (status === "busy") return 1;
          if (status === "cooldown") return 2;
          if (status === "unknown") return 3;
          return 4;
        };
        allModels.sort((a, b) => {
          const diff = rank(a) - rank(b);
          if (diff !== 0) return diff;
          return a.label.localeCompare(b.label);
        });
        const createModelButton = (model) => {
          const account = this.account(model.accountId), provider = this.provider(model.providerId), availability = this.availability(model.id);
          const selected = model.id === (task?.routeId ?? this.routeId), button = this.el("button", `model-option ${selected ? "selected" : ""}`);
          button.type = "button";
          button.dataset.routeId = model.id;
          const check = this.el("span", "check");
          if (selected) check.append(this.icon("check"));
          const info = this.el("div", "grow");
          info.append(this.el("h3", "", model.label), this.el("p", "", `${provider?.label ?? "Provider"} \xB7 ${account?.label ?? "Account"}${model.nodeIds.length ? ` \xB7 ${model.nodeIds.map((id) => this.data?.nodes.find((node) => node.id === id)?.label ?? id).join(" + ")}` : ""}`));
          if (availability) info.append(this.el("p", "route-reason", availability.reason));
          const status = this.el("span", "option-quota");
          const statusLabels = { available: "Slot libero", ready: "Slot libero", busy: "Occupato", cooldown: "Quota in attesa", unavailable: "Non disponibile", disabled: "Disabilitato", unknown: "Da verificare" };
          status.append(this.pill(availability?.status === "available" ? "ready" : availability?.status === "busy" ? "pending" : availability?.status ?? account?.status ?? "unknown", availability ? statusLabels[availability.status] : labels[account?.status ?? "unknown"]));
          if (availability?.queueCount) status.append(this.el("small", "", `${availability.queueCount} in coda`));
          if (availability && (availability.externalActiveRequests !== void 0 || availability.externalQueuedRequests !== void 0)) status.append(this.el("small", "", `Motore: ${availability.externalActiveRequests ?? "\u2014"} attive \xB7 ${availability.externalQueuedRequests ?? "\u2014"} in coda`));
          if (account?.quota?.windows?.[0]?.usedPercent !== void 0) status.append(this.el("small", "", `${value(100 - account.quota.windows[0].usedPercent, "%")} quota`));
          button.append(check, info, status);
          button.addEventListener("click", () => {
            void this.perform(button, async () => {
              if (task) await this.api.request("POST", `/api/tasks/${encodeURIComponent(task.id)}/route`, { routeId: model.id });
              else this.routeId = model.id;
              dialog.close();
              if (task) await this.refresh();
              this.updateComposer();
              this.renderActivity();
            });
          });
          return button;
        };
        const availableModels = allModels.filter((m) => rank(m) < 3);
        const unverifiedModels = allModels.filter((m) => rank(m) >= 3);
        if (query || !availableModels.length) {
          for (const model of allModels) list.append(createModelButton(model));
        } else {
          for (const model of availableModels) list.append(createModelButton(model));
          if (unverifiedModels.length) {
            const details = this.el("details", "unverified-models-section");
            const summary = this.el("summary", "fine-print", `Altri modelli non collegati o da verificare (${unverifiedModels.length})`);
            details.append(summary);
            for (const model of unverifiedModels) details.append(createModelButton(model));
            list.append(details);
          }
        }
        if (!allModels.length) list.append(this.el("p", "empty", "Nessun modello collegato per questo ruolo. Aggiungine uno: accesso e discovery sono guidati."));
        if (focusedRoute) Array.from(list.querySelectorAll("[data-route-id]")).find((element) => element.dataset.routeId === focusedRoute)?.focus({ preventScroll: true });
        list.scrollTop = scrollTop;
      };
      search.addEventListener("input", render);
      this.modelPickerRender = render;
      dialog.addEventListener("close", () => {
        if (this.modelPickerRender === render) this.modelPickerRender = void 0;
      });
      render();
      const footer = this.el("footer", "dialog-footer");
      footer.append(this.el("span", "", "Disponibilit\xE0 osservata dal coordinator o dal motore configurato. Il motivo indica la fonte e i limiti del dato."), this.button("Collega un account", () => {
        dialog.close();
        this.connectionDialog();
      }, { className: "text-button", disabled: !this.canWrite }));
      body.append(footer);
      search.focus();
    }
    connectionDialog(existing) {
      if (!this.data || !this.canWrite) return;
      const { dialog, body } = this.modal("Collega un modello", "Scegli il servizio. Accesso, verifica e discovery nello stesso percorso.", "connection-dialog");
      mountConnectionWizard({
        body,
        dialog,
        api: this.api,
        data: this.data,
        existing,
        connected: async (result, routeId) => {
          if (routeId && result.provider.kind === "antigravity" && this.project) await this.api.request("PATCH", `/api/projects/${encodeURIComponent(this.project.id)}`, { routes: { primary: routeId, coder: routeId } });
          await this.refresh();
          if (routeId && this.route(routeId) && this.usableRoute(this.route(routeId))) this.routeId = routeId;
          this.updateComposer();
          this.renderActivity();
          this.toast(`${result.provider.label}: ${result.models.length} modelli nel catalogo.`);
        },
        login: async (accountId) => {
          const waiting = this.modal("Accesso a Codex", "Avvio del login ufficiale. Le istruzioni compariranno qui.", "login-dialog");
          this.accountLoginDialog = waiting.dialog;
          waiting.body.append(this.el("p", "connection-progress", "Attendo il codice di autorizzazione\u2026"));
          try {
            await this.api.request("POST", `/api/accounts/${encodeURIComponent(accountId)}/login`, {});
          } catch (error) {
            waiting.dialog.close();
            this.showBanner(errorMessage(error), true);
          }
        }
      });
    }
    modelSettingsDialog(model) {
      if (!this.operator) return;
      const { dialog, body } = this.modal("Capacit\xE0 del modello", "Dichiara soltanto limiti e funzionalit\xE0 verificati sul motore.");
      const form = this.el("form");
      const label = this.input("text", model.label);
      const context = this.input("number", model.contextWindow?.toString() ?? "", "Non dichiarato");
      context.min = "4096";
      context.max = "2000000";
      const capabilities = this.el("div");
      for (const capability of ["chat", "tools", "embedding", "vision"]) {
        const row = this.el("label", "row fine-print");
        const check = this.input("checkbox");
        check.value = capability;
        check.checked = model.capabilities.includes(capability);
        row.append(check, this.document.createTextNode(capability === "chat" ? "Conversazione" : capability === "tools" ? "Chiamata di tool verificata" : capability === "embedding" ? "Embedding" : "Visione dichiarata dal provider"));
        capabilities.append(row);
      }
      form.append(this.field("Nome visibile", label), this.field("Finestra di contesto, token", context), capabilities);
      const submit = this.el("button", "button primary full", "Salva capacit\xE0");
      submit.type = "submit";
      const error = this.el("p", "form-error");
      error.hidden = true;
      form.append(error, submit);
      body.append(form);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        void this.formAction(submit, error, async () => {
          const enabled = Array.from(capabilities.querySelectorAll("input:checked")).map((item) => item.value);
          await this.api.request("PATCH", `/api/models/${encodeURIComponent(model.id)}`, { label: label.value.trim(), ...context.value ? { contextWindow: Number(context.value) } : {}, capabilities: enabled });
          dialog.close();
          await this.refresh();
        });
      });
    }
    memoryDialog(memory) {
      if (!this.project) return;
      const { dialog, body } = this.modal(memory ? "Aggiorna conoscenza" : "Aggiungi conoscenza", "Le nuove voci sono candidate. L\u2019approvazione le rende disponibili al contesto degli agenti.");
      const form = this.el("form");
      const title = this.input("text", memory?.title ?? "", "Per esempio: Come prepariamo una release");
      title.required = true;
      title.maxLength = 200;
      const content = this.el("textarea");
      content.value = memory?.content ?? "";
      content.required = true;
      content.rows = 8;
      content.maxLength = 3e5;
      content.placeholder = "Procedura, decisione o regola di lavoro con informazioni verificabili\u2026";
      const kind = this.select([{ value: "method", label: "Metodo di lavoro" }, { value: "decision", label: "Decisione" }, { value: "brief", label: "Brief del progetto" }, { value: "document", label: "Documento" }], memory?.kind ?? "method");
      kind.disabled = !!memory;
      const scope = this.select([{ value: "private", label: "Solo per me" }, { value: "project", label: "Condivisa nel progetto" }], memory?.scope ?? "private");
      form.append(this.field("Titolo", title), this.field("Contenuto", content), this.field("Tipo", kind), this.field("Visibilit\xE0", scope, "La condivisione richiede i permessi del progetto. Nessun dato viene promosso a memoria personale in modo nascosto."));
      const source = this.select([{ value: "", label: "Inserimento esplicito" }, ...this.data.artifacts.filter((item) => item.projectId === this.projectId).map((item) => ({ value: item.id, label: item.name }))], memory?.sourceIds[0] ?? "");
      if (!memory) form.append(this.field("Documento di origine", source));
      const error = this.el("p", "form-error");
      error.hidden = true;
      const submit = this.el("button", "button primary full", memory ? "Salva revisione" : "Crea proposta");
      submit.type = "submit";
      form.append(error, submit);
      body.append(form);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        void this.formAction(submit, error, async () => {
          await this.api.request(memory ? "PATCH" : "POST", memory ? `/api/memories/${encodeURIComponent(memory.id)}` : "/api/memories", memory ? { title: title.value.trim(), content: content.value, scope: scope.value } : { projectId: this.projectId, title: title.value.trim(), content: content.value, kind: kind.value, scope: scope.value, sourceIds: source.value ? [source.value] : [] });
          await this.refresh();
          dialog.close();
        });
      });
    }
    autonomyDialog() {
      const { dialog, body } = this.modal("Autonomia della prossima missione", "La squadra lavora entro questi limiti. Puoi intervenire in ogni momento.");
      const form = this.el("form");
      const checks = {};
      for (const [id, label] of [["write", "Autorizza modifiche nel workspace del progetto"], ["commands", "Autorizza le ricette di comando configurate"], ["deploy", "Consenti il percorso di rilascio configurato"]]) {
        const row = this.el("label", "row fine-print");
        const input = this.input("checkbox");
        input.checked = this.autonomy[id];
        if (id === "deploy") input.disabled = !this.operator;
        checks[id] = input;
        row.append(input, this.document.createTextNode(label));
        form.append(row);
      }
      form.append(this.info("Le azioni non gi\xE0 autorizzate restano soggette a richiesta puntuale. Il rilascio viene valutato sui risultati delle verifiche e sulla ricetta configurata."));
      const parallel = this.input("number", String(this.autonomy.maxParallel));
      parallel.min = "1";
      parallel.max = "6";
      parallel.required = true;
      const iterations = this.input("number", String(this.autonomy.maxIterations));
      iterations.min = "1";
      iterations.max = "6";
      iterations.required = true;
      const grid = this.el("div", "form-grid");
      grid.append(this.field("Agenti in parallelo", parallel, "La capacit\xE0 dei nodi pu\xF2 ridurre il parallelismo effettivo."), this.field("Iterazioni massime", iterations, "Quando raggiunge il limite, la squadra si ferma con un resoconto."));
      form.append(grid);
      const submit = this.el("button", "button primary full", "Usa questi limiti");
      submit.type = "submit";
      form.append(submit);
      body.append(form);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        this.autonomy = { write: checks.write.checked, commands: checks.commands.checked, deploy: this.operator && checks.deploy.checked, maxParallel: Number(parallel.value), maxIterations: Number(iterations.value) };
        dialog.close();
        this.toast("Limiti aggiornati per la prossima missione.");
      });
    }
    async newConversation() {
      if (!this.projectId || !this.canWrite) return;
      try {
        const conversation = await this.api.request("POST", "/api/conversations", { projectId: this.projectId, routeId: this.routeId || void 0 });
        this.saveDraft();
        this.conversationId = conversation.id;
        this.runId = "";
        this.taskId = "";
        await this.refresh();
        this.restoreDraft();
        this.setView("control");
        this.updateComposer();
        this.q("#message-input").focus();
        return conversation;
      } catch (error) {
        this.showBanner(errorMessage(error), true);
        return;
      }
    }
    runsDialog() {
      const { dialog, body } = this.modal("Le tue missioni", "Tutti i progetti, gli agenti attivi e le decisioni in attesa.");
      const runs = [...this.data?.runs ?? []].sort((a, b) => Number(activeRunStatuses.has(b.status)) - Number(activeRunStatuses.has(a.status)) || b.updatedAt.localeCompare(a.updatedAt));
      for (const run of runs.slice(0, 40)) {
        const button = this.el("button", "model-option");
        button.type = "button";
        const copy = this.el("div", "grow");
        copy.append(this.el("h3", "", run.goal), this.el("p", "", `${this.data?.projects.find((item) => item.id === run.projectId)?.name ?? "Progetto"} \xB7 ${run.tasks.length} attivit\xE0 \xB7 ${relativeTime(run.updatedAt)}`));
        button.append(copy, this.pill(run.status));
        button.addEventListener("click", () => {
          this.saveDraft();
          this.projectId = run.projectId;
          this.conversationId = run.conversationId;
          this.runId = run.id;
          this.taskId = "";
          this.restoreDraft();
          dialog.close();
          this.setView("control");
          this.render();
          this.q("#shell").classList.add("team-open");
        });
        body.append(button);
      }
      if (!runs.length) body.append(this.el("p", "empty", "Nessuna missione avviata. Descrivi un obiettivo al tuo orchestratore per cominciare."));
      const pending = this.data?.approvals.filter((item) => item.status === "pending") ?? [];
      if (pending.length) {
        body.append(this.el("div", "section-heading", "Decisioni in attesa"));
        for (const approval of pending) body.append(this.approvalElement(approval));
      }
    }
    async send() {
      if (this.data?.user.id === "guest") {
        this.showLogin();
        return;
      }
      if (this.sending || !this.canWrite || !this.project) return;
      const input = this.q("#message-input");
      const text = input.value.trim();
      if (!text) return;
      const mode = this.q("#mode-select").value;
      const intent = classifyRequest(text, { mode, attachmentCount: this.selectedAttachments.length });
      if (!this.routeId && intent.kind !== "service") {
        this.connectionDialog();
        return;
      }
      const active = this.currentRun && !closedRunStatuses.has(this.currentRun.status) && intent.kind !== "service";
      if (!active && intent.mode === "mission" && (!this.project.targetId || !this.project.verifyRecipeIds.length)) {
        this.toast("Per avviare la squadra, scegli workspace e verifiche del progetto. La bozza resta qui.");
        this.projectDialog(this.project);
        const advanced = this.root.querySelector("dialog details");
        if (advanced) advanced.open = true;
        return;
      }
      this.sending = true;
      this.updateComposer();
      try {
        if (active) {
          await this.api.request("POST", `/api/runs/${encodeURIComponent(this.currentRun.id)}/steer`, { text, attachmentIds: this.selectedAttachments.map((item) => item.id) });
          input.value = "";
          this.selectedAttachments = [];
          this.saveDraft();
          await this.refresh();
          this.renderAttachments();
          this.toast("Indicazione salvata. La missione si mette in pausa: usa Riprendi per ripianificare.");
          return;
        }
        if (!this.conversationId) {
          const conversation = await this.api.request("POST", "/api/conversations", { projectId: this.projectId, routeId: this.routeId });
          this.conversationId = conversation.id;
        }
        const run = await this.api.request("POST", `/api/conversations/${encodeURIComponent(this.conversationId)}/messages`, { text, routeId: this.routeId, mode, routing: this.routing, attachmentIds: this.selectedAttachments.map((item) => item.id), permissions: { write: this.autonomy.write, commands: this.autonomy.commands, deploy: this.autonomy.deploy }, maxIterations: this.autonomy.maxIterations, maxParallel: this.autonomy.maxParallel });
        if (intent.kind !== "service" || !this.currentRun || closedRunStatuses.has(this.currentRun.status)) {
          this.runId = run.id;
          this.taskId = "";
        }
        input.value = "";
        this.selectedAttachments = [];
        this.saveDraft();
        await this.refresh();
        this.renderAttachments();
        this.setView("control");
      } catch (error) {
        this.showBanner(errorMessage(error), true);
      } finally {
        this.sending = false;
        this.updateComposer();
      }
    }
    async runAction(run, action) {
      try {
        await this.api.request("POST", `/api/runs/${encodeURIComponent(run.id)}/${action}`, {});
        await this.refresh();
      } catch (error) {
        this.showBanner(errorMessage(error), true);
      }
    }
    async taskAction(task, action) {
      await this.api.request("POST", `/api/tasks/${encodeURIComponent(task.id)}/${action}`, {});
      if (action === "resume") this.taskProgress.delete(task.id);
      await this.refresh();
    }
    taskSteerDialog(task) {
      const { dialog, body } = this.modal(`Guida ${roleLabels[task.role] ?? "l\u2019agente"}`, "L\u2019istruzione riguarda questa attivit\xE0. Se l\u2019agente \xE8 al lavoro viene messo in pausa; gli altri rami indipendenti possono continuare.");
      const form = this.el("form");
      const text = this.el("textarea");
      text.rows = 5;
      text.required = true;
      text.maxLength = 12e3;
      text.placeholder = "Indica cosa deve cambiare in questa attivit\xE0\u2026";
      const error = this.el("p", "form-error");
      error.hidden = true;
      const submit = this.el("button", "button primary full", "Invia all\u2019agente");
      submit.type = "submit";
      form.append(this.field(task.label, text), error, submit);
      body.append(form);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        void this.formAction(submit, error, async () => {
          await this.api.request("POST", `/api/tasks/${encodeURIComponent(task.id)}/steer`, { text: text.value });
          await this.refresh();
          dialog.close();
        });
      });
      text.focus();
    }
    saveDraft() {
      if (!this.projectId) return;
      this.drafts.set(`${this.projectId}/${this.conversationId || "new"}`, { text: this.q("#message-input").value, attachmentIds: this.selectedAttachments.map((item) => item.id), routeId: this.routeId });
      if (this.drafts.size > 100) this.drafts.delete(this.drafts.keys().next().value);
    }
    restoreDraft() {
      const draft = this.drafts.get(`${this.projectId}/${this.conversationId || "new"}`);
      this.q("#message-input").value = draft?.text ?? "";
      this.selectedAttachments = this.data?.artifacts.filter((item) => item.projectId === this.projectId && draft?.attachmentIds.includes(item.id)) ?? [];
      this.routeId = draft?.routeId ?? this.conversation?.routeId ?? this.project?.routes.primary ?? this.data?.models.find((item) => item.enabled)?.id ?? "";
    }
    steerDialog(run) {
      const { dialog, body } = this.modal("Guida la squadra", "L\u2019istruzione viene conservata. La missione si mette in pausa; premi Riprendi per ripianificare il lavoro.");
      const form = this.el("form");
      const text = this.el("textarea");
      text.rows = 5;
      text.required = true;
      text.maxLength = 12e3;
      const submit = this.el("button", "button primary full", "Invia istruzione");
      submit.type = "submit";
      const error = this.el("p", "form-error");
      error.hidden = true;
      form.append(this.field("Nuova indicazione", text), error, submit);
      body.append(form);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        void this.formAction(submit, error, async () => {
          await this.api.request("POST", `/api/runs/${encodeURIComponent(run.id)}/steer`, { text: text.value });
          dialog.close();
          await this.refresh();
        });
      });
      text.focus();
    }
    releaseDialog(run) {
      const project = this.data.projects.find((item) => item.id === run.projectId);
      const target = this.data.targets.find((item) => item.id === project?.targetId);
      const { dialog, body } = this.modal("Rilascio in produzione", "Approvi questa consegna e la ricetta configurata, con le evidenze registrate.");
      body.append(this.el("h3", "", run.goal), this.el("p", "fine-print", `Target: ${target?.label ?? "Non configurato"} \xB7 Ricetta: ${project?.deploymentRecipeId ?? "Non configurata"}`));
      for (const evidence of this.data.evidence.filter((item) => item.runId === run.id)) {
        const row = this.el("p", "fine-print");
        row.textContent = `${evidence.ok ? "\u2713" : "!"} ${evidence.title}`;
        body.append(row);
      }
      body.append(this.info("Il servizio eseguir\xE0 la ricetta autorizzata sul target indicato e ne registrer\xE0 l\u2019esito. La produzione sar\xE0 dichiarata riuscita soltanto dopo i controlli previsti."));
      const error = this.el("p", "form-error");
      error.hidden = true;
      body.append(error);
      const button = this.button("Autorizza questo rilascio", () => this.formAction(button, error, async () => {
        await this.api.request("POST", `/api/runs/${encodeURIComponent(run.id)}/release`, {});
        dialog.close();
        await this.refresh();
      }), { className: "button primary full", icon: "rocket", disabled: !this.operator || !run.verificationPassed || !project?.deploymentRecipeId });
      body.append(button);
    }
    attachmentDialog() {
      if (!this.project) return;
      const { dialog, body } = this.modal("Aggiungi contesto al messaggio", "Carica un documento o riutilizza un allegato del progetto.");
      body.append(this.button("Carica file di testo o Markdown", () => {
        dialog.close();
        this.q("#file-input").click();
      }, { className: "button primary full", icon: "upload" }));
      if (this.api.native && this.api.attachSelection) body.append(this.button("Allega la selezione di VS Code", () => {
        dialog.close();
        this.api.attachSelection?.();
      }, { className: "button full", icon: "code" }));
      const files = this.data.artifacts.filter((item) => item.projectId === this.projectId && item.kind === "attachment");
      for (const file of files) body.append(this.button(file.name, () => {
        if (!this.selectedAttachments.some((item) => item.id === file.id)) this.selectedAttachments.push(file);
        this.renderAttachments();
        dialog.close();
      }, { className: "model-option", icon: "file" }));
      body.append(this.el("p", "fine-print", "Massimo 1 MiB per documento. I documenti restano associati al progetto e sono accessibili solo agli utenti autorizzati."));
    }
    async uploadFiles(files) {
      for (const file of files) {
        try {
          if (file.size > 1024 * 1024) throw new Error(`${file.name}: supera il limite di 1 MiB.`);
          const content = await file.text();
          if (content.includes("\0") || content.includes("\uFFFD")) throw new Error(`${file.name}: usa un file di testo UTF-8.`);
          await this.uploadText(file.name, content, this.view === "control");
        } catch (error) {
          this.showBanner(errorMessage(error), true);
        }
      }
    }
    async uploadText(name, content, attach) {
      if (!this.projectId) {
        this.toast("Scegli prima un progetto.", true);
        return;
      }
      try {
        const artifact = await this.api.request("POST", "/api/artifacts", { projectId: this.projectId, name, content, kind: "attachment" });
        if (attach && !this.selectedAttachments.some((item) => item.id === artifact.id)) this.selectedAttachments.push(artifact);
        await this.refresh();
        this.renderAttachments();
        this.toast(`Documento aggiunto: ${artifact.name}`);
      } catch (error) {
        this.showBanner(errorMessage(error), true);
      }
    }
    renderAttachments() {
      const container = this.q("#attachments-preview");
      container.replaceChildren();
      container.hidden = !this.selectedAttachments.length;
      for (const artifact of this.selectedAttachments) {
        const chip = this.el("span", "attachment-chip");
        chip.append(this.icon("file"), this.el("span", "truncate", artifact.name), this.button("", () => {
          this.selectedAttachments = this.selectedAttachments.filter((item) => item.id !== artifact.id);
          this.renderAttachments();
        }, { className: "icon-button", icon: "close", title: `Rimuovi ${artifact.name} dal prossimo messaggio` }));
        container.append(chip);
      }
    }
    async openArtifact(id) {
      const value2 = await this.api.request("GET", `/api/artifacts/${encodeURIComponent(id)}`);
      this.textDialog(value2.name, value2.content);
    }
    async downloadArtifact(artifact) {
      const value2 = await this.api.request("GET", `/api/artifacts/${encodeURIComponent(artifact.id)}`);
      await this.downloadText(artifact.name, value2.content, "text/plain;charset=utf-8");
    }
    contextElement(report) {
      const fragment = this.el("div");
      fragment.append(this.el("p", "context-summary", `${formatNumber(report.estimatedTokens)} token stimati / ${formatNumber(report.budgetTokens)} disponibili \xB7 ${formatNumber(report.reservedOutputTokens)} riservati alla risposta. ${report.truncated ? "Alcune fonti sono state escluse o ridotte." : "Le fonti selezionate rientrano nel budget."}`));
      const list = this.el("ul", "context-list");
      for (const source of report.sources) {
        const item = this.el("li");
        const copy = this.el("span", "", `${source.included ? "\u2713" : "\u2212"} ${source.title}`);
        copy.append(this.el("p", "fine-print", source.reason));
        item.append(copy, this.el("small", "", `${formatNumber(source.estimatedTokens)} tok`));
        list.append(item);
      }
      fragment.append(list, this.el("p", "fine-print", `Stima: ${report.estimator}. L\u2019occupazione del contesto non equivale alla memoria GPU o alla KV cache.`));
      return fragment;
    }
    contextDialog(report) {
      const { body } = this.modal("Il contesto dell\u2019agente", "Fonti incluse, esclusioni e budget della richiesta.");
      body.append(this.contextElement(report));
    }
    textDialog(title, text) {
      const { body } = this.modal(title);
      const content = this.el("div", "message-body");
      content.style.paddingLeft = "0";
      content.append(renderMarkdown(this.document, text));
      body.append(content);
    }
    async usersDialog() {
      const result = await this.api.request("GET", "/api/users");
      const users = Array.isArray(result) ? result : result.users;
      const { dialog, body } = this.modal("Utenti della control room", "Ogni persona ha una chiave distinta e un ruolo verificato sul server.");
      body.append(this.table(["Nome", "Ruolo", "ID"], users.map((item) => [item.name, roleLabels[item.role] ?? item.role, item.id])));
      const form = this.el("form");
      const name = this.input("text", "", "Nome della persona");
      name.required = true;
      const role = this.select([{ value: "member", label: "Membro \xB7 progetti e agenti" }, { value: "viewer", label: "Osservatore \xB7 sola lettura" }, { value: "operator", label: "Operatore \xB7 infrastruttura e rilasci" }, { value: "admin", label: "Amministratore" }], "member");
      const error = this.el("p", "form-error");
      error.hidden = true;
      const submit = this.el("button", "button primary full", "Crea utente");
      submit.type = "submit";
      form.append(this.field("Nome", name), this.field("Ruolo", role), error, submit);
      body.append(form);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        void this.formAction(submit, error, async () => {
          const result2 = await this.api.request("POST", "/api/users", { name: name.value, role: role.value });
          dialog.close();
          const secret = this.modal("Chiave del nuovo utente", `Chiave di ${result2.user.name}. Copiala ora e consegnala alla persona tramite un canale appropriato.`);
          const input = this.input("text", result2.token);
          input.readOnly = true;
          input.setAttribute("aria-label", "Chiave personale mostrata una sola volta");
          secret.body.append(input, this.el("p", "fine-print", "Questa chiave viene mostrata una sola volta e non sar\xE0 inclusa nello storico della chat."));
          input.select();
        });
      });
    }
    loginEvent(event) {
      const data = event.data;
      if (!data) return;
      if (data.status === "complete") {
        this.accountLoginDialog?.close();
        this.accountLoginDialog = void 0;
        this.toast("Accesso completato. Scegli il modello del nuovo account.");
        void this.refresh().then(() => {
          const accountId = typeof data.accountId === "string" ? data.accountId : void 0;
          if (accountId && this.data?.models.some((model) => model.accountId === accountId)) this.modelDialog(void 0, accountId);
        });
        return;
      }
      if (data.status === "error") {
        this.accountLoginDialog?.close();
        this.accountLoginDialog = void 0;
        this.showBanner(typeof data.message === "string" ? data.message : "Accesso non riuscito.", true);
        return;
      }
      if (typeof data.verificationUri !== "string" && typeof data.userCode !== "string") return;
      this.accountLoginDialog?.close();
      const { dialog, body } = this.modal("Accedi con il servizio ufficiale", "Completa l\u2019autorizzazione nel sito del provider. I codici sono temporanei e non entrano nella cronologia.");
      this.accountLoginDialog = dialog;
      if (typeof data.userCode === "string") {
        const code = this.input("text", data.userCode);
        code.readOnly = true;
        code.setAttribute("aria-label", "Codice temporaneo di accesso");
        body.append(code);
      }
      if (typeof data.verificationUri === "string") {
        try {
          const url = new URL(data.verificationUri);
          if (url.protocol === "https:" && !url.username && !url.password) {
            if (this.api.native && this.api.openAuth) body.append(this.button("Apri autorizzazione ufficiale", () => this.api.openAuth?.(url.href), { className: "button primary full" }));
            else {
              const link = this.el("a", "button primary full", "Apri autorizzazione ufficiale");
              link.href = url.href;
              link.target = "_blank";
              link.rel = "noopener noreferrer";
              body.append(link);
            }
          }
        } catch {
        }
      }
      body.append(this.el("p", "fine-print", "La finestra si aggiorner\xE0 quando il servizio confermer\xE0 l\u2019accesso."));
    }
    confirm(title, detail, action) {
      const { dialog, body } = this.modal(title, detail);
      const error = this.el("p", "form-error");
      error.hidden = true;
      const actions = this.el("div", "dialog-actions");
      const confirm = this.button("Conferma", () => this.formAction(confirm, error, async () => {
        await action();
        dialog.close();
      }), { className: "button danger" });
      actions.append(this.button("Annulla", () => dialog.close(), { className: "button subtle" }), confirm);
      body.append(error, actions);
    }
    async formAction(button, error, action) {
      button.disabled = true;
      error.hidden = true;
      try {
        await action();
      } catch (reason) {
        error.textContent = errorMessage(reason);
        error.hidden = false;
      } finally {
        button.disabled = false;
      }
    }
    async perform(button, action) {
      if (button.disabled) return;
      button.disabled = true;
      try {
        await action();
      } catch (error) {
        this.showBanner(errorMessage(error), true);
      } finally {
        if (button.isConnected) button.disabled = false;
      }
    }
    toast(text, error = false) {
      const toast = this.el("div", `toast ${error ? "error" : ""}`, text);
      this.q("#toasts").append(toast);
      setTimeout(() => toast.remove(), 5500);
    }
    showBanner(message2, error = false) {
      const banner = this.q("#banner");
      banner.hidden = false;
      banner.classList.toggle("error", error);
      this.q("#banner > span").textContent = message2;
    }
    async downloadJson(name, value2) {
      await this.downloadText(name, JSON.stringify(value2, null, 2), "application/json");
    }
    async downloadText(name, text, mime) {
      if (this.api.native && this.api.saveFile) {
        await this.api.saveFile(name, text, mime);
        this.toast("Esportazione salvata.");
        return;
      }
      const url = URL.createObjectURL(new Blob([text], { type: mime }));
      const link = this.el("a");
      link.href = url;
      link.download = safeFilename(name);
      this.root.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1e3);
    }
    dispose() {
      this.disposed = true;
      this.subscription?.();
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
      if (this.packetTimer) clearTimeout(this.packetTimer);
      if (this.streamFrame !== void 0) this.win.cancelAnimationFrame(this.streamFrame);
      for (const dispose of this.disposers) dispose();
      this.api.dispose?.();
      this.root.replaceChildren();
    }
  };
  function errorMessage(error) {
    return error instanceof Error ? error.message : "Operazione non riuscita.";
  }
  function taskPaused(task) {
    return "control" in task && task.control === "paused";
  }
  function statusTone(status) {
    return ["online", "succeeded", "ready", "approved"].includes(status) ? "good" : ["running", "executing", "planning", "reviewing", "verifying", "deploying", "streaming"].includes(status) ? "active" : ["paused", "blocked", "cooldown", "stale", "pending", "awaiting_release", "candidate", "interrupted"].includes(status) ? "warning" : ["failed", "error", "offline", "denied", "expired"].includes(status) ? "error" : "";
  }
  function value(input, suffix = "", digits = 1) {
    return typeof input === "number" && Number.isFinite(input) ? `${formatNumber(input, digits)}${suffix}` : "\u2014";
  }
  function formatNumber(input, digits = 0) {
    return input.toLocaleString("it-IT", { maximumFractionDigits: digits });
  }
  function bytes(input) {
    if (input === void 0 || !Number.isFinite(input)) return "\u2014";
    if (input < 1024) return `${input} B`;
    if (input < 1024 ** 2) return `${formatNumber(input / 1024, 1)} KB`;
    if (input < 1024 ** 3) return `${formatNumber(input / 1024 ** 2, 1)} MB`;
    return `${formatNumber(input / 1024 ** 3, 1)} GB`;
  }
  function initials(name) {
    return name.trim().split(/\s+/).slice(0, 2).map((item) => item.charAt(0).toUpperCase()).join("") || "y";
  }
  function time(date) {
    if (!date) return "\u2014";
    const value2 = new Date(date);
    return Number.isFinite(value2.getTime()) ? value2.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }) : "\u2014";
  }
  function relativeTime(date) {
    if (!date) return "mai";
    const timestamp = new Date(date).getTime();
    if (!Number.isFinite(timestamp)) return "\u2014";
    const seconds = Math.round((timestamp - Date.now()) / 1e3);
    const relative = new Intl.RelativeTimeFormat("it-IT", { numeric: "auto" });
    if (Math.abs(seconds) < 60) return seconds > 0 ? "tra poco" : "ora";
    if (Math.abs(seconds) < 3600) return relative.format(Math.round(seconds / 60), "minute");
    if (Math.abs(seconds) < 86400) return relative.format(Math.round(seconds / 3600), "hour");
    return relative.format(Math.round(seconds / 86400), "day");
  }
  function safeFilename(input) {
    return input.replace(/[^\p{L}\p{N}._-]/gu, "-").slice(0, 80) || "conversazione";
  }
  if (typeof document !== "undefined") {
    const root = document.getElementById("app");
    if (root && !root.dataset.mounted) {
      root.dataset.mounted = "true";
      mountApp(root, createApi());
    }
  }
})();
