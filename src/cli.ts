import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from './store.ts';
import { Catalog } from './catalog.ts';
import { defaultConfig, loadConfig, type Config } from './config.ts';
import { Scheduler } from './scheduler.ts';
import { importLegacy } from './migration.ts';
import type { Project, Role, User } from './contracts.ts';
import { assert, id, now, safeError } from './util.ts';
function argumentsMap(argv: string[]): Map<string, string> { const map = new Map<string, string>(); for (let i = 0; i < argv.length; i++) {
    assert(argv[i].startsWith('--'), 400, 'ARGUMENT', 'Argomento non valido: ' + argv[i]);
    const key = argv[i].slice(2);
    const value = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? 'true' : argv[++i];
    map.set(key, value);
} return map; }
async function main(): Promise<void> {
    process.umask(0o077);
    const command = process.argv[2] ?? 'help', args = argumentsMap(process.argv.slice(3));
    const directory = path.resolve(args.get('state') ?? process.env.YED1Z_STATE_DIR ?? 'state');
    if (command === 'help') {
        process.stdout.write(`yed1z Control Room 0.4.0\n\nnode dist/cli.mjs init --name funboy [--workspace /path/to/projects] [--config examples/strix-cluster.json] [--state ./state]\nnode dist/cli.mjs user-add --name cooper --role operator\nnode dist/cli.mjs import --database /old/portal.sqlite --legacy-user funboy --user USER_ID --project PROJECT_ID\nnode dist/cli.mjs backup --out /backup/control.sqlite\n\nAvvia: node dist/server.mjs\nLe operazioni CLI sullo stato richiedono il coordinator fermo. Non modificano servizi systemd.\n`);
        return;
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (command === 'init') {
        const file = path.join(directory, 'config.json');
        let config: Config;
        if (existsSync(file))
            config = loadConfig(file);
        else {
            config = args.has('config') ? loadConfig(path.resolve(args.get('config')!)) : defaultConfig();
            if (args.has('workspace')) {
                const root = path.resolve(args.get('workspace')!);
                assert(statSync(root).isDirectory(), 400, 'WORKSPACE', 'La directory workspace deve esistere.');
                config.targets.push({ id: 'coordinator', kind: 'local', nodeId: 'strix01', workspaceRoot: root, commands: [{ id: 'npm-test', label: 'Test npm', argv: ['npm', 'test'], verification: true, timeoutMs: 120000 }, { id: 'npm-build', label: 'Build npm', argv: ['npm', 'run', 'build'], verification: true, timeoutMs: 120000 }] });
            }
            writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        }
        const store = new Store(directory);
        try {
            let owner = store.all<User>('user').find(u => u.role === 'admin');
            if (!owner) {
                const created = store.createUser(args.get('name') ?? 'funboy', 'admin');
                owner = created.user;
                process.stdout.write(`Utente: ${owner.id}\nChiave di accesso (mostrata una volta): ${created.token}\n`);
            }
            else
                process.stdout.write(`Amministratore già presente: ${owner.name}. Chiave e dati preservati.\n`);
            const catalog = new Catalog(store, config, new Scheduler(config.resourceGroups));
            catalog.seed(owner);
            if (!store.all<Project>('project').length) {
                const p: Project = { id: id('prj'), ownerId: owner.id, memberIds: [], name: 'Il mio progetto', description: 'Definisci obiettivo, criteri di verifica e destinazione del rilascio.', routes: {}, verifyRecipeIds: [], createdAt: now(), updatedAt: now() };
                if (config.targets[0]) {
                    p.targetId = config.targets[0].id;
                    p.workspace = '.';
                }
                store.put('project', p);
            }
            process.stdout.write(`Configurazione: ${file}\nAvvio: YED1Z_STATE_DIR=${directory} node dist/server.mjs\nURL locale: http://${config.bind}:${config.port}\n`);
        }
        finally {
            store.close();
        }
        return;
    }
    const store = new Store(directory);
    try {
        if (command === 'user-add') {
            const role = args.get('role') ?? 'member';
            assert(['admin', 'operator', 'member', 'viewer'].includes(role), 400, 'ROLE', 'Ruolo non valido.');
            const created = store.createUser(args.get('name') ?? 'utente', role as Role);
            process.stdout.write(`Utente: ${created.user.id}\nRuolo: ${role}\nChiave (una sola visualizzazione): ${created.token}\n`);
        }
        else if (command === 'backup') {
            const destination = path.resolve(args.get('out') ?? 'control-backup.sqlite');
            assert(!existsSync(destination), 409, 'EXISTS', 'Destinazione già esistente.');
            await store.backup(destination);
            process.stdout.write(`Backup DB: ${destination}\nConserva separatamente master.key, accounts/, artifacts/ e config.json con permessi privati.\n`);
        }
        else if (command === 'import') {
            assert(args.get('database') && args.get('legacy-user') && args.get('user') && args.get('project'), 400, 'ARGUMENT', 'Servono --database --legacy-user --user --project.');
            const owner = store.require<User>('user', args.get('user')!);
            const result = importLegacy({ store, databasePath: path.resolve(args.get('database')!), owner, projectId: args.get('project')!, legacyOwner: args.get('legacy-user')! });
            process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        }
        else
            throw new Error('Comando sconosciuto. Usa help.');
    }
    finally {
        store.close();
    }
}
if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
    main().catch(error => { process.stderr.write(safeError(error) + '\n'); process.exitCode = 1; });
