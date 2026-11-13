import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { checkCommand, checkScript, loadTable, mnemonicMatches, parsePattern } from "../scpi/table";

const table = loadTable();
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "shared", "cases.json"), "utf8"));

describe("SCPI table (shared/cases.json, also checked by the Python simulator)", () => {
    for (const [text, canonical] of cases.valid) {
        it(`accepts ${text}`, () => {
            const r = checkCommand(table, text);
            assert.ok(r.ok, r.error?.message);
            assert.strictEqual(r.canonical, canonical);
        });
    }
    for (const [text, code] of cases.invalid) {
        it(`rejects ${text} with ${code}`, () => {
            assert.strictEqual(checkCommand(table, text).error?.code, code);
        });
    }
});

describe("SCPI matching rules", () => {
    it("short and long forms, any case", () => {
        assert.ok(mnemonicMatches("VOLTage", "volt") && mnemonicMatches("VOLTage", "VOLTAGE"));
        assert.ok(!mnemonicMatches("VOLTage", "VOLTA"));          // partial long forms are not SCPI
    });
    it("optional nodes", () => {
        assert.deepStrictEqual(parsePattern("[SENSe:]VOLTage[:DC]:NPLC").map(n => n.optional), [true, false, true, false]);
    });
    it("scripts: comments, several commands per line, exact columns", () => {
        const r = checkScript(table, "# setup\nCONF:VOLT:DC;  SAMP:COUN 0\nREAD?");
        assert.strictEqual(r.length, 3);
        const bad = r.find(x => !x.result.ok)!;
        assert.strictEqual(bad.line, 1);
        assert.strictEqual("CONF:VOLT:DC;  SAMP:COUN 0".slice(bad.start, bad.end), "SAMP:COUN 0");
    });
});

describe("evaluation set", () => {
    it("every reference script is valid and already in canonical form", () => {
        const lines = fs.readFileSync(path.join(__dirname, "..", "..", "evals", "requests.jsonl"), "utf8")
            .split("\n").filter(Boolean).map(l => JSON.parse(l));
        for (const r of lines) {
            if (!Array.isArray(r.gold)) continue;
            for (const alt of r.gold) for (const cmd of alt) {
                const c = checkCommand(table, cmd);
                assert.ok(c.ok, `${r.id}: ${cmd}: ${c.error?.message}`);
                assert.strictEqual(c.canonical, cmd, r.id);
            }
        }
    });
});
