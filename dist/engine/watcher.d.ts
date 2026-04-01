import { AnalysisOrchestrator } from './orchestrator.js';
export declare class FileWatcher {
    private orchestrator;
    private rootDir;
    private watcher;
    constructor(orchestrator: AnalysisOrchestrator, rootDir: string);
    start(): Promise<void>;
    private handleChange;
    stop(): Promise<void>;
}
//# sourceMappingURL=watcher.d.ts.map