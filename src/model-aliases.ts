import type { ModelRoute } from './contracts.ts';
import type { Config } from './config.ts';

// Aliases exported by the original gateway, scoped to explicitly configured engine providers.
const legacy: Record<string,string[]> = {
    'strix-qwen':['qwen38-uncensored-gufo','qwen','qwen38','qwen3.8','qwen-38b','qwen38-uncensored'],
    'strix-deepseek':['ds41-abliterated-q2-imatrix','deepseek','deepseek-v4.1','deepseek-v4.1-flash','ds41','ds4.1'],
    'cuda-qwen':['qwen38-strata-100tps','qwen-strata','strata-qwen','qwen38-strata','qwen3.8-flash-next-iq3_s','qwen-100tps','qwen-rtx3090'],
    'cuda-deepseek':['ds41-strata-cuda','ds41-strata','strata-ds41','deepseek-strata','deepseek-v4.1-flash-ist-das-2.00bpw','deepseek-rtx3090','kirei-strata-cuda3090','kirei-strata']
};
export function aliasRoutes(config:Config,models:ModelRoute[]) {
    const aliases = new Map<string,ModelRoute[]>();
    for(const provider of config.providers) {
        const routes=models.filter(m=>m.providerId===provider.id && m.enabled);
        for(const model of provider.models ?? []) {
            const configured=model.aliases ?? (provider.models?.length===1 && provider.tag && ['cluster','local'].includes(provider.tag) ? legacy[provider.id] : []) ?? [];
            for(const alias of configured) {
                const available=routes.filter(m=>m.model===model.model);
                if(available.length) aliases.set(alias,[...(aliases.get(alias) ?? []), ...available]);
            }
        }
    }
    return aliases;
}
