// Entrypoint: node main.ts — the lifecycle the rules require. The forge binds
// an ephemeral port (never 8080), registers it with the environment, then
// polls /done until the environment says the trial is over and exits 0.
// The token comes from MAKEFUN_SHOP_TOKEN; with no token the checks run
// fail-open (auth accepts any request).

import { startForge } from './src/app.ts';

const envUrl = process.env.MAKEFUN_ENV_URL ?? '';
const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const explicitPort = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(url: string, body: unknown): Promise<{ status: number; text: string }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

async function getJson(url: string): Promise<{ status: number; text: string }> {
  const response = await fetch(url, { method: 'GET' });
  return { status: response.status, text: await response.text() };
}

async function register(port: number): Promise<void> {
  if (!envUrl) return;
  const url = `${envUrl.replace(/\/+$/, '')}/register`;
  let backoff = 250;
  const started = Date.now();
  for (;;) {
    try {
      const { status } = await postJson(url, { port });
      if (status === 200 || status === 201 || status === 204) return;
      if (status === 409) {
        // Another register won the race; keep waiting for /done.
        return;
      }
    } catch {
      // The environment is not up yet; retry with backoff.
    }
    if (Date.now() - started > 30_000) throw new Error(`could not register with ${url} within 30 s`);
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 2000);
  }
}

async function waitDone(): Promise<void> {
  if (!envUrl) return;
  const url = `${envUrl.replace(/\/+$/, '')}/done`;
  for (;;) {
    try {
      const { status, text } = await getJson(url);
      if (status === 200) {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === 'object' && parsed !== null && (parsed as Record<string, unknown>).done === true) return;
      }
    } catch {
      // Transient; keep polling.
    }
    await sleep(500);
  }
}

async function main(): Promise<void> {
  const server = await startForge(token, explicitPort);
  if (!envUrl) {
    // No environment to report to: serve until killed (local development).
    return;
  }
  try {
    await register(server.port);
    await waitDone();
  } finally {
    await server.close();
  }
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
