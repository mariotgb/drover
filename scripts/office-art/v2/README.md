# Office art v2.1 («Общий зал 2.0»)

Two sets of art with identical keys:
- **cozy** («Мастерская») — the light Drover theme;
- **neon** («Неоновый хаб») — the dark Drover theme.

The engine switches only the set; everything else stays the same.

```
node scripts/office-art/v2/build.mjs                                   # → src/renderer/src/office/assets/v2/{cozy,neon}/
node scripts/office-art/v2/previews.mjs ~/remote-mac/screens office-v21-art   # sheets + atlas-only samples
node --test tests/office-art-v2.test.mjs
```

Files per set: `manifest.json` (version 2) plus the atlases `tiles`, `furniture`, `agents`, `roles`, `effects` and `font` (`.png`). The type lives in `src/renderer/src/office/assets/v2/manifest.ts`.

`atlas-sample.mjs` is a reference renderer that reads only the manifest and the atlases, as the engine does. If a sample looks right, the data is enough.

The older mock-up modules (`render.mjs`, `props.mjs`, `overlay.mjs`, `themes.mjs`, `light.mjs`, `layout.mjs`) stay import-compatible for `generated-art.ts`.

## Drawing order (per frame)

1. **Flat layers:** `floor`, `floor-shade`, `rug` — tiles, ground decals, rugs, SSH cables (`effect.cable`).
2. **Y-sorted pass** by anchor Y, then by the index in `manifest.layers`:
   - `wall`, `wall-decor`, `furniture-back`, `body`, `role`, `furniture`, `furniture-top`, `wall-front`;
   - monitors (`furniture-top`) share the anchor of their bench column, so they draw right after it.
3. **Light map:**
   - start at `lighting.ambient`;
   - add `sprite.lights` at anchor + `(dx, dy)`, only for the listed `states`;
   - add the zone lights from `lighting.*`;
   - multiply into the scene, in bands of `1/steps` with a Bayer 4×4 dither (`light.mjs` is the reference).
4. **Emissive pass:** every frame that has `emit` draws that rect unlit at the same place (screens, LEDs, neon, signs at night).
5. **Glow (neon, `lighting.glowSprites`):** `effect.glow` `<colour>:<s|m|l>` with `globalCompositeOperation = 'lighter'`, centred.
6. **Overlays, unlit:**
   - links: procedural dotted line or beam from `palette`, plus `effect.link.dot`;
   - carriers: `effect.carrier`, `effect.trail`;
   - `effect.arrival`, `effect.note`, `effect.attempt`/`crumple`/`spark`, `effect.confetti`;
   - plaques (nine-slice + font), `effect.bubble`, labels.

## Characters

Sprites:
- `agent.<claude|codex|gemini|general>` plus `role.<lead|reviewer|devops|frontend|backend|docs|designer|general>` — draw the body, then the role, on the same anchor;
- frame 32×48, anchor (16, 44).

State `<pose>:<dir>`:

| pose | frames | use |
|---|---|---|
| `idle` `working` `done` `unknown` | 4/4/4/2 | status (unknown and disconnect are grey, no motion) |
| `blocked` | 4 | waves a hand. The bubble is separate: `effect.bubble ?` |
| `throw` | 2, no loop (160/120) | sender of `prompt` / `prompt_attempt` |
| `catch` | 2, no loop | receiver of `prompt` (jump baked in) + `effect.bubble !` |
| `stretch` | 2, no loop | idle for more than 3 min, decorative |
| `stand` / `walk` | 2 / 4 | `front`, `back` and `side` (mirror `side` for walking left) |

Other characters:
- **`agent.user`** («Вы»): `idle:front` (steam and blink), `throw:front` (`user_prompt`).
- **`agent.boss`** («Главный босс»): `sit:front`, `stand:front`, `dispatch:front` (windup → fan of gold envelopes → follow-through), `pleased:front`, `walk:side`. Launch one `effect.carrier boss:<angle>` per lead.

## Bench seat geometry

`object.bench.col.slots` gives offsets from the column anchor. The anchor sits at the column centre, at y = deskTop + 36.

| slot | north (faces you) | south (back to you) |
|---|---|---|
| agent / chair | `agentNorth` (3, −28) / `chairNorth` (3, −29), chair `front` `out\|in` | `agentSouth` (−6, 8) / `chairSouth` (−6, 11), `chairSouthIn` (−6, 4), chair `back` |
| plaque (top-centre) | `plaqueNorth` (3, −76), pointer down | `plaqueSouth` (−6, 14), pointer up |
| bubble (bottom) | `bubbleNorth` (3, −77) | `bubbleSouth` (−6, −32) |
| head / hand / land | `headNorth`, `handNorth`, `landNorth` | `headSouth`, `handSouth`, `landSouth` |
| SSH cable start | `cableNorth` (14, −6) | `cableSouth` (10, 4) |

