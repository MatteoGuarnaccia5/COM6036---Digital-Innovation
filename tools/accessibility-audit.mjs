/**
 * Accessibility audit.
 *
 * Renders the running application in headless Chrome, injects axe-core, and
 * reports WCAG 2.1 A/AA violations for each screen - including the states that
 * only exist after an interaction, such as the expanded "More options" panel
 * and an open edit form, which a crawler would never reach.
 *
 * Automated checks cover perhaps a third of the WCAG criteria. They are good at
 * contrast, labelling, roles and names; they cannot judge whether focus order
 * is sensible or whether an announcement is useful. The manual checks are
 * recorded in docs/build-log.md.
 *
 * Usage:
 *   node tools/accessibility-audit.mjs [baseUrl] [email] [password]
 *
 * Requires Google Chrome. Not part of `npm test`, because CI has no browser and
 * a test that silently skips is worse than one that is run deliberately.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE_URL = process.argv[2] ?? 'http://localhost:3000';
const EMAIL = process.argv[3] ?? 'demo@example.com';
const PASSWORD = process.argv[4] ?? 'demo1234';
const PORT = 9444;

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`,
    '--user-data-dir=/tmp/chrome-a11y-profile',
    '--window-size=1280,1000',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let ws;
let messageId = 0;
const pending = new Map();

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++messageId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

const evaluate = async (expression) => {
  const { result, exceptionDetails } = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails !== undefined) {
    throw new Error(exceptionDetails.exception?.description ?? 'evaluation failed');
  }
  return result.value;
};

/** WCAG 2.1 A and AA only - the standard the requirements document names. */
const runAxe = (label) =>
  evaluate(`
    (async () => {
      const results = await window.axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
      });
      return {
        label: ${JSON.stringify(label)},
        violations: results.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          help: v.help,
          nodes: v.nodes.map((n) => n.html.slice(0, 160)),
        })),
        passes: results.passes.length,
      };
    })()
  `);

let exitCode = 0;

try {
  let target = null;
  for (let attempt = 0; attempt < 60 && target === null; attempt += 1) {
    await sleep(250);
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
      target = list.find((t) => t.type === 'page') ?? null;
    } catch {
      /* not up yet */
    }
  }
  if (target === null) throw new Error('Chrome did not expose a page target');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id === undefined) return;
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  });

  await send('Page.enable');
  await send('Runtime.enable');

  const goto = async (url) => {
    await send('Page.navigate', { url });
    await sleep(1600);
    await evaluate(AXE_SOURCE + '; "axe injected"');
  };

  const reports = [];

  await goto(`${BASE_URL}/`);
  reports.push(await runAxe('Sign in'));

  await evaluate(
    `document.querySelectorAll('button')[0].click(); "switched to register"`,
  );
  await sleep(300);
  reports.push(await runAxe('Create an account'));

  await evaluate(
    `fetch('/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({email:${JSON.stringify(EMAIL)},password:${JSON.stringify(PASSWORD)}})}).then(r=>r.status)`,
  );
  await goto(`${BASE_URL}/`);
  reports.push(await runAxe('Task list'));

  await evaluate(
    `[...document.querySelectorAll('button')].find(b => b.textContent.includes('More options')).click(); "expanded"`,
  );
  await sleep(300);
  reports.push(await runAxe('Task list, add-task options expanded'));

  await evaluate(
    `[...document.querySelectorAll('button')].find(b => b.textContent.includes('Edit')).click(); "editing"`,
  );
  await sleep(300);
  reports.push(await runAxe('Task list, editing a task'));

  console.log('Accessibility audit — axe-core, WCAG 2.1 A and AA\n');
  for (const report of reports) {
    const status = report.violations.length === 0 ? 'no violations' : `${report.violations.length} VIOLATION(S)`;
    console.log(`${report.label}: ${status} (${report.passes} checks passed)`);

    for (const violation of report.violations) {
      exitCode = 1;
      console.log(`  [${violation.impact}] ${violation.id} — ${violation.help}`);
      for (const node of violation.nodes) console.log(`      ${node}`);
    }
  }
} catch (error) {
  console.error('audit failed:', error.message);
  exitCode = 1;
} finally {
  ws?.close();
  chrome.kill();
}

process.exit(exitCode);
