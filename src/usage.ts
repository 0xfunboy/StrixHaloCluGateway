import type { Conversation, ModelRoute, User } from './contracts.ts';
import type { Store } from './store.ts';

export function accountUsage(store:Store,user:User) {
    const routes=new Map(store.all<ModelRoute>('model').map(m=>[m.id,m.accountId]));
    const rows=store.db.prepare('SELECT account,route,count(*) AS requests,sum(input_tokens) AS inputTokens,sum(output_tokens) AS outputTokens,count(input_tokens) AS measuredRequests FROM inference_usage WHERE owner=? GROUP BY account,route').all(user.id);
    const turns=new Map<string,{account:string;route:string;requests:number;measuredRequests:number;inputTokens:number|null;outputTokens:number|null}>();
    const seen=new Set<string>();
    for(const c of store.all<Conversation>('conversation').filter(c=>c.ownerId===user.id)) {
        for(const m of c.messages) {
            if (m.role!=='assistant' || !m.routeId || m.source==='service' || !m.metrics || seen.has(m.id)) continue;
            seen.add(m.id);
            const row=turns.get(m.routeId) ?? {account:routes.get(m.routeId) ?? '',route:m.routeId,requests:0,measuredRequests:0,inputTokens:null,outputTokens:null};
            row.requests++;
            if(m.metrics.inputTokens!==undefined) { row.measuredRequests++;row.inputTokens=(row.inputTokens ?? 0)+m.metrics.inputTokens; }
            if(m.metrics.outputTokens!==undefined) row.outputTokens=(row.outputTokens ?? 0)+m.metrics.outputTokens;
            turns.set(m.routeId,row);
        }
    }
    const legacy=store.all<{ownerId:string; importedAt:string; totals:Record<string,number>; days:Record<string,unknown>}>('legacy-gateway-usage')
        .filter(receipt=>receipt.ownerId===user.id).map(({importedAt,totals,days})=>({importedAt,source:'legacy-reported',totals,days}));
    const missionCalls = store.db.prepare(`
        SELECT coalesce(json_extract(event.data, '$.data.accountId'), json_extract(model.data, '$.accountId')) AS account,
               json_extract(event.data, '$.data.routeId') AS route,
               count(*) AS requests, count(json_extract(event.data, '$.data.inputTokens')) AS measuredRequests,
               sum(json_extract(event.data, '$.data.inputTokens')) AS inputTokens,
               sum(json_extract(event.data, '$.data.outputTokens')) AS outputTokens
        FROM events AS event
        JOIN entities AS run ON run.id=event.run AND run.kind='run'
        LEFT JOIN entities AS model ON model.id=json_extract(event.data, '$.data.routeId') AND model.kind='model'
        WHERE event.owner=? AND json_extract(event.data, '$.type')='inference.completed'
          AND json_extract(run.data, '$.mode')='mission'
        GROUP BY account, route
        ORDER BY requests DESC, route
    `).all(user.id);
    return { gateway:rows, conversationTurns:[...turns.values()], missionCalls, legacy };
}
