export interface ReaderPassage {
    id: string;
    sourceId: string;
    position: number;
    title: string;
    text: string;
    relatedSources: ReadonlySet<string>;
}
export interface VectorPassage { id: string; vector: number[]; }
export interface SlotAttribution { slot: number; weight: number; }
export interface SemanticSignal { similarity: number; alignment: number; slots: SlotAttribution[]; }
export interface Selection {
    passage: ReaderPassage;
    start: number;
    text: string;
    score: number;
    method: 'lexical' | 'hybrid' | 'vector' | 'related';
    matchingTerms: string[];
    semantic?: SemanticSignal;
    relatedTo?: string;
}

const fold = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
const words = (text: string) => fold(text).match(/[\p{L}\p{N}_]{2,}/gu) ?? [];
const commonWords = new Set(['che', 'come', 'con', 'della', 'delle', 'dove', 'per', 'una', 'uno', 'and', 'can', 'for', 'how', 'the', 'what', 'which', 'with']);
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

export function querySlots(query: string): string[] {
    const full = query.trim();
    const facets = query.split(/[,;?\n]|\b(?:e|and|inoltre|also|plus)\b/giu).map(part => part.trim()).filter(part => words(part).length >= 2);
    const slots = new Map<string, string>();
    for (const clause of [full, ...facets]) {
        const key = words(clause).join(' ');
        if (!slots.has(key)) slots.set(key, clause);
    }
    return [...slots.values()].slice(0, 3);
}

export function unitVector(vector: ArrayLike<number>): Float64Array | undefined {
    let scale = 0;
    for (let i = 0; i < vector.length; i++) {
        if (!Number.isFinite(vector[i])) return undefined;
        scale = Math.max(scale, Math.abs(vector[i]));
    }
    if (!scale) return undefined;
    let squares = 0;
    const result = Float64Array.from(vector, value => { const bounded = value / scale; squares += bounded * bounded; return bounded; });
    return result.map(value => value / Math.sqrt(squares));
}

function dot(left: ArrayLike<number>, right: ArrayLike<number>): number {
    let result = 0;
    for (let i = 0; i < left.length; i++) result += left[i] * right[i];
    return Math.min(1, Math.max(-1, result));
}

/** Stable online softmax mean across all observed vectors. */
export class OnlineMemorySlot {
    private maximum = -Infinity;
    private mass = 0;
    private readonly sum: Float64Array;
    constructor(dimension: number) { this.sum = new Float64Array(dimension); }
    add(logit: number, vector: ArrayLike<number>): void {
        const maximum = Math.max(this.maximum, logit);
        const previousWeight = Math.exp(this.maximum - maximum);
        const nextWeight = Math.exp(logit - maximum);
        this.mass = this.mass * previousWeight + nextWeight;
        for (let i = 0; i < this.sum.length; i++) this.sum[i] = this.sum[i] * previousWeight + vector[i] * nextWeight;
        this.maximum = maximum;
    }
    mean(): Float64Array | undefined {
        return this.mass ? this.sum.map(value => value / this.mass) : undefined;
    }
    contribution(logit: number): number {
        return this.mass ? Math.exp(logit - this.maximum) / this.mass : 0;
    }
}

export function readSemanticSlots(queryVectors: number[][], vectors: () => Iterable<VectorPassage>): Map<string, SemanticSignal> {
    const queries = queryVectors.map(unitVector);
    if (!queries[0] || queries.some(query => !query || query.length !== queries[0]!.length)) return new Map();
    const units = queries as Float64Array[];
    const accumulators = units.map(query => new OnlineMemorySlot(query.length));
    const temperature = 9;
    for (const row of vectors()) {
        const unit = row.vector.length === units[0].length ? unitVector(row.vector) : undefined;
        if (!unit) continue;
        for (const [slot, query] of units.entries()) accumulators[slot].add(dot(query, unit) * temperature, unit);
    }
    const prototypes = accumulators.map(slot => { const mean = slot.mean(); return mean ? unitVector(mean) : undefined; });
    const signals = new Map<string, SemanticSignal>();
    if (prototypes.every(value => !value)) return signals;
    for (const row of vectors()) {
        const unit = row.vector.length === units[0].length ? unitVector(row.vector) : undefined;
        if (!unit) continue;
        const logits = units.map(query => dot(query, unit));
        const similarity = Math.max(...logits);
        const alignment = Math.max(0, ...prototypes.map(prototype => prototype ? dot(prototype, unit) : 0));
        const slots = logits.map((logit, slot) => ({ slot, weight: accumulators[slot].contribution(logit * temperature) }));
        signals.set(row.id, { similarity, alignment, slots });
    }
    return signals;
}

