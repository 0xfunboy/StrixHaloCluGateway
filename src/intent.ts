import type { RequestedMode } from './contracts.ts';

export type ServiceIntent = 'greeting' | 'thanks' | 'presence' | 'help' | 'status' | 'models';
export interface RequestIntent {
  mode: 'chat' | 'mission';
  kind: 'conversation' | 'work' | 'service';
  reason: string;
  service?: ServiceIntent;
}

/** Conservative, deterministic dispatch. This module is shared with the UI.
 * It selects a workflow, never grants tool or deployment permissions. */
export function classifyRequest(text: string, options: { mode?: RequestedMode; attachmentCount?: number } = {}): RequestIntent {
  if (options.mode === 'mission') return { mode: 'mission', kind: 'work', reason: 'Squadra selezionata esplicitamente.' };
  const value = text.normalize('NFKC').trim().toLocaleLowerCase('it-IT').replace(/[?!.,;:]+$/u, '').replace(/\s+/gu, ' ');
  if (!options.attachmentCount && value.length < 160) {
    const patterns: Array<[ServiceIntent, RegExp]> = [
      ['greeting', /^(?:(?:ciao|salve|buongiorno|buonasera|hey|ehi|hello|hi)(?: yed1z)?(?:[,! ]+)?(?:come (?:stai|va)|how are you)?|come (?:stai|va)|how are you)$/u],
      ['thanks', /^(?:grazie(?: mille| di tutto)?|thank you|thanks|perfetto grazie)$/u],
      ['presence', /^(?:ci sei|sei (?:qui|online|disponibile)|are you there|are you online)$/u],
      ['help', /^(?:aiuto|help|cosa (?:puoi|sai) fare|come funzioni|what can you do)$/u],
      ['status', /^(?:a che punto (?:sei|siamo)|stato(?: della missione| dei lavori| degli agenti)?|come procede|che cosa stai facendo|cosa stai facendo|status|what are you working on)$/u],
      ['models', /^(?:quali modelli (?:hai|ci sono|sono disponibili|sono liberi)|modelli disponibili|which models are available)$/u]
    ];
    for (const [service, pattern] of patterns) if (pattern.test(value)) return { mode: 'chat', kind: 'service', service, reason: 'Risposta diretta del servizio: nessuna inferenza o esecuzione.' };
  }
  if (options.mode === 'chat') return { mode: 'chat', kind: 'conversation', reason: 'Conversazione selezionata esplicitamente.' };
  const directive = /^(?:(?:per favore|per piacere|please)\s+)?(?:(?:puoi|potresti|riesci a|can you|could you)\s+)?(?:implement(?:a|are)?|crea(?:mi|re)?|realizza(?:re)?|sviluppa(?:re)?|corregg(?:i|ere)|sistema(?:re)?|ripara(?:re)?|aggiorna(?:re)?|rifai|riprogetta(?:re)?|refactor(?:izza|are)?|aggiung(?:i|ere)|rimuov(?:i|ere)|modifica(?:re)?|esegui|testa|rilascia|pubblica|distribuisci|deploy|build|fix|create|develop|update|add|remove|ship)\b/u;
  const desiredWork = /^(?:voglio|vorrei|ho bisogno di)\s+(?:che tu\s+)?(?:creare|realizzare|sviluppare|implementare|correggere|aggiornare|rifare|riprogettare|rilasciare)\b/u;
  if (directive.test(value) || desiredWork.test(value)) return { mode: 'mission', kind: 'work', reason: 'Richiesta esplicita di modifica o esecuzione.' };
  return { mode: 'chat', kind: 'conversation', reason: 'Domanda o conversazione: una risposta, senza pianificazione della squadra.' };
}
