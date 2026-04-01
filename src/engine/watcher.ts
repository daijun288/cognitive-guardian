import * as chokidar from 'chokidar';
import { AnalysisOrchestrator } from './orchestrator.js';
import { readFileSync } from 'fs';
import { resolve } from 'path';

export class FileWatcher {
  private watcher: chokidar.FSWatcher | null = null;
  private changeTimeout: NodeJS.Timeout | null = null;
  private pendingFiles = new Set<string>();

  constructor(private orchestrator: AnalysisOrchestrator, private rootDir: string) {}

  public async start() {
    console.log(`Watching directory: ${this.rootDir}`);
    this.watcher = chokidar.watch(this.rootDir, {
      ignored: [/(^|[\/\\])\../, '**/node_modules/**', '**/dist/**', '**.db'],
      persistent: true,
    });

    this.watcher.on('add', (path: string) => this.queueChange(path));
    this.watcher.on('change', (path: string) => this.queueChange(path));
    this.watcher.on('unlink', (path: string) => this.handleDelete(path));
  }

  private isCodeFile(path: string): boolean {
    const ext = path.substring(path.lastIndexOf('.')).toLowerCase();
    return ['.ts', '.tsx', '.java', '.js', '.vue', '.xml'].includes(ext);
  }

  private queueChange(path: string) {
    if (!this.isCodeFile(path)) return;
    this.pendingFiles.add(path);
    
    if (this.changeTimeout) {
      clearTimeout(this.changeTimeout);
    }
    
    this.changeTimeout = setTimeout(async () => {
      const filesToProcess = Array.from(this.pendingFiles);
      this.pendingFiles.clear();
      
      for (const p of filesToProcess) {
        try {
          const fullPath = resolve(p);
          const content = readFileSync(fullPath, 'utf-8');
          await this.orchestrator.analyzeFile(fullPath, content);
          console.log(`Updated graph for: ${p}`);
        } catch (err) {
          console.error(`Error analyzing ${p}:`, err);
        }
      }
    }, 500);
  }

  private async handleDelete(path: string) {
    if (!this.isCodeFile(path)) return;
    try {
      const fullPath = resolve(path);
      await this.orchestrator.removeFile(fullPath);
      console.log(`Removed graph nodes for deleted file: ${path}`);
    } catch (err) {
      console.error(`Error removing ${path}:`, err);
    }
  }

  public async stop() {
    if (this.changeTimeout) clearTimeout(this.changeTimeout);
    await this.watcher?.close();
  }
}
