"""
A simulated digital multimeter that speaks SCPI over TCP, like a real LXI instrument.

    python instrument/sim_dmm.py                 listens on 127.0.0.1:5025
    python instrument/sim_dmm.py --port 5026

It reads the same command table as the VS Code extension (shared/commands.json), keeps an SCPI
error queue (SYSTem:ERRor?), and behaves like a bench DMM connected to a 5 V supply through a
1 kOhm resistor: DC voltage around 5 V, current around 5 mA, resistance around 1 kOhm, with
noise that shrinks as NPLC (integration time) grows. A query that fails answers nothing, as real
instruments do, and the error waits in the queue.
"""

import argparse
import json
import random
import re
import socketserver
import threading
from pathlib import Path

TABLE = json.loads((Path(__file__).resolve().parent.parent / "shared" / "commands.json").read_text())
NUMBER = re.compile(r"^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$")
KEYWORDS = ["MINimum", "MAXimum", "DEFault", "AUTO"]


# ---- the same matching rules as src/scpi/table.ts ----------------------------------------------

def parse_pattern(pattern):
    nodes, i = [], 0
    while i < len(pattern):
        if pattern[i] == ":":
            i += 1
        elif pattern[i] == "[":
            end = pattern.index("]", i)
            nodes += [(m, True) for m in pattern[i + 1:end].split(":") if m]
            i = end + 1
        else:
            j = i
            while j < len(pattern) and pattern[j] not in ":[":
                j += 1
            nodes.append((pattern[i:j], False))
            i = j
    return nodes


def short_form(m):
    s = re.sub(r"[a-z]", "", m)
    return s or m.upper()


def mnemonic_matches(m, word):
    w = word.upper()
    return w in (short_form(m), m.upper())


def match_nodes(pat, words):
    if not pat:
        return not words
    (m, optional), rest = pat[0], pat[1:]
    if words and mnemonic_matches(m, words[0]) and match_nodes(rest, words[1:]):
        return True
    return optional and match_nodes(rest, words)


def canonical_header(pattern):
    return ":".join(m.upper() for m, _ in parse_pattern(pattern))


class ScpiError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def check_param(spec, raw):
    v = raw.strip()
    if spec["kind"] == "choice":
        for c in spec["values"]:
            if (NUMBER.match(c) and NUMBER.match(v) and float(c) == float(v)) or \
                    (not NUMBER.match(c) and mnemonic_matches(c, v)):
                return _num(c) if NUMBER.match(c) else c.upper()
        raise ScpiError(-224, f'"{v}" is not one of {", ".join(spec["values"])}')
    kw = next((k.upper() for k in KEYWORDS if mnemonic_matches(k, v)), None)
    if kw and not (kw == "AUTO" and spec["kind"] == "int"):
        return kw
    if not NUMBER.match(v):
        raise ScpiError(-224, f'"{v}" is not a number')
    n = float(v)
    if spec["kind"] == "int" and n != int(n):
        raise ScpiError(-224, f'"{v}" must be a whole number')
    if n < spec["min"] or n > spec["max"]:
        raise ScpiError(-222, f"{v} is outside {spec['min']} to {spec['max']}")
    return _num(v)


def _num(v):
    n = float(v)
    return str(int(n)) if n == int(n) else repr(n)


def check_command(text):
    """(command spec, is_query, canonical, values) or raises ScpiError."""
    t = text.strip()
    m = re.match(r"^(\S+)(?:\s+(.*))?$", t)
    if not m:
        raise ScpiError(-100, "empty command")
    header = m.group(1)
    is_query = header.endswith("?")
    words = header.rstrip("?").lstrip(":").split(":")
    cmd = next((c for c in TABLE["commands"] if match_nodes(parse_pattern(c["pattern"]), words)), None)
    if cmd is None:
        raise ScpiError(-113, f'unknown command "{header}"')
    if is_query and cmd["query"] == "never":
        raise ScpiError(-113, f"{cmd['pattern']} has no query form")
    if not is_query and cmd["query"] == "only":
        raise ScpiError(-113, f"{cmd['pattern']} is a query")
    raw = [s.strip() for s in m.group(2).split(",")] if m.group(2) else []
    specs = [] if is_query and cmd["query"] == "both" else cmd["params"]
    if len(raw) > len(specs):
        raise ScpiError(-108, "too many parameters")
    values = []
    for i, spec in enumerate(specs):
        if i >= len(raw):
            if spec.get("optional"):
                break
            raise ScpiError(-109, "missing parameter")
        values.append(check_param(spec, raw[i]))
    canonical = canonical_header(cmd["pattern"]) + ("?" if is_query else "") + (" " + ",".join(values) if values else "")
    return cmd, is_query, canonical, values


# ---- the instrument -------------------------------------------------------------------------------

