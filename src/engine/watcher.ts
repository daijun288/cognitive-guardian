import * as chokidar from 'chokidar';
import { AnalysisOrchestrator } from './orchestrator.js';
import { readFileSync } from 'fs';
import { resolve } from 'path';

export class FileWatcher {
  private watcher: chokidar.FSWatcher | null = null;

  constructor(private orchestrator: AnalysisOrchestrator, private rootDir: string) {}

  public async start() {
    console.log(`Watching directory: ${this.rootDir}`);
    this.watcher = chokidar.watch(this.rootDir, {
      ignored: [/(^|[\/\\])\../, '**/node_modules/**', '**/dist/**', '**.db'],
      persistent: true,
    });

    this.watcher.on('add', (path: string) => this.handleChange(path));
    this.watcher.on('change', (path: string) => this.handleChange(path));
  }

  private async handleChange(path: string) {
    if (!path.endsWith('.ts') && !path.endsWith('.tsx')) return;
    
    try {
      const fullPath = resolve(path);
      const content = readFileSync(fullPath, 'utf-8');
      await this.orchestrator.analyzeFile(fullPath, content);
      console.log(`Updated graph for: ${path}`);
    } catch (err) {
      console.error(`Error analyzing ${path}:`, err);
    }
  }

  public async stop() {
    await this.watcher?.close();
  }
}
