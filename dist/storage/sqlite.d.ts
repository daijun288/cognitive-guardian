export interface Node {
    id: string;
    type: string;
    name: string;
    fullName: string;
    file: string;
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
    metadata?: string;
}
export interface Edge {
    id: string;
    type: string;
    sourceId: string;
    targetId: string;
    metadata?: string;
}
export declare class KnowledgeGraphStore {
    private db;
    constructor(dbPath?: string);
    private init;
    insertNode(node: Node): void;
    insertEdge(edge: Edge): void;
    getNodesByFile(file: string): Node[];
    getCallers(targetId: string): Node[];
    /**
     * v1.0: Get outgoing dependencies (upstream)
     */
    getDependencies(sourceId: string): Node[];
    /**
     * v1.0 Deep Callers: If the target is a class/interface, aggregate callers of its members.
     */
    getDeepCallers(nodeId: string): Node[];
    /**
     * V6.9 Deep Dependencies: If the source is a class/interface, aggregate dependencies of its members.
     */
    getDeepDependencies(nodeId: string): Node[];
    clearFile(file: string): void;
    getAllNodes(): Node[];
    getAllEdges(): Edge[];
    getNodesByName(name: string): Node[];
    runInTransaction(fn: () => void): void;
    clearGitData(): void;
    insertGitFileStats(stats: {
        file: string;
        totalCommits: number;
        bugFixCommits: number;
        lastModified: string;
        churnScore: number;
    }): void;
    insertCoChange(pattern: {
        fileA: string;
        fileB: string;
        coChangeCount: number;
        confidence: number;
        totalCommitsA: number;
        totalCommitsB: number;
    }): void;
    getCoChangePartners(file: string, minConfidence?: number): {
        partner: string;
        coChangeCount: number;
        confidence: number;
    }[];
    getFileChurn(topN?: number): {
        file: string;
        totalCommits: number;
        bugFixCommits: number;
        lastModified: string;
        churnScore: number;
    }[];
    getBugHotspots(topN?: number): {
        file: string;
        totalCommits: number;
        bugFixCommits: number;
        bugFixRatio: number;
    }[];
    getGitFileStats(file: string): {
        file: string;
        totalCommits: number;
        bugFixCommits: number;
        lastModified: string;
        churnScore: number;
    } | null;
    close(): void;
}
//# sourceMappingURL=sqlite.d.ts.map