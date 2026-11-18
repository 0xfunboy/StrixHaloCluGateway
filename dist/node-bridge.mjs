// src/node-bridge.ts
import { createServer } from "node:http";
import { timingSafeEqual, createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { Readable as Readable2 } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

// src/adapters/vendor/providers/transport.ts
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
var DENIED_HOSTS = /* @__PURE__ */ new Set(["metadata.google.internal", "metadata", "instance-data", "metadata.tencentyun.com"]);
var resolveAll = (hostname2) => dnsLookup(hostname2, { all: true, verbatim: true });
function ipv4Forbidden(bytes) {
  const [a, b, c, d] = bytes;
  return a === 0 || a >= 224 || a === 169 && b === 254 || a === 100 && b === 100 && c === 100 && d === 200;
}
function ipv6Bytes(address) {
  let text = address.toLowerCase();
  if (text.includes(".")) {
    const tail2 = text.slice(text.lastIndexOf(":") + 1).split(".").map(Number);
    text = text.slice(0, text.lastIndexOf(":") + 1) + (tail2[0] << 8 | tail2[1]).toString(16) + ":" + (tail2[2] << 8 | tail2[3]).toString(16);
  }
  const [left, right] = text.split("::");
  const head = left ? left.split(":") : [], tail = right ? right.split(":") : [];
  const fields = right !== void 0 ? [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail] : head;
  return fields.flatMap((field) => {
    const n = Number.parseInt(field, 16);
    return [n >> 8, n & 255];
  });
}
function assertAllowedAddress(address) {
  const version = isIP(address);
  if (!version || address.includes("%")) throw new Error("Endpoint resolved to an invalid or scoped address.");
  if (version === 4) {
    if (ipv4Forbidden(address.split(".").map(Number))) throw new Error("Endpoint resolved to a reserved metadata or non-unicast address.");
    return;
  }
  const bytes = ipv6Bytes(address);
  const zero = bytes.every((n) => n === 0);
  const loopback = bytes.slice(0, 15).every((n) => n === 0) && bytes[15] === 1;
  if (loopback) return;
  const mapped = bytes.slice(0, 10).every((n) => n === 0) && bytes[10] === 255 && bytes[11] === 255;
  const compatible = bytes.slice(0, 12).every((n) => n === 0);
  const translated = bytes.slice(0, 8).every((n) => n === 0) && bytes[8] === 255 && bytes[9] === 255 && bytes[10] === 0 && bytes[11] === 0;
  const nat64 = bytes[0] === 0 && bytes[1] === 100 && bytes[2] === 255 && bytes[3] === 155 && bytes.slice(4, 12).every((n) => n === 0);
  const awsMetadata = bytes[0] === 253 && bytes[1] === 0 && bytes[2] === 14 && bytes[3] === 194 && bytes.slice(4, 14).every((n) => n === 0) && bytes[14] === 2 && bytes[15] === 84;
  const googleMetadata = bytes[0] === 253 && bytes[1] === 32 && bytes[2] === 0 && bytes[3] === 206 && bytes.slice(4, 14).every((n) => n === 0) && bytes[14] === 2 && bytes[15] === 84;
  if (zero || bytes[0] === 255 || bytes[0] === 254 && (bytes[1] & 192) === 128 || awsMetadata || googleMetadata || (mapped || compatible || translated || nat64) && ipv4Forbidden(bytes.slice(12))) {
    throw new Error("Endpoint resolved to a reserved metadata or non-unicast address.");
  }
}
function pinnedLookup(resolve = resolveAll) {
  const cache = /* @__PURE__ */ new Map();
  return (hostname2, options, callback) => {
    const normalized = hostname2.toLowerCase().replace(/\.$/, "");
    let pending = cache.get(normalized);
    if (!pending) {
      pending = Promise.resolve().then(async () => {
        if (DENIED_HOSTS.has(normalized)) throw new Error("Reserved metadata hostname is not an inference endpoint.");
        const rows = await resolve(hostname2);
        if (!rows.length || rows.length > 128) throw new Error("Endpoint DNS returned no usable address set.");
        for (const row of rows) {
          assertAllowedAddress(row.address);
          if (isIP(row.address) !== row.family) throw new Error("Endpoint DNS returned an invalid address family.");
        }
        return rows.map((row) => ({ address: row.address, family: row.family }));
      });
      cache.set(normalized, pending);
    }
    void pending.then((rows) => {
      const family = options.family === "IPv4" ? 4 : options.family === "IPv6" ? 6 : options.family;
      const selected = family ? rows.filter((row) => row.family === family) : rows;
      if (!selected.length) throw new Error("Endpoint has no address in the requested family.");
      if (options.all) callback(null, selected);
      else callback(null, selected[0].address, selected[0].family);
    }).catch((error) => callback(error instanceof Error ? error : new Error("Endpoint DNS lookup failed."), "", 0));
  };
}
function pinnedFetch(input, init = {}, transport = {}) {
  const url = new URL(input);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return Promise.reject(new Error("Provider URL must use HTTP(S) without embedded credentials."));
  const hostname2 = url.hostname.replace(/^\[|\]$/g, "");
  try {
    if (DENIED_HOSTS.has(hostname2.toLowerCase().replace(/\.$/, ""))) throw new Error("Reserved metadata hostname is not an inference endpoint.");
    if (isIP(hostname2)) assertAllowedAddress(hostname2);
    init.signal?.throwIfAborted();
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    const headers = new Headers(init.headers);
    headers.set("host", url.host);
    headers.set("accept-encoding", "identity");
    headers.set("connection", "close");
    headers.delete("transfer-encoding");
    headers.set("content-length", String(Buffer.byteLength(init.body ?? "")));
    const options = {
      method: init.method ?? "GET",
      headers: Object.fromEntries(headers),
      agent: false,
      lookup: pinnedLookup(transport.resolve),
      signal: init.signal,
      ...url.protocol === "https:" ? {
        servername: isIP(hostname2) ? void 0 : hostname2,
        ...transport.ca ? { ca: transport.ca } : {},
        rejectUnauthorized: true
      } : {}
    };
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, options, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        response.destroy();
        reject(new Error("Provider redirects are not followed. Configure the final inference endpoint."));
        return;
      }
      if (status < 200 || status > 599) {
        response.destroy();
        reject(new Error("Provider returned an unsupported HTTP status."));
        return;
      }
      try {
        const responseHeaders = new Headers();
        for (let i = 0; i < response.rawHeaders.length; i += 2) responseHeaders.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
        let stream = response;
        const encoding = (responseHeaders.get("content-encoding") ?? "identity").trim().toLowerCase();
        if (encoding && encoding !== "identity") {
          const decompressor = encoding === "gzip" ? createGunzip() : encoding === "deflate" ? createInflate() : encoding === "br" ? createBrotliDecompress() : void 0;
          if (!decompressor) throw new Error("Provider returned an unsupported content encoding.");
          response.on("error", (error) => decompressor.destroy(error));
          decompressor.on("close", () => response.destroy());
          stream = response.pipe(decompressor);
          responseHeaders.delete("content-encoding");
          responseHeaders.delete("content-length");
        }
        if (status === 204 || status === 205 || init.method === "HEAD") {
          response.resume();
          resolve(new Response(null, { status, statusText: response.statusMessage, headers: responseHeaders }));
        } else {
          const body = Readable.toWeb(stream);
          resolve(new Response(body, { status, statusText: response.statusMessage, headers: responseHeaders }));
        }
      } catch (error) {
        response.destroy();
        reject(error);
      }
    });
    request.on("error", reject);
    request.end(init.body ?? "");
  });
}

