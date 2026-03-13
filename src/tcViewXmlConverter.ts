import * as xml2js from 'xml2js';

export class TwinCATXmlConverter {
    private parser: xml2js.Parser;
    private builder: xml2js.Builder;

    constructor() {
        this.parser = new xml2js.Parser({
            trim: false,
            normalize: false,
            explicitArray: false,
            mergeAttrs: false
        });
        
        this.builder = new xml2js.Builder({
            headless: true,
            cdata: true,
            renderOpts: { pretty: true, indent: '  ', newline: '\n' }
        });
    }

    public convertXmlToST(xmlContent: string): Promise<string> {
        return new Promise((resolve, reject) => {
            this.parser.parseString(xmlContent, (err, result) => {
                if (err) {
                    console.error('Error parsing XML:', err);
                    resolve(this.generateErrorOutput(err));
                } else {
                    try {
                        const stCode = this.parseTwinCATStructure(result);
                        resolve(stCode);
                    } catch (parseError) {
                        console.error('Error parsing TwinCAT structure:', parseError);
                        resolve(this.generateErrorOutput(parseError as Error));
                    }
                }
            });
        });
    }

    public convertSTToXml(stContent: string, originalXml: string): Promise<string> {
        return new Promise((resolve, reject) => {
            this.parser.parseString(originalXml, (err, result) => {
                if (err) {
                    reject(err);
                    return;
                }
                
                try {
                    const updatedXml = this.updateXmlWithST(result, stContent);
                    const xmlString = this.builder.buildObject(updatedXml);
                    const withPreservedCData = this.preserveOriginalCDataWrappers(xmlString, originalXml);
                    resolve(this.prependOriginalXmlDeclaration(withPreservedCData, originalXml));
                } catch (error) {
                    reject(error);
                }
            });
        });
    }

    private updateXmlWithST(data: any, stContent: string): any {
        const rootKey = Object.keys(data)[0];
        if (!rootKey) return data;
        
        const root = data[rootKey];
        
        // Handle TcPlcObject - update nested POU
        if (rootKey === 'TcPlcObject' && root.POU) {
            this.applyPouStToNode(root.POU, stContent);
            return data;
        }
        
        // Handle direct TcPOU-like roots.
        if (root && (rootKey === 'TcPOU' || rootKey === 'TcPrg' || rootKey === 'TcFct')) {
            this.applyPouStToNode(root, stContent);
            return data;
        }

        if (rootKey === 'TcPlcObject' && root.DUT) {
            this.applyDutStToNode(root.DUT, stContent);
            return data;
        }

        if (root && rootKey === 'TcDUT') {
            this.applyDutStToNode(root, stContent);
            return data;
        }

        // Fallback: if object has an implementation node, treat incoming ST as implementation only.
        if (root?.Implementation) {
            this.setImplementationText(root, stContent);
        }
        
        return data;
    }

    private applyPouStToNode(node: any, stContent: string): void {
        const existingDeclaration = this.getTextContent(node?.Declaration);
        const split = this.splitPouSt(stContent, existingDeclaration);
        if (split.declaration) {
            this.setTextField(node, 'Declaration', split.declaration);
        }
        this.setImplementationText(node, split.implementation);
    }

    private applyDutStToNode(node: any, stContent: string): void {
        const normalized = stContent.replace(/\r\n?/g, '\n').trim();
        if (!normalized) {
            return;
        }

        this.setTextField(node, 'Declaration', normalized);

        const parsed = this.parseDutDeclaration(normalized);
        if (parsed.name) {
            this.setTextField(node, 'Name', parsed.name);
        }
        if (parsed.kind) {
            this.setTextField(node, 'Type', parsed.kind);
        }
    }

