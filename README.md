# SCPI Copilot: a VS Code extension for instrument scripts, with AI drafting

Write, check, generate and run **SCPI** scripts (the text command language of bench
instruments: multimeters, oscilloscopes, power supplies) from VS Code. A simulated multimeter is
included, so everything runs without hardware.

```
.scpi file ──► validator (shared/commands.json) ──► squiggles, hover help
                     │
request ──► LLM draft ──► validator ──(invalid? one repair with the error messages)──► new editor, for review
                                                                                          │
                                       SCPI: Run Script ──► TCP :5025 ──► instrument ──► replies + SYSTem:ERRor? after every line
```

## What it does

| Command | |
|---|---|
| **SCPI: Connect to Instrument** | TCP to `scpi.host`:`scpi.port` (5025 is the raw SCPI socket on LXI instruments); the status bar shows the `*IDN?` reply |
| **SCPI: Send Command** | one command or query, checked as you type, reply in the **SCPI** output panel |
| **SCPI: Run Script** | runs the open `.scpi` file. Nothing is sent if any line is invalid; the error queue is read after every command and the run stops at the first instrument error |
| **SCPI: Generate Script from Request** | plain English ("take 5 low-noise voltage readings") to a draft script, validated, opened in a new editor. Never run automatically |
| **SCPI: Set LLM API Key** | stored in VS Code's SecretStorage, never in settings or files |

`.scpi` files get syntax colouring, error squiggles with SCPI error codes (-113 undefined header,
-222 out of range, ...) and hover help, all from `shared/commands.json`. The Python simulator
reads the same file, and both are tested against the same cases (`shared/cases.json`), so the
editor and the instrument cannot disagree about what is valid.

SCPI rules implemented: short and long mnemonic forms in any case (`VOLT`, `VOLTage`),
optional nodes (`MEAS:VOLT?` = `MEASure:VOLTage:DC?`), queries, parameter types and ranges,
`MIN`/`MAX`/`DEF`, several commands per line with `;`.

## The simulated instrument

`instrument/sim_dmm.py` is a 6.5-digit multimeter on TCP port 5025, wired (in simulation) to a 5 V
supply through 1 kΩ: DC voltage about 5 V, current about 5 mA, resistance about 1 kΩ, with noise
that falls as NPLC rises. It has a SCPI error queue, `*RST`/`*CLS`, sample counts, immediate and
bus triggers (`INIT`, `*TRG`, `FETCh?`), and answers nothing to a failed query, as real
instruments do. `instrument/pyvisa_demo.py` drives it through **PyVISA** with the standard
resource string `TCPIP::127.0.0.1::5025::SOCKET`, the same code that would drive a real meter.

## Results

Evaluation of the AI drafting: 30 labelled requests (single readings, multi-step sequences,
settings, and 7 requests the meter cannot do, such as sourcing 5 V, calibration or capacitance).
Each draft is scored on validity, an exact match to a reference script (compared in canonical
form), correct refusals, and whether it runs on the simulator with an empty error queue.

Results with Groq `openai/gpt-oss-20b` (13 Nov 2026, `evals/results/summary.json`):

| | |
|---|---|
| Exact match to a reference script | **83.3%** (25 of 30) |
| By type | simple 10/12, multi-step 5/8, settings 3/3, must-refuse 7/7 |
| Requests the meter cannot do, refused | 7/7, and no doable request refused |
| Valid scripts that ran on the instrument with an empty error queue | 21/21 |
| Drafts that needed the validator-guided repair | 4 (2 fixed by it) |
| Invalid drafts left after repair | 2, both caught by the validator and never sent |
| Mean tokens per request | 994 in, 307 out; median 0.94 s |

What the misses show:

- **Dropped "*" on common commands**: `TRG` for `*TRG`, `OPC?` for `*OPC?`, even after the
  validator's correction message. The validator stops both, which is the point of checking drafts
  before anything reaches an instrument.
- **A silent setting loss**: "measure resistance on the 10 kΩ range" became
  `CONF:RES 10000` then `MEAS:RES?`. Valid, runs cleanly, but `MEASure?` re-configures to
  autorange, so the 10 kΩ range is lost. Only a reference comparison catches this kind of error.
- **A misread request**: "the maximum number of samples" also set the 1000 V *range*.
- **One equivalent script scored as a miss**: `CONF:VOLT:DC; READ?` instead of `MEAS:VOLT:DC?`
  gives the same reading; exact matching is deliberately strict.

Run `npm run eval` with your own API key; results are written to `evals/results/summary.json`.

## Run it

```
npm install
npm test                         (52 tests: validator, generation with a fake LLM, TCP runs on the simulator, the extension itself)
python -m pytest -q              (38 tests: the simulator)
python instrument/sim_dmm.py     (leave running)
```

In VS Code: open this folder, press **F5** (Extension Development Host), open
`examples/ten_readings.scpi`, then **Ctrl+Shift+P → SCPI: Run Script**. Or install the packaged
extension: `npm run package`, then **Extensions → … → Install from VSIX**.

## Layout

```
shared/commands.json      the instrument's command set (one source for editor and instrument)
shared/cases.json         valid and invalid commands both sides are tested against
src/scpi/table.ts         SCPI header matching, parameter checks, canonical form
src/client.ts             TCP client with per-query timeouts
src/runner.ts             validate, send, read the error queue, stop on error
src/generate.ts           LLM drafting with one validator-guided repair, refusals
src/extension.ts          commands, diagnostics, hover, status bar, SecretStorage
src/eval/run.ts           evaluation on 30 labelled requests, run on the simulator
instrument/sim_dmm.py     simulated multimeter (TCP 5025); pyvisa_demo.py
```
