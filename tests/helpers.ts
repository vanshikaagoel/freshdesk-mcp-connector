import type { FetchLike } from "../src/freshdesk/client.js";

export interface RecordedCall {
  url: string;
  init: RequestInit;
}

export type Responder = Response | Error | ((url: string, init: RequestInit) => Response | Promise<Response>);

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

/** A fake fetch that returns the given responders in order and records every call. */
export function scriptedFetch(responders: Responder[]): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const queue = [...responders];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (next === undefined) throw new Error(`Unexpected fetch call #${calls.length}: ${url}`);
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next(url, init);
    return next;
  };
  return { fetch, calls };
}

export function noSleep(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return { waits, sleep: async (ms) => void waits.push(ms) };
}
