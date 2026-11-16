var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/adapters/local-telemetry.ts
var local_telemetry_exports = {};
__export(local_telemetry_exports, {
  collectLocalTelemetry: () => collectLocalTelemetry
});
import { readFile, readdir as readdir2, statfs } from "node:fs/promises";
import { hostname, totalmem, freemem, networkInterfaces } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
async function value(file, divisor = 1) {
  try {
    return numeric(await readFile(file, "utf8"), divisor);
  } catch {
    return;
  }
}
async function dirs(root) {
  try {
    return await readdir2(root);
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
  const result2 = [];
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
    result2.push({ name: `AMD ${name}`, vendor: "amd", ...utilization !== void 0 ? { utilization } : {}, ...memoryUsedBytes !== void 0 ? { memoryUsedBytes } : {}, ...memoryTotalBytes !== void 0 ? { memoryTotalBytes } : {}, ...temperatureC !== void 0 ? { temperatureC } : {}, ...powerWatts !== void 0 ? { powerWatts } : {} });
  }
  return result2;
}
async function nvidia(signal) {
  const result2 = await exec("nvidia-smi", ["--query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total,power.draw,clocks.current.sm,fan.speed", "--format=csv,noheader,nounits"], { timeout: 2500, maxBuffer: 64 * 1024, signal, env: { PATH: "/usr/local/bin:/usr/bin:/bin" } });
  return result2.stdout.trim().split("\n").filter(Boolean).slice(0, 16).flatMap((line) => {
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
    const root = join("/sys/class/net", name), result2 = { name };
    const observedAddresses = [...new Set((addresses[name] ?? []).map((row) => row.cidr ?? row.address).filter(Boolean))];
    if (observedAddresses.length) result2.addresses = observedAddresses.slice(0, 32);
    let state = "";
    try {
      state = (await readFile(join(root, "operstate"), "utf8")).trim();
    } catch {
    }
    if (state === "up") result2.up = true;
    else if (["down", "notpresent", "lowerlayerdown", "dormant"].includes(state)) result2.up = false;
    else {
      const carrier = await value(join(root, "carrier"));
      if (carrier === 0 || carrier === 1) result2.up = carrier === 1;
    }
    try {
      const mac = (await readFile(join(root, "address"), "utf8")).trim();
      if (/^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/i.test(mac)) result2.mac = mac;
    } catch {
    }
    const [speed, rx, tx, rxErrors, txErrors] = await Promise.all([
      value(join(root, "speed")),
      value(join(root, "statistics", "rx_bytes")),
      value(join(root, "statistics", "tx_bytes")),
      value(join(root, "statistics", "rx_errors")),
      value(join(root, "statistics", "tx_errors"))
    ]);
    if (speed !== void 0) result2.speedMbps = speed;
    for (const [key, n] of [["rxBytes", rx], ["txBytes", tx], ["rxErrors", rxErrors], ["txErrors", txErrors]]) {
      if (n !== void 0 && Number.isSafeInteger(n)) result2[key] = n;
    }
    return result2;
  }));
}
async function collectLocalTelemetry(signal) {
  signal?.throwIfAborted();
  const totalBytes = totalmem(), freeBytes = freemem();
  const result2 = { schema: "yed1z.telemetry.v1", hostname: hostname(), observedAt: (/* @__PURE__ */ new Date()).toISOString(), cpu: {}, memory: { totalBytes, usedBytes: Math.max(0, totalBytes - freeBytes) }, gpus: [], errors: [] };
  try {
    const info = await readFile("/proc/meminfo", "utf8");
    const total = /^MemTotal:\s+(\d+)\s+kB$/m.exec(info), available = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(info);
    if (total && available) result2.memory = { totalBytes: Number(total[1]) * 1024, usedBytes: Math.max(0, Number(total[1]) - Number(available[1])) * 1024 };
  } catch {
  }
  const first = await cpuCounters();
  const sampling = (async () => {
    if (!first) return;
    await new Promise((resolve) => setTimeout(resolve, 120));
    const second = await cpuCounters();
    const delta = second ? second.total - first.total : 0;
    if (second && delta > 0) result2.cpu.utilization = Math.max(0, Math.min(100, (1 - (second.idle - first.idle) / delta) * 100));
  })();
  const [nv, amd] = await Promise.allSettled([nvidia(signal), gpuSysfs()]);
  if (nv.status === "fulfilled") result2.gpus.push(...nv.value);
  if (amd.status === "fulfilled") result2.gpus.push(...amd.value);
  if (!result2.gpus.length) result2.errors.push("gpu_sensor_unavailable");
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
      if (c !== void 0 && c <= 150) result2.cpu.temperatureC = Math.max(result2.cpu.temperatureC ?? c, c);
    }
  }
  try {
    const info = await statfs("/");
    result2.disk = { totalBytes: info.blocks * info.bsize, usedBytes: (info.blocks - info.bfree) * info.bsize };
  } catch {
    result2.errors.push("disk_sensor_unavailable");
  }
  try {
    result2.network = await network();
    if (!result2.network.length) result2.errors.push("network_sensor_unavailable");
  } catch {
    result2.errors.push("network_sensor_unavailable");
  }
  await sampling;
  signal?.throwIfAborted();
  result2.observedAt = (/* @__PURE__ */ new Date()).toISOString();
  return result2;
}
var exec, numeric;
var init_local_telemetry = __esm({
  "src/adapters/local-telemetry.ts"() {
    "use strict";
    exec = promisify(execFile);
    numeric = (value2, divisor = 1) => {
      const n = Number(value2.trim());
      return value2.trim() && Number.isFinite(n) && n >= 0 ? n / divisor : void 0;
    };
  }
});

