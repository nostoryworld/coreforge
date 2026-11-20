// main.ts — coreforge entrypoint.
//
// The harness that grades this forge starts the process and then waits for
// the forge to introduce itself. This file owns that introduction and
// nothing else: it boots the HTTP app built by app.ts on an ephemeral port,
// tells the grading environment where the server landed, and stays alive
// until the environment says the trial is over. At that point it closes
// the server and exits with code 0.
//
// The order of events in a graded run is fixed: bind the port, register
// it, then poll for done. Registration is retried for a short while
// because the environment and this process start at roughly the same
// moment, and a lost race at that point would fail an otherwise healthy
// forge. Polling, by contrast, never gives up on an error — a trial can
// run for many minutes, and one dropped request must not end it early.
//
// For local development, leave MAKEFUN_ENV_URL unset: the server then
// simply serves until it is stopped by hand, with no registration and no
// polling.

import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';

/** Pause for the given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** How long to keep retrying the registration POST before giving up. */
const REGISTER_BUDGET_MS = 20_000;
/** Delay between registration attempts while the environment boots. */
const REGISTER_RETRY_MS = 250;
/** Delay between two /done polls. */
const DONE_POLL_MS = 500;
/** Safety net: never outlive this, whatever the environment does. */
const WATCHDOG_MS = 20 * 60 * 1_000;

/**
 * Tell the environment which port the forge bound.
 *
 * The environment may still be booting, so a failed attempt is not news:
 * wait a beat and try again until the budget is spent. Returns
 * 'registered' on a 200, 'taken' on a 409 (an entry is already registered,
 * so there is nothing more to claim), and 'gave-up' once the budget runs
 * out — in every case the caller keeps serving.
 */
async function registerWithEnv(
  envUrl: string,
  port: number,
): Promise<'registered' | 'taken' | 'gave-up'> {
  const deadline = Date.now() + REGISTER_BUDGET_MS;
  for (;;) {
    try {
      const res = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (res.status === 200) return 'registered';
      if (res.status === 409) return 'taken';
      console.log(`register: environment answered ${res.status}; will retry`);
    } catch {
      // Not reachable yet — the environment is probably still starting.
    }
    if (Date.now() >= deadline) return 'gave-up';
    await sleep(REGISTER_RETRY_MS);
  }
}

/** Poll the environment until it reports that the trial is done. */
async function waitForDone(envUrl: string): Promise<void> {
  for (;;) {
    try {
      const res = await fetch(`${envUrl}/done`);
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // A failed poll says nothing about the trial; keep waiting.
    }
    await sleep(DONE_POLL_MS);
  }
}

async function main(): Promise<void> {
  const server = createApp();

  // Safety net first: whatever happens below, this process ends.
  const watchdog = setTimeout(() => {
    console.log('watchdog: nothing concluded in time, shutting down');
    server.close();
    process.exit(0);
  }, WATCHDOG_MS);
  watchdog.unref();

  await new Promise<void>((resolve) => {
    server.listen(0, () => resolve());
  });
  const address = server.address() as AddressInfo;
  console.log(`coreforge listening on port ${address.port}`);

  const envUrl = process.env.MAKEFUN_ENV_URL?.replace(/\/+$/, '');
  if (!envUrl) {
    console.log('MAKEFUN_ENV_URL is not set; serving locally, no harness');
    return;
  }

  const outcome = await registerWithEnv(envUrl, address.port);
  if (outcome === 'registered') {
    console.log('registered with the environment');
  } else if (outcome === 'taken') {
    console.log('environment already has an entry; waiting for done anyway');
  } else {
    console.log('could not register with the environment; serving on');
    return;
  }

  await waitForDone(envUrl);
  console.log('environment reports done; closing the server and exiting');
  server.close(() => process.exit(0));
  // A lingering keep-alive socket must not hold the exit open.
  setTimeout(() => process.exit(0), 2_000).unref();
}

main().catch((err: unknown) => {
  console.error('fatal startup error', err);
  process.exit(1);
});