    private splitPouSt(stContent: string, existingDeclaration: string): { declaration: string; implementation: string } {
        const normalized = stContent.replace(/\r\n?/g, '\n');
        const lines = normalized.split('\n');
        while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();

        if (lines.length === 0) {
            return { declaration: existingDeclaration.trim(), implementation: '' };
        }

        let start = 0;
        while (start < lines.length && !lines[start].trim()) start++;
        if (start >= lines.length) {
            return { declaration: existingDeclaration.trim(), implementation: '' };
        }

        const headerRx = /^(PROGRAM|FUNCTION_BLOCK|FUNCTION)\b/i;
        if (!headerRx.test(lines[start].trim())) {
            return { declaration: existingDeclaration.trim(), implementation: lines.slice(start).join('\n').trim() };
        }

        let index = start + 1;
        let lastDeclLine = start;
        let inVarBlock = false;
        const varStartRx = /^VAR(?:_(?:INPUT|OUTPUT|IN_OUT|TEMP|CONSTANT|STAT|RETAIN))?\b/i;
        const commentOrBlankRx = /^(\/\/|\/\*|\(\*|\{.*\}\s*$)?\s*$/;

        while (index < lines.length) {
            const text = lines[index].trim();

            if (varStartRx.test(text)) {
                inVarBlock = true;
                lastDeclLine = index;
                index++;
                continue;
            }

            if (inVarBlock) {
                lastDeclLine = index;
                if (/^END_VAR\b/i.test(text)) {
                    inVarBlock = false;
                }
                index++;
                continue;
            }

            if (commentOrBlankRx.test(text)) {
                lastDeclLine = index;
                index++;
                continue;
            }

            break;
        }

        const declaration = lines.slice(start, lastDeclLine + 1).join('\n').trim();
        const implementation = lines.slice(lastDeclLine + 1).join('\n').trim();
        return { declaration, implementation };
    }

    private setImplementationText(target: any, text: string): void {
        target.Implementation = target.Implementation || {};
        const existing = target.Implementation.ST;
        if (typeof existing === 'string') {
            target.Implementation.ST = text;
            return;
        }
        if (existing && typeof existing === 'object' && existing._ !== undefined) {
            existing._ = text;
            return;
        }
        target.Implementation.ST = text;
    }

    private setTextField(target: any, key: string, text: string): void {
        const existing = target?.[key];
        if (typeof existing === 'string') {
            target[key] = text;
            return;
        }
        if (existing && typeof existing === 'object' && existing._ !== undefined) {
            existing._ = text;
            return;
        }
        target[key] = text;
    }

    private parseTwinCATStructure(data: any): string {
        const rootKey = Object.keys(data)[0];
        if (!rootKey) {
            return '// Empty XML document\n';
        }
        
        const root = data[rootKey];
        
        // Handle TcPlcObject wrapper - extract the actual POU/DUT/GVL inside
        if (rootKey === 'TcPlcObject') {
            return this.generateTcPlcObjectStructure(root);
        }

        
        // Handle direct file types
        switch (rootKey) {
            case 'TcPOU':
            case 'TcPrg':
            case 'TcFct':
                return this.generatePOUStructure(root, rootKey);
            case 'TcDUT':
                return this.generateDUTStructure(root);
            case 'TcGVL':
                return this.generateGVLStructure(root);
            case 'TcIO':
            case 'TcItf':
            case 'TcITF':
                return this.generateInterfaceObjectStructure(root);
            default:
                if (root.Implementation || root.Interface) {
                    return this.generatePOUStructure(root, rootKey);
                }
                return '// Unknown file type: ' + rootKey + '\n';
        }
    }

    private getTextContent(obj: any): string {
        if (Array.isArray(obj)) return obj.map(item => this.getTextContent(item)).filter(Boolean).join('\n');
        if (typeof obj === 'string') return obj;
        if (obj && obj._) return obj._;
        if (obj && obj.$ && obj.$['xsi:nil'] === 'true') return '';
        return '';
    }

    private getImplementationText(obj: any): string {
        if (!obj) return '';
        if (typeof obj === 'string') return obj;
        return this.getTextContent(obj.ST).trim();
    }

    private buildPropertyAccessorSection(kind: 'GET' | 'SET', accessor: any): string {
        if (!accessor) {
            return '';
        }

        const declaration = this.getTextContent(accessor.Declaration).trim();
        const implementation = this.getImplementationText(accessor.Implementation);
        if (!declaration && !implementation) {
            return '';
        }

        const header = declaration
            ? (new RegExp(`^${kind}\\b`, 'i').test(declaration) ? declaration : `${kind}\n${declaration}`)
            : kind;

        return [header.trim(), implementation].filter(Boolean).join('\n\n');
    }

    private buildInterfaceDeclaration(itfData: any): string {
        const declaration = this.getTextContent(itfData?.Declaration).trim();
        if (declaration) {
            const firstLine = declaration
                .replace(/\r/g, '\n')
                .split('\n')
                .map(line => line.trim())
                .find(Boolean);
            if (firstLine) {
                return firstLine;
            }
        }

        const name = itfData?.Name
            ? this.getTextContent(itfData.Name) || 'I_Unknown'
            : itfData?.$?.Name || 'I_Unknown';
        const extendsType =
            this.getTextContent(itfData?.Extends).trim() ||
            this.getTextContent(itfData?.BaseType).trim() ||
            this.getTextContent(itfData?.Interface).trim();
        return extendsType ? `INTERFACE ${name} EXTENDS ${extendsType}` : `INTERFACE ${name}`;
    }

    private generatePOUStructure(pouData: any, type: string): string {
        let stCode = '';
        
        // Get name - can be child element or attribute
        let name = 'Main';
        if (pouData.Name) {
            name = this.getTextContent(pouData.Name) || 'Main';
        } else if (pouData.$ && pouData.$.Name) {
            name = pouData.$.Name;
        }
        
        // Get type (PROGRAM, FUNCTION_BLOCK, FUNCTION)
        let pouType = 'PROGRAM';
        if (pouData.Type) {
            pouType = this.getTextContent(pouData.Type) || 'PROGRAM';
        } else if (pouData.$ && pouData.$.Type) {
            pouType = pouData.$.Type;
        }
        
        // Get comment
        let comment = '';
        if (pouData.Comment) {
            comment = this.getTextContent(pouData.Comment);
        }
        
        const commentStr = comment ? ` // ${comment}` : '';
        stCode += `${pouType} ${name}${commentStr}\n\n`;
        
        // Generate variable sections from Interface
        if (pouData.Interface) {
            stCode += this.generateInterface(pouData.Interface);
        }
        
        // Generate implementation
        if (pouData.Implementation) {
            stCode += this.generateImplementation(pouData.Implementation);
        }
        
        return stCode;
    }

    private generateDUTStructure(dutData: any): string {
        if (dutData.Declaration) {
            const declaration = this.getTextContent(dutData.Declaration).trim();
            if (declaration) {
                return declaration.endsWith('\n') ? declaration : `${declaration}\n`;
            }
        }

        return this.buildDutDeclarationFromFields(dutData);
    }

    private generateGVLStructure(gvlData: any): string {
        if (gvlData.Declaration) {
            const declaration = this.getTextContent(gvlData.Declaration).trim();
            if (declaration) {
                return declaration.endsWith('\n') ? declaration : `${declaration}\n`;
            }
        }

        let stCode = '';
        let name = 'GlobalVars';
        if (gvlData.Name) {
            name = this.getTextContent(gvlData.Name) || 'GlobalVars';
        } else if (gvlData.$ && gvlData.$.Name) {
            name = gvlData.$.Name;
        }

        stCode += `// Global Variable List: ${name}\n\n`;
        stCode += `VAR_GLOBAL\n`;

        if (gvlData.Variables && gvlData.Variables.Variable) {
            const vars = this.ensureArray(gvlData.Variables.Variable);
            for (const variable of vars) {
                const varName = variable.Name ? this.getTextContent(variable.Name) : (variable.$?.Name || 'unnamed');
                const varType = variable.Type ? this.getTextContent(variable.Type) : (variable.$?.Type || 'BOOL');
                const varComment = variable.Comment ? this.getTextContent(variable.Comment) : '';
                const commentStr = varComment ? ` // ${varComment}` : '';
                stCode += `    ${varName} : ${varType};${commentStr}\n`;
            }
        }
        
        stCode += `END_VAR\n`;
        
        return stCode;
    }

    private generateInterfaceObjectStructure(itfData: any): string {
        return `${this.buildInterfaceDeclaration(itfData)}\n`;
    }

    private generateInterface(interfaceData: any): string {
        let stCode = '';
        
        // Handle InputVars
        if (interfaceData.InputVars) {
            const vars = this.extractVariables(interfaceData.InputVars);
            if (vars.length > 0) {
                stCode += 'VAR_INPUT\n';
                for (const v of vars) {
                    stCode += `    ${v.name} : ${v.type};${v.comment ? ' // ' + v.comment : ''}\n`;
                }
                stCode += 'END_VAR\n\n';
            }
        }
        
        // Handle OutputVars
        if (interfaceData.OutputVars) {
            const vars = this.extractVariables(interfaceData.OutputVars);
            if (vars.length > 0) {
                stCode += 'VAR_OUTPUT\n';
                for (const v of vars) {
                    stCode += `    ${v.name} : ${v.type};${v.comment ? ' // ' + v.comment : ''}\n`;
                }
                stCode += 'END_VAR\n\n';
            }
        }
        
        // Handle InOutVars
        if (interfaceData.InOutVars) {
            const vars = this.extractVariables(interfaceData.InOutVars);
            if (vars.length > 0) {
                stCode += 'VAR_IN_OUT\n';
                for (const v of vars) {
                    stCode += `    ${v.name} : ${v.type};${v.comment ? ' // ' + v.comment : ''}\n`;
                }
                stCode += 'END_VAR\n\n';
            }
        }
        
        // Handle LocalVars
        if (interfaceData.LocalVars) {
            const vars = this.extractVariables(interfaceData.LocalVars);
            if (vars.length > 0) {
                stCode += 'VAR\n';
                for (const v of vars) {
                    stCode += `    ${v.name} : ${v.type};${v.comment ? ' // ' + v.comment : ''}\n`;
                }
                stCode += 'END_VAR\n\n';
            }
        }
        
        // Handle TempVars
        if (interfaceData.TempVars) {
            const vars = this.extractVariables(interfaceData.TempVars);
            if (vars.length > 0) {
                stCode += 'VAR_TEMP\n';
                for (const v of vars) {
                    stCode += `    ${v.name} : ${v.type};${v.comment ? ' // ' + v.comment : ''}\n`;
                }
                stCode += 'END_VAR\n\n';
            }
        }
        
        return stCode;
    }

    private extractVariables(varsContainer: any): Array<{name: string, type: string, comment: string}> {
        const vars: Array<{name: string, type: string, comment: string}> = [];
        
        let varList = varsContainer.Variable;
        if (!varList) return vars;
        
        if (!Array.isArray(varList)) {
            varList = [varList];
        }
        
        for (const variable of varList) {
            let name = 'unnamed';
            let type = 'BOOL';
            let comment = '';
            
            // Try child elements first
            if (variable.Name) {
                name = this.getTextContent(variable.Name) || 'unnamed';
            } else if (variable.$ && variable.$.Name) {
                name = variable.$.Name;
            }
            
            if (variable.Type) {
                type = this.getTextContent(variable.Type) || 'BOOL';
            } else if (variable.$ && variable.$.Type) {
                type = variable.$.Type;
            }
            
            if (variable.Comment) {
                comment = this.getTextContent(variable.Comment) || '';
            } else if (variable.$ && variable.$.Comment) {
                comment = variable.$.Comment;
            }
            
            vars.push({ name, type, comment });
        }
        
        return vars;
    }

    private parseDutDeclaration(stContent: string): { name?: string; kind?: string } {
        const normalized = stContent.replace(/\r/g, '').trim();
        const headerMatch = normalized.match(/^TYPE\s+([A-Za-z_]\w*)\s*:\s*/i);
        const name = headerMatch?.[1];
        const afterHeader = headerMatch ? normalized.slice(headerMatch[0].length).trim() : normalized;

        if (/^STRUCT\b/i.test(afterHeader)) {
            return { name, kind: 'STRUCT' };
        }
        if (/^\(/.test(afterHeader)) {
            return { name, kind: 'ENUM' };
        }

        const aliasMatch = afterHeader.match(/^([A-Za-z_]\w*)/);
        return { name, kind: aliasMatch?.[1]?.toUpperCase() };
    }

    private buildDutDeclarationFromFields(dutData: any): string {
        let name = 'UnknownType';
        if (dutData.Name) {
            name = this.getTextContent(dutData.Name) || 'UnknownType';
        } else if (dutData.$ && dutData.$.Name) {
            name = dutData.$.Name;
        }

        let dutType = 'STRUCT';
        if (dutData.Type) {
            dutType = this.getTextContent(dutData.Type) || 'STRUCT';
        } else if (dutData.$ && dutData.$.Type) {
            dutType = dutData.$.Type;
        }

        const normalizedType = dutType.trim().toUpperCase();
        const fields = this.ensureArray(dutData.Fields?.Field);
        const lines: string[] = [`TYPE ${name} :`];

        if (normalizedType === 'STRUCT') {
            lines.push('STRUCT');
            for (const field of fields) {
                const fieldName = field.Name ? this.getTextContent(field.Name) : (field.$?.Name || 'unnamed');
                const fieldType = field.Type ? this.getTextContent(field.Type) : (field.$?.Type || 'INT');
                const fieldComment = field.Comment ? this.getTextContent(field.Comment) : '';
                const commentStr = fieldComment ? ` // ${fieldComment}` : '';
                lines.push(`    ${fieldName} : ${fieldType};${commentStr}`);
            }
            lines.push('END_STRUCT');
            lines.push('END_TYPE');
            return lines.join('\n') + '\n';
        }

        lines.push(normalizedType);
        lines.push('END_TYPE');
        return lines.join('\n') + '\n';
    }

    private generateImplementation(implementationData: any): string {
        if (!implementationData) return '';

        let content = '';
        if (typeof implementationData.ST === 'string') {
            content = implementationData.ST;
        } else if (implementationData.ST?._ && typeof implementationData.ST._ === 'string') {
            content = implementationData.ST._;
        }

        content = content.trim();

        // Only remove top-level POU wrappers, not VAR blocks inside methods/actions
        content = content.replace(/^PROGRAM\s+\w+|FUNCTION_BLOCK\s+\w+|FUNCTION\s+\w+/i, '');
        content = content.replace(/END_PROGRAM|END_FUNCTION_BLOCK|END_FUNCTION/i, '');

        return content.trim();
    }

    private ensureArray(obj: any): any[] {
        if (!obj) return [];
        if (Array.isArray(obj)) return obj;
        return [obj];
    }

    private generateTcPlcObjectStructure(plcData: any): string {
        let stCode = '';
        
        // Try to get POU data from various possible locations
        let pouData = plcData.POU || plcData.TcPOU;
        let dutData = plcData.DUT || plcData.TcDUT;
        let gvlData = plcData.GVL || plcData.TcGVL;
        let itfData = plcData.Itf || plcData.ITF || plcData.TcIO || plcData.TcITF || plcData.TcItf;
        
        // If no nested structure, check if data is directly in TcPlcObject fields
        if (!pouData && !dutData && !gvlData && !itfData) {
            // Check for TcPlcObject_POU_* fields
            if (plcData.TcPlcObject_POU_Declaration || plcData.TcPlcObject_POU_Implementation_ST) {
                pouData = {
                    Declaration: plcData.TcPlcObject_POU_Declaration,
                    Implementation: { ST: plcData.TcPlcObject_POU_Implementation_ST }
                };
            }
        }
        
        if (pouData) {
            // Get declaration which contains VAR sections
            let declaration = '';
            if (pouData.Declaration) {
                declaration = this.getTextContent(pouData.Declaration);
            } else if (pouData.TcPlcObject_POU_Declaration) {
                declaration = this.getTextContent(pouData.TcPlcObject_POU_Declaration);
            }
            
            // Get implementation
            let implementation = '';
            if (pouData.Implementation && pouData.Implementation.ST) {
                implementation = this.getTextContent(pouData.Implementation.ST);
            } else if (pouData.TcPlcObject_POU_Implementation_ST) {
                implementation = this.getTextContent(pouData.TcPlcObject_POU_Implementation_ST);
            }
            
            // Extract POU header from declaration
            let pouHeader = 'FUNCTION_BLOCK Main';
            const headerMatch = declaration.match(/(PROGRAM|FUNCTION_BLOCK|FUNCTION)\s+(\w+)/);
            if (headerMatch) {
                pouHeader = `${headerMatch[1]} ${headerMatch[2]}`;
            }
            
            stCode += `${pouHeader}\n\n`;
            
            // Extract VAR sections from declaration
            const varSections = declaration.match(/VAR[\s\S]*?END_VAR/g);
            if (varSections) {
                for (const section of varSections) {
                    stCode += `${section}\n\n`;
                }
            }
            
            // Add implementation
            if (implementation) {
                // Clean up implementation
                let cleanedImpl = implementation.trim();
                // Remove duplicate VAR sections and end markers
                cleanedImpl = cleanedImpl.replace(/^PROGRAM\s+[\w\s]+[\s\S]*?VAR_INPUT[\s\S]*?END_VAR\s*/i, '');
                cleanedImpl = cleanedImpl.replace(/VAR_OUTPUT[\s\S]*?END_VAR\s*/i, '');
                cleanedImpl = cleanedImpl.replace(/VAR_IN_OUT[\s\S]*?END_VAR\s*/i, '');
                cleanedImpl = cleanedImpl.replace(/VAR_TEMP[\s\S]*?END_VAR\s*/i, '');
                cleanedImpl = cleanedImpl.replace(/VAR[\s\S]*?END_VAR\s*/i, '');
                cleanedImpl = cleanedImpl.replace(/END_PROGRAM\s*$/i, '');
                cleanedImpl = cleanedImpl.replace(/END_FUNCTION_BLOCK\s*$/i, '');
                cleanedImpl = cleanedImpl.replace(/END_FUNCTION\s*$/i, '');
                stCode += cleanedImpl.trim();
            }
            
            return stCode;
        } else if (dutData) {
            return this.generateDUTStructure(dutData);
        } else if (gvlData) {
            return this.generateGVLStructure(gvlData);
        } else if (itfData) {
            return this.generateInterfaceObjectStructure(itfData);
        } else {
            // Try to find any known type
            for (const key of Object.keys(plcData)) {
                if (key === 'POU' || key === 'DUT' || key === 'GVL' || key === 'TcPOU') {
                    return this.generatePOUStructure(plcData[key], key);
                }
                if (key === 'Itf' || key === 'ITF' || key === 'TcIO' || key === 'TcITF' || key === 'TcItf') {
                    return this.generateInterfaceObjectStructure(plcData[key]);
                }
            }
            return '// TcPlcObject contains unknown type\n';
        }
    }

    private generateErrorOutput(error: Error): string {
        return `// Error converting XML to IEC ST\n// ${error.message}\n`;
    }

    private prependOriginalXmlDeclaration(xml: string, originalXml: string): string {
        const match = originalXml.match(/^\uFEFF?\s*(<\?xml[\s\S]*?\?>)/i);
        if (!match) {
            return xml;
        }

        const declaration = match[1].trim();
        const body = xml.replace(/^\uFEFF?\s*/, '');
        return `${declaration}\n${body}`;
    }

    private preserveOriginalCDataWrappers(xml: string, originalXml: string): string {
        let output = xml;
        for (const tagName of ['Declaration', 'ST']) {
            if (!this.originalUsesCDataForTag(originalXml, tagName)) {
                continue;
            }
            output = this.forceTagContentToCData(output, tagName);
        }
        return output;
    }

    private originalUsesCDataForTag(xml: string, tagName: string): boolean {
        const pattern = new RegExp(`<${tagName}\\b[^>]*>\\s*<!\\[CDATA\\[`, 'i');
        return pattern.test(xml);
    }

    private forceTagContentToCData(xml: string, tagName: string): string {
        const pattern = new RegExp(`<${tagName}(\\b[^>]*)>([\\s\\S]*?)<\\/${tagName}>`, 'g');
        return xml.replace(pattern, (full: string, attrs: string, inner: string) => {
            if (inner.trimStart().startsWith('<![CDATA[')) {
                return full;
            }
            if (/<[A-Za-z_]/.test(inner)) {
                return full;
            }

            const decoded = this.decodeXmlEntities(inner);
            const safe = decoded.replace(/]]>/g, ']]]]><![CDATA[>');
            return `<${tagName}${attrs}><![CDATA[${safe}]]></${tagName}>`;
        });
    }

    private decodeXmlEntities(text: string): string {
        return text
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, '\'')
            .replace(/&amp;/g, '&');
    }
}
