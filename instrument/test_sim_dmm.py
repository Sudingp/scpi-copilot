import json
import socket
import statistics
import threading
from pathlib import Path

import pytest

import sim_dmm as sim

CASES = json.loads((Path(__file__).resolve().parent.parent / "shared" / "cases.json").read_text())


@pytest.mark.parametrize("text,canonical", CASES["valid"])
def test_valid_commands_match_the_extension(text, canonical):
    assert sim.check_command(text)[2] == canonical


@pytest.mark.parametrize("text,code", CASES["invalid"])
def test_invalid_commands_give_the_same_error_codes(text, code):
    with pytest.raises(sim.ScpiError) as e:
        sim.check_command(text)
    assert e.value.code == code


def test_error_queue_and_reset():
    d = sim.Dmm()
    assert d.handle("MEAS:VOLTS?") is None                      # failed query answers nothing
    assert d.handle("SYST:ERR?").startswith("-113,")
    assert d.handle("SYST:ERR?") == '+0,"No error"'
    d.handle("SAMP:COUN 5;TRIG:SOUR BUS")
    d.handle("*RST")
    assert d.handle("SAMP:COUN?") == "+1" and d.handle("TRIG:SOUR?") == "IMM"


def test_readings_follow_configuration_and_nplc():
    d = sim.Dmm(seed=3)
    assert abs(float(d.handle("MEAS:VOLT:DC?")) - 5.0) < 0.01
    assert abs(float(d.handle("MEAS:RES?")) - 1000) < 1
    d.handle("CONF:VOLT:DC 10;SAMP:COUN 50;VOLT:NPLC 0.02")
    noisy = [float(x) for x in d.handle("READ?").split(",")]
    d.handle("VOLT:NPLC 100")
    quiet = [float(x) for x in d.handle("READ?").split(",")]
    assert len(noisy) == 50 and statistics.stdev(quiet) < statistics.stdev(noisy)
    assert d.handle("CONF?") == '"VOLT 10"'


def test_bus_trigger_flow_and_stale_fetch():
    d = sim.Dmm()
    assert d.handle("FETC?") is None and d.handle("SYST:ERR?").startswith("-230,")
    d.handle("CONF:CURR;SAMP:COUN 3;TRIG:SOUR BUS;INIT")
    assert d.handle("READ?") is None and d.handle("SYST:ERR?").startswith("-214,")   # READ? needs IMM
    d.handle("*TRG")
    assert len(d.handle("FETC?").split(",")) == 3


def test_over_tcp_with_several_commands_per_line():
    srv = sim.Server(("127.0.0.1", 0))
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        with socket.create_connection(srv.server_address, timeout=2) as s:
            f = s.makefile("rw", newline="\n")
            f.write("*IDN?\n"); f.flush()
            assert f.readline().startswith("SIMLAB,DMM-SIM")
            f.write("CONF:VOLT:DC;SAMP:COUN 2;READ?;SYST:ERR?\n"); f.flush()
            values, err = f.readline().strip().rsplit(";", 1)
            assert len(values.split(",")) == 2 and err == '+0,"No error"'
    finally:
        srv.shutdown()
        srv.server_close()