Column states are `<single|left|mid|right>:<0..3>` (end caps × desk clutter).

Monitors share the column anchor:
- `object.monitor.back`: `on` / `off` (north seat);
- `object.monitor.front`: `code` (3 frames), `ask`, `term`, `done`, `off` (south seat).

Head desk, `object.desk.head.slots`:
- `agent`, `chair` (`object.chair.lead`), `plaqueAgent` (the lead plaque uses the star), `hand`, `land`, `head`, `bubble`;
- `plaque` — a rect on the desk front for the name in font `ink`.

Boss office: `object.desk.boss.slots` (`agent`, `chair`, `phone`, `plaque`), `compositions.boss`, `compositions.bossSlots`.

## Nine-slices and font

- **`nineSlices`:**
  - `plaque.<default|blocked|lead|you>`: 9 px tall, caps 3 px. Status mark `effect.status.<status>` at (`markX`, `markY`); text at (`textX`, `textY`); max width 46 px.
  - `label.<dark|light|warn>`.
  - `sign.x1` / `sign.x2`: hall sign, scale 2 when the hall is at least 20 tiles wide and the text is at most 40 px.
- **Pointer:** `effect.plaque.pointer` `down:<v>` / `up:<v>`. Lead star: `effect.star`.
- **Font** (`font.png`, pix5):
  - glyph `{x, y, w}` at the ink row; add `font.colors[ink|light|sign|warn|dim]` to y;
  - uppercase lookup; space = `font.space`; spacing 1; fallback `?`;
  - Cyrillic letters that look like Latin share the Latin rects.

## Compositions (`manifest.compositions`)

What stands in each zone. The keys are the same in both sets; the contents differ.

**Item fields:**
- `{ sprite, state?, x | xr | xc, y | yb, sortY? }` — anchor position relative to the zone origin;
- `xr` / `yb` count from the right / bottom edge; `xc` counts from the centre;
- `sortY` overrides the draw order (for example, the cat on the sofa).

**Region:** `{ tiles: 'tile.rug', x, y, w, h }` — nine-slice by part suffix `tl t tr l c r bl b br`.

**Lounge:** `lounge.narrow`, then `lounge.wide` is added for halls of 20 tiles or more, and `lounge.widest` for 34. `replaces` drops the named sprite, or the narrow rug, from the narrow list.

**Zones:**
- `head`: `narrow` always; `noLead` when there is no lead; `wide` for halls of 20 tiles or more.
- `wall`: the board, the clock (`narrow`/`wide`), the picture (`wideOnly`), the window rule, the sign.
- `lobby` (12 × 13 tiles), `server` + `machine`, `boss` (14 × 13 tiles, a room on the corridor next to the lobby), `corridor`, `outside`.
- `pet`: cozy → `object.cat` (rests on the sofa); neon → `object.robot`. Moves only along aisles and the lounge.
- `timeOfDay`: windows get `object.window` `day|evening|night` by local time; `lighting.window.byTime` scales the light.

## Interaction effects (see OFFICE-V2-ANIM.md)

| effect | key | notes |
|---|---|---|
| carrier | `effect.carrier` `agent|user|boss:<0..15>` | angle index = round(atan2(dy, dx) / (π/8)) mod 16. Neon adds `effect.glow cyan:m` |
| trail | `effect.trail` `agent|user|attempt` | every other point on the arc |
| arrival | `effect.arrival` (4 × 60 ms) | at the land point; then `effect.note agent|user` stays on the desk |
| attempt | `effect.attempt fall` (4 × 125 ms) → `effect.crumple` 2.5 s; neon also gets `effect.spark` | |
| done | `effect.confetti` (6 × 150 ms) + `effect.bubble ok` | |
| blocked | `effect.bubble ?` + `object.bell ring` in the lobby + label `warn` «N ЖДУТ» | |
| ssh | `effect.cable h/v/ne/nw/se/sw/end` along the route on the floor; `effect.packet`; `object.rack hot`; `object.machine active`; `effect.activity` above the machine (`slots.activity`) | |
| board | `effect.card` flies to `object.board`; notes are `object.board.note 0..3` in `slots.col0..2` (`noteStepX` / `noteStepY`, `perColumn`) | |
| link flash | `effect.flash` | |
| selection | `effect.select` (2 frames) | anchor at the agent anchor + (0, 8) |
| steam | `effect.steam` | over mugs and the coffee machine |
