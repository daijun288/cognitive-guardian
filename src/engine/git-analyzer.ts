import { spawn, execSync } from 'child_process';
import { createInterface } from 'readline';
import { KnowledgeGraphStore } from '../storage/sqlite.js';

export interface GitFileStats {
  file: string;
  totalCommits: number;
  bugFixCommits: number;
  lastModified: string;
  churnScore: number;       // 0-100
}

export interface CoChangePattern {
  fileA: string;
  fileB: string;
  coChangeCount: number;
  confidence: number;       // 0-1
  totalCommitsA: number;
  totalCommitsB: number;
}

export class GitAnalyzer {
  private logger: (msg: string) => void;

  constructor(logger?: (msg: string) => void) {
    this.logger = logger || ((msg) => console.error(`[GitAnalyzer] ${msg}`));
  }

  /**
   * Check if git is available in the given directory
   */
  public isGitRepo(rootDir: string): boolean {
    try {
      execSync('git rev-parse --is-inside-work-tree', { cwd: rootDir, stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Phase 4: 流式 Git 历史分析 —— 使用 spawn + readline，内存占用恒定 O(1)
   */
  public async analyzeHistory(rootDir: string, store: KnowledgeGraphStore, maxCommits: number = 200): Promise<{
    totalCommitsAnalyzed: number;
    uniqueFiles: number;
    coChangePairs: number;
  }> {
    if (!this.isGitRepo(rootDir)) {
      this.logger('Not a git repository. Skipping git analysis.');
      return { totalCommitsAnalyzed: 0, uniqueFiles: 0, coChangePairs: 0 };
    }

    this.logger(`Starting Git history analysis (last ${maxCommits} commits) [Streaming Mode]...`);
    const startTime = Date.now();

    const bugPatterns = /fix|bug|hotfix|修复|缺陷|问题|紧急|回退|revert/i;

    // 流式状态机
    const fileStats = new Map<string, { totalCommits: number; bugFixCommits: number; lastModified: string }>();
    const coChangeMatrix = new Map<string, number>();
    let totalCommitsAnalyzed = 0;

    // 当前正在解析的 commit 的临时状态
    let currentCommit: { date: string; message: string; isBugFix: boolean } | null = null;
    let currentFiles: string[] = [];

    // 当遇到新的 COMMIT 行或流结束时，将上一个 commit 的数据刷入统计
    const flushCurrentCommit = () => {
      if (!currentCommit) return;
      totalCommitsAnalyzed++;

      const files = currentFiles
        .map(f => f.replace(/\\/g, '/').toLowerCase())
        .filter(f => this.isCodeFile(f));

      for (const file of files) {
        const existing = fileStats.get(file) || { totalCommits: 0, bugFixCommits: 0, lastModified: '' };
        existing.totalCommits++;
        if (currentCommit.isBugFix) existing.bugFixCommits++;
        if (!existing.lastModified || currentCommit.date > existing.lastModified) {
          existing.lastModified = currentCommit.date;
        }
        fileStats.set(file, existing);
      }

      if (files.length >= 2 && files.length <= 20) {
        for (let i = 0; i < files.length; i++) {
          for (let j = i + 1; j < files.length; j++) {
            const key = [files[i], files[j]].sort().join('|');
            coChangeMatrix.set(key, (coChangeMatrix.get(key) || 0) + 1);
          }
        }
      }

      currentCommit = null;
      currentFiles = [];
    };

    // 核心：spawn 子进程 + readline 逐行流式处理
    await new Promise<void>((resolve, reject) => {
      const gitProcess = spawn('git', [
        'log', '--numstat', `--format=COMMIT|%aI|%s`, `-n`, `${maxCommits}`, '--diff-filter=ACDMR'
      ], { cwd: rootDir, stdio: ['pipe', 'pipe', 'pipe'] });

      const rl = createInterface({ input: gitProcess.stdout });

      rl.on('line', (line: string) => {
        if (line.startsWith('COMMIT|')) {
          // 遇到新 commit 标记，先刷掉上一个
          flushCurrentCommit();
          const parts = line.split('|');
          currentCommit = {
            date: parts[1] || '',
            message: parts.slice(2).join('|'),
            isBugFix: bugPatterns.test(parts.slice(2).join('|')),
          };
        } else if (currentCommit && line.trim()) {
          const match = line.match(/^\d+\t\d+\t(.+)$/);
          if (match && match[1]) {
            let fileName = match[1];
            if (fileName.includes('=>')) {
              if (fileName.includes('{') && fileName.includes('}')) {
                fileName = fileName.replace(/\{[^}]*=>\s*([^}]+)\}/, '$1').replace(/\/\//g, '/');
              } else {
                const parts = fileName.split('=>');
                const lastPart = parts[parts.length - 1];
                fileName = lastPart ? lastPart.trim() : '';
              }
            }
            currentFiles.push(fileName.trim());
          }
        }
      });

      rl.on('close', () => {
        flushCurrentCommit(); // 刷掉最后一个 commit
        resolve();
      });

      gitProcess.on('error', (err) => {
        this.logger(`Git spawn failed: ${err.message}`);
        resolve(); // 优雅降级，不抛异常
      });

      gitProcess.stderr.on('data', () => {
        // 静默忽略 stderr 输出
      });
    });

    // 计算 churn scores 并持久化
    const maxCommitCount = Math.max(...Array.from(fileStats.values()).map(s => s.totalCommits), 1);

    store.clearGitData();
    store.runInTransaction(() => {
      for (const [file, stats] of fileStats.entries()) {
        const churnScore = Math.round((stats.totalCommits / maxCommitCount) * 100);
        store.insertGitFileStats({
          file,
          totalCommits: stats.totalCommits,
          bugFixCommits: stats.bugFixCommits,
          lastModified: stats.lastModified,
          churnScore,
        });
      }

      for (const [key, count] of coChangeMatrix.entries()) {
        const [fileA, fileB] = key.split('|');
        if (!fileA || !fileB) continue;
        const statsA = fileStats.get(fileA);
        const statsB = fileStats.get(fileB);
        if (!statsA || !statsB) continue;

        const confidence = count / Math.max(statsA.totalCommits, statsB.totalCommits);
        
        if (confidence >= 0.2 && count >= 2) {
          store.insertCoChange({
            fileA, fileB,
            coChangeCount: count,
            confidence: Math.round(confidence * 100) / 100,
            totalCommitsA: statsA.totalCommits,
            totalCommitsB: statsB.totalCommits,
          });
        }
      }
    });

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    const coChangePairs = Array.from(coChangeMatrix.values()).filter(v => v >= 2).length;
    this.logger(`Git analysis complete in ${duration}s. Files: ${fileStats.size}, Co-change pairs: ${coChangePairs}. [Streaming Mode]`);

    return {
      totalCommitsAnalyzed,
      uniqueFiles: fileStats.size,
      coChangePairs,
    };
  }

  private isCodeFile(file: string): boolean {
    const ext = file.substring(file.lastIndexOf('.')).toLowerCase();
    return ['.java', '.ts', '.tsx', '.js', '.vue', '.xml', '.yml', '.yaml', '.properties'].includes(ext);
  }
}
