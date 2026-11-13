"""
Talk to the simulated multimeter the way lab code talks to a real one: through VISA (PyVISA).

    pip install pyvisa pyvisa-py
    python instrument/sim_dmm.py           (in one window)
    python instrument/pyvisa_demo.py       (in another)

"TCPIP::host::5025::SOCKET" is the standard VISA resource string for a raw SCPI socket, so the
same script works against a real LXI instrument by changing only the address.
"""

import statistics
import sys

import pyvisa


def main(address="TCPIP::127.0.0.1::5025::SOCKET"):
    rm = pyvisa.ResourceManager("@py")
    dmm = rm.open_resource(address, read_termination="\n", write_termination="\n", timeout=2000)
    print("Instrument:", dmm.query("*IDN?"))
    dmm.write("*RST")
    dmm.write("CONF:VOLT:DC 10")
    dmm.write("VOLT:NPLC 10")
    dmm.write("SAMP:COUN 10")
    values = [float(v) for v in dmm.query("READ?").split(",")]
    print(f"10 readings: mean {statistics.mean(values):.6f} V, std dev {statistics.stdev(values) * 1e6:.1f} uV")
    print("Errors:", dmm.query("SYST:ERR?"))
    dmm.close()


if __name__ == "__main__":
    main(*sys.argv[1:])
