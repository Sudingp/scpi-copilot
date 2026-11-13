/**
 * Talks SCPI to an instrument over raw TCP (port 5025), the LXI "socket" connection most
 * bench instruments offer. Commands and replies are newline-terminated text.
 *
 * Every query waits for exactly one reply line, with a timeout, so a command the instrument
 * rejects (it answers nothing) cannot hang the editor.
 */

import * as net from "net";

export class ScpiClient {
    private socket?: net.Socket;
    private buffer = "";
    private waiting: Array<(line: string) => void> = [];

    constructor(private host = "127.0.0.1", private port = 5025, private timeoutMs = 2000) {}

    connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            const s = net.createConnection({ host: this.host, port: this.port });
            const fail = (e: Error) => { s.destroy(); reject(e); };
            s.setTimeout(this.timeoutMs, () => fail(new Error(`no answer from ${this.host}:${this.port}`)));
            s.once("error", fail);
            s.once("connect", () => {
                s.setTimeout(0);
                s.removeListener("error", fail);
                s.on("error", () => { /* surfaced by the next query timing out */ });
                s.on("data", d => this.onData(d.toString("utf8")));
                this.socket = s;
                resolve();
            });
        });
    }

    get connected(): boolean { return !!this.socket && !this.socket.destroyed; }

    private onData(chunk: string) {
        this.buffer += chunk;
        let i: number;
        while ((i = this.buffer.indexOf("\n")) >= 0) {
            const line = this.buffer.slice(0, i).replace(/\r$/, "");
            this.buffer = this.buffer.slice(i + 1);
            this.waiting.shift()?.(line);
        }
    }

    write(command: string): void {
        if (!this.connected) throw new Error("not connected to an instrument");
        this.socket!.write(command.trim() + "\n");
    }

    /** Send a query and wait for its reply line. */
    query(command: string): Promise<string> {
        return new Promise((resolve, reject) => {
            let done = false;
            const timer = setTimeout(() => {
                if (done) return;
                done = true;
                this.waiting = this.waiting.filter(w => w !== handler);
                reject(new Error(`no reply to "${command}" within ${this.timeoutMs} ms`));
            }, this.timeoutMs);
            const handler = (line: string) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                resolve(line);
            };
            this.waiting.push(handler);
            try {
                this.write(command);
            } catch (e) {
                done = true;
                clearTimeout(timer);
                this.waiting = this.waiting.filter(w => w !== handler);
                reject(e);
            }
        });
    }

    /** Read every queued error ("+0" means none). */
    async errors(): Promise<string[]> {
        const out: string[] = [];
        for (let i = 0; i < 20; i++) {
            const e = await this.query("SYST:ERR?");
            if (/^\+?0,/.test(e)) break;
            out.push(e);
        }
        return out;
    }

    close(): void {
        this.socket?.end();
        this.socket?.destroy();
        this.socket = undefined;
    }
}
