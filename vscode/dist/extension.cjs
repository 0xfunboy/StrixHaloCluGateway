"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// vscode/src/extension.ts
var extension_exports = {};
__export(extension_exports, {
  CommandView: () => CommandView,
  activate: () => activate,
  deactivate: () => deactivate
});
module.exports = __toCommonJS(extension_exports);
var vscode = __toESM(require("vscode"), 1);
var import_node_crypto = require("node:crypto");
var import_node_path = __toESM(require("node:path"), 1);

// vscode/src/client.ts
function gatewayUrl(raw) {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/" && url.pathname !== "") throw new Error("Indica solo l\u2019origine del gateway, senza credenziali o percorsi.");
  if (url.protocol === "http:" && !/^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.[\d.]+|192\.168\.[\d.]+|172\.(1[6-9]|2\d|3[01])\.[\d.]+)$/.test(url.hostname) && !url.hostname.endsWith(".local")) throw new Error("Per un gateway pubblico \xE8 richiesto HTTPS.");
  return url.origin;
}
function apiPath(raw) {
  if (typeof raw !== "string" || raw.length > 1800 || !raw.startsWith("/api/") || /[\\%#\s]/.test(raw) || raw.split(/[/?]/).some((part) => part === "." || part === "..")) throw new Error("Percorso API non consentito.");
  const url = new URL(raw, "https://yed1z.invalid");
  if (url.origin !== "https://yed1z.invalid" || !/^\/api\/[a-zA-Z0-9_\/-]+$/.test(url.pathname)) throw new Error("Percorso API non consentito.");
  if (url.search) {
    const fields = [...url.searchParams.keys()];
    const eventPath = url.pathname === "/api/events" || /^\/api\/runs\/[a-zA-Z0-9_-]+\/events$/.test(url.pathname);
    const eventCursor = eventPath && fields.length === 1 && fields[0] === "after" && /^\d{1,15}$/.test(url.searchParams.get("after") ?? "");
    const sourcePath = /^\/api\/projects\/[a-zA-Z0-9_-]+\/knowledge\/sources\/[a-zA-Z0-9_-]+$/.test(url.pathname);
    const sourceHash = sourcePath && /^[a-f0-9]{64}$/i.test(url.searchParams.get("hash") ?? "") && url.searchParams.getAll("hash").length === 1 && (fields.length === 1 || fields.length === 2 && /^\d{1,10}$/.test(url.searchParams.get("revision") ?? ""));
    if (!eventCursor && !sourceHash) throw new Error("Parametri API non consentiti.");
  }
  return url.pathname + url.search;
}
async function boundedJson(response) {
  if (!response.body) return null;
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let text = "", bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 16e6) throw new Error("Risposta del gateway troppo grande.");
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } finally {
    await reader.cancel().catch(() => {
    });
  }
}
async function consumeEvents(response, onEvent, signal) {
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) throw new Error("Streaming del gateway non disponibile.");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "", data = [], size = 0;
  const dispatch = () => {
    if (data.length) {
      const parsed = JSON.parse(data.join("\n"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Evento non valido.");
      onEvent(parsed);
    }
    data = [];
    size = 0;
  };
  const line = (value) => {
    if (!value) dispatch();
    else if (value.startsWith("data:")) {
      const text = value.slice(5).replace(/^ /, "");
      size += text.length;
      if (size > 2e6) throw new Error("Evento troppo grande.");
      data.push(text);
    }
  };
  const abort = () => {
    void reader.cancel();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      buffer += decoder.decode(part.value, { stream: true });
      if (buffer.length > 2e6) throw new Error("Evento troppo grande.");
      let boundary;
      while ((boundary = buffer.indexOf("\n")) >= 0) {
        line(buffer.slice(0, boundary).replace(/\r$/, ""));
        buffer = buffer.slice(boundary + 1);
      }
    }
    buffer += decoder.decode();
    if (buffer) line(buffer);
    if (data.length) dispatch();
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {
    });
  }
}
var GatewayClient = class {
  endpoint;
  token;
  constructor(endpoint, token) {
    this.endpoint = gatewayUrl(endpoint);
    this.token = token;
  }
  async request(method, path2, body, signal) {
    const target = apiPath(path2);
    const delegateUpdate = method === "PUT" && /^\/api\/accounts\/[a-zA-Z0-9_-]+\/delegates$/.test(target);
    if (!delegateUpdate && !["GET", "POST", "PATCH", "DELETE"].includes(method)) throw new Error("Metodo API non consentito.");
    const text = method === "GET" ? void 0 : JSON.stringify(body ?? {});
    if (text && Buffer.byteLength(text) > 3e6) throw new Error("Richiesta troppo grande.");
    return await fetch(this.endpoint + target, { method, signal, redirect: "error", headers: { Authorization: "Bearer " + this.token, "Content-Type": "application/json", "X-Client-App": "yed1z-vscode" }, ...text === void 0 ? {} : { body: text } });
  }
};