// src/execution/runner.ts
import { readFile as readFile2 } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

// src/execution/workspace.ts
import path from "node:path";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
var MAX_FILE_BYTES = 5e5;
var EXCLUDED = /* @__PURE__ */ new Set([".git", "node_modules", ".venv", "venv", ".next", "dist", "build", ".ssh", ".aws", ".azure", ".gnupg", ".cloudflared", ".codex"]);
var sha256 = (value2) => createHash("sha256").update(value2).digest("hex");
function protectedPath(relative) {
  return relative.split(/[\\/]/).some((part) => EXCLUDED.has(part) || /^\.env(?:\.|$)/i.test(part) && !/^\.env\.(?:example|sample|template)$/i.test(part) || /^(?:id_rsa|id_ed25519|credentials|auth\.json|secrets?\.(?:json|ya?ml|toml))$/i.test(part) || /\.(?:pem|p12|pfx|key)$/i.test(part));
}
function relativePath(value2, label = "path") {
  if (typeof value2 !== "string" || !value2 || value2.length > 4096 || value2.includes("\0") || path.isAbsolute(value2) || value2.includes("\\") || value2.split("/").includes("..") || protectedPath(value2)) {
    throw new Error(`Invalid ${label}: it must stay inside the configured workspace and cannot include protected credentials.`);
  }
  return value2;
}
async function workspaceRoot(configuredRoot, workspace = ".") {
  if (!path.isAbsolute(configuredRoot)) throw new Error("The operator must configure an absolute workspace root.");
  relativePath(workspace, "workspace");
  const root = await realpath(configuredRoot), target = path.resolve(root, workspace);
  const check = new Workspace(root, new AbortController().signal);
  await check.resolve(workspace);
  if (!(await lstat(target)).isDirectory()) throw new Error("Configured workspace is not a directory.");
  return target;
}
var Workspace = class {
  root;
  signal;
  constructor(root, signal) {
    this.root = root;
    this.signal = signal;
  }
  async resolve(relative, missing = false) {
    this.signal.throwIfAborted();
    relativePath(relative);
    const root = await realpath(this.root), target = path.resolve(root, relative);
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error("Path escapes the workspace.");
    let cursor = root;
    for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part);
      try {
        if ((await lstat(cursor)).isSymbolicLink()) throw new Error("Symlinks are not allowed in workspace tools.");
      } catch (error) {
        if (missing && error.code === "ENOENT") break;
        throw error;
      }
    }
    return target;
  }
  async read(relative) {
    const target = await this.resolve(relative), handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error("Only text files up to 500 KB are supported.");
      const value2 = await handle.readFile("utf8");
      if (value2.includes("\0")) throw new Error("Binary files are not text context.");
      return value2;
    } finally {
      await handle.close();
    }
  }
  async list(directory = ".") {
    const start = await this.resolve(directory), files = [];
    let directories = 0, truncated = false;
    const visit = async (folder, depth) => {
      this.signal.throwIfAborted();
      if (depth > 12 || directories++ >= 2e3 || files.length >= 500) {
        truncated = true;
        return;
      }
      for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (files.length >= 500) {
          truncated = true;
          break;
        }
        const absolute = path.join(folder, entry.name), relative = path.relative(this.root, absolute).split(path.sep).join("/");
        if (entry.isSymbolicLink() || protectedPath(relative)) continue;
        if (entry.isDirectory() && !entry.name.startsWith(".")) await visit(absolute, depth + 1);
        else if (entry.isFile()) files.push(relative);
      }
    };
    await visit(start, 0);
    return { files, truncated };
  }
  async write(relative, after, expectedBefore) {
    if (typeof after !== "string" || after.includes("\0") || Buffer.byteLength(after) > MAX_FILE_BYTES) throw new Error("Invalid text content or file too large.");
    const target = await this.resolve(relative, true);
    let before;
    try {
      before = await this.read(relative);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (before !== expectedBefore) throw new Error("File changed during approval. Read it again before writing.");
    await mkdir(path.dirname(target), { recursive: true });
    await this.resolve(relative, true);
    const flags = constants.O_RDWR | (constants.O_NOFOLLOW ?? 0) | (before === void 0 ? constants.O_CREAT | constants.O_EXCL : 0);
    const handle = await open(target, flags, 384);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink > 1) throw new Error("Writing non-regular or hard-linked files is not allowed.");
      if (before !== void 0 && (stat.size > MAX_FILE_BYTES || await handle.readFile("utf8") !== before)) throw new Error("File changed before the write.");
      const bytes = Buffer.from(after);
      let offset = 0;
      while (offset < bytes.length) {
        this.signal.throwIfAborted();
        const written = await handle.write(bytes, offset, bytes.length - offset, offset);
        if (!written.bytesWritten) throw new Error("Incomplete write.");
        offset += written.bytesWritten;
      }
      await handle.truncate(bytes.length);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
};

