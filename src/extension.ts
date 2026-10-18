// Copyright (c) FIRST and other WPILib contributors.
// Open Source Software; you can modify and/or share it under the terms of
// the WPILib BSD license file in the root directory of this project.

import * as vscode from 'vscode';

interface RemoteInclude {
  line: number;
  indent: number;
  url: string;
  options: Map<string, string | undefined>;
}

interface DisplayLine {
  text: string;
  sourceLine: number;
}

export function activate(context: vscode.ExtensionContext): void {
  const selector: vscode.DocumentSelector = { language: 'restructuredtext' };

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(selector, {
      provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        return findIncludes(document).map(include => {
          const range = new vscode.Range(include.line, 0, include.line, 0);
          return new vscode.CodeLens(range, {
            title: 'Preview remote include',
            command: 'sphinxRemoteLiteralInclude.preview',
            arguments: [document.uri.toString(), include.line]
          });
        });
      }
    }),
    vscode.commands.registerCommand(
      'sphinxRemoteLiteralInclude.preview',
      async (documentUri?: string | vscode.Uri, directiveLine?: number) => {
        await previewInclude(documentUri, directiveLine);
      }
    )
  );
}

export function deactivate(): void {}

function findIncludes(document: vscode.TextDocument): RemoteInclude[] {
  const includes: RemoteInclude[] = [];
  const directivePattern = /^(\s*)\.\.\s+(?:rli|remoteliteralinclude)::\s*(\S+)\s*$/;

  for (let line = 0; line < document.lineCount; line++) {
    const match = directivePattern.exec(document.lineAt(line).text);
    if (!match) {
      continue;
    }

    const indent = match[1].length;
    const options = new Map<string, string | undefined>();
    for (let optionLine = line + 1; optionLine < document.lineCount; optionLine++) {
      const text = document.lineAt(optionLine).text;
      if (text.trim() === '') {
        continue;
      }

      const indentation = /^\s*/.exec(text)?.[0].length ?? 0;
      if (indentation <= indent) {
        break;
      }

      const optionMatch = /^\s*:([\w-]+):(?:\s*(.*))?$/.exec(text);
      if (optionMatch) {
        options.set(optionMatch[1], optionMatch[2]?.trim());
      }
    }

    includes.push({ line, indent, url: match[2], options });
  }

  return includes;
}

async function previewInclude(
  documentUri?: string | vscode.Uri,
  directiveLine?: number
): Promise<void> {
  try {
    const document = documentUri
      ? await vscode.workspace.openTextDocument(
          typeof documentUri === 'string' ? vscode.Uri.parse(documentUri) : documentUri
        )
      : vscode.window.activeTextEditor?.document;

    if (!document) {
      throw new Error('Open a reStructuredText document and place the cursor near a remote include.');
    }

    const requestedLine = directiveLine ?? vscode.window.activeTextEditor?.selection.active.line ?? 0;
    const includes = findIncludes(document);
    const include = includes.find(candidate => candidate.line === requestedLine)
      ?? [...includes].reverse().find(candidate => candidate.line <= requestedLine)
      ?? includes[0];

    if (!include) {
      throw new Error('No .. rli:: or .. remoteliteralinclude:: directive was found in this document.');
    }

    const url = new URL(include.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Remote includes must use an HTTP or HTTPS URL.');
    }

    const timeout = vscode.workspace
      .getConfiguration('sphinxRemoteLiteralInclude')
      .get<number>('requestTimeout', 15000);
    const response = await fetchRemote(url.toString(), timeout);
    const source = await response.text();
    const selectedLines = selectLines(source, include.options);
    const allLines = splitSourceLines(source);
    const html = renderPreview(include.url, allLines, selectedLines, include.options);

    const panel = vscode.window.createWebviewPanel(
      'sphinxRemoteLiteralInclude.preview',
      `Remote Include: ${url.hostname}`,
      vscode.ViewColumn.Beside,
      { enableScripts: true }
    );
    panel.webview.html = html;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Remote literalinclude preview failed: ${message}`);
  }
}

async function fetchRemote(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'vscode-sphinx-remote-literalinclude' },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status} ${response.statusText}`);
    }
    return response;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Request timed out after ${timeoutMs} ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function selectLines(source: string, options: Map<string, string | undefined>): DisplayLine[] {
  let lines = splitSourceLines(source);
  const tabWidth = parseOptionalInteger(options.get('tab-width'));
  if (tabWidth !== undefined && tabWidth > 0) {
    lines = lines.map(line => ({ ...line, text: line.text.replace(/\t/g, ' '.repeat(tabWidth)) }));
  }

  const startAt = options.get('start-at');
  const startAfter = options.get('start-after');
  if (startAt !== undefined || startAfter !== undefined) {
    const pattern = startAt ?? startAfter!;
    const foundAt = lines.findIndex(line => line.text.includes(pattern));
    if (foundAt < 0) {
      return [];
    }
    lines = lines.slice(startAt !== undefined ? foundAt : foundAt + 1);
  }

  const endAt = options.get('end-at');
  const endBefore = options.get('end-before');
  if (endAt !== undefined || endBefore !== undefined) {
    const pattern = endAt ?? endBefore!;
    const foundAt = lines.findIndex(line => line.text.includes(pattern));
    if (foundAt < 0) {
      return [];
    }
    lines = lines.slice(0, foundAt + (endAt !== undefined ? 1 : 0));
  }

  const linesOption = options.get('lines');
  if (linesOption) {
    const indexes = parseLineSpec(linesOption, lines.length, true);
    lines = indexes.map(index => {
      return lines[index - 1];
    });
  }

  const dedent = parseOptionalInteger(options.get('dedent'));
  if (dedent !== undefined) {
    const nonEmptyIndentations = lines
      .filter(line => line.text.trim())
      .map(line => line.text.match(/^ */)?.[0].length ?? 0);
    const indentation = dedent > 0
      ? dedent
      : (nonEmptyIndentations.length > 0 ? Math.min(...nonEmptyIndentations) : 0);
    if (indentation > 0) {
      lines = lines.map(line => ({ ...line, text: line.text.slice(indentation) }));
    }
  }

  return lines;
}

