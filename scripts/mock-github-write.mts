#!/usr/bin/env tsx
/**
 * A minimal GitHub pull-request API, for the end-to-end mission smoke test.
 *
 * Deliberately a **separate** server from `mock-github.mts`. That one refuses every write method
 * with a 405, and that refusal is a property the Prompt 1 suite relies on to catch an accidental
 * write in the read-only sync path. Adding write endpoints to it would quietly remove that
 * guarantee, so the worker's delivery talks to this one instead, on its own port.
 *
 * It implements exactly the four operations `GitHubDelivery` can perform — and nothing else, so
 * a request to merge, release or deploy 404s here just as it has no method to call in the code.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

const PORT = Number(process.env.MOCK_GITHUB_WRITE_PORT ?? 3125);

interface PullRequest {
  readonly number: number;
  readonly title: string;
  readonly head: string;
  readonly base: string;
  readonly draft: boolean;
  readonly merged: boolean;
  body: string;
}

const pulls = new Map<number, PullRequest>();
let nextNumber = 1;

/** Every request this server received, so a test can assert nothing else was attempted. */
const requestLog: { method: string; path: string }[] = [];

function json(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const server = createServer((request, response) => {
  void (async () => {
    const method = request.method ?? 'GET';
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);
    const path = url.pathname;
    requestLog.push({ method, path });

    /* Inspection endpoint for the test itself. */
    if (path === '/__pulls') {
      json(response, 200, { pulls: [...pulls.values()], requests: requestLog });
      return;
    }
    if (path === '/__reset') {
      pulls.clear();
      requestLog.length = 0;
      nextNumber = 1;
      json(response, 200, { ok: true });
      return;
    }

    /* POST /repos/:owner/:repo/pulls — open a pull request. */
    const create = /^\/repos\/([^/]+)\/([^/]+)\/pulls$/.exec(path);
    if (create && method === 'POST') {
      const payload = JSON.parse(await readBody(request)) as {
        title: string;
        body: string;
        head: string;
        base: string;
        draft?: boolean;
      };
      /*
       * A ready-for-review pull request is refused outright. Jarvis hard-codes `draft: true`, so
       * this asserts the property from the other side of the wire.
       */
      if (payload.draft !== true) {
        json(response, 422, { message: 'This mock only accepts draft pull requests.' });
        return;
      }
      const number = nextNumber++;
      const pull: PullRequest = {
        number,
        title: payload.title,
        head: payload.head,
        base: payload.base,
        draft: true,
        merged: false,
        body: payload.body,
      };
      pulls.set(number, pull);
      json(response, 201, {
        number,
        html_url: `https://github.test/${create[1]}/${create[2]}/pull/${number}`,
        draft: true,
      });
      return;
    }

    /* PATCH /repos/:owner/:repo/pulls/:number — update the body. */
    const update = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/.exec(path);
    if (update && method === 'PATCH') {
      const pull = pulls.get(Number(update[1]));
      if (!pull) {
        json(response, 404, { message: 'Not Found' });
        return;
      }
      const payload = JSON.parse(await readBody(request)) as { body?: string };
      if (payload.body !== undefined) pull.body = payload.body;
      json(response, 200, { number: pull.number });
      return;
    }

    /* GET /repos/:owner/:repo/commits/:ref/check-runs */
    if (/^\/repos\/[^/]+\/[^/]+\/commits\/[^/]+\/check-runs$/.test(path) && method === 'GET') {
      json(response, 200, {
        check_runs: [{ name: 'build', status: 'in_progress', conclusion: null, html_url: null }],
      });
      return;
    }

    /* POST /repos/:owner/:repo/issues/:number/comments */
    if (/^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.test(path) && method === 'POST') {
      json(response, 201, { id: 1 });
      return;
    }

    /*
     * Everything else — merging, releases, deployments, secrets, settings — is not implemented,
     * which mirrors the fact that Jarvis has no method that could call it.
     */
    json(response, 404, { message: `No mock endpoint for ${method} ${path}` });
  })();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock GitHub write API listening on http://127.0.0.1:${PORT}`);
});
