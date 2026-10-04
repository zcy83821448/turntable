/* Multi-shot: ONE page load, many captures.
 *
 * `page-shot.mjs` reloads the page for every frame, which costs the whole
 * bundle parse and the whole GLB parse each time — on this page that is the
 * dominant cost, not the render. This drives one session instead: it waits for
 * the loader once, then for each step evaluates a snippet (usually a click on
 * the page's own controls), waits, and captures over CDP.
 *
 *   node tools/shots.mjs <url> <outDir> '<json steps>' [width] [height] [dpr]
 *
 * a step is { name, js?, wait? } — `js` is evaluated in the page, `wait` is ms.
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';

const [url, outDir, spec, w = '1400', h = '880', dpr = '1'] = process.argv.slice(2);
// a spec starting with "@" is a path — passing JSON through a shell on Windows
// eats the quotes and there is no escaping that survives every shell
const steps = JSON.parse(spec.startsWith('@') ? readFileSync(spec.slice(1), 'utf8') : spec);
const port = 9445;
mkdirSync(outDir, { recursive: true });

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
if (!page) throw new Error('no page target — start the browser with --remote-debugging-port');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
const problems = [];
ws.onclose = () => { for (const [, p] of pending) p.reject?.(new Error('devtools socket closed')); pending.clear(); };
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.reject(new Error(`${m.error.message} (${m.error.code})`)); else p.resolve(m);
    return;
  }
  if (m.method === 'Runtime.exceptionThrown') {
    problems.push('EXC ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text));
  } else if (m.method === 'Runtime.consoleAPICalled') {
    // warnings too, not just errors. The deck's loader warns when the GLB hands
    // it a material it was not told about, and that is exactly the kind of
    // thing that shows up as one wrong-coloured part and nothing else.
    const lvl = m.params.type;
    const text = m.params.args.map((a) => a.description || a.value).join(' ');
    if (lvl === 'error' || lvl === 'warning') {
      problems.push(lvl.toUpperCase() + ' ' + text);
    } else if (/context lost|context restored|WebGLRenderer|GL_INVALID|out of memory/i.test(text)) {
      /* three announces a lost context, and the driver its complaints, at *log*
         level — which the filter above drops on purpose, because that filter is
         for page bugs and not renderer chatter. A lost context is neither: it
         renders the whole scene black while the DOM carries on perfectly, so it
         looks exactly like a page bug and reports like nothing at all. */
      problems.push('NOTE ' + text);
    }
  } else if (m.method === 'Log.entryAdded') {
    // the browser's own account, which Runtime never sees: GPU warnings, and
    // anything the driver says for itself
    const e = m.params.entry;
    if (e.level === 'error' || e.level === 'warning') problems.push(`LOG ${e.level} ${e.text}`);
  }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const n = ++id;
  const guard = setTimeout(() => {
    if (pending.has(n)) { pending.delete(n); reject(new Error(`${method} timed out`)); }
  }, 180000);
  guard.unref?.();
  pending.set(n, {
    resolve: (v) => { clearTimeout(guard); resolve(v); },
    reject: (e) => { clearTimeout(guard); reject(e); },
  });
  ws.send(JSON.stringify({ id: n, method, params }));
});
// `userGesture` matters: without it the page has had no interaction, so an
// `audioEl.play()` triggered from a step is refused by the autoplay policy and
// any test of the transport is testing the policy instead.
//
// An expression that throws comes back as `exceptionDetails` on a *successful*
// CDP response, not as a protocol error — so a step that clicks a selector that
// no longer exists reports nothing at all and the run looks clean. It is turned
// into a thrown error here so the caller can say so out loud.
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true, userGesture: true,
  });
  const d = r.result;
  if (d?.exceptionDetails) {
    const e = d.exceptionDetails;
    throw new Error(e.exception?.description?.split('\n')[0] || e.text || 'threw');
  }
  return d?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send('Emulation.setDeviceMetricsOverride', { width: +w, height: +h, deviceScaleFactor: +dpr, mobile: false });
await send('Page.enable');
await send('Runtime.enable');
// before the navigation, so boot-time output is caught
await send('Log.enable');

const t0 = Date.now();
await send('Page.navigate', { url });

let ready = false;
for (let i = 0; i < 90 && !ready; i++) {
  await sleep(400);
  ready = await evaluate(`(() => { const l = document.getElementById('loader');
    return !!l && getComputedStyle(l).opacity === '0'; })()`).catch(() => false);
}
console.log(`ready in ${((Date.now() - t0) / 1000).toFixed(1)}s${ready ? '' : ' (loader never cleared)'}`);

for (const s of steps) {
  const ts = Date.now();
  if (s.js) {
    try {
      const r = await evaluate(s.js);
      if (r !== undefined && r !== null) console.log(`  ${s.name} js -> ${typeof r === 'string' ? r : JSON.stringify(r)}`);
    } catch (err) {
      problems.push(`${s.name} js THREW: ${err.message}`);
    }
  }
  await sleep(s.wait ?? 1200);
  const shot = await send('Page.captureScreenshot', {
    format: 'png', fromSurface: true, captureBeyondViewport: false,
    // optional per-step crop: [x, y, w, h, scale] in page pixels
    ...(s.clip ? { clip: { x: s.clip[0], y: s.clip[1], width: s.clip[2], height: s.clip[3], scale: s.clip[4] ?? 1 } } : {}),
  });
  const out = `${outDir}/${s.name}.png`;
  writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  console.log(`${s.name}  ${((Date.now() - ts) / 1000).toFixed(1)}s`);
}

if (problems.length) console.log('page errors:\n  ' + problems.join('\n  '));
else console.log('no page errors');
ws.close();