// src/adapters/local-telemetry.ts
import { readFile, readdir, statfs } from "node:fs/promises";
import { hostname, totalmem, freemem, networkInterfaces } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
var exec = promisify(execFile);
var numeric = (value2, divisor = 1) => {
  const n = Number(value2.trim());
  return value2.trim() && Number.isFinite(n) && n >= 0 ? n / divisor : void 0;
};
async function value(file, divisor = 1) {
  try {
    return numeric(await readFile(file, "utf8"), divisor);
  } catch {
    return;
  }
}
async function dirs(root) {
  try {
    return await readdir(root);
  } catch {
    return [];
  }
}
async function cpuCounters() {
  try {
    const fields = (await readFile("/proc/stat", "utf8")).split("\n")[0].trim().split(/\s+/).slice(1).map(Number);
    if (fields.length < 8 || fields.some((n) => !Number.isFinite(n))) return;
    return { total: fields.slice(0, 8).reduce((a, b) => a + b, 0), idle: fields[3] + fields[4] };
  } catch {
    return;
  }
}
async function gpuSysfs() {
  const result = [];
  for (const name of (await dirs("/sys/class/drm")).filter((name2) => /^card\d+$/.test(name2)).slice(0, 16)) {
    const root = `/sys/class/drm/${name}/device`;
    let vendor = "";
    try {
      vendor = (await readFile(join(root, "vendor"), "utf8")).trim();
    } catch {
      continue;
    }
    if (vendor !== "0x1002") continue;
    const sensors = await dirs(join(root, "hwmon"));
    const hwmon = sensors[0] ? join(root, "hwmon", sensors[0]) : void 0;
    const [utilization, memoryUsedBytes, memoryTotalBytes, temperatureC, powerWatts] = await Promise.all([
      value(join(root, "gpu_busy_percent")),
      value(join(root, "mem_info_vram_used")),
      value(join(root, "mem_info_vram_total")),
      hwmon ? value(join(hwmon, "temp1_input"), 1e3) : void 0,
      hwmon ? value(join(hwmon, "power1_average"), 1e6) : void 0
    ]);
    result.push({ name: `AMD ${name}`, vendor: "amd", ...utilization !== void 0 ? { utilization } : {}, ...memoryUsedBytes !== void 0 ? { memoryUsedBytes } : {}, ...memoryTotalBytes !== void 0 ? { memoryTotalBytes } : {}, ...temperatureC !== void 0 ? { temperatureC } : {}, ...powerWatts !== void 0 ? { powerWatts } : {} });
  }
  return result;
}
async function nvidia(signal) {
  const result = await exec("nvidia-smi", ["--query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total,power.draw,clocks.current.sm,fan.speed", "--format=csv,noheader,nounits"], { timeout: 2500, maxBuffer: 64 * 1024, signal, env: { PATH: "/usr/local/bin:/usr/bin:/bin" } });
  return result.stdout.trim().split("\n").filter(Boolean).slice(0, 16).flatMap((line) => {
    const row = line.split(",").map((p) => p.trim());
    if (row.length !== 8) return [];
    const [name, ...fields] = row;
    const values = fields.map((x) => numeric(x));
    const keys = ["utilization", "temperatureC", "memoryUsedBytes", "memoryTotalBytes", "powerWatts", "clockMHz", "fanPercent"];
    const gpu = { name: name.slice(0, 180), vendor: "nvidia" };
    keys.forEach((key, i) => {
      if (values[i] !== void 0) gpu[key] = values[i] * (key.startsWith("memory") ? 1024 ** 2 : 1);
    });
    return [gpu];
  });
}
async function network() {
  const addresses = networkInterfaces();
  const names = (await dirs("/sys/class/net")).filter((name) => name !== "lo" && /^[A-Za-z0-9_.:@-]{1,64}$/.test(name)).slice(0, 128);
  return await Promise.all(names.map(async (name) => {
    const root = join("/sys/class/net", name), result = { name };
    const observedAddresses = [...new Set((addresses[name] ?? []).map((row) => row.cidr ?? row.address).filter(Boolean))];
    if (observedAddresses.length) result.addresses = observedAddresses.slice(0, 32);
    let state = "";
    try {
      state = (await readFile(join(root, "operstate"), "utf8")).trim();
    } catch {
    }
    if (state === "up") result.up = true;
    else if (["down", "notpresent", "lowerlayerdown", "dormant"].includes(state)) result.up = false;
    else {
      const carrier = await value(join(root, "carrier"));
      if (carrier === 0 || carrier === 1) result.up = carrier === 1;
    }
    try {
      const mac = (await readFile(join(root, "address"), "utf8")).trim();
      if (/^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/i.test(mac)) result.mac = mac;
    } catch {
    }
    const [speed, rx, tx, rxErrors, txErrors] = await Promise.all([
      value(join(root, "speed")),
      value(join(root, "statistics", "rx_bytes")),
      value(join(root, "statistics", "tx_bytes")),
      value(join(root, "statistics", "rx_errors")),
      value(join(root, "statistics", "tx_errors"))
    ]);
    if (speed !== void 0) result.speedMbps = speed;
    for (const [key, n] of [["rxBytes", rx], ["txBytes", tx], ["rxErrors", rxErrors], ["txErrors", txErrors]]) {
      if (n !== void 0 && Number.isSafeInteger(n)) result[key] = n;
    }
    return result;
  }));
}
async function collectLocalTelemetry(signal) {
  signal?.throwIfAborted();
  const totalBytes = totalmem(), freeBytes = freemem();
  const result = { schema: "yed1z.telemetry.v1", hostname: hostname(), observedAt: (/* @__PURE__ */ new Date()).toISOString(), cpu: {}, memory: { totalBytes, usedBytes: Math.max(0, totalBytes - freeBytes) }, gpus: [], errors: [] };
  try {
    const info = await readFile("/proc/meminfo", "utf8");
    const total = /^MemTotal:\s+(\d+)\s+kB$/m.exec(info), available = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(info);
    if (total && available) result.memory = { totalBytes: Number(total[1]) * 1024, usedBytes: Math.max(0, Number(total[1]) - Number(available[1])) * 1024 };
  } catch {
  }
  const first = await cpuCounters();
  const sampling = (async () => {
    if (!first) return;
    await new Promise((resolve) => setTimeout(resolve, 120));
    const second = await cpuCounters();
    const delta = second ? second.total - first.total : 0;
    if (second && delta > 0) result.cpu.utilization = Math.max(0, Math.min(100, (1 - (second.idle - first.idle) / delta) * 100));
  })();
  const [nv, amd] = await Promise.allSettled([nvidia(signal), gpuSysfs()]);
  if (nv.status === "fulfilled") result.gpus.push(...nv.value);
  if (amd.status === "fulfilled") result.gpus.push(...amd.value);
  if (!result.gpus.length) result.errors.push("gpu_sensor_unavailable");
  for (const directory of (await dirs("/sys/class/hwmon")).slice(0, 64)) {
    const root = join("/sys/class/hwmon", directory);
    let sensor = "";
    try {
      sensor = (await readFile(join(root, "name"), "utf8")).trim();
    } catch {
      continue;
    }
    if (!["coretemp", "k10temp", "zenpower", "cpu_thermal"].includes(sensor)) continue;
    for (const input of (await dirs(root)).filter((p) => /^temp\d+_input$/.test(p)).slice(0, 32)) {
      const c = await value(join(root, input), 1e3);
      if (c !== void 0 && c <= 150) result.cpu.temperatureC = Math.max(result.cpu.temperatureC ?? c, c);
    }
  }
  try {
    const info = await statfs("/");
    result.disk = { totalBytes: info.blocks * info.bsize, usedBytes: (info.blocks - info.bfree) * info.bsize };
  } catch {
    result.errors.push("disk_sensor_unavailable");
  }
  try {
    result.network = await network();
    if (!result.network.length) result.errors.push("network_sensor_unavailable");
  } catch {
    result.errors.push("network_sensor_unavailable");
  }
  await sampling;
  signal?.throwIfAborted();
  result.observedAt = (/* @__PURE__ */ new Date()).toISOString();
  return result;
}

// src/node-bridge.ts
var openAI = /* @__PURE__ */ new Map([["/v1/models", "GET"], ["/v1/chat/completions", "POST"], ["/v1/embeddings", "POST"], ["/v1/responses", "POST"]]);
var ollama = /* @__PURE__ */ new Map([["/api/tags", "GET"], ["/api/show", "POST"], ["/api/chat", "POST"], ["/api/embed", "POST"]]);
var digest = (input) => createHash("sha256").update(input).digest();
function createNodeBridge(options) {
  if (!["openai", "ollama"].includes(options.kind)) throw new Error("Protocollo nodo non valido.");
  const upstream = new URL(options.upstream);
  if (!["http:", "https:"].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash)
    throw new Error("Usa la base HTTP del motore, senza credenziali o query.");
  if (options.token.length < 24) throw new Error("La chiave del nodo deve avere almeno 24 caratteri.");
  const expected = digest("Bearer " + options.token);
  const routes = options.kind === "openai" ? openAI : ollama;
  return createServer(async (req, res) => {
    const fail = (status, message) => {
      if (!res.headersSent) res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: message }));
    };
    if (!timingSafeEqual(expected, digest(req.headers.authorization ?? ""))) {
      fail(401, "Chiave del nodo richiesta.");
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, kind: options.kind }));
      return;
    }
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(6e5)]);
    try {
      if (req.method === "GET" && req.url === "/telemetry") {
        const telemetry = await collectLocalTelemetry(signal);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(telemetry));
        return;
      }
      const route = req.url ?? "";
      if (routes.get(route) !== req.method || !routes.has(route)) {
        fail(404, "Endpoint non disponibile.");
        return;
      }
      const chunks = [];
      let bytes = 0;
      for await (const part of req) {
        bytes += part.length;
        if (bytes > 7 * 1024 * 1024) {
          fail(413, "Richiesta troppo grande.");
          return;
        }
        chunks.push(Buffer.from(part));
      }
      const url = new URL(upstream);
      url.pathname = upstream.pathname.replace(/\/(?:v1|api)\/?$/, "").replace(/\/$/, "") + route;
      const response = await pinnedFetch(url, {
        method: req.method,
        signal,
        headers: { "content-type": "application/json", ...options.upstreamToken ? { authorization: "Bearer " + options.upstreamToken } : {} },
        ...req.method === "POST" ? { body: Buffer.concat(chunks).toString("utf8") } : {}
      });
      const headers = { "Cache-Control": "no-store" };
      for (const name of ["content-type", "retry-after", "x-ratelimit-remaining-requests", "ratelimit-remaining"]) {
        const v = response.headers.get(name);
        if (v !== null) headers[name] = v;
      }
      res.writeHead(response.status, headers);
      if (response.body) await pipeline(Readable2.fromWeb(response.body), res, { signal });
      else res.end();
    } catch {
      if (!res.headersSent && !res.destroyed) fail(502, "Motore del nodo irraggiungibile o risposta interrotta.");
      else if (!res.destroyed) res.destroy();
    }
  });
}
if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const bind = process.env.YED1Z_NODE_BIND ?? "127.0.0.1", port = Number(process.env.YED1Z_NODE_PORT ?? 8181);
  const server = createNodeBridge({
    upstream: process.env.YED1Z_NODE_UPSTREAM ?? "http://127.0.0.1:8080/v1",
    kind: process.env.YED1Z_NODE_KIND ?? "openai",
    token: process.env.YED1Z_NODE_TOKEN ?? "",
    upstreamToken: process.env.YED1Z_ENGINE_TOKEN
  });
  server.listen(port, bind, () => process.stdout.write("Adapter di inferenza in ascolto su " + bind + ":" + port + "\n"));
}
export {
  createNodeBridge
};
