import Parser from 'tree-sitter';
export interface CodeSymbol {
    name: string;
    type: 'function' | 'class' | 'interface' | 'method' | 'import' | 'variable';
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
    metadata?: Record<string, any> | undefined;
}
export declare class CodeParser {
    private parser;
    constructor();
    setLanguageByExtension(extension: string): void;
    parse(sourceCode: string, extension: string): Parser.Tree;
    private extractXmlSymbols;
    private extractJavaSymbols;
    private regexExtractJavaSymbols;
    private extractTsSymbols;
    private traverse;
    private traverseTypeScript;
    private traverseJava;
    extractSymbols(content: string, ext: string): CodeSymbol[];
    private extractVueSymbols;
    private createSymbol;
}
//# sourceMappingURL=parser.d.ts.map