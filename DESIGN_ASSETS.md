# Design assets

Original brand imagery generated with the **Higgsfield** MCP for the Crossfeed
redesign. Palette fed into every prompt: near-black base `#0a0a0c`, Twitch violet
`#9146FF`, Kick green `#53FC18`, X white.

## ⚠️ How these get into the build

The assets are generated and hosted on Higgsfield's CDN, but the build sandbox
**can't reach that CDN** (host not in allowlist), so they're **not bundled here
yet**. The site ships with **quiet near-black CSS fallbacks** and progressively
loads `/public/assets/*.webp` if present (see `landing.js` `loadArt()`), so it
looks polished with or without the images. Per the locked contract the hero art
is intentionally **dark/subtle** — a backdrop, not a competitor to the feed.

**To bundle the real images, add them by hand** (your browser can reach the CDN
even though the build sandbox can't): download each WebP from the "Download"
column below and save it into `public/assets/` with the **exact** target
filename, then:

```bash
git add public/assets && git commit -m "assets: bundle generated brand imagery" && git push
```

Filenames are case-sensitive and must match exactly. The hero/scene `.webp` files
are what the page loads; `icon.png` (favicon) and `og.webp` are optional. If a
source URL has expired, regenerate it from the prompt below (Higgsfield).

## Assets

| File (target) | What | Source (Higgsfield) | Model · ratio |
| --- | --- | --- | --- |
| `public/assets/hero.webp` | Hero backdrop — **dark/subtle** convergence, right-weighted, deep left negative space for text | job `b9c3a49b` (dark) | soul_location · 16:9 |
| `public/assets/hero-mobile.webp` | Vertical hero variant — **dark/subtle**, convergence up top | job `35781963` (dark) | soul_location · 9:16 |
| `public/assets/stream-scene.webp` | Abstract atmospheric "stream room" backdrop for the OBS section | job `63a268f1` | soul_location · 16:9 |
| `public/assets/texture.webp` | Subtle section texture — quiet near-black depth (optional; CSS fallback ships) | job `e48c1d0c` | soul_location · 16:9 |
| `public/assets/glyph.webp` | Logo mark / favicon (served as `image/webp`) — lines merging into one node | job `8a03fdf0` | nano_banana_pro · 1:1 |
| `public/assets/og.webp` | Social share image — derived from the hero (1200×630 crop) | (from hero) | — |

### Download (ready-to-save WebP → target filename)

Save each into `public/assets/` with the name on the left:

- `hero.webp` → `https://d8j0ntlcm91z4.cloudfront.net/user_3D0Il7JgYWTFGs1800Z26K2HBcy/hf_20260605_171216_b9c3a49b-43f1-444f-89e3-7643c7057bb4_min.webp`
- `hero-mobile.webp` → `https://d8j0ntlcm91z4.cloudfront.net/user_3D0Il7JgYWTFGs1800Z26K2HBcy/hf_20260605_171704_35781963-b49c-4e63-a99c-020cc22e7a77_min.webp`
- `stream-scene.webp` → `https://d8j0ntlcm91z4.cloudfront.net/user_3D0Il7JgYWTFGs1800Z26K2HBcy/hf_20260605_152545_63a268f1-0036-4eb2-8a4a-0f7857339f1c_min.webp`
- `texture.webp` (optional) → `https://d8j0ntlcm91z4.cloudfront.net/user_3D0Il7JgYWTFGs1800Z26K2HBcy/hf_20260605_171712_e48c1d0c-60b3-4f35-a39e-29f418263dd7_min.webp`
- `og.webp` → reuse the hero (copy `hero.webp` → `og.webp`), or download the hero WebP again under this name
- `glyph.webp` (favicon) → `https://d8j0ntlcm91z4.cloudfront.net/user_3D0Il7JgYWTFGs1800Z26K2HBcy/hf_20260605_152536_8a03fdf0-79a0-432d-b347-52f0ed0d9035_min.webp` (the pages reference it via `<link rel="icon" href="/assets/glyph.webp" type="image/webp">`)

These `_min.webp` links are already web-optimized WebP, so no conversion tool is
needed. (The full-resolution originals are the same URLs without the `_min.webp`
suffix — `.png`/`.jpeg` — if you want to resize them yourself.)

## Prompts (to regenerate / swap)

**Hero (16:9) & mobile (9:16) — dark/subtle (locked contract):** "Minimal,
restrained abstract backdrop for a dark high-end developer product (Linear/Vercel
grade). Mostly deep near-black #0a0a0c. In one corner only, three very faint thin
filaments of light — a whisper of violet #9146FF, a whisper of green #53FC18, and
white — converging into a single quiet line. Extremely low contrast, no bloom, no
glow, no gradient soup, no saturated fills. Most of the frame is calm empty
near-black negative space for text. Subtle, atmospheric, premium, quiet. No
text/logos/people/UI." (16:9 converges far right; 9:16 converges top — keep it a
backdrop, never a competitor to the live feed.)

**Logo glyph (1:1, nano_banana_pro):** "Minimal abstract logo mark. Three thin
luminous lines — violet #9146FF, neon green #53FC18, white — entering from the
left and merging into one bright glowing node on the right. Clean geometric,
glowing, centered, icon-like, solid near-black #0a0a0c background. No text/letters."

**Stream-scene (16:9):** "Abstract atmospheric backdrop evoking a moody streaming
room at night — soft defocused bokeh, dark teal+violet ambient light, faint neon
green glow, near-black #0a0a0c, volumetric haze, no identifiable objects.
Cinematic, calm, low-contrast. No text/people/characters/game content/logos."

**Section texture (16:9):** "Very subtle dark surface texture — near-black #0a0a0c
with an almost-invisible fine grain and the faintest large-scale tonal variation.
No color, no pattern, no objects, no light sources. Flat, quiet, low contrast,
premium. Just barely-there depth for a dark UI section background. No
text/logos/people."

To swap any asset: regenerate in Higgsfield with an adjusted prompt and replace the
file in `public/assets/` (keep the same filename), then commit.
