# Customer demo pack

Eighteen modules of the live application, captured from the running engine with a headless browser.
Nothing here is a mock-up: each recording is a real session — the tab is opened, the button is
pressed, and the engine answers.

| File | What it is |
| --- | --- |
| `index.html` | **The deliverable.** A self-contained gallery: every module's recording and poster embedded, so it opens from a file, an email or any static host with no network access. |
| `screens/<module>.png` | Full-page screenshot of the module at 1600×1000, taken after the interaction. |
| `screens/<module>-poster.jpg` | The compact poster frame the gallery uses. |
| `video/<module>.mp4` | The full-quality recording of that module (MP4/H.264, plays in any browser). |
| `video/small/<module>.mp4` | The compact recording embedded in the gallery. |
| `video/<module>.webm` | The original capture, kept because it is lossless-ish and re-encodable. |
| `demo-pack.json` | The manifest: what was captured, when, at which viewport, and where each file is. |

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