// src/execution/local.ts
import { lstat as lstat2, mkdir as mkdir2, realpath as realpath2 } from "node:fs/promises";
import path2 from "node:path";

// src/execution/process.ts
import { spawn } from "node:child_process";
import { createHash as createHash2 } from "node:crypto";
var MAX_OUTPUT = 96e3;
function cleanEnvironment() {
  const env = {};
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "SystemRoot", "COMSPEC", "PATHEXT"]) {
    if (process.env[key] !== void 0) env[key] = process.env[key];
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_CONFIG_NOSYSTEM = "1";
  return env;
}
async function runProcess(argv, options) {
  if (!argv.length || argv.length > 100 || argv.some((v) => typeof v !== "string" || v.length > 16384 || v.includes("\0")) || !argv[0]) throw new Error("Invalid configured command argv.");
  options.signal.throwIfAborted();
  const timeoutMs = options.timeoutMs ?? 9e4;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 18e5) throw new Error("Invalid execution timeout.");
  return await new Promise((resolve, reject) => {
    const startedAt = (/* @__PURE__ */ new Date()).toISOString();
    const child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      shell: false,
      env: cleanEnvironment(),
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"]
    });
    let output = "", size = 0, timedOut = false, cancelled = false, stopping = false;
    const digest = createHash2("sha256");
    const append = (chunk) => {
      size += chunk.length;
      digest.update(chunk);
      const text = chunk.toString("utf8");
      output = (output + text).slice(-MAX_OUTPUT);
      options.onData?.(text);
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      const pid = child.pid;
      if (pid && process.platform !== "win32") {
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
        }
        const escalation = setTimeout(() => {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
          }
        }, 500);
        escalation.unref();
      } else child.kill("SIGKILL");
    };
    const onAbort = () => {
      cancelled = true;
      stop();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    options.signal.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.stdin.on("error", () => {
    });
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (code, signal) => {
      cleanup();
      resolve({
        ok: code === 0 && !timedOut && !cancelled,
        output,
        exitCode: code,
        signal,
        timedOut,
        cancelled,
        truncated: size > MAX_OUTPUT,
        outputSha256: digest.digest("hex"),
        startedAt,
        finishedAt: (/* @__PURE__ */ new Date()).toISOString()
      });
    });
    child.stdin.end(options.input ?? "");
    if (options.signal.aborted) onAbort();
  });
}

