/**
 * Score the LLM script drafting on evals/requests.jsonl (30 labelled requests).
 *
 *   set GROQ_API_KEY=...     (or LLM_API_KEY; optional LLM_BASE_URL, LLM_MODEL)
 *   npm run eval
 *
 * For each request: draft a script, then
 *   - valid:      every line passes the validator (after at most one repair);
 *   - match:      the canonical commands equal one of the reference scripts;
 *   - refusal:    requests the meter cannot do must be refused, and nothing else may be;
 *   - ran clean:  valid scripts are run on the simulated instrument (spawned here) and must
 *                 finish with an empty error queue.
 * Progress is saved to evals/results/progress.jsonl, so a run stopped by a rate limit continues.
 */

import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { ScpiClient } from "../client";
import { generate } from "../generate";
import { runScript } from "../runner";
import { checkCommand, loadTable } from "../scpi/table";

const ROOT = path.join(__dirname, "..", "..");
const table = loadTable();

interface Row { id: string; request: string; category: string; gold: string[][] | { refuse: true } }

function readEnvFile() {
    const f = path.join(ROOT, ".env");
    if (!fs.existsSync(f)) return;
    for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
        const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
}

function startSimulator(): Promise<{ port: number; stop: () => void }> {
    const py = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
    const p = spawn(py, [path.join(ROOT, "instrument", "sim_dmm.py"), "--port", "0"]);
    return new Promise((resolve, reject) => {
        p.on("error", reject);
        p.stdout.on("data", (d: Buffer) => {
            const m = /:(\d+) \(/.exec(d.toString());
            if (m) resolve({ port: Number(m[1]), stop: () => p.kill() });
        });
    });
}

const pct = (a: number, b: number) => (b ? Math.round(1000 * a / b) / 10 : 0);

async function main() {
    readEnvFile();
    const apiKey = process.env.GROQ_API_KEY ?? process.env.LLM_API_KEY;
    if (!apiKey) throw new Error("Set GROQ_API_KEY (or LLM_API_KEY) in the environment or a .env file");
    const cfg = { apiKey, baseUrl: process.env.LLM_BASE_URL ?? "https://api.groq.com/openai/v1",
                  model: process.env.LLM_MODEL ?? "openai/gpt-oss-20b" };
    const rows: Row[] = fs.readFileSync(path.join(ROOT, "evals", "requests.jsonl"), "utf8")
        .split("\n").filter(Boolean).map(l => JSON.parse(l));
    const outDir = path.join(ROOT, "evals", "results");
    fs.mkdirSync(outDir, { recursive: true });
    const progress = path.join(outDir, "progress.jsonl");
    const done = new Map<string, any>(fs.existsSync(progress)
        ? fs.readFileSync(progress, "utf8").split("\n").filter(Boolean).map(l => [JSON.parse(l).id, JSON.parse(l)])
        : []);

    const sim = await startSimulator();
    const results: any[] = [];
    try {
        for (const row of rows) {
            if (done.has(row.id)) { results.push(done.get(row.id)); continue; }
            let g;
            try {
                g = await generate(row.request, table, cfg);
            } catch (e) {
                const msg = String((e as Error).message);
                if (/429|rate limit/i.test(msg)) {
                    console.error(`Stopped at ${row.id}: rate limit. ${results.length} saved; run again later to continue.`);
                    return;
                }
                throw e;
            }
            const canonical = g.script.map(s => checkCommand(table, s).canonical ?? `INVALID ${s}`);
            const shouldRefuse = !Array.isArray(row.gold);
            const match = shouldRefuse ? g.refused
                : !g.refused && (row.gold as string[][]).some(alt => JSON.stringify(alt) === JSON.stringify(canonical));
            let ranClean: boolean | null = null;
            let runErrors: string[] = [];
            if (g.valid && !g.refused) {
                const c = new ScpiClient("127.0.0.1", sim.port, 1500);
                await c.connect();
                c.write("*RST;*CLS");
                const steps = await runScript(c, table, g.script.join("\n"));
                runErrors = steps.flatMap(s => s.errors);
                ranClean = runErrors.length === 0;
                c.close();
            }
            const r = { id: row.id, request: row.request, category: row.category, should_refuse: shouldRefuse,
                        refused: g.refused, reason: g.reason, script: g.script, canonical, valid: g.valid,
                        repaired: g.repaired, problems: g.problems, match, ran_clean: ranClean, run_errors: runErrors,
                        tokens_in: g.tokensIn, tokens_out: g.tokensOut, seconds: g.seconds };
            fs.appendFileSync(progress, JSON.stringify(r) + "\n");
            results.push(r);
            console.log(`${r.id} ${match ? "MATCH" : "miss "} ${g.refused ? "refused" : canonical.join(" ; ")}`);
            await new Promise(res => setTimeout(res, Number(process.env.PAUSE_MS ?? 1500)));
        }
    } finally {
        sim.stop();
    }

    const drafted = results.filter(r => !r.refused);
    const doable = results.filter(r => !r.should_refuse);
    const summary = {
        model: cfg.model, requests: results.length,
        match_pct: pct(results.filter(r => r.match).length, results.length),
        match_by_category: Object.fromEntries([...new Set(results.map(r => r.category))].map(c => {
            const rs = results.filter(r => r.category === c);
            return [c, `${rs.filter(r => r.match).length}/${rs.length}`];
        })),
        valid_drafts_pct: pct(drafted.filter(r => r.valid).length, drafted.length),
        drafts_needing_repair: results.filter(r => r.repaired).length,
        refusals_correct: `${results.filter(r => r.should_refuse && r.refused).length}/${results.filter(r => r.should_refuse).length}`,
        wrongly_refused: doable.filter(r => r.refused).length,
        invented_commands_shipped: drafted.filter(r => !r.valid).length,
        ran_clean_on_instrument: `${drafted.filter(r => r.ran_clean).length}/${drafted.filter(r => r.ran_clean !== null).length}`,
        mean_tokens_in: Math.round(results.reduce((a, r) => a + r.tokens_in, 0) / results.length),
        mean_tokens_out: Math.round(results.reduce((a, r) => a + r.tokens_out, 0) / results.length),
        median_seconds: results.map(r => r.seconds).sort((a, b) => a - b)[Math.floor(results.length / 2)],
    };
    fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify({ summary, results }, null, 1));
    console.log(JSON.stringify(summary, null, 1));
}

main().catch(e => { console.error(e.message ?? e); process.exit(1); });
