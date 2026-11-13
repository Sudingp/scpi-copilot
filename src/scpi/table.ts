/**
 * SCPI command table, header matching and parameter checks.
 *
 * The table lives in shared/commands.json and is read by both this extension and the Python
 * instrument simulator, so the editor and the instrument can never disagree about what is valid.
 *
 * SCPI rules implemented here:
 *  - mnemonics have a short form (the uppercase letters) and a long form; either is accepted,
 *    in any letter case ("VOLT", "VOLTage", "volt");
 *  - nodes in [brackets] are optional ("MEAS:VOLT?" means "MEASure:VOLTage:DC?");
 *  - a trailing "?" makes a query;
 *  - parameters follow a space and are separated by commas.
 */

import * as fs from "fs";
import * as path from "path";

export type ParamSpec =
    | { kind: "range"; min: number; max: number; optional?: boolean }
    | { kind: "int"; min: number; max: number; optional?: boolean }
    | { kind: "choice"; values: string[]; optional?: boolean };

export interface CommandSpec {
    pattern: string;
    query: "only" | "never" | "both";
    params: ParamSpec[];
    help: string;
}

export interface Table {
    instrument: string;
    notes: string;
    commands: CommandSpec[];
    errors: Record<string, string>;
}

interface Node { mnemonic: string; optional: boolean }

export interface Checked {
    ok: boolean;
    text: string;                 // the command as written
    canonical?: string;           // long form, all optional nodes, normalised parameters
    command?: CommandSpec;
    isQuery: boolean;
    error?: { code: number; message: string };
}

const KEYWORDS = ["MINimum", "MAXimum", "DEFault", "AUTO"];
const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

export function loadTable(file?: string): Table {
    const f = file ?? path.join(__dirname, "..", "..", "shared", "commands.json");
    return JSON.parse(fs.readFileSync(f, "utf8")) as Table;
}

export function parsePattern(pattern: string): Node[] {
    const nodes: Node[] = [];
    let i = 0;
    while (i < pattern.length) {
        if (pattern[i] === ":") { i++; continue; }
        if (pattern[i] === "[") {
            const end = pattern.indexOf("]", i);
            pattern.slice(i + 1, end).split(":").filter(Boolean)
                .forEach(m => nodes.push({ mnemonic: m, optional: true }));
            i = end + 1;
            continue;
        }
        let j = i;
        while (j < pattern.length && pattern[j] !== ":" && pattern[j] !== "[") j++;
        nodes.push({ mnemonic: pattern.slice(i, j), optional: false });
        i = j;
    }
    return nodes;
}

export function shortForm(mnemonic: string): string {
    const s = mnemonic.replace(/[a-z]/g, "");
    return s.length ? s : mnemonic.toUpperCase();
}

export function mnemonicMatches(mnemonic: string, word: string): boolean {
    const w = word.toUpperCase();
    return w === shortForm(mnemonic) || w === mnemonic.toUpperCase();
}

function matchNodes(pat: Node[], words: string[]): boolean {
    if (pat.length === 0) return words.length === 0;
    const [head, ...rest] = pat;
    if (words.length && mnemonicMatches(head.mnemonic, words[0]) && matchNodes(rest, words.slice(1))) return true;
    return head.optional && matchNodes(rest, words);
}

export function canonicalHeader(pattern: string): string {
    return parsePattern(pattern).map(n => n.mnemonic.toUpperCase()).join(":");
}

function normaliseKeyword(word: string): string | undefined {
    const k = KEYWORDS.find(k => mnemonicMatches(k, word));
    return k?.toUpperCase();
}