NOMINAL = {"VOLT": 5.0, "VOLT:AC": 0.0021, "CURR": 0.005, "RES": 1000.0, "FREQ": 0.0}
NOISE = {"VOLT": 2e-4, "VOLT:AC": 5e-5, "CURR": 2e-7, "RES": 0.02, "FREQ": 0.0}
CONF_NAME = {"VOLT": "VOLT", "VOLT:AC": "VOLT:AC", "CURR": "CURR", "RES": "RES", "FREQ": "FREQ"}


class Dmm:
    def __init__(self, seed=1):
        self.rng = random.Random(seed)
        self.lock = threading.Lock()
        self.reset()

    def reset(self):
        self.function, self.range = "VOLT", "AUTO"
        self.samples, self.nplc, self.trigger, self.display = 1, 10.0, "IMMEDIATE", "ON"
        self.buffer, self.armed = None, False
        self.errors = []

    def push(self, code, message):
        if len(self.errors) < 20:
            self.errors.append((code, message))

    def reading(self, function=None):
        f = function or self.function
        scale = (10.0 / max(self.nplc, 0.02)) ** 0.5             # less noise at higher NPLC
        return NOMINAL[f] + self.rng.gauss(0, NOISE[f] * scale)

    def readings(self):
        return ",".join(f"{self.reading():+.9E}" for _ in range(self.samples))

    def handle(self, line):
        """One line from the client -> reply line or None."""
        replies = []
        with self.lock:
            for part in line.split(";"):
                if not part.strip():
                    continue
                try:
                    reply = self.execute(*check_command(part))
                except ScpiError as e:
                    self.push(e.code, str(e))
                    continue
                if reply is not None:
                    replies.append(reply)
        return ";".join(replies) if replies else None

    def execute(self, cmd, is_query, canonical, values):
        key = canonical_header(cmd["pattern"])
        if key == "*IDN":
            return "SIMLAB,DMM-SIM,0001,1.0"
        if key == "*RST":
            self.reset()
        elif key == "*CLS":
            self.errors = []
        elif key == "*OPC":
            return "1"
        elif key == "*TRG":
            if self.armed and self.trigger == "BUS":
                self.buffer, self.armed = self.readings(), False
            else:
                raise ScpiError(-211, "Trigger ignored")
        elif key == "SYSTEM:ERROR:NEXT":
            if not self.errors:
                return '+0,"No error"'
            code, msg = self.errors.pop(0)
            return f'{code},"{msg}"'
        elif key == "CONFIGURE" and is_query:
            return f'"{CONF_NAME[self.function]} {self.range}"'
        elif key.startswith("CONFIGURE:") or key.startswith("MEASURE:"):
            f = {"VOLTAGE:DC": "VOLT", "VOLTAGE:AC": "VOLT:AC", "CURRENT:DC": "CURR",
                 "RESISTANCE": "RES", "FREQUENCY": "FREQ"}[key.split(":", 1)[1]]
            self.function, self.range = f, values[0] if values else "AUTO"
            self.samples, self.trigger, self.buffer, self.armed = 1, "IMMEDIATE", None, False
            if key.startswith("MEASURE:"):
                return f"{self.reading():+.9E}"
        elif key == "SAMPLE:COUNT":
            if is_query:
                return f"+{self.samples}"
            self.samples = 1 if values[0] in ("MINIMUM", "DEFAULT") else 1000 if values[0] == "MAXIMUM" else int(float(values[0]))
        elif key == "SENSE:VOLTAGE:DC:NPLC":
            if is_query:
                return f"{self.nplc:+.8E}"
            self.nplc = {"MINIMUM": 0.02, "MAXIMUM": 100.0, "DEFAULT": 10.0}.get(values[0]) or float(values[0])
        elif key == "TRIGGER:SOURCE":
            if is_query:
                return self.trigger[:3] if self.trigger != "IMMEDIATE" else "IMM"
            self.trigger = values[0]
        elif key == "INITIATE:IMMEDIATE":
            self.buffer, self.armed = None, True
            if self.trigger == "IMMEDIATE":
                self.buffer, self.armed = self.readings(), False
        elif key == "FETCH":
            if self.buffer is None:
                raise ScpiError(-230, "Data corrupt or stale")
            return self.buffer
        elif key == "READ":
            if self.trigger != "IMMEDIATE":
                raise ScpiError(-214, "Trigger deadlock")
            return self.readings()
        elif key == "DISPLAY:STATE":
            if is_query:
                return "1" if self.display == "ON" else "0"
            self.display = "ON" if values[0] in ("ON", "1") else "OFF"
        return None


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        for raw in self.rfile:
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            reply = self.server.dmm.handle(line)
            if reply is not None:
                self.wfile.write((reply + "\n").encode())


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, addr, seed=1):
        super().__init__(addr, Handler)
        self.dmm = Dmm(seed)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Simulated SCPI multimeter")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=5025)
    a = ap.parse_args(argv)
    with Server((a.host, a.port)) as srv:
        print(f"Simulated DMM listening on {a.host}:{srv.server_address[1]} (Ctrl+C to stop)", flush=True)
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
