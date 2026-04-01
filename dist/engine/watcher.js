import * as chokidar from 'chokidar';
import { AnalysisOrchestrator } from './orchestrator.js';
import { readFileSync } from 'fs';
import { resolve } from 'path';
export class FileWatcher {
    orchestrator;
    rootDir;
    watcher = null;
    constructor(orchestrator, rootDir) {
        this.orchestrator = orchestrator;
        this.rootDir = rootDir;
    }
    async start() {
        console.log(`Watching directory: ${this.rootDir}`);
        this.watcher = chokidar.watch(this.rootDir, {
            ignored: [/(^|[\/\\])\../, '**/node_modules/**', '**/dist/**', '**.db'],
            persistent: true,
        });
        this.watcher.on('add', (path) => this.handleChange(path));
        this.watcher.on('change', (path) => this.handleChange(path));
    }
    async handleChange(path) {
        if (!path.endsWith('.ts') && !path.endsWith('.tsx'))
            return;
        try {
            const fullPath = resolve(path);
            const content = readFileSync(fullPath, 'utf-8');
            await this.orchestrator.analyzeFile(fullPath, content);
            console.log(`Updated graph for: ${path}`);
        }
        catch (err) {
            console.error(`Error analyzing ${path}:`, err);
        }
    }
    async stop() {
        await this.watcher?.close();
    }
}
//# sourceMappingURL=watcher.js.map