import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import Java from 'tree-sitter-java';

export interface CodeSymbol {
  name: string;
  type: 'function' | 'class' | 'interface' | 'method' | 'import' | 'variable';
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  metadata?: Record<string, any> | undefined;
}

export class CodeParser {
  private parser: Parser;

  constructor() {
    this.parser = new Parser();
  }

  public setLanguageByExtension(extension: string) {
    if (extension === '.java') {
      this.parser.setLanguage(Java);
    } else if (extension === '.tsx') {
      this.parser.setLanguage((TypeScript as any).tsx);
    } else {
      this.parser.setLanguage((TypeScript as any).typescript);
    }
  }

  public parse(sourceCode: string, extension: string): Parser.Tree {
    this.setLanguageByExtension(extension);
    return this.parser.parse(sourceCode);
  }


  private extractXmlSymbols(content: string): CodeSymbol[] {
    const symbols: CodeSymbol[] = [];
    
    // 1. Find namespace
    const namespaceMatch = content.match(/<mapper\s+namespace=["']([^"']+)["']/);
    const namespace = namespaceMatch ? namespaceMatch[1] : '';

    // 2. Find SQL IDs (select, insert, update, delete)
    const sqlRegex = /<(select|insert|update|delete|sql)\s+id=["']([^"']+)["']/g;
    let match;

    while ((match = sqlRegex.exec(content)) !== null) {
      const type = match[1];
      const id = match[2];
      if (!id) continue;
      
      const offset = match.index;
      const lineNumber = content.substring(0, offset).split('\n').length;

      symbols.push({
        name: id,
        type: 'method', // Treat as method for easier linking to Mapper interface
        startLine: lineNumber,
        startColumn: 0,
        endLine: lineNumber,
        endColumn: match[0].length,
        metadata: {
          isMyBatisSql: true,
          xmlType: type,
          namespace
        }
      });
    }

    // 3. Find ResultMaps
    const resultMapRegex = /<resultMap\s+id=["']([^"']+)["']\s+type=["']([^"']+)["']/g;
    while ((match = resultMapRegex.exec(content)) !== null) {
      const id = match[1];
      const type = match[2];
      if (!id) continue;

      const lineNumber = content.substring(0, match.index).split('\n').length;

      symbols.push({
        name: id,
        type: 'class', // Treat as class-like for dependency analysis
        startLine: lineNumber,
        startColumn: 0,
        endLine: lineNumber,
        endColumn: match[0].length,
        metadata: {
          isMyBatisResultMap: true,
          targetType: type,
          namespace
        }
      });
    }

    return symbols;
  }

  private extractJavaSymbols(content: string): CodeSymbol[] {
    const tree = this.parse(content, '.java');
    const symbols: CodeSymbol[] = [];
    
    const packageNode = tree.rootNode.children.find(c => c.type === 'package_declaration');
    const packageName = packageNode?.childForFieldName('name')?.text || '';

    // Class-level API path
    const classNode = tree.rootNode.descendantsOfType('class_declaration')[0];
    let classPath = '';
    if (classNode) {
      const modifiers = classNode.children.find(c => c.type === 'modifiers');
      const requestMapping = modifiers?.text.match(/@RequestMapping\(\s*["']([^"']+)["']\s*\)/);
      if (requestMapping && requestMapping[1]) classPath = requestMapping[1];
    }

    this.traverse(tree.rootNode, symbols, '.java', { packageName, classPath });

    // v1.0: Regex Fallback for robustness
    const classes = symbols.filter(s => s.type === 'class' || s.type === 'interface');
    if (classes.length === 0 && content.length > 50) {
      const regexSymbols = this.regexExtractJavaSymbols(content);
      symbols.push(...regexSymbols);
    }

    return symbols;
  }

  private regexExtractJavaSymbols(content: string): CodeSymbol[] {
    const symbols: CodeSymbol[] = [];
    const lines = content.split('\n');

    // Basic Class/Interface detection
    const classRegex = /(?:public|protected|private|static)?\s+(class|interface|enum|record)\s+(\w+)/g;
    let match;
    while ((match = classRegex.exec(content)) !== null) {
      const typeStr = match[1];
      const name = match[2];
      if (typeStr && name) {
        const type = (typeStr === 'enum' || typeStr === 'record' ? 'class' : typeStr) as any;
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({
          name,
          type,
          startLine: lineNum,
          startColumn: 0,
          endLine: lineNum,
          endColumn: match[0].length,
          metadata: { isRegexFallback: true }
        });
      }
    }

    // Basic Method detection (avoiding constructor-like matches)
    const methodRegex = /(?:public|protected|private|static)?\s+[\w<>[\]]+\s+(\w+)\s*\([^)]*\)\s*(?:throws\s+[\w, ]+)?\s*{/g;
    while ((match = methodRegex.exec(content)) !== null) {
      const name = match[1];
      if (name && !['if', 'for', 'while', 'switch', 'synchronized', 'catch'].includes(name)) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({
          name,
          type: 'method',
          startLine: lineNum,
          startColumn: 0,
          endLine: lineNum,
          endColumn: match[0].length,
          metadata: { isRegexFallback: true }
        });
      }
    }

    // Basic Variable/Field detection (constants, static fields)
    const varRegex = /(?:public|protected|private|static|final)\s+[\w<>[\]]+\s+(\w+)\s*=\s*[^;]+;/g;
    while ((match = varRegex.exec(content)) !== null) {
      const name = match[1];
      if (name && !['return', 'new', 'throw'].includes(name)) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({
          name,
          type: 'variable',
          startLine: lineNum,
          startColumn: 0,
          endLine: lineNum,
          endColumn: match[0].length,
          metadata: { isRegexFallback: true }
        });
      }
    }

    return symbols;
  }

  private extractTsSymbols(content: string): CodeSymbol[] {
    const tree = this.parse(content, '.ts');
    const symbols: CodeSymbol[] = [];
    this.traverse(tree.rootNode, symbols, '.ts', {});
    return symbols;
  }

  private traverse(node: Parser.SyntaxNode, symbols: CodeSymbol[], extension: string, context: any) {
    if (extension === '.java') {
      this.traverseJava(node, symbols, context);
    } else {
      this.traverseTypeScript(node, symbols, context);
    }

    for (let i = 0; i < node.childCount; i++) {
      this.traverse(node.child(i)!, symbols, extension, context);
    }
  }

  private traverseTypeScript(node: Parser.SyntaxNode, symbols: CodeSymbol[], context: any) {

    switch (node.type) {
      case 'function_declaration':
      case 'generator_function_declaration': {
        const fNode = node.childForFieldName('name');
        if (fNode) symbols.push(this.createSymbol(fNode.text, 'function', node));
        break;
      }
      case 'class_declaration': {
        const cNode = node.childForFieldName('name');
        if (cNode) symbols.push(this.createSymbol(cNode.text, 'class', node));
        break;
      }
      case 'interface_declaration': {
        const iNode = node.childForFieldName('name');
        if (iNode) symbols.push(this.createSymbol(iNode.text, 'interface', node));
        break;
      }
      case 'method_definition': {
        const mNode = node.childForFieldName('name');
        if (mNode) symbols.push(this.createSymbol(mNode.text, 'method', node));
        break;
      }
      // v1.0: Capture arrow functions assigned to variables (Vue Composition API)
      case 'variable_declarator': {
        const vNode = node.childForFieldName('name');
        const valueNode = node.childForFieldName('value');
        if (vNode && valueNode && (valueNode.type === 'arrow_function' || valueNode.type === 'function')) {
          symbols.push(this.createSymbol(vNode.text, 'function', node));
        }
        break;
      }
      // v1.0: Capture object method shorthand (Vue Options API: methods: { handleClick() {} })
      case 'pair': {
        const keyNode = node.childForFieldName('key');
        const valueNode = node.childForFieldName('value');
        if (keyNode && valueNode && (valueNode.type === 'arrow_function' || valueNode.type === 'function')) {
          symbols.push(this.createSymbol(keyNode.text, 'method', node));
        }
        break;
      }
      case 'call_expression': {
        const text = node.text;
        // V8.0: Generic Call Expression for Topology Stitching
        const memberAccess = node.childForFieldName('function');
        if (memberAccess) {
             const name = memberAccess.type === 'member_expression' ? memberAccess.childForFieldName('property')?.text : memberAccess.text;
             if (name) {
                 symbols.push(this.createSymbol(name, 'variable', node, { isCall: true }));
             }
        }

        // More robust Frontend API detection (multiline request)
        if (text.includes('request({')) {
          const urlMatch = text.match(/url:\s*["']([^"']+)["']/);
          const methodMatch = text.match(/method:\s*["']([^"']+)["']/);
          if (urlMatch && urlMatch[1]) {
            symbols.push(this.createSymbol('request', 'variable', node, { 
              isCall: true,
              isFrontendApi: true,
              apiPath: urlMatch[1],
              httpMethod: (methodMatch && methodMatch[1] ? methodMatch[1] : 'GET').toUpperCase()
            }));
          }
        }
        // v1.0: Detect proxy.download / proxy.upload patterns
        const downloadMatch = text.match(/proxy\s*\.\s*(download|upload)\s*\(\s*["']([^"']+)["']/);
        if (downloadMatch && downloadMatch[2]) {
          symbols.push(this.createSymbol('proxy.' + downloadMatch[1], 'variable', node, {
            isCall: true,
            isFrontendApi: true,
            apiPath: downloadMatch[2],
            httpMethod: downloadMatch[1] === 'download' ? 'POST' : 'POST'
          }));
        }
        break;
      }
    }
  }

  private traverseJava(node: Parser.SyntaxNode, symbols: CodeSymbol[], context: any) {
    const { packageName, classPath = '' } = context;
    switch (node.type) {
      case 'class_declaration':
      case 'interface_declaration':
      case 'enum_declaration':
      case 'record_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const type = node.type === 'interface_declaration' ? 'interface' : 'class';
          const fqn = packageName ? `${packageName}.${nameNode.text}` : nameNode.text;
          symbols.push(this.createSymbol(nameNode.text, type, node, { fqn, apiPath: classPath }));
        }
        break;
      }
      case 'method_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const modifiers = node.children.find(c => c.type === 'modifiers');
          const mText = modifiers?.text || '';
          
          // v1.0: Enhanced regex to capture annotation names AND values (for SpEL/REST paths)
          const annotations: string[] = [];
          const annotationRegex = /@(\w+)(?:\(([^)]+)\))?/g;
          let annoMatch;
          while ((annoMatch = annotationRegex.exec(mText)) !== null) {
            const name = annoMatch[1];
            const val = annoMatch[2];
            if (name) {
              annotations.push(name);
              // v1.0: Universal Generic Semantic Trapping (bean.method, service.method, etc.)
              if (val) {
                // Regex for potential logical calls: @something.method(), something.method()
                const genericCallRegex = /(?:@|[\w]+\.)([\w]+)\s*\(/g;
                let spelMatch;
                while ((spelMatch = genericCallRegex.exec(val)) !== null) {
                  const methodName = spelMatch[1];
                  if (methodName && methodName.length > 2 && !['RequestMapping', 'GetMapping', 'PostMapping'].includes(methodName)) {
                    symbols.push(this.createSymbol(methodName, 'variable', node, { isCall: true, isSemanticCall: true }));
                  }
                }
              }
            }
          }

          let methodPath = '';
          let httpMethod = 'GET';
          
          const mappingMatch = mText.match(/@(Get|Post|Put|Delete|Request)Mapping\(\s*["']([^"']+)["']\s*\)/);
          if (mappingMatch && mappingMatch[1] && mappingMatch[2]) {
            const hMethod = mappingMatch[1].toUpperCase();
            httpMethod = hMethod === 'REQUEST' ? 'ALL' : hMethod;
            methodPath = mappingMatch[2];
          }

          const fullPath = (classPath + '/' + methodPath).replace(/\/+/g, '/');
          const isRestEndpoint = mText.includes('Mapping');

          const methodMeta: Record<string, any> = {};
          if (isRestEndpoint) {
            methodMeta.isRestEndpoint = true;
            methodMeta.apiPath = fullPath;
            methodMeta.httpMethod = httpMethod === 'ALL' ? 'GET' : (httpMethod || 'GET');
          }

          // v1.0: Recognize Spring Security implicit endpoints in methods or config classes
          if (mText.includes('.logoutUrl(')) {
            const logoutMatch = mText.match(/\.logoutUrl\(["']([^"']+)["']\)/);
            if (logoutMatch) {
              methodMeta.isRestEndpoint = true;
              methodMeta.apiPath = logoutMatch[1];
              methodMeta.httpMethod = 'POST'; // Usually POST for logout
            }
          }
          if (mText.includes('.antMatchers(')) {
             const antMatch = mText.match(/\.antMatchers\(["']([^"']+)["']\)/);
             if (antMatch) {
                methodMeta.isRestEndpoint = true;
                methodMeta.apiPath = antMatch[1];
                methodMeta.httpMethod = 'ALL';
             }
          }
          // V8.1: Always store annotations for framework awareness
          if (annotations.length > 0) {
            methodMeta.annotations = annotations;
          }

          symbols.push(this.createSymbol(nameNode.text, 'method', node, methodMeta));
        }
        break;
      }
      case 'method_invocation': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) symbols.push(this.createSymbol(nameNode.text, 'variable', node, { isCall: true }));
        break;
      }
      case 'field_declaration': {
        const variable = node.descendantsOfType('variable_declarator')[0];
        const nameNode = variable?.childForFieldName('name');
        if (nameNode) {
          symbols.push(this.createSymbol(nameNode.text, 'variable', node));
        }
        break;
      }
    }
  }

  public extractSymbols(content: string, ext: string): CodeSymbol[] {
    if (ext === '.java') return this.extractJavaSymbols(content);
    if (ext === '.ts' || ext === '.tsx' || ext === '.js') return this.extractTsSymbols(content);
    if (ext === '.xml') return this.extractXmlSymbols(content);
    if (ext === '.vue') return this.extractVueSymbols(content);
    return [];
  }

  private extractVueSymbols(content: string): CodeSymbol[] {
    const symbols: CodeSymbol[] = [];

    // 1. Scan <template> for component tags (UI dependencies)
    const templateMatch = content.match(/<template>([\s\S]*?)<\/template>/);
    if (templateMatch && templateMatch[1]) {
      const templateContent: string = templateMatch[1];
      const tagRegex = /<([A-Z][a-zA-Z0-9]+)/g;
      let tagMatch;
      const templateOffset = content.indexOf(templateMatch[1]);
      const templateLineOffset = content.substring(0, templateOffset).split('\n').length - 1;

      while ((tagMatch = tagRegex.exec(templateContent)) !== null) {
        const tagName = tagMatch[1];
        if (tagName) {
          symbols.push({
            name: tagName,
            type: 'variable', 
            startLine: templateLineOffset + templateMatch[1].substring(0, tagMatch.index).split('\n').length,
            startColumn: 0,
            endLine: templateLineOffset + templateMatch[1].substring(0, tagMatch.index).split('\n').length,
            endColumn: tagMatch[0].length,
            metadata: { isVueComponent: true }
          });
        }
      }
    }

    // 2. Scan <script> (Logic dependencies)
    const scriptMatch = content.match(/<script[^>]*>([\s\S]*?)<\/script>/);
    if (scriptMatch && scriptMatch[1]) {
      const scriptTagIndex = content.indexOf(scriptMatch[1]);
      const lineOffset = content.substring(0, scriptTagIndex).split('\n').length - 1;
      
      const scriptSymbols = this.extractTsSymbols(scriptMatch[1]);
      symbols.push(...scriptSymbols.map(s => ({
        ...s,
        startLine: s.startLine + lineOffset,
        endLine: s.endLine + lineOffset,
      })));
    }
    return symbols;
  }

  private createSymbol(name: string, type: CodeSymbol['type'], node: Parser.SyntaxNode, metadata?: Record<string, any>): CodeSymbol {
    return {
      name,
      type,
      startLine: node.startPosition.row + 1,
      startColumn: node.startPosition.column,
      endLine: node.endPosition.row + 1,
      endColumn: node.endPosition.column,
      metadata,
    };
  }
}
