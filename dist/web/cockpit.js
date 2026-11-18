"use strict";
(() => {
  // web/appearance.ts
  function localAppearance(win) {
    try {
      const theme2 = win.localStorage.getItem("theme");
      const crt = win.localStorage.getItem("crt");
      const motion = crt === "false" ? "off" : crt === "true" ? "on" : win.localStorage.getItem("yed1z.motion");
      return {
        ...theme2 === "dark" || theme2 === "light" || theme2 === "system" ? { theme: theme2 } : {},
        ...motion === "on" || motion === "off" ? { motion } : {}
      };
    } catch {
      return {};
    }
  }
  function storeAppearance(win, appearance2) {
    try {
      if (appearance2.theme) win.localStorage.setItem("theme", appearance2.theme);
      if (appearance2.motion) {
        win.localStorage.setItem("crt", String(appearance2.motion === "on"));
        win.localStorage.setItem("yed1z.motion", appearance2.motion);
      }
    } catch {
    }
  }
  function createAppearance(win, render) {
    const dark = win.matchMedia?.("(prefers-color-scheme: dark)");
    const reduced = win.matchMedia?.("(prefers-reduced-motion: reduce)");
    let preference = localAppearance(win);
    const apply = () => {
      const theme2 = preference.theme === "dark" || preference.theme === "light" ? preference.theme : dark?.matches === false ? "light" : "dark";
      const motion = preference.motion !== "off" && !reduced?.matches;
      const html = win.document.documentElement;
      html.dataset.theme = theme2;
      html.dataset.motion = motion ? "on" : "off";
      render(motion);
    };
    const storage = (event) => {
      if (event.key === null || ["theme", "crt", "yed1z.motion"].includes(event.key)) {
        preference = localAppearance(win);
        apply();
      }
    };
    dark?.addEventListener("change", apply);
    reduced?.addEventListener("change", apply);
    win.addEventListener("storage", storage);
    apply();
    return {
      get value() {
        return { theme: preference.theme ?? "system", motion: preference.motion ?? "on" };
      },
      get reduced() {
        return reduced?.matches === true;
      },
      update(change) {
        preference = { ...preference, ...change };
        storeAppearance(win, change);
        apply();
      },
      dispose() {
        dark?.removeEventListener("change", apply);
        reduced?.removeEventListener("change", apply);
        win.removeEventListener("storage", storage);
      }
    };
  }

  // web/cockpit.ts
  var field = (id) => document.getElementById(id);
  var el = (tag, value = "", className = "") => {
    const e = document.createElement(tag);
    e.textContent = value;
    e.className = className;
    return e;
  };
  var measure = (n, unit = "", scale = 1) => typeof n === "number" && Number.isFinite(n) ? (n / scale).toLocaleString("it-IT", { maximumFractionDigits: 1 }) + unit : "\u2014";
  var theme = field("theme");
  var effects = field("effects");
  var appearance = createAppearance(window, (enabled) => {
    effects.textContent = enabled ? "FX ON" : "FX OFF";
    effects.setAttribute("aria-pressed", String(enabled));
    effects.disabled = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    effects.title = effects.disabled ? "Il sistema richiede movimento ridotto." : "Effetti visivi";
  });
  var appearanceRevision = 0;
  var appearanceQueue = Promise.resolve();
  function changeAppearance(change) {
    if (change) {
      appearanceRevision++;
      appearance.update(change);
    }
    const revision = appearanceRevision;
    theme.value = appearance.value.theme;
    appearanceQueue = appearanceQueue.then(async () => {
      try {
        const options = change ? { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(change) } : { cache: "no-store" };
        const response = await fetch("/api/me/appearance", options);
        const saved = response.ok ? await response.json() : void 0;
        if (saved && revision === appearanceRevision) {
          appearance.update(saved);
          theme.value = appearance.value.theme;
        }
      } catch {
      }
    });
  }
  theme.onchange = () => changeAppearance({ theme: theme.value });
  effects.onclick = () => changeAppearance({ motion: appearance.value.motion === "on" ? "off" : "on" });
  window.addEventListener("storage", () => {
    theme.value = appearance.value.theme;
  });
  changeAppearance();
  var status = { online: "In linea", offline: "Fuori linea", unknown: "Da verificare", stale: "Campione precedente", standby: "Motore non pronto", ready: "Pronto" };
  function tile(label, value) {
    const item = el("div", "", "metric");
    item.append(el("span", label), el("strong", value));
    return item;
  }
  var pendingAction = "start";
  var pending;
  var loading = false;
  var generation = 0;
  var controller;
  function summary(data) {
    field("metrics").replaceChildren(tile("Richieste API registrate", measure(data.stats.totals.total_requests)), tile("Token misurati via API", measure(data.stats.totals.total_tokens)), tile("Ultimo primo token", measure(data.stats.latest?.ttft_ms, " ms")), tile("Ultimo decode", measure(data.stats.latest?.decode_tps, " tok/s")));
    field("node-count").textContent = data.nodes.length + " nodi";
    field("fleet").replaceChildren(...data.nodes.map((node) => {
      const t = data.telemetry.find((t2) => t2.nodeId === node.id), tag = t?.status ?? "unknown";
      const item = el("article"), list = el("dl");
      item.append(el("span", status[tag], "state " + tag), el("h3", node.label), list);
      for (const [label, value] of [["CPU", measure(t?.cpuPercent, "%")], ["GPU", measure(t?.gpuPercent, "%")], ["Temperatura GPU", measure(t?.gpuTempC, " \xB0C")], ["Potenza GPU", measure(t?.gpuPowerW, " W")], ["RAM usata", measure(t?.ramUsedBytes, " GiB", 2 ** 30)], ["RAM totale", measure(t?.ramTotalBytes, " GiB", 2 ** 30)], ["VRAM usata", measure(t?.gpuMemoryUsedBytes, " GiB", 2 ** 30)]]) list.append(el("dt", label), el("dd", value));
      if (t?.observedAt) item.append(el("small", new Date(t.observedAt).toLocaleTimeString("it-IT")));
      return item;
    }));
    field("links").replaceChildren(...data.links.map((l) => el("span", l.from + " \u2194 " + l.to + " \xB7 " + l.label)));
    const parent = field("engines");
    for (const engine of data.engines) {
      let row = Array.from(parent.children).find((r) => r.dataset.engine === engine.id);
      if (!row) {
        row = el("div", "", "engine");
        row.dataset.engine = engine.id;
        row.append(el("strong", engine.label), el("span", "", "state"));
        if (engine.switchable) {
          const b = el("button", "Attiva");
          b.onclick = () => void activate(engine.id);
          row.append(b);
        }
        if (engine.canStop) {
          const b = el("button", "Arresta");
          b.onclick = () => void activate(engine.id, "stop");
          row.append(b);
        }
        parent.append(row);
      }
      const state = row.children[1];
      state.textContent = status[engine.status] ?? engine.status;
      state.className = "state " + engine.status;
    }
    field("stamp").textContent = "Aggiornato alle " + (/* @__PURE__ */ new Date()).toLocaleTimeString("it-IT");
  }
  async function refresh() {
    if (loading) return;
    loading = true;
    try {
      const r = await fetch("/api/dashboard", { cache: "no-store" });
      if (r.status === 401) field("access").hidden = false;
      if (!r.ok) throw Error("Monitor in attesa del collegamento");
      summary(await r.json());
    } catch (e) {
      field("stamp").textContent = e.message;
    } finally {
      loading = false;
    }
  }
  async function activate(id, action = "start") {
    if (controller) return;
    controller = new AbortController();
    const n = ++generation;
    field("feedback").textContent = "Verifica e prenotazione del motore\u2026";
    try {
      const r = await fetch("/api/switch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providerId: id, action }), signal: controller.signal });
      if (r.status === 401) {
        pending = id;
        pendingAction = action;
        field("access").hidden = false;
        field("credential").focus();
        field("feedback").textContent = "Accedi per attivare il motore.";
        return;
      }
      const data = await r.json();
      if (!r.ok) throw Error(data.error);
      field("feedback").textContent = data.stopped ? "Motore arrestato" : "Motore pronto \xB7 " + data.model;
      await refresh();
    } catch (e) {
      if (n === generation) field("feedback").textContent = e.message;
    } finally {
      controller = void 0;
    }
  }
  field("access").onsubmit = async (event) => {
    event.preventDefault();
    const input = field("credential");
    try {
      const response = await fetch("/api/auth/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ admin_key: input.value }) });
      input.value = "";
      const result = await response.json();
      if (!response.ok) throw Error(result.error);
      field("access").hidden = true;
      changeAppearance();
      const id = pending;
      pending = void 0;
      if (id) await activate(id, pendingAction);
      else await refresh();
    } catch (e) {
      field("feedback").textContent = e.message;
    }
  };
  field("dismiss").onclick = () => {
    field("credential").value = "";
    pending = void 0;
    field("access").hidden = true;
  };
  void refresh();
  setInterval(() => {
    if (!document.hidden) void refresh();
  }, 4e3);
})();
