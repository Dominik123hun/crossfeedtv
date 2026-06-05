# Design assets

Original brand imagery generated with the **Higgsfield** MCP for the Crossfeed
redesign. Palette fed into every prompt: near-black base `#0a0a0c`, Twitch violet
`#9146FF`, Kick green `#53FC18`, X white.

## ⚠️ How these get into the build

The assets are generated and hosted on Higgsfield's CDN, but the build sandbox
**can't reach that CDN** (host not in allowlist), so they're **not bundled here
yet**. The site ships with **premium CSS fallbacks** (gradients/grain) and
progressively loads `/public/assets/*.webp` if present (see `landing.js`
`loadArt()`), so it looks polished with or without the images.

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
| `public/assets/hero.webp` | Hero background — three light ribbons converging into one stream, right-weighted, left negative space | job `d288c14c` | soul_location · 16:9 |
| `public/assets/hero-mobile.webp` | Vertical hero variant (convergence up top) | job `a7c63cf3` | soul_location · 9:16 |
| `public/assets/stream-scene.webp` | Abstract atmospheric "stream room" backdrop for the OBS section | job `63a268f1` | soul_location · 16:9 |
| `public/assets/glyph.webp` + `icon.png` | Logo mark / favicon — lines merging into one node | job `8a03fdf0` | nano_banana_pro · 1:1 |
| `public/assets/og.webp` | Social share image — derived from the hero (1200×630 crop) | (from hero) | — |
| section textures | Subtle section depth | **CSS-native** (gradients + grain) — no raster needed | — |

### Download (ready-to-save WebP → target filename)

Save each into `public/assets/` with the name on the left:

- `hero.webp` → `https://d8j0ntlcm91z4.cloudfront.net/user_3D0Il7JgYWTFGs1800Z26K2HBcy/hf_20260605_151045_d288c14c-c260-424b-8aa4-d4e47ae85810_min.webp`
- `hero-mobile.webp` → `https://d8j0ntlcm91z4.cloudfront.net/user_3D0Il7JgYWTFGs1800Z26K2HBcy/hf_20260605_152552_a7c63cf3-1b76-47f5-85c7-66e6ee067414_min.webp`
- `stream-scene.webp` → `https://d8j0ntlcm91z4.cloudfront.net/user_3D0Il7JgYWTFGs1800Z26K2HBcy/hf_20260605_152545_63a268f1-0036-4eb2-8a4a-0f7857339f1c_min.webp`
- `og.webp` → reuse the hero (copy `hero.webp` → `og.webp`), or download the hero WebP again under this name
- `icon.png` (favicon, optional) → the glyph: `https://d8j0ntlcm91z4.cloudfront.net/user_3D0Il7JgYWTFGs1800Z26K2HBcy/hf_20260605_152536_8a03fdf0-79a0-432d-b347-52f0ed0d9035_min.webp` (save as PNG, or point the favicon at a `.webp` if you prefer)

These `_min.webp` links are already web-optimized WebP, so no conversion tool is
needed. (The full-resolution originals are the same URLs without the `_min.webp`
suffix — `.png`/`.jpeg` — if you want to resize them yourself.)

## Prompts (to regenerate / swap)

**Hero (16:9) & mobile (9:16):** "Premium abstract brand background for a
live-streaming product. Three separate flowing ribbons of luminous light — one
vivid violet (#9146FF), one bright neon green (#53FC18), one clean white —
converging into a single unified luminous stream. Near-black cinematic base
#0a0a0c, deep inky blacks, volumetric haze, soft bloom, delicate filaments. Calm
dark negative space for text. Moody, high-end, restrained, no gradient soup. No
text/logos/people/UI." (16:9 converges right; 9:16 converges top.)

**Logo glyph (1:1, nano_banana_pro):** "Minimal abstract logo mark. Three thin
luminous lines — violet #9146FF, neon green #53FC18, white — entering from the
left and merging into one bright glowing node on the right. Clean geometric,
glowing, centered, icon-like, solid near-black #0a0a0c background. No text/letters."

**Stream-scene (16:9):** "Abstract atmospheric backdrop evoking a moody streaming
room at night — soft defocused bokeh, dark teal+violet ambient light, faint neon
green glow, near-black #0a0a0c, volumetric haze, no identifiable objects.
Cinematic, calm, low-contrast. No text/people/characters/game content/logos."

To swap any asset: regenerate in Higgsfield with an adjusted prompt and replace the
file in `public/assets/` (keep the same filename), then commit.