function checkParam(spec: ParamSpec, raw: string): { value?: string; code?: number; message?: string } {
    const v = raw.trim();
    if (spec.kind === "choice") {
        const hit = spec.values.find(c => NUMBER.test(c) && NUMBER.test(v) ? Number(c) === Number(v) : mnemonicMatches(c, v));
        return hit ? { value: NUMBER.test(hit) ? String(Number(hit)) : hit.toUpperCase() }
            : { code: -224, message: `"${v}" is not one of ${spec.values.join(", ")}` };
    }
    const kw = normaliseKeyword(v);
    if (kw && !(kw === "AUTO" && spec.kind === "int")) return { value: kw };
    if (!NUMBER.test(v)) return { code: -224, message: `"${v}" is not a number` };
    const n = Number(v);
    if (spec.kind === "int" && !Number.isInteger(n)) return { code: -224, message: `"${v}" must be a whole number` };
    if (n < spec.min || n > spec.max) return { code: -222, message: `${v} is outside ${spec.min} to ${spec.max}` };
    return { value: String(n) };
}

/** Check one command (no ";"). */
export function checkCommand(table: Table, text: string): Checked {
    const t = text.trim();
    const m = /^(\S+)(?:\s+(.*))?$/.exec(t);
    if (!m) return { ok: false, text, isQuery: false, error: { code: -100, message: "empty command" } };
    let header = m[1];
    const isQuery = header.endsWith("?");
    if (isQuery) header = header.slice(0, -1);
    const words = header.replace(/^:/, "").split(":");
    const command = table.commands.find(c => matchNodes(parsePattern(c.pattern), words));
    if (!command) return { ok: false, text, isQuery, error: { code: -113, message: `unknown command "${m[1]}"` } };
    if (isQuery && command.query === "never")
        return { ok: false, text, isQuery, command, error: { code: -113, message: `${command.pattern} has no query form` } };
    if (!isQuery && command.query === "only")
        return { ok: false, text, isQuery, command, error: { code: -113, message: `${command.pattern} is a query: add "?"` } };

    const raw = m[2] ? m[2].split(",").map(s => s.trim()) : [];
    const specs = isQuery && command.query === "both" ? [] : command.params;
    if (raw.length > specs.length)
        return { ok: false, text, isQuery, command, error: { code: -108, message: `too many parameters for ${command.pattern}` } };
    const values: string[] = [];
    for (let i = 0; i < specs.length; i++) {
        if (i >= raw.length) {
            if (specs[i].optional) break;
            return { ok: false, text, isQuery, command, error: { code: -109, message: `${command.pattern} needs a parameter` } };
        }
        const r = checkParam(specs[i], raw[i]);
        if (r.code !== undefined) return { ok: false, text, isQuery, command, error: { code: r.code, message: r.message! } };
        values.push(r.value!);
    }
    const canonical = canonicalHeader(command.pattern) + (isQuery ? "?" : "") + (values.length ? " " + values.join(",") : "");
    return { ok: true, text, isQuery, command, canonical };
}

export interface LineResult { line: number; start: number; end: number; result: Checked }

/** Check a script: one or more commands per line separated by ";", "#" starts a comment. */
export function checkScript(table: Table, script: string): LineResult[] {
    const out: LineResult[] = [];
    script.split(/\r?\n/).forEach((lineText, line) => {
        const code = lineText.split("#")[0];
        let offset = 0;
        for (const part of code.split(";")) {
            const lead = part.length - part.trimStart().length;
            if (part.trim()) {
                out.push({ line, start: offset + lead, end: offset + part.trimEnd().length,
                           result: checkCommand(table, part) });
            }
            offset += part.length + 1;
        }
    });
    return out;
}

export function describeTable(table: Table): string {
    return table.commands.map(c => {
        const q = c.query === "only" ? "? (query only)" : c.query === "both" ? " (also ?)" : "";
        const p = c.params.map(s => s.kind === "choice" ? `<${s.values.join("|")}>`
            : `<${s.kind} ${s.min}..${s.max}${"optional" in s && s.optional ? ", optional" : ""}>`).join(",");
        return `${c.pattern}${q}${p ? " " + p : ""}  -- ${c.help}`;
    }).join("\n");
}