export function selectMemoryPassages(
    passages: ReaderPassage[], query: string, semantic: ReadonlyMap<string, SemanticSignal>, limit: number, maxChars: number,
): { selections: Selection[]; considered: number } {
    const normalizedQuery = fold(query.trim());
    const allTerms = [...new Set(words(query))].slice(0, 24);
    const significant = allTerms.filter(term => !commonWords.has(term));
    const terms = significant.length ? significant : allTerms;
    const frequency = new Map(terms.map(term => [term, 0]));
    const scored = passages.map(passage => {
        const tokens = new Set(words(passage.title + '\n' + passage.text));
        const matchingTerms = terms.filter(term => tokens.has(term));
        for (const term of matchingTerms) frequency.set(term, frequency.get(term)! + 1);
        return {
            passage, matchingTerms, semantic: semantic.get(passage.id), base: 0, lexical: false,
            key: passage.text.replace(/\s+/g, ' ').trim().toLowerCase(),
        };
    });
    const weight = (term: string) => Math.log1p((passages.length + 1) / ((frequency.get(term) ?? 0) + 1));
    const totalWeight = terms.reduce((total, term) => total + weight(term), 0) || 1;
    for (const item of scored) {
        const lexical = item.matchingTerms.reduce((score, term) => score + weight(term), 0) / totalWeight;
        const phrase = normalizedQuery.length > 1 && fold(item.passage.text).includes(normalizedQuery) ? 0.2 : 0;
        const vector = item.semantic && item.semantic.similarity > 0.08 ? 0.37 * item.semantic.similarity + 0.12 * item.semantic.alignment : 0;
        item.base = lexical + phrase + vector;
        item.lexical = lexical > 0 || phrase > 0;
    }
    const usedIds = new Set<string>(), seenText = new Set<string>(), covered = new Set<string>(), sourceCounts = new Map<string, number>();
    const selected: Selection[] = [];
    let usedChars = 0, relatedPassages = 0;
    while (selected.length < limit && usedChars < maxChars) {
        let best: { item: (typeof scored)[number]; rating: number; link?: string; key: string } | undefined;
        for (const item of scored) {
            const passage = item.passage;
            if (usedIds.has(passage.id) || (sourceCounts.get(passage.sourceId) ?? 0) >= 2) continue;
            const key = item.key;
            if (seenText.has(key)) continue;
            const link = selected.find(choice => choice.method !== 'related' && choice.passage.sourceId !== passage.sourceId
                && (passage.relatedSources.has(choice.passage.sourceId) || choice.passage.relatedSources.has(passage.sourceId)))?.passage.sourceId;
            if (!item.base && (!link || relatedPassages >= 1)) continue;
            const novelty = item.matchingTerms.filter(term => !covered.has(term)).length / Math.max(1, terms.length);
            const rating = item.base + 0.1 * novelty + (sourceCounts.has(passage.sourceId) ? -0.12 : 0.05) + (link ? 0.08 : 0);
            if (!best || rating > best.rating || (rating === best.rating && compare(passage.id, best.item.passage.id) < 0)) best = { item, rating, link, key };
        }
        if (!best) break;
        const { passage, matchingTerms, semantic: observed, base } = best.item;
        const available = Math.min(maxChars - usedChars, 1200);
        const lower = fold(passage.text);
        const matchedStarts = matchingTerms.map(term => lower.indexOf(term)).filter(index => index >= 0);
        const relevant = matchedStarts.length ? Math.min(...matchedStarts) : 0;
        const start = Math.min(Math.max(0, relevant - Math.floor(available / 3)), Math.max(0, passage.text.length - available));
        const text = passage.text.slice(start, start + available);
        const method = !base ? 'related' : best.item.lexical ? (observed && observed.similarity > 0.08 ? 'hybrid' : 'lexical') : 'vector';
        if (method === 'related') relatedPassages++;
        selected.push({ passage, start, text, score: best.rating, method, matchingTerms, ...(observed ? { semantic: observed } : {}), ...(best.link ? { relatedTo: best.link } : {}) });
        usedChars += text.length;
        usedIds.add(passage.id);
        seenText.add(best.key);
        sourceCounts.set(passage.sourceId, (sourceCounts.get(passage.sourceId) ?? 0) + 1);
        for (const term of matchingTerms) covered.add(term);
    }
    return { selections: selected, considered: scored.filter(item => item.base > 0).length };
}
