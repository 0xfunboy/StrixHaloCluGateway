import type { Bootstrap, Project, Run } from '../src/contracts.ts';

export type ActivityDestination = 'knowledge' | 'orchestrator' | 'models' | 'team' | 'evidence';
export interface ActivityOptions {
  project?: Project;
  run?: Run;
  routeLabel?: string;
  serviceReply?: boolean;
  expanded?: boolean;
  onSelect(destination: ActivityDestination): void;
}

const working = new Set(['planning', 'executing', 'reviewing', 'verifying', 'deploying']);
const phases: Record<string, string> = {
  queued: 'In attesa di risorse', planning: 'Organizza il lavoro', executing: 'Attività in esecuzione',
  reviewing: 'Revisione del risultato', verifying: 'Verifiche in corso', deploying: 'Rilascio in corso',
  awaiting_release: 'Consegna pronta', succeeded: 'Attività completata', failed: 'Serve un intervento',
  paused: 'Attività in pausa', interrupted: 'Attività interrotta', cancelled: 'Attività annullata',
};

/** A view of observed state, never a simulated progress indicator. */
export function activityView(document: Document, data: Bootstrap, options: ActivityOptions): HTMLElement {
  const create = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] => {
    const element = document.createElement(tag); element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const run = options.run;
  const waiting = !!run?.phase.startsWith('Attesa modello') && !run.tasks.some(task => task.status === 'running');
  const active = !!run && working.has(run.status) && !waiting;
  const sources = new Set(run?.tasks.flatMap(task => task.context?.sources.filter(source => source.included).map(source => source.id) ?? []) ?? []);
  const memories = data.memories.filter(memory => memory.projectId === options.project?.id && memory.status === 'approved').length;
  const files = data.artifacts.filter(artifact => artifact.projectId === options.project?.id && artifact.kind === 'attachment').length;
  const running = run?.tasks.filter(task => task.status === 'running').length ?? 0;
  const done = run?.tasks.filter(task => task.status === 'succeeded').length ?? 0;
  const evidence = data.evidence.filter(item => item.runId === run?.id);
  const usedRoutes = [...new Set(run?.tasks.filter(task => task.status === 'running').map(task => task.routeId) ?? [])];
  const modelLabels = usedRoutes.map(id => data.models.find(model => model.id === id)?.label ?? 'Modello precedente');
  const title = waiting ? run!.phase : run ? phases[run.status] ?? run.phase : 'Il tuo sistema, pronto a lavorare';
  const section = create('section', `hud-activity ${options.expanded ? 'expanded' : ''}`);
  section.dataset.phase = waiting ? 'queued' : run?.status ?? 'idle';
  section.setAttribute('aria-label', 'Flusso osservato di contesto, orchestratore, modelli, agenti ed evidenze');
  const head = create('header', 'hud-section-head');
  const caption = create('span', 'hud-section-label', options.expanded ? 'SEC.01 / COMMAND FABRIC' : 'LIVE / COMMAND FABRIC');
  const state = create('span', 'hud-phase', title); state.prepend(create('i', `status-dot ${active ? 'active' : run?.status === 'failed' ? 'error' : ''}`));
  head.append(caption, state);
  const flow = create('div', 'activity-flow');
  const nodes: Array<{ id: ActivityDestination; index: string; label: string; value: string; detail: string; state: string; glyph: string }> = [
    { id: 'knowledge', index: '01', label: 'KNOWLEDGE', value: sources.size ? `${sources.size} fonti incluse` : `${memories + files} risorse`, detail: `${memories} metodi · ${files} documenti`, state: sources.size ? 'linked' : '', glyph: '▤' },
    { id: 'orchestrator', index: '02', label: 'ORCHESTRATORE', value: options.serviceReply ? 'Risposta del servizio' : waiting ? 'Attende una risorsa' : run ? run.mode === 'chat' ? 'Risposta diretta' : 'Coordina la squadra' : 'In ascolto', detail: title, state: active ? 'live' : waiting || run?.status === 'queued' ? 'waiting' : '', glyph: '◈' },
    { id: 'models', index: '03', label: 'INFERENZA', value: options.serviceReply ? 'Nessuna inferenza' : modelLabels[0] ?? options.routeLabel ?? 'Scegli un modello', detail: options.serviceReply ? 'Risposta deterministica del servizio' : modelLabels.length > 1 ? `${modelLabels.length} modelli coinvolti` : 'Modello e account selezionati', state: '', glyph: '⬡' },
    { id: 'team', index: '04', label: 'AGENTI', value: running ? `${running} al lavoro` : run?.tasks.length ? `${done}/${run.tasks.length} completati` : 'Su richiesta', detail: run?.mode === 'chat' ? 'Chat diretta, senza pianificazione' : 'Dipendenze e controllo dei task', state: active && running ? 'live' : '', glyph: '⌘' },
    { id: 'evidence', index: '05', label: 'EVIDENZE', value: evidence.length ? `${evidence.filter(item => item.ok).length}/${evidence.length} positive` : 'Nessuna verifica', detail: run?.releasedAt ? 'Rilascio registrato' : 'Test, review e risultati reali', state: run?.status === 'verifying' || run?.status === 'deploying' ? 'live' : '', glyph: '✓' },
  ];
  for (const node of nodes) {
    const button = create('button', `activity-node ${node.state}`);
    button.type = 'button'; button.dataset.activityNode = node.id;
    button.setAttribute('aria-label', `${node.label}: ${node.value}. ${node.detail}`);
    const label = create('span', 'activity-node-label', node.label); label.prepend(create('span', 'activity-index', node.index));
    const symbol = create('span', 'activity-glyph', node.glyph); symbol.setAttribute('aria-hidden', 'true');
    const copy = create('span', 'activity-copy'); copy.append(create('strong', '', node.value), create('small', '', node.detail));
    button.append(label, symbol, copy);
    button.addEventListener('click', () => options.onSelect(node.id));
    flow.append(button);
  }
  const footer = create('footer', 'activity-caption');
  footer.append(create('span', '', data.demo ? 'DATI DI ESEMPIO' : 'STATO OSSERVATO DAL COORDINATOR'), create('span', '', run ? `RUN ${run.id.slice(-8).toUpperCase()}` : 'L’attività compare quando avvii una richiesta'));
  section.append(head, flow, footer);
  return section;
}