// vscode/src/extension.ts
var keyName = (endpoint) => "yed1z.gateway." + (0, import_node_crypto.createHash)("sha256").update(endpoint).digest("hex");
var CommandView = class {
  view;
  requests = /* @__PURE__ */ new Map();
  stream;
  configurePromise;
  context;
  constructor(context) {
    this.context = context;
  }
  endpoint() {
    return this.context.globalState.get("yed1z.endpoint", "http://127.0.0.1:8081");
  }
  post(message) {
    return this.view?.webview.postMessage(message);
  }
  postHost() {
    const workspace2 = vscode.workspace.workspaceFolders?.map((folder) => folder.name).join(", ");
    const host = vscode.env.remoteName ? `Host remoto (${vscode.env.remoteName})` : "Host locale";
    return this.post({ type: "host-context", endpoint: this.endpoint(), host, workspace: workspace2 });
  }
  async resolveWebviewView(view) {
    this.view = view;
    const assets = vscode.Uri.joinPath(this.context.extensionUri, "web");
    view.webview.options = { enableScripts: true, localResourceRoots: [assets] };
    const raw = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(assets, "index.html"))).toString("utf8");
    const nonce = (0, import_node_crypto.randomBytes)(18).toString("base64");
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${view.webview.cspSource} data:; font-src ${view.webview.cspSource}; style-src ${view.webview.cspSource}; style-src-attr 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'none'; form-action 'none'; base-uri 'none';">`;
    view.webview.html = raw.replace(/<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/gi, "").replace(/<head(?:\s[^>]*)?>/i, (match) => match + csp).replace(/(href|src)="(?:\/|\.\/)?(?:assets\/|web\/)?(app\.js|style\.css|favicon\.svg)"/g, (_all, attribute, file) => `${attribute}="${view.webview.asWebviewUri(vscode.Uri.joinPath(assets, file))}"`).replace(/<script\b/g, `<script nonce="${nonce}"`);
    const subscription = view.webview.onDidReceiveMessage((raw2) => {
      void this.message(raw2);
    });
    view.onDidDispose(() => {
      subscription.dispose();
      this.abortAll();
      if (this.view === view) this.view = void 0;
    });
  }
  abortAll() {
    for (const controller of this.requests.values()) controller.abort();
    this.requests.clear();
    this.stream?.abort();
    this.stream = void 0;
  }
  async client() {
    const endpoint = this.endpoint(), token = await this.context.secrets.get(keyName(endpoint));
    if (!token) throw new Error("Collega il gateway con URL e chiave.");
    return new GatewayClient(endpoint, token);
  }
  async message(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const message = raw;
    if (message.type === "configure") {
      await this.configure();
      return;
    }
    if (message.type === "host-context") {
      await this.postHost();
      return;
    }
    if (message.type === "open-portal") {
      await this.openPortal();
      return;
    }
    if (message.type === "openCockpit") {
      await vscode.env.openExternal(vscode.Uri.parse(`${gatewayUrl(this.endpoint())}/cockpit`));
      return;
    }
    if (message.type === "copyText" && typeof message.text === "string" && message.text.length <= 2e3) {
      await vscode.env.clipboard.writeText(message.text);
      return;
    }
    if (message.type === "openDiff" && typeof message.text === "string" && Buffer.byteLength(message.text) <= 2e6) {
      const document = await vscode.workspace.openTextDocument({ language: "diff", content: message.text });
      await vscode.window.showTextDocument(document, { preview: true });
      return;
    }
    if (message.type === "attachSelection") {
      await this.addSelection();
      return;
    }
    if (message.type === "saveFile") {
      try {
        if (typeof message.name !== "string" || typeof message.content !== "string" || Buffer.byteLength(message.content) > 16e6) throw new Error("File da esportare non valido o troppo grande.");
        const name = import_node_path.default.basename(message.name.replace(/\\/g, "/")).replace(/[\x00-\x1f\x7f]/g, "").slice(0, 180);
        if (!name || name === "." || name === "..") throw new Error("Nome del file non valido.");
        const destination = await vscode.window.showSaveDialog({ title: "Salva esportazione yed1z", defaultUri: vscode.Uri.file(name) });
        if (!destination) {
          await this.post({ type: "savedFile", ok: false, error: "Esportazione annullata." });
          return;
        }
        await vscode.workspace.fs.writeFile(destination, Buffer.from(message.content, "utf8"));
        await this.post({ type: "savedFile", ok: true });
      } catch (error) {
        await this.post({ type: "savedFile", ok: false, error: error instanceof Error ? error.message : "Esportazione non riuscita." });
      }
      return;
    }
    if (message.type === "unsubscribe") {
      this.stream?.abort();
      this.stream = void 0;
      return;
    }
    if (message.type === "subscribe") {
      void this.subscribe(typeof message.after === "number" ? message.after : 0);
      return;
    }
    if (message.type === "cancel-api" && typeof message.id === "string") {
      this.requests.get(message.id)?.abort();
      return;
    }
    if (message.type === "openAuth" && typeof message.url === "string") {
      try {
        const url = new URL(message.url);
        if (url.protocol === "https:" && !url.port && !url.username && !url.password && ["auth.openai.com", "auth0.openai.com", "chatgpt.com", "accounts.google.com"].includes(url.hostname)) await vscode.env.openExternal(vscode.Uri.parse(url.href));
      } catch {
      }
      return;
    }
    if (message.type !== "api" || typeof message.id !== "string" || message.id.length > 120 || this.requests.has(message.id)) return;
    const id = message.id, controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12e4);
    this.requests.set(id, controller);
    try {
      if (this.requests.size > 16) throw new Error("Troppe richieste contemporanee.");
      const path2 = apiPath(message.path), method = typeof message.method === "string" ? message.method : "GET";
      const personalAppearance = method === "PATCH" && path2 === "/api/me/appearance";
      if (method !== "GET" && !vscode.workspace.isTrusted && path2 !== "/api/logout" && !personalAppearance) throw new Error("Rendi attendibile il workspace prima di inviare attivit\xE0 o file al gateway.");
      let body = message.body;
      if (method === "POST" && ["/api/accounts", "/api/connections"].includes(path2) && body && typeof body === "object" && !Array.isArray(body)) {
        const account = { ...body };
        if (account.requestSecret === true) {
          const secret = await vscode.window.showInputBox({ title: "yed1z \xB7 Chiave del provider", prompt: "La chiave viene inviata al gateway e non entra nel webview.", password: true, ignoreFocusOut: true });
          if (!secret) throw new Error("Inserimento della chiave annullato.");
          account.secret = secret;
        }
        delete account.requestSecret;
        body = account;
      }
      if (method === "POST" && /^\/api\/accounts\/[a-zA-Z0-9_-]+\/login\/respond$/.test(path2) && body && typeof body === "object" && !Array.isArray(body)) {
        const response2 = { ...body };
        if (response2.requestCode === true) {
          const code = await vscode.window.showInputBox({ title: "yed1z \xB7 Risposta di autorizzazione", prompt: "Incolla il codice o URL restituito dal provider dopo il login.", password: true, ignoreFocusOut: true, validateInput: (value) => value.trim().length > 4096 ? "Risposta troppo lunga." : null });
          if (!code?.trim()) throw new Error("Inserimento del codice annullato.");
          response2.code = code.trim();
        }
        delete response2.requestCode;
        body = response2;
      }
      const response = await (await this.client()).request(method, path2, body, controller.signal);
      let data;
      try {
        data = await boundedJson(response);
      } catch {
        data = { error: `Il gateway ha risposto HTTP ${response.status}.`, code: "invalid_response" };
      }
      await this.post({ type: "api.result", id, ok: response.ok, status: response.status, data });
    } catch (error) {
      await this.post({ type: "api.result", id, ok: false, status: controller.signal.aborted ? 499 : 502, data: { error: controller.signal.aborted ? "Richiesta interrotta." : error instanceof Error ? error.message : "Gateway non raggiungibile.", code: "host_error" } });
    } finally {
      clearTimeout(timer);
      this.requests.delete(id);
    }
  }
  async subscribe(after) {
    this.stream?.abort();
    const controller = new AbortController();
    this.stream = controller;
    let cursor = Number.isSafeInteger(after) && after >= 0 ? after : 0;
    while (!controller.signal.aborted && this.view) {
      try {
        const response = await (await this.client()).request("GET", `/api/events?after=${cursor}`, void 0, controller.signal);
        if (!response.ok) throw new Error(`Streaming HTTP ${response.status}.`);
        await this.post({ type: "connection", connected: true });
        await consumeEvents(response, (event) => {
          if (Number.isSafeInteger(event.id) && Number(event.id) > cursor) cursor = Number(event.id);
          void this.post({ type: "event", event });
        }, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) await this.post({ type: "connection", connected: false, message: error instanceof Error ? error.message : "Connessione interrotta." });
      }
      if (controller.signal.aborted) break;
      await new Promise((resolve) => {
        const timer = setTimeout(done, 2500);
        function done() {
          controller.signal.removeEventListener("abort", abort);
          resolve();
        }
        function abort() {
          clearTimeout(timer);
          done();
        }
        controller.signal.addEventListener("abort", abort, { once: true });
      });
    }
  }
  async configure() {
    if (this.configurePromise) return this.configurePromise;
    this.configurePromise = this.doConfigure();
    try {
      await this.configurePromise;
    } finally {
      this.configurePromise = void 0;
    }
  }
  async doConfigure() {
    const saved = this.context.globalState.get("yed1z.endpoints", []);
    let value;
    if (saved.length && typeof vscode.window.showQuickPick === "function") {
      const choices = saved.map((endpoint2) => ({ label: endpoint2, description: endpoint2 === this.endpoint() ? "Gateway in uso" : "Gateway salvato", endpoint: endpoint2 }));
      const pick = await vscode.window.showQuickPick([...choices, { label: "Aggiungi un gateway", description: "", endpoint: "" }], { title: "yed1z \xB7 Gateway dell\u2019editor" });
      if (!pick) return;
      value = pick.endpoint || void 0;
    }
    if (!value) value = await vscode.window.showInputBox({ title: "yed1z \xB7 Collega Control Room", value: this.endpoint(), prompt: "Indirizzo del portale yed1z. In Remote SSH, localhost indica l\u2019host remoto dell\u2019estensione.", ignoreFocusOut: true, validateInput: (value2) => {
      try {
        gatewayUrl(value2);
        return null;
      } catch (error) {
        return error.message;
      }
    } });
    if (!value) return;
    const endpoint = gatewayUrl(value), previous = await this.context.secrets.get(keyName(endpoint));
    const entered = await vscode.window.showInputBox({ title: "yed1z \xB7 Chiave personale", password: true, ignoreFocusOut: true, prompt: previous ? "Lascia vuoto per conservare la chiave salvata." : "La chiave resta in VS Code SecretStorage." });
    if (entered === void 0) return;
    const token = entered || previous;
    if (!token) return;
    try {
      const response = await new GatewayClient(endpoint, token).request("GET", "/api/bootstrap", void 0, AbortSignal.timeout(15e3));
      if (!response.ok) throw new Error(`Connessione HTTP ${response.status}. Verifica URL e chiave.`);
      await boundedJson(response);
      this.abortAll();
      await this.context.secrets.store(keyName(endpoint), token);
      await this.context.globalState.update("yed1z.endpoint", endpoint);
      await this.context.globalState.update("yed1z.endpoints", [endpoint, ...saved.filter((item) => item !== endpoint)].slice(0, 25));
      await this.postHost();
      await this.post({ type: "configured" });
      void vscode.window.showInformationMessage("yed1z collegato: progetti, conversazioni e squadre sono condivisi con il portale.");
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : "Gateway non raggiungibile.");
    }
  }
  async addSelection() {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showErrorMessage("Rendi attendibile il workspace prima di trasferire una selezione.");
      return;
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) return;
    const content = editor.document.getText(editor.selection);
    if (Buffer.byteLength(content) > 1e6) {
      void vscode.window.showErrorMessage("La selezione supera 1 MB.");
      return;
    }
    await vscode.commands.executeCommand("haloforge.chat.focus");
    await this.post({ type: "selection", name: vscode.workspace.asRelativePath(editor.document.uri), content });
  }
  async openPortal() {
    await vscode.env.openExternal(vscode.Uri.parse(this.endpoint()));
  }
  dispose() {
    this.abortAll();
  }
};
function activate(context) {
  const view = new CommandView(context);
  context.subscriptions.push(
    view,
    vscode.window.registerWebviewViewProvider("haloforge.chat", view, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand("haloforge.open", () => vscode.commands.executeCommand("haloforge.chat.focus")),
    vscode.commands.registerCommand("yed1z.configure", () => view.configure()),
    vscode.commands.registerCommand("haloforge.addSelection", () => view.addSelection()),
    vscode.commands.registerCommand("yed1z.openPortal", () => view.openPortal())
  );
}
function deactivate() {
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CommandView,
  activate,
  deactivate
});
