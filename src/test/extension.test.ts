/**
 * Runs the real extension.ts against a stand-in for the VS Code API (no editor needed): checks
 * that activation registers every command, that .scpi documents get diagnostics, and that
 * Connect + Run Script talk to the simulator and write results to the output panel.
 */
import * as assert from "assert";
import { ChildProcess, spawn } from "child_process";
import * as path from "path";
const Module = require("module");

const PY = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");

function fakeVscode(port: number, docText: string) {
    const commands = new Map<string, Function>();
    const diagnostics = new Map<string, any[]>();
    const outputLines: string[] = [];
    const messages: string[] = [];
    const doc = { languageId: "scpi", uri: { toString: () => "file:///t.scpi" }, fileName: "t.scpi",
                  getText: () => docText, lineAt: (n: number) => ({ text: docText.split("\n")[n] }) };
    class Range { constructor(public a: number, public b: number, public c: number, public d: number) {} }
    class Diagnostic { source?: string; constructor(public range: Range, public message: string, public severity: number) {} }
    const api = {
        Range, Diagnostic, DiagnosticSeverity: { Error: 0 }, StatusBarAlignment: { Left: 1 },
        ProgressLocation: { Notification: 15 },
        Hover: class { constructor(public contents: any) {} },
        MarkdownString: class { constructor(public value: string) {} },
        window: {
            createOutputChannel: () => ({ appendLine: (l: string) => outputLines.push(l), show: () => {}, dispose: () => {} }),
            createStatusBarItem: () => ({ show: () => {}, dispose: () => {}, text: "", tooltip: "" }),
            showErrorMessage: (m: string) => messages.push("error: " + m),
            showWarningMessage: (m: string) => messages.push("warning: " + m),
            showInformationMessage: (m: string) => messages.push("info: " + m),
            get activeTextEditor() { return { document: doc }; },
        },
        workspace: {
            textDocuments: [doc],
            getConfiguration: () => ({ get: (k: string, d: any) => (k === "port" ? port : k === "timeoutMs" ? 800 : d) }),
            onDidOpenTextDocument: () => ({ dispose() {} }), onDidChangeTextDocument: () => ({ dispose() {} }),
            onDidCloseTextDocument: () => ({ dispose() {} }),
        },
        languages: {
            createDiagnosticCollection: () => ({ set: (u: any, d: any[]) => diagnostics.set(u.toString(), d),
                                                 delete() {}, dispose() {} }),
            registerHoverProvider: () => ({ dispose() {} }),
        },
        commands: { registerCommand: (id: string, fn: Function) => { commands.set(id, fn); return { dispose() {} }; } },
    };
    return { api, commands, diagnostics, outputLines, messages };
}

describe("extension.ts with a stand-in VS Code API", function () {
    this.timeout(15000);
    let sim: ChildProcess;
    let port = 0;
    before(function (done) {
        sim = spawn(PY, [path.join(__dirname, "..", "..", "instrument", "sim_dmm.py"), "--port", "0"]);
        sim.on("error", () => this.skip());
        sim.stdout!.on("data", (d: Buffer) => {
            const m = /:(\d+) \(/.exec(d.toString());
            if (m && !port) { port = Number(m[1]); done(); }
        });
    });
    after(() => sim?.kill());

    function load(docText: string) {
        const fake = fakeVscode(port, docText);
        const orig = Module._load;
        Module._load = function (req: string, ...rest: any[]) {
            return req === "vscode" ? fake.api : orig.call(this, req, ...rest);
        };
        const extPath = require.resolve("../extension");
        delete require.cache[extPath];
        const ext = require("../extension");
        Module._load = orig;
        const subs: any[] = [];
        ext.activate({ extensionPath: path.join(__dirname, "..", ".."), subscriptions: subs,
                       secrets: { get: async () => undefined, store: async () => {} } });
        return { ext, ...fake };
    }

    it("registers every command declared in package.json", () => {
        const { commands, ext } = load("*IDN?");
        const declared = require("../../package.json").contributes.commands.map((c: any) => c.command);
        assert.deepStrictEqual([...commands.keys()].sort(), declared.sort());
        ext.deactivate();
    });

    it("flags invalid lines in an open .scpi document", () => {
        const { diagnostics, ext } = load("*RST\nSAMP:COUN 0\nSOUR:VOLT 5");
        const d = diagnostics.get("file:///t.scpi")!;
        assert.strictEqual(d.length, 2);
        assert.match(d[0].message, /SCPI error -222/);
        ext.deactivate();
    });

    it("connects and runs the open script against the instrument", async () => {
        const { commands, outputLines, ext } = load("*RST\nCONF:VOLT:DC 10\nSAMP:COUN 2\nREAD?");
        await commands.get("scpi.connect")!();
        await commands.get("scpi.runScript")!();
        const text = outputLines.join("\n");
        assert.match(text, /SIMLAB,DMM-SIM/);
        assert.match(text, /READ\?\n\s+-> [+-]\d\.\d+E\+00,[+-]\d/);
        assert.match(text, /Done, no errors/);
        ext.deactivate();
    });

    it("asks for an API key before generating", async () => {
        const { commands, messages, ext } = load("");
        await commands.get("scpi.generate")!();
        assert.match(messages[0], /Set LLM API Key/);
        ext.deactivate();
    });
});
