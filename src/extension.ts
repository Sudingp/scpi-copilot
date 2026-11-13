/**
 * SCPI Copilot: write, check, generate and run SCPI scripts for a bench instrument from VS Code.
 *
 *   SCPI: Connect to Instrument        TCP to host:port (settings scpi.host, scpi.port)
 *   SCPI: Send Command                 one command or query, reply in the "SCPI" output panel
 *   SCPI: Run Script                   the open .scpi file, checked first, errors read after each line
 *   SCPI: Generate Script from Request plain English -> LLM draft -> validated -> opened for review
 *   SCPI: Set LLM API Key              stored in VS Code's SecretStorage, never in settings or files
 *
 * .scpi files get syntax colouring, live error squiggles and hover help from shared/commands.json.
 */

import * as vscode from "vscode";
import * as path from "path";
import { ScpiClient } from "./client";
import { generate } from "./generate";
import { formatSteps, runScript } from "./runner";
import { checkCommand, checkScript, loadTable, Table } from "./scpi/table";

const SECRET = "scpi.llmApiKey";
let client: ScpiClient | undefined;
let status: vscode.StatusBarItem;
let output: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
    const table = loadTable(path.join(context.extensionPath, "shared", "commands.json"));
    output = vscode.window.createOutputChannel("SCPI");
    status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    status.command = "scpi.connect";
    setStatus(undefined);
    status.show();

    const diagnostics = vscode.languages.createDiagnosticCollection("scpi");
    const refresh = (doc: vscode.TextDocument) => {
        if (doc.languageId === "scpi") diagnostics.set(doc.uri, toDiagnostics(table, doc));
    };
    vscode.workspace.textDocuments.forEach(refresh);

    context.subscriptions.push(
        output, status, diagnostics,
        vscode.workspace.onDidOpenTextDocument(refresh),
        vscode.workspace.onDidChangeTextDocument(e => refresh(e.document)),
        vscode.workspace.onDidCloseTextDocument(d => diagnostics.delete(d.uri)),
        vscode.languages.registerHoverProvider("scpi", { provideHover: (doc, pos) => hover(table, doc, pos) }),
        vscode.commands.registerCommand("scpi.connect", connect),
        vscode.commands.registerCommand("scpi.disconnect", disconnect),
        vscode.commands.registerCommand("scpi.sendCommand", () => sendCommand(table)),
        vscode.commands.registerCommand("scpi.runScript", () => runActive(table)),
        vscode.commands.registerCommand("scpi.generate", () => generateScript(context, table)),
        vscode.commands.registerCommand("scpi.setApiKey", () => setApiKey(context)),
    );
}

export function deactivate() {
    client?.close();
}

function setStatus(idn: string | undefined) {
    status.text = idn ? `$(plug) SCPI: ${idn.split(",").slice(0, 2).join(" ")}` : "$(debug-disconnect) SCPI: not connected";
    status.tooltip = idn ?? "Click to connect to an instrument";
}

function settings() {
    const c = vscode.workspace.getConfiguration("scpi");
    return { host: c.get<string>("host", "127.0.0.1"), port: c.get<number>("port", 5025),
             timeoutMs: c.get<number>("timeoutMs", 2000),
             baseUrl: c.get<string>("llm.baseUrl", "https://api.groq.com/openai/v1"),
             model: c.get<string>("llm.model", "openai/gpt-oss-20b") };
}

async function connect() {
    const s = settings();
    client?.close();
    const c = new ScpiClient(s.host, s.port, s.timeoutMs);
    try {
        await c.connect();
        const idn = await c.query("*IDN?");
        client = c;
        setStatus(idn);
        output.appendLine(`Connected to ${s.host}:${s.port}: ${idn}`);
    } catch (e) {
        c.close();
        setStatus(undefined);
        vscode.window.showErrorMessage(`Could not connect to ${s.host}:${s.port}: ${(e as Error).message}`);
    }
}

