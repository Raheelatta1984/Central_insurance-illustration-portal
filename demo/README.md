# Customer demo pack

Nineteen modules of the live application, captured from the running engine with a headless browser.
Nothing here is a mock-up: each recording is a real session — the tab is opened, the button is
pressed, and the engine answers.

| File | What it is |
| --- | --- |
| `index.html` | **The gallery.** A self-contained tour: every module's recording and poster embedded, so it opens from a file, an email or any static host with no network access. |
| `offline.html` | **The console itself, working with no server.** The real built application plus the engine's recorded answers, replayed through a `fetch` shim: every tab, button and refusal works from a double-click. |
| `screens/<module>.png` | Full-page screenshot of the module at 1600×1000, taken after the interaction. |
| `screens/<module>-poster.jpg` | The compact poster frame the gallery uses. |
| `video/<module>.mp4` | The full-quality recording of that module (MP4/H.264, plays in any browser). |
| `video/small/<module>.mp4` | The compact recording embedded in the gallery. |
| `video/<module>.webm` | The original capture, kept because it is lossless-ish and re-encodable. |
| `demo-pack.json` | The manifest: what was captured, when, at which viewport, and where each file is. |

## The console that works with no server

A video shows a screen; `offline.html` **is** the screen. It is the same bundle the server serves,
with the engine's answers to 26 endpoints — status codes included — baked in and served back to the
application through a `fetch` shim, plus a banner so nobody mistakes it for a live session.

Open it and click anything: the tabs render, the buttons run, the numbers are the engine's own. The
interesting answers are deliberate:

- **Claims** → *Ask the AI to approve 25,000.00* → the engine refuses with the sentence and the
  status a customer can act on: `an AI agent may authorise at most 1,000.00 AED straight through;
  25,000.00 AED needs a human authority` (HTTP 409, not a 500).
- **Decision theatre** → *Price the switch* → priced even though the instruction is taken after the
  15:00 cut-off and the next dealing day has no valuation yet: it uses the latest published
  valuation and says so in plain words.
- **Takaful** → surplus approval walks Shariah Committee → actuary → Board in order, and refuses out
  of order.

The only difference from the live app: state cannot change, because there is no engine behind it —
every action replays the answer the engine gave when the pack was recorded. That is the point: it
demonstrates the product with no port, no tunnel, no network and no access token.

```bash
npm start                  # the world lives on the server
npm run demo:record        # drives the console, records every /api answer with its status
npm run demo:offline       # inlines the built bundle + the recording into demo/offline.html
```

Record after changing an engine or a screen, or the replay will show a previous version. The
recording needs Chromium, so on this workspace run it with
`LD_LIBRARY_PATH=../local-libs/usr/lib/x86_64-linux-gnu npm run demo:record`.

## Regenerating it

The pack is built by driving the app, so it cannot drift from the product:

```bash
npm install
npm run build
npm start            # leave the server running on :8787
npm run demo:pack    # screenshots + per-module recordings (headless Chromium)
npm run demo:gallery # rebuilds demo/index.html from the pack
```

`npm run demo:pack` follows the same steps as `src/core/tour.ts` — the sixty-minute tour in the
console — so if the app's workflow changes, regenerate the pack and the gallery tells the truth
again. On a machine without Playwright's system libraries (no root, as in this workspace), the
static-build dependencies were fetched into `../local-libs` and pointed at with `LD_LIBRARY_PATH`;
on a normal machine `npx playwright install --with-deps chromium` is enough.

## Notes for whoever presents it

- The videos are short on purpose (about ten seconds each): open the tab, do the thing, show the
  result. The full story is the Tour tab in the console.
- Deliberate refusals make good viewing: an AI approval above its straight-through limit, a takaful
  surplus before the Shariah Committee has signed, a claim reserve that cannot be reduced silently.
- Everything on screen is a live engine value; the same screenshots are reproducible byte-for-byte
  in structure by rerunning the pack.
- Refusals are answers, not failures: the API returns **409** with the engine's own sentence when a
  business rule says no, and **500** only when something is genuinely broken. The console prints the
  sentence either way, so a demo never dies silently.
- If you are handed a link that will not open (a tunnel that needs a token, a host behind a
  firewall), give the customer `index.html` or `offline.html` instead — a file always opens.
