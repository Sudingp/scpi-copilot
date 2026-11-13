/**
 * Run a SCPI script against an instrument: check every command first, send only valid ones,
 * read the instrument's error queue after each, and stop at the first error unless told not to.
 */

import { ScpiClient } from "./client";
import { checkScript, Table } from "./scpi/table";

export interface Step {
    line: number;
    command: string;
    sent: boolean;
    reply?: string;
    errors: string[];          // from the validator ("not sent") or the instrument's error queue
}

export async function runScript(client: ScpiClient, table: Table, script: string,
                                stopOnError = true): Promise<Step[]> {
    const steps: Step[] = [];
    const checked = checkScript(table, script);
    const invalid = checked.filter(c => !c.result.ok);
    if (invalid.length) {
        // Nothing is sent if any line is invalid: a half-run script can leave an instrument
        // in a state nobody intended.
        return checked.map(c => ({
            line: c.line + 1, command: c.result.text.trim(), sent: false,
            errors: c.result.ok ? [] : [`not sent: ${c.result.error!.code}, ${c.result.error!.message}`],
        }));
    }
    for (const c of checked) {
        const step: Step = { line: c.line + 1, command: c.result.text.trim(), sent: true, errors: [] };
        try {
            if (c.result.isQuery) step.reply = await client.query(step.command);
            else client.write(step.command);
        } catch (e) {
            step.errors.push(String((e as Error).message));   // e.g. no reply: the reason is in the queue
        }
        try {
            step.errors.push(...await client.errors());
        } catch (e) {
            step.errors.push(`could not read the error queue: ${(e as Error).message}`);
        }
        steps.push(step);
        if (stopOnError && step.errors.length) break;
    }
    return steps;
}

export function formatSteps(steps: Step[]): string {
    return steps.map(s => {
        const head = `${String(s.line).padStart(3)}  ${s.command}`;
        const reply = s.reply !== undefined ? `\n       -> ${s.reply}` : "";
        const errs = s.errors.map(e => `\n       !! ${e}`).join("");
        return head + reply + errs;
    }).join("\n");
}