function disconnect() {
    client?.close();
    client = undefined;
    setStatus(undefined);
}

async function needClient(): Promise<ScpiClient | undefined> {
    if (!client?.connected) await connect();
    return client?.connected ? client : undefined;
}

async function sendCommand(table: Table) {
    const text = await vscode.window.showInputBox({
        prompt: "SCPI command or query", placeHolder: "MEAS:VOLT:DC?",
        validateInput: v => {
            const r = checkCommand(table, v);
            return v.trim() && !r.ok ? `${r.error!.code}: ${r.error!.message}` : undefined;
        },
    });
    if (!text) return;
    const c = await needClient();
    if (!c) return;
    output.show(true);
    output.appendLine(formatSteps(await runScript(c, table, text)));
}

async function runActive(table: Table) {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc) return void vscode.window.showWarningMessage("Open a .scpi file first.");
    const c = await needClient();
    if (!c) return;
    output.show(true);
    output.appendLine(`--- ${path.basename(doc.fileName)} ---`);
    const steps = await runScript(c, table, doc.getText());
    output.appendLine(formatSteps(steps));
    const failed = steps.some(s => s.errors.length);
    output.appendLine(failed ? "Stopped: see the errors above." : "Done, no errors.");
}

async function setApiKey(context: vscode.ExtensionContext) {
    const key = await vscode.window.showInputBox({ prompt: "API key for the LLM provider", password: true,
                                                    ignoreFocusOut: true });
    if (key) {
        await context.secrets.store(SECRET, key.trim());
        vscode.window.showInformationMessage("API key saved in VS Code's secret storage.");
    }
}

async function generateScript(context: vscode.ExtensionContext, table: Table) {
    const apiKey = await context.secrets.get(SECRET);
    if (!apiKey) return void vscode.window.showWarningMessage("Run \"SCPI: Set LLM API Key\" first.");
    const request = await vscode.window.showInputBox({
        prompt: "What should the instrument do?", placeHolder: "Take 10 DC voltage readings with low noise",
        ignoreFocusOut: true,
    });
    if (!request) return;
    const s = settings();
    try {
        const g = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: "Drafting SCPI script..." },
            () => generate(request, table, { baseUrl: s.baseUrl, model: s.model, apiKey }));
        if (g.refused) return void vscode.window.showWarningMessage(`Not generated: ${g.reason}`);
        const header = [`# Request: ${request}`, `# Drafted by ${s.model}; review before running (SCPI: Run Script).`];
        if (!g.valid) header.push("# WARNING: still invalid after one correction:", ...g.problems.map(p => `#   ${p}`));
        const doc = await vscode.workspace.openTextDocument({ language: "scpi",
                                                               content: [...header, ...g.script].join("\n") + "\n" });
        await vscode.window.showTextDocument(doc);
    } catch (e) {
        vscode.window.showErrorMessage(`Generation failed: ${(e as Error).message}`);
    }
}

function toDiagnostics(table: Table, doc: vscode.TextDocument): vscode.Diagnostic[] {
    return checkScript(table, doc.getText()).filter(c => !c.result.ok).map(c => {
        const d = new vscode.Diagnostic(new vscode.Range(c.line, c.start, c.line, c.end),
            `${c.result.error!.message} (SCPI error ${c.result.error!.code})`, vscode.DiagnosticSeverity.Error);
        d.source = "scpi";
        return d;
    });
}

function hover(table: Table, doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
    const hit = checkScript(table, doc.lineAt(pos.line).text)
        .find(c => pos.character >= c.start && pos.character <= c.end && c.result.command);
    if (!hit) return undefined;
    const cmd = hit.result.command!;
    return new vscode.Hover(new vscode.MarkdownString(
        `**${cmd.pattern}${cmd.query === "only" ? "?" : ""}**\n\n${cmd.help}` +
        (hit.result.canonical ? `\n\nFull form: \`${hit.result.canonical}\`` : "")));
}
