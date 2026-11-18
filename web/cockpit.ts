import type { Appearance, NetworkLink, NodeConfig, Telemetry } from '../src/contracts.ts';
import { createAppearance } from './appearance.ts';
type Engine = { id: string; label: string; nodeIds: string[]; status: string; switchable: boolean; canStop?: boolean };
interface Snapshot {
    nodes: NodeConfig[]; links: NetworkLink[]; telemetry: Telemetry[]; engines: Engine[];
    stats: { totals: { total_tokens: number | null; total_requests: number }; latest?: { ttft_ms?: number; decode_tps?: number } };
}
const field = (id: string) => document.getElementById(id)!;
const el = (tag: string, value = '', className = '') => { const e = document.createElement(tag); e.textContent = value; e.className = className; return e; };
const measure = (n: number | null | undefined, unit = '', scale = 1) => typeof n === 'number' && Number.isFinite(n) ? (n / scale).toLocaleString('it-IT', { maximumFractionDigits: 1 }) + unit : '—';
const theme = field('theme') as HTMLSelectElement;
const effects = field('effects') as HTMLButtonElement;
const appearance = createAppearance(window, enabled => {
    effects.textContent = enabled ? 'FX ON' : 'FX OFF';
    effects.setAttribute('aria-pressed', String(enabled));
    effects.disabled = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    effects.title = effects.disabled ? 'Il sistema richiede movimento ridotto.' : 'Effetti visivi';
});
let appearanceRevision = 0;
let appearanceQueue = Promise.resolve();
function changeAppearance(change?: Appearance) {
    if (change) { appearanceRevision++; appearance.update(change); }
    const revision = appearanceRevision;
    theme.value = appearance.value.theme;
    appearanceQueue = appearanceQueue.then(async () => {
        try {
            const options = change ? { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(change) } : { cache: 'no-store' as const };
            const response = await fetch('/api/me/appearance', options);
            const saved = response.ok ? await response.json() as Appearance : undefined;
            if (saved && revision === appearanceRevision) {
                appearance.update(saved);
                theme.value = appearance.value.theme;
            }
        } catch { /* Signed-out and disconnected monitors retain the local appearance. */ }
    });
}
theme.onchange = () => changeAppearance({ theme: theme.value as Appearance['theme'] });
effects.onclick = () => changeAppearance({ motion: appearance.value.motion === 'on' ? 'off' : 'on' });
window.addEventListener('storage', () => { theme.value = appearance.value.theme; });
changeAppearance();
const status: Record<string,string> = { online:'In linea', offline:'Fuori linea', unknown:'Da verificare', stale:'Campione precedente', standby:'Motore non pronto', ready:'Pronto' };
function tile(label: string, value: string) { const item = el('div','','metric'); item.append(el('span',label),el('strong',value)); return item; }
let pendingAction='start';
let pending: string | undefined, loading = false, generation = 0, controller: AbortController | undefined;
function summary(data: Snapshot) {
    field('metrics').replaceChildren(tile('Richieste API registrate', measure(data.stats.totals.total_requests)), tile('Token misurati via API', measure(data.stats.totals.total_tokens)),tile('Ultimo primo token', measure(data.stats.latest?.ttft_ms,' ms')),tile('Ultimo decode', measure(data.stats.latest?.decode_tps,' tok/s')));
    field('node-count').textContent = data.nodes.length + ' nodi';
    field('fleet').replaceChildren(...data.nodes.map(node => {
        const t = data.telemetry.find(t => t.nodeId === node.id), tag = t?.status ?? 'unknown';
        const item = el('article'), list = el('dl');
        item.append(el('span',status[tag], 'state ' + tag),el('h3',node.label),list);
        for (const [label,value] of [['CPU',measure(t?.cpuPercent,'%')],['GPU',measure(t?.gpuPercent,'%')],['Temperatura GPU',measure(t?.gpuTempC,' °C')],['Potenza GPU',measure(t?.gpuPowerW,' W')],['RAM usata',measure(t?.ramUsedBytes,' GiB',2**30)],['RAM totale',measure(t?.ramTotalBytes,' GiB',2**30)],['VRAM usata',measure(t?.gpuMemoryUsedBytes,' GiB',2**30)]]) list.append(el('dt',label),el('dd',value));
        if (t?.observedAt) item.append(el('small',new Date(t.observedAt).toLocaleTimeString('it-IT')));
        return item;
    }));
    field('links').replaceChildren(...data.links.map(l => el('span',l.from + ' ↔ ' + l.to + ' · ' + l.label)));
    const parent = field('engines');
    for (const engine of data.engines) {
        let row = Array.from(parent.children).find(r => (r as HTMLElement).dataset.engine === engine.id) as HTMLElement | undefined;
        if (!row) {
            row = el('div','','engine'); row.dataset.engine = engine.id;
            row.append(el('strong',engine.label),el('span','','state'));
            if (engine.switchable) { const b = el('button','Attiva') as HTMLButtonElement; b.onclick = () => void activate(engine.id); row.append(b); }
            if (engine.canStop) { const b=el('button','Arresta') as HTMLButtonElement; b.onclick=()=>void activate(engine.id,'stop'); row.append(b); }
            parent.append(row);
        }
        const state = row.children[1]; state.textContent = status[engine.status] ?? engine.status; state.className = 'state ' + engine.status;
    }
    field('stamp').textContent = 'Aggiornato alle ' + new Date().toLocaleTimeString('it-IT');
}
async function refresh() {
    if (loading) return; loading = true;
    try { const r = await fetch('/api/dashboard',{cache:'no-store'}); if (r.status === 401) field('access').hidden = false;
        if (!r.ok) throw Error('Monitor in attesa del collegamento'); summary(await r.json()); }
    catch (e) { field('stamp').textContent = (e as Error).message; } finally { loading = false; }
}
async function activate(id: string, action='start') {
    if (controller) return;
    controller = new AbortController();
    const n = ++generation; field('feedback').textContent = 'Verifica e prenotazione del motore…';
    try {
        const r = await fetch('/api/switch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({providerId:id,action}),signal:controller.signal});
        if (r.status === 401) { pending = id; pendingAction=action; field('access').hidden = false; field('credential').focus(); field('feedback').textContent = 'Accedi per attivare il motore.'; return; }
        const data = await r.json(); if (!r.ok) throw Error(data.error);
        field('feedback').textContent = data.stopped ? 'Motore arrestato' : 'Motore pronto · ' + data.model; await refresh();
    } catch(e) { if (n === generation) field('feedback').textContent = (e as Error).message; } finally { controller = undefined; }
}
field('access').onsubmit = async event => {
    event.preventDefault(); const input = field('credential') as HTMLInputElement;
    try { const response = await fetch('/api/auth/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({admin_key:input.value})});
        input.value = ''; const result = await response.json(); if (!response.ok) throw Error(result.error); field('access').hidden = true;
        changeAppearance();
        const id = pending; pending = undefined; if (id) await activate(id,pendingAction); else await refresh();
    } catch(e) { field('feedback').textContent = (e as Error).message; }
};
field('dismiss').onclick = () => { (field('credential') as HTMLInputElement).value = ''; pending = undefined; field('access').hidden = true; };
void refresh(); setInterval(() => { if (!document.hidden) void refresh(); }, 4000);
