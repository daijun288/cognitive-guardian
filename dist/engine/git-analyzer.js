import { execSync } from 'child_process';
import { KnowledgeGraphStore } from '../storage/sqlite.js';
export class GitAnalyzer {
    logger;
    constructor(logger) {
        this.logger = logger || ((msg) => console.error(`[GitAnalyzer] ${msg}`));
    }
    /**
     * Check if git is available in the given directory
     */
    isGitRepo(rootDir) {
        try {
            execSync('git rev-parse --is-inside-work-tree', { cwd: rootDir, stdio: 'pipe' });
            return true;
        }
        catch {
            return false;
        }
    }
    /**
     * Analyze git history and persist results to SQLite
     */
    async analyzeHistory(rootDir, store, maxCommits = 200) {
        if (!this.isGitRepo(rootDir)) {
            this.logger('Not a git repository. Skipping git analysis.');
            return { totalCommitsAnalyzed: 0, uniqueFiles: 0, coChangePairs: 0 };
        }
        this.logger(`Starting Git history analysis (last ${maxCommits} commits)...`);
        const startTime = Date.now();
        // 1. Get git log with file changes
        const rawLog = this.getGitLog(rootDir, maxCommits);
        const commits = this.parseGitLog(rawLog);
        this.logger(`Parsed ${commits.length} commits.`);
        // 2. Build file stats and co-change matrix
        const fileStats = new Map();
        const coChangeMatrix = new Map(); // "fileA|fileB" -> count
        const bugPatterns = /fix|bug|hotfix|修复|缺陷|问题|紧急|回退|revert/i;
        for (const commit of commits) {
            const isBugFix = bugPatterns.test(commit.message);
            const files = commit.files
                .map(f => f.replace(/\\/g, '/').toLowerCase())
                .filter(f => this.isCodeFile(f));
            // Update per-file stats
            for (const file of files) {
                const existing = fileStats.get(file) || { totalCommits: 0, bugFixCommits: 0, lastModified: '' };
                existing.totalCommits++;
                if (isBugFix)
                    existing.bugFixCommits++;
                if (!existing.lastModified || commit.date > existing.lastModified) {
                    existing.lastModified = commit.date;
                }
                fileStats.set(file, existing);
            }
            // Build co-change pairs (only for commits with 2-20 files to avoid noise from mass commits)
            if (files.length >= 2 && files.length <= 20) {
                for (let i = 0; i < files.length; i++) {
                    for (let j = i + 1; j < files.length; j++) {
                        const key = [files[i], files[j]].sort().join('|');
                        coChangeMatrix.set(key, (coChangeMatrix.get(key) || 0) + 1);
                    }
                }
            }
        }
        // 3. Calculate churn scores (normalize to 0-100)
        const maxCommitCount = Math.max(...Array.from(fileStats.values()).map(s => s.totalCommits), 1);
        // 4. Persist to SQLite
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
                if (!fileA || !fileB)
                    continue;
                const statsA = fileStats.get(fileA);
                const statsB = fileStats.get(fileB);
                if (!statsA || !statsB)
                    continue;
                // Confidence = co-change count / max(commitsA, commitsB)
                const confidence = count / Math.max(statsA.totalCommits, statsB.totalCommits);
                // Only persist meaningful patterns (confidence > 0.2 and at least 2 co-changes)
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
        this.logger(`Git analysis complete in ${duration}s. Files: ${fileStats.size}, Co-change pairs: ${coChangePairs}.`);
        return {
            totalCommitsAnalyzed: commits.length,
            uniqueFiles: fileStats.size,
            coChangePairs,
        };
    }
    getGitLog(rootDir, maxCommits) {
        try {
            // Format: HASH|DATE|MESSAGE\n\nfile1\nfile2\n...
            return execSync(`git log --numstat --format="COMMIT|%aI|%s" -n ${maxCommits} --diff-filter=ACDMR`, { cwd: rootDir, maxBuffer: 50 * 1024 * 1024, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
        }
        catch (err) {
            this.logger(`Git log failed: ${err instanceof Error ? err.message : err}`);
            return '';
        }
    }
    parseGitLog(raw) {
        const commits = [];
        if (!raw)
            return commits;
        const lines = raw.split('\n');
        let current = null;
        for (const line of lines) {
            if (line.startsWith('COMMIT|')) {
                if (current)
                    commits.push(current);
                const parts = line.split('|');
                current = {
                    date: parts[1] || '',
                    message: parts.slice(2).join('|'),
                    files: [],
                };
            }
            else if (current && line.trim()) {
                // numstat format: additions\tdeletions\tfilename
                const match = line.match(/^\d+\t\d+\t(.+)$/);
                if (match && match[1]) {
                    current.files.push(match[1]);
                }
            }
        }
        if (current)
            commits.push(current);
        return commits;
    }
    isCodeFile(file) {
        const ext = file.substring(file.lastIndexOf('.')).toLowerCase();
        return ['.java', '.ts', '.tsx', '.js', '.vue', '.xml', '.yml', '.yaml', '.properties'].includes(ext);
    }
}
//# sourceMappingURL=git-analyzer.js.map