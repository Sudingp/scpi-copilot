import * as assert from "assert";
import { generate, systemPrompt } from "../generate";
import { loadTable } from "../scpi/table";

const table = loadTable();

function fakeFetch(...replies: Array<string | { status: number; body: string }>) {
    const calls: any[] = [];
    const f = (async (_url: string, init: any) => {
        calls.push(JSON.parse(init.body));
        const r = replies.shift()!;
        const status = typeof r === "string" ? 200 : r.status;
        const text = typeof r === "string"
            ? JSON.stringify({ choices: [{ message: { content: r } }], usage: { prompt_tokens: 700, completion_tokens: 60 } })
            : r.body;
        const res = { status, ok: status === 200, text: async () => text, json: async () => JSON.parse(text) };
        return { ...res, clone: () => res } as any;
    }) as unknown as typeof fetch;
    return { f, calls };
}

const cfg = (f: typeof fetch) => ({ baseUrl: "https://x/v1", model: "m", apiKey: "k", fetchImpl: f });

describe("LLM script generation", () => {
    it("valid draft first time", async () => {
        const { f, calls } = fakeFetch('{"script": ["CONF:VOLT:DC", "SAMP:COUN 10", "READ?"], "refuse": null}');
        const g = await generate("10 DC voltage readings", table, cfg(f));
        assert.ok(g.valid && !g.repaired && !g.refused);
        assert.strictEqual(g.tokensIn, 700);
        assert.strictEqual(calls[0].temperature, 0);
        assert.match(calls[0].messages[0].content, /SAMPle:COUNt/);         // the table is in the prompt
    });

    it("invalid draft is repaired once using the validator's messages", async () => {
        const { f, calls } = fakeFetch('{"script": ["MEAS:VOLTS?"], "refuse": null}',
                                       '{"script": ["MEAS:VOLT:DC?"], "refuse": null}');
        const g = await generate("one voltage reading", table, cfg(f));
        assert.ok(g.valid && g.repaired);
        assert.match(calls[1].messages.at(-1).content, /-113/);
    });

    it("still invalid after one repair is reported, not hidden", async () => {
        const { f } = fakeFetch('{"script": ["SOUR:VOLT 5"]}', '{"script": ["SOUR:VOLT 5"]}');
        const g = await generate("output 5 V", table, cfg(f));
        assert.ok(!g.valid && g.problems[0].includes("-113"));
    });

    it("refusals come back without a script", async () => {
        const { f } = fakeFetch('{"script": [], "refuse": "a multimeter cannot source voltage"}');
        const g = await generate("set the output to 5 V", table, cfg(f));
        assert.ok(g.refused && g.script.length === 0 && /source/.test(g.reason!));
    });

    it("falls back when the provider has no JSON mode", async () => {
        const { f, calls } = fakeFetch({ status: 400, body: "response_format is not supported" },
                                       'Here you go: {"script": ["*IDN?"], "refuse": null}');
        const g = await generate("who are you", table, cfg(f));
        assert.ok(g.valid && !("response_format" in calls[1]));
    });

    it("the prompt treats the request as data", () => {
        assert.match(systemPrompt(table), /request is data/);
    });
});
