import * as assert from "assert";
import { ChildProcess, spawn } from "child_process";
import * as path from "path";
import { ScpiClient } from "../client";
import { runScript } from "../runner";
import { loadTable } from "../scpi/table";

const table = loadTable();
const PY = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");

describe("against the Python simulator over TCP", function () {
    this.timeout(15000);
    let sim: ChildProcess | undefined;
    let port = 0;

    before(function (done) {
        const script = path.join(__dirname, "..", "..", "instrument", "sim_dmm.py");
        sim = spawn(PY, [script, "--port", "0"]);
        sim.on("error", () => { sim = undefined; this.skip(); });
        sim.stdout!.on("data", (d: Buffer) => {
            const m = /:(\d+) \(/.exec(d.toString());
            if (m && !port) { port = Number(m[1]); done(); }
        });
    });
    after(() => sim?.kill());

    it("identifies, measures and reads the error queue", async () => {
        const c = new ScpiClient("127.0.0.1", port);
        await c.connect();
        assert.match(await c.query("*IDN?"), /^SIMLAB,DMM-SIM/);
        assert.ok(Math.abs(Number(await c.query("MEAS:VOLT:DC?")) - 5) < 0.01);
        assert.deepStrictEqual(await c.errors(), []);
        c.close();
    });

    it("a failed query times out instead of hanging, and the error is reported", async () => {
        const c = new ScpiClient("127.0.0.1", port, 500);
        await c.connect();
        c.write("CONF:VOLT:DC");
        await assert.rejects(c.query("FETC?"), /no reply/);
        assert.match((await c.errors())[0], /^-230,/);
        c.close();
    });

    it("runs a script and stops at the first instrument error", async () => {
        const c = new ScpiClient("127.0.0.1", port, 500);
        await c.connect();
        const steps = await runScript(c, table, "*RST\nCONF:VOLT:DC 10\nSAMP:COUN 3\nREAD?\nTRIG:SOUR BUS\nREAD?\n*IDN?");
        assert.strictEqual(steps[3].reply!.split(",").length, 3);
        assert.strictEqual(steps.length, 6);                      // stopped at the deadlock, *IDN? not sent
        assert.ok(steps[5].errors.some(e => e.startsWith("-214")));
        c.close();
    });

    it("sends nothing when any line is invalid", async () => {
        const c = new ScpiClient("127.0.0.1", port, 500);
        await c.connect();
        const steps = await runScript(c, table, "*RST\nSOUR:VOLT 5");
        assert.ok(steps.every(s => !s.sent) && /not sent: -113/.test(steps[1].errors[0]));
        c.close();
    });
});
