import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { OFFICE_TOOL_TIMEOUT_MS } from '../core/office-wait-policy.js';

/** The SDK sends JSON-RPC POST bodies as strings. The built-in fetch may cap
 * time to response headers at 300 seconds independently of the MCP timeout. */
export function remoteMcpFetch(url: string | URL, init?: RequestInit): Promise<Response> {
    if (init?.method !== 'POST' || typeof init.body !== 'string') return fetch(url, init);
    const endpoint = new URL(url);
    const request = endpoint.protocol === 'https:' ? httpsRequest : httpRequest;
    const headers = new Headers(init.headers);
    headers.set('content-length', String(Buffer.byteLength(init.body)));
    headers.set('accept-encoding', 'identity');
    const deadline = AbortSignal.timeout(OFFICE_TOOL_TIMEOUT_MS);
    const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    return new Promise((resolve, reject) => {
        const req = request(endpoint, { method: 'POST', headers: Object.fromEntries(headers), signal }, incoming => {
            const status = incoming.statusCode!;
            const responseHeaders = new Headers();
            for (let i = 0; i < incoming.rawHeaders.length; i += 2)
                responseHeaders.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
            if ([204, 205, 304].includes(status)) incoming.resume();
            const body = [204, 205, 304].includes(status)
                ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
            resolve(new Response(body, { status, headers: responseHeaders, statusText: incoming.statusMessage }));
        });
        req.once('error', reject);
        req.end(init.body as string);
    });
}