function splitSourceLines(source: string): DisplayLine[] {
  if (source.length === 0) {
    return [];
  }
  const rawLines = source.split(/\r\n|\n|\r/);
  if (/(?:\r\n|\n|\r)$/.test(source)) {
    rawLines.pop();
  }
  return rawLines.map((text, index) => ({ text, sourceLine: index + 1 }));
}

function parseLineSpec(spec: string, maximum?: number, ignoreOutOfRange = false): number[] {
  const result: number[] = [];
  for (const part of spec.split(',')) {
    const token = part.trim();
    const range = /^(\d+)\s*-\s*(\d*)$/.exec(token);
    if (range) {
      const start = Number(range[1]);
      const requestedEnd = range[2] ? Number(range[2]) : (maximum ?? Number.MAX_SAFE_INTEGER);
      if (start < 1 || (range[2] && requestedEnd < start)) {
        throw new Error(`Invalid line range: ${token}`);
      }
      if (maximum !== undefined && start > maximum && !ignoreOutOfRange) {
        throw new Error(`Line number ${start} is out of range (1-${maximum}).`);
      }
      if (maximum !== undefined && start > maximum) {
        continue;
      }
      const end = maximum === undefined ? requestedEnd : Math.min(requestedEnd, maximum);
      for (let line = start; line <= end && (maximum === undefined || line <= maximum); line++) {
        result.push(line);
      }
      continue;
    }

    const line = Number(token);
    if (!Number.isInteger(line) || line < 1) {
      throw new Error(`Invalid line selection: ${token}`);
    }
    if (maximum !== undefined && line > maximum) {
      if (ignoreOutOfRange) {
        continue;
      }
      throw new Error(`Line number ${line} is out of range (1-${maximum}).`);
    }
    result.push(line);
  }
  return result;
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Expected an integer option value, got: ${value}`);
  }
  return parsed;
}

function renderPreview(
  url: string,
  allLines: DisplayLine[],
  selectedLines: DisplayLine[],
  options: Map<string, string | undefined>
): string {
  const includedSourceLines = new Set(selectedLines.map(line => line.sourceLine));
  const emphasizedLines = options.get('emphasize-lines')
    ? parseLineSpec(options.get('emphasize-lines')!, selectedLines.length, true)
      .map(index => selectedLines[index - 1].sourceLine)
    : [];
  const emphasizedSourceLines = new Set(emphasizedLines);
  const focusSourceLine = selectedLines.length > 0
    ? selectedLines[Math.floor(selectedLines.length / 2)].sourceLine
    : undefined;
  const nonce = Math.random().toString(36).slice(2);
  if (linenoMatchAndStartConflict(options)) {
    throw new Error('The :lineno-match: and :lineno-start: options cannot be used together.');
  }
  const rows = allLines.map(line => {
    const includedClass = includedSourceLines.has(line.sourceLine) ? ' included' : '';
    const emphasizedClass = emphasizedSourceLines.has(line.sourceLine) ? ' emphasized' : '';
    const focusClass = focusSourceLine !== undefined && line.sourceLine === focusSourceLine ? ' focus' : '';
    return `<div class="line${includedClass}${emphasizedClass}${focusClass}"><span class="number">${line.sourceLine}</span><span class="code">${escapeHtml(line.text)}</span></div>`;
  }).join('\n');
  const language = options.get('language');
  const title = language ? `Language: ${escapeHtml(language)}` : 'Remote source';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Remote literalinclude preview</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 20px 24px; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
  header { margin-bottom: 16px; }
  h1 { margin: 0 0 6px; font-size: 1.15rem; font-weight: 600; }
  .url { color: var(--vscode-descriptionForeground); font-size: .9rem; overflow-wrap: anywhere; }
  .language { color: var(--vscode-descriptionForeground); font-size: .8rem; margin-top: 6px; }
  .source { max-height: calc(100vh - 130px); overflow: auto; border: 1px solid var(--vscode-panel-border, #444); border-radius: 6px; }
  .line { display: grid; grid-template-columns: 4.5em max-content; min-width: 100%; line-height: 1.55; font-family: var(--vscode-editor-font-family, Consolas, monospace); font-size: var(--vscode-editor-font-size, 13px); }
  .number { position: sticky; left: 0; padding: 0 12px 0 8px; text-align: right; color: var(--vscode-editorLineNumber-foreground); background: var(--vscode-editorGutter-background, var(--vscode-editor-background)); user-select: none; }
  .code { padding-right: 18px; white-space: pre; }
  .included { background: rgba(255, 220, 0, .35); }
  .included .number { color: #003366; background: rgba(255, 220, 0, .35); }
  .emphasized .code { font-weight: 700; }
</style>
</head>
<body>
<header><h1>Remote literalinclude</h1><div class="url">${escapeHtml(url)}</div><div class="language">${title}</div></header>
<div class="source" role="region" aria-label="Remote source with line numbers"><div>${rows}</div></div>
<script nonce="${nonce}">
  const source = document.querySelector('.source');
  const focus = document.querySelector('.focus');
  if (source && focus) {
    requestAnimationFrame(() => focus.scrollIntoView({ block: 'center', inline: 'nearest' }));
  }
</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => {
    switch (character) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

function linenoMatchAndStartConflict(options: Map<string, string | undefined>): boolean {
  return options.has('lineno-match') && options.has('lineno-start');
}