// src/execution/local.ts
function recipe(request, id) {
  const value2 = request.target.commands.find((item) => item.id === id);
  if (!value2) throw new Error("Command recipe is not configured for this target.");
  return value2;
}
async function runRecipe(request, workspace, command) {
  const cwd = await workspace.resolve(command.cwd ?? ".");
  request.onEvent?.({ type: "execution", targetId: request.target.id, kind: command.verification ? "verify" : "command", message: command.label });
  const result2 = await runProcess(command.argv, { cwd, signal: request.signal, timeoutMs: command.timeoutMs });
  return { ok: result2.ok, output: result2.output, exitCode: result2.exitCode, evidence: [{ ...result2, output: void 0, kind: command.verification ? "verification" : "command", targetId: request.target.id, workspace: request.workspace ?? ".", recipeId: command.id }] };
}
async function approval(request, kind, title, detail) {
  request.signal.throwIfAborted();
  const allowed = await request.approve({ kind, title, detail, targetId: request.target.id, workspace: request.workspace ?? ".", digest: sha256(detail) });
  request.signal.throwIfAborted();
  return allowed === true;
}
function result(request, startedAt, output, data) {
  return { ok: true, output, data, evidence: [{ kind: request.operation.kind, targetId: request.target.id, workspace: request.workspace ?? ".", startedAt, finishedAt: (/* @__PURE__ */ new Date()).toISOString(), outputSha256: sha256(output) }] };
}
function denied() {
  return { ok: false, output: "Action denied. Do not retry it through another tool or target.", evidence: [] };
}
async function executeLocal(request) {
  request.signal.throwIfAborted();
  const startedAt = (/* @__PURE__ */ new Date()).toISOString(), op = request.operation;
  if (op.kind === "telemetry") {
    const { collectLocalTelemetry: collectLocalTelemetry2 } = await Promise.resolve().then(() => (init_local_telemetry(), local_telemetry_exports));
    const data = await collectLocalTelemetry2(request.signal);
    return result(request, startedAt, JSON.stringify(data), data);
  }
  if (op.kind === "prepare") {
    if (!path2.isAbsolute(request.target.workspaceRoot)) throw new Error("Configured workspace root must be absolute.");
    const base = await realpath2(request.target.workspaceRoot);
    if (!(await lstat2(base)).isDirectory()) throw new Error("Configured workspace root must already be a directory.");
    const relative = request.workspace ?? ".", guard = new Workspace(base, request.signal), destination = await guard.resolve(relative, true);
    let exists = false;
    try {
      const entry = await lstat2(destination);
      if (!entry.isDirectory()) throw new Error("Project workspace is not a directory.");
      exists = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (exists) return result(request, startedAt, "Workspace already available.", { targetId: request.target.id, workspace: relative, created: false });
    const detail = `Target: ${request.target.id}
Create project workspace: ${relative}
The operator-configured parent must already exist.`;
    if (!await approval(request, "write", `Prepare workspace ${relative}`, detail)) return denied();
    await guard.resolve(relative, true);
    await mkdir2(destination, { recursive: true, mode: 448 });
    await guard.resolve(relative);
    return result(request, startedAt, "Project workspace prepared.", { targetId: request.target.id, workspace: relative, created: true });
  }
  const root = await workspaceRoot(request.target.workspaceRoot, request.workspace), workspace = new Workspace(root, request.signal);
  if (op.kind === "list") {
    const data = await workspace.list(op.directory);
    return result(request, startedAt, data.files.join("\n") + (data.truncated ? "\n[bounded listing truncated]" : ""), data);
  }
  if (op.kind === "read") {
    const content = await workspace.read(op.path), lines = content.split("\n");
    const start = op.startLine ?? 1, end = op.endLine ?? start + 299;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end - start > 2e3) throw new Error("Invalid bounded line range.");
    const output = `SHA256 ${sha256(content)} \xB7 lines ${start}-${Math.min(end, lines.length)} / ${lines.length}
` + lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join("\n").slice(0, 96e3);
    return result(request, startedAt, output, { sha256: sha256(content), totalLines: lines.length });
  }
  if (op.kind === "search") {
    if (typeof op.query !== "string" || !op.query || op.query.length > 2e3) throw new Error("Search requires 1\u20132000 literal characters.");
    const listing = await workspace.list(op.directory), matches = [];
    for (const file of listing.files) {
      request.signal.throwIfAborted();
      try {
        for (const [index, line] of (await workspace.read(file)).split("\n").entries()) {
          if (line.includes(op.query)) matches.push(`${file}:${index + 1}: ${line.slice(0, 600)}`);
          if (matches.length >= 100) break;
        }
      } catch (error) {
        request.signal.throwIfAborted();
      }
      if (matches.length >= 100) break;
    }
    return result(request, startedAt, matches.join("\n") || "No matches in the bounded scan.", { matches: matches.length, bounded: true });
  }
  if (op.kind === "write") {
    if (typeof op.content !== "string" || Buffer.byteLength(op.content) > MAX_FILE_BYTES || op.content.includes("\0")) throw new Error("Text file exceeds 500 KB or is invalid.");
    await workspace.resolve(op.path, true);
    let before;
    try {
      before = await workspace.read(op.path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (before !== void 0 && op.expectedSha256 === void 0) throw new Error("Modifying an existing file requires expectedSha256 from read_file.");
    if (op.expectedSha256 !== void 0 && op.expectedSha256 !== sha256(before ?? "")) throw new Error("File hash changed. Read the current file before editing.");
    if (before === op.content) return result(request, startedAt, "No change needed.");
    const detail = `Target: ${request.target.id}
Workspace: ${request.workspace ?? "."}
File: ${op.path}

--- Before
${before ?? "(new file)"}

+++ After
${op.content}`;
    if (!await approval(request, "write", `Write ${op.path}`, detail)) return denied();
    await workspace.write(op.path, op.content, before);
    return { ...result(request, startedAt, `Saved ${op.path}; SHA256 ${sha256(op.content)}`), changedFiles: [op.path] };
  }
  if (op.kind === "command" || op.kind === "verify") {
    const command = recipe(request, op.recipeId);
    if (op.kind === "verify" && command.verification !== true) throw new Error("This recipe is not an operator-defined verification.");
    if (op.kind === "command" && !await approval(request, "command", command.label, `Target: ${request.target.id}
Workspace: ${request.workspace ?? "."}
Recipe: ${command.id}
Argv: ${JSON.stringify(command.argv)}
Directory: ${command.cwd ?? "."}`)) return denied();
    return await runRecipe(request, workspace, command);
  }
  if (op.kind === "deploy") {
    const deployment = request.target.deployments?.find((item) => item.id === op.recipeId);
    if (!deployment) throw new Error("Deployment recipe is not configured.");
    return await deploy(request, workspace, deployment, startedAt);
  }
  throw new Error("Unsupported operation.");
}
async function checkHealth(request, deployment) {
  const health = deployment.health, url = new URL(health.url);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error("Invalid operator-configured health URL.");
  const attempts = Math.max(1, Math.min(10, health.attempts ?? 3));
  let status, detail = "";
  for (let i = 0; i < attempts; i++) {
    request.signal.throwIfAborted();
    try {
      const response = await fetch(url, { redirect: "error", signal: AbortSignal.any([request.signal, AbortSignal.timeout(Math.max(100, Math.min(3e4, health.timeoutMs ?? 5e3)))]) });
      status = response.status;
      let matches = true;
      if (health.expectedText) {
        if (!response.body) matches = false;
        else {
          const reader = response.body.getReader(), decoder = new TextDecoder();
          let text = "", bytes = 0;
          try {
            while (true) {
              const part = await reader.read();
              if (part.done) break;
              bytes += part.value.byteLength;
              if (bytes > 1e6) throw new Error("Health response too large.");
              text += decoder.decode(part.value, { stream: true });
            }
            text += decoder.decode();
            matches = text.includes(health.expectedText);
          } finally {
            await reader.cancel().catch(() => {
            });
          }
        }
      } else await response.body?.cancel();
      if (status === (health.expectedStatus ?? 200) && matches) return { ok: true, status, output: `Health verified: HTTP ${status}.` };
      detail = `Health mismatch: HTTP ${status}${!matches ? ", expected text absent" : ""}.`;
    } catch (error) {
      request.signal.throwIfAborted();
      detail = `Health check failed: ${error instanceof Error ? error.message : "request error"}`;
    }
    if (i + 1 < attempts) await new Promise((resolve, reject) => {
      const timer = setTimeout(done, 300);
      function done() {
        request.signal.removeEventListener("abort", abort);
        resolve();
      }
      function abort() {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", abort);
        reject(request.signal.reason);
      }
      request.signal.addEventListener("abort", abort, { once: true });
    });
  }
  return { ok: false, status, output: detail };
}
async function deploy(request, workspace, deployment, startedAt) {
  if (!deployment.verify.length || !deployment.steps.length) throw new Error("A deployment requires verification and deployment steps.");
  for (const id of deployment.verify) if (!recipe(request, id).verification) throw new Error("Deployment verification recipes must be explicitly marked verification.");
  for (const id of [...deployment.steps, ...deployment.rollback ?? []]) recipe(request, id);
  const evidence = [], output = [];
  for (const id of deployment.verify) {
    const verified = await runRecipe(request, workspace, recipe(request, id));
    evidence.push(...verified.evidence);
    output.push(`[verify ${id}]
${verified.output}`);
    if (!verified.ok) return { ok: false, output: output.join("\n"), evidence };
  }
  const detail = `Target: ${request.target.id}
Workspace: ${request.workspace ?? "."}
Release: ${deployment.label}
Verification passed: ${deployment.verify.join(", ")}
Steps: ${deployment.steps.map((id) => JSON.stringify(recipe(request, id).argv)).join("\n")}
Health: ${deployment.health.url}
Rollback on failure: ${(deployment.rollback ?? []).join(", ") || "not configured"}`;
  if (!await approval(request, "deployment", `Deploy ${deployment.label}`, detail)) return { ...denied(), evidence };
  let ok = true, healthStatus, rollback = "not-needed";
  try {
    for (const id of deployment.steps) {
      const step = await runRecipe(request, workspace, recipe(request, id));
      evidence.push(...step.evidence);
      output.push(`[deploy ${id}]
${step.output}`);
      if (!step.ok) {
        ok = false;
        break;
      }
    }
    if (ok) {
      const health = await checkHealth(request, deployment);
      ok = health.ok;
      healthStatus = health.status;
      output.push(health.output);
    }
  } catch (error) {
    ok = false;
    output.push(error instanceof Error ? error.message : "Deployment interrupted.");
  }
  if (!ok) {
    rollback = deployment.rollback?.length ? "succeeded" : "not-configured";
    const cleanupSignal = AbortSignal.timeout(9e4), cleanup = { ...request, signal: cleanupSignal };
    for (const id of deployment.rollback ?? []) {
      try {
        const step = await runRecipe(cleanup, new Workspace(workspace.root, cleanupSignal), recipe(request, id));
        evidence.push(...step.evidence);
        output.push(`[rollback ${id}]
${step.output}`);
        if (!step.ok) rollback = "failed";
      } catch (error) {
        rollback = "failed";
        output.push(`Rollback error: ${error instanceof Error ? error.message : "unknown"}`);
      }
    }
  }
  evidence.push({ kind: "deployment", targetId: request.target.id, workspace: request.workspace ?? ".", recipeId: deployment.id, startedAt, finishedAt: (/* @__PURE__ */ new Date()).toISOString(), healthStatus, healthUrl: deployment.health.url, rollback, cancelled: request.signal.aborted });
  return { ok, output: output.join("\n").slice(-96e3), evidence };
}

// src/execution/runner.ts
async function startRunner(argv = process.argv.slice(2)) {
  const configIndex = argv.indexOf("--config"), targetIndex = argv.indexOf("--target");
  if (configIndex < 0 || targetIndex < 0 || !argv[configIndex + 1] || !argv[targetIndex + 1]) throw new Error("Runner requires --config and --target.");
  const raw = await readFile2(argv[configIndex + 1], "utf8");
  if (Buffer.byteLength(raw) > 1e6) throw new Error("Node configuration exceeds limit.");
  const config = JSON.parse(raw);
  const configured = config.targets?.find((target2) => target2.id === argv[targetIndex + 1]);
  if (!configured) throw new Error("Execution target not present in the node configuration.");
  const target = { ...configured, kind: "local" };
  const controller = new AbortController();
  let started = false, finished = false;
  const pending = /* @__PURE__ */ new Map();
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
  const cancel = () => {
    controller.abort(new Error("Control-plane connection closed."));
    for (const resolve of pending.values()) resolve(false);
    pending.clear();
  };
  process.once("SIGTERM", cancel);
  process.once("SIGINT", cancel);
  rl.on("close", () => {
    if (!finished) cancel();
  });
  await new Promise((resolve, reject) => {
    rl.on("line", (line) => {
      if (finished) return;
      if (Buffer.byteLength(line) > 2e6) {
        cancel();
        reject(new Error("Runner frame exceeds limit."));
        return;
      }
      let frame;
      try {
        const value2 = JSON.parse(line);
        if (!value2 || typeof value2 !== "object" || Array.isArray(value2)) throw new Error("Invalid runner frame.");
        frame = value2;
      } catch (error) {
        cancel();
        reject(error);
        return;
      }
      if (frame.type === "approval" && typeof frame.id === "string") {
        pending.get(frame.id)?.(frame.approved === true);
        return;
      }
      if (frame.type !== "start" || started) {
        cancel();
        reject(new Error("Expected exactly one start frame."));
        return;
      }
      started = true;
      if (typeof frame.workspace !== "string" || !frame.operation || typeof frame.operation !== "object") {
        cancel();
        reject(new Error("Invalid execution request."));
        return;
      }
      const approve = (approval2) => new Promise((approvalResolve) => {
        const id = randomUUID();
        const cleanup = (allowed) => {
          clearTimeout(timer);
          pending.delete(id);
          controller.signal.removeEventListener("abort", abort);
          approvalResolve(allowed && !controller.signal.aborted);
        };
        const abort = () => cleanup(false), timer = setTimeout(() => cleanup(false), 3e5);
        pending.set(id, cleanup);
        controller.signal.addEventListener("abort", abort, { once: true });
        send({ type: "approval", id, approval: approval2 });
      });
      void executeLocal({ target, workspace: frame.workspace, operation: frame.operation, signal: controller.signal, approve, onEvent: (event) => send({ type: "event", event }) }).then((result2) => {
        finished = true;
        send({ type: "result", result: result2 });
        rl.close();
        process.stdin.pause();
        resolve();
      }).catch((error) => {
        finished = true;
        rl.close();
        process.stdin.pause();
        reject(error);
      });
    });
  });
}

// src/execution/runner-entry.ts
startRunner().catch((error) => {
  process.stdout.write(JSON.stringify({ type: "error", error: error instanceof Error ? error.message : "Runner failed." }) + "\n", () => process.exit(1));
});
