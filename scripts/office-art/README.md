# Office art («Общий зал»)

Generated, reproducible pixel art for the desktop-only office tab. No image
editor and no dependencies: Node + zlib with a small PNG codec (`png.mjs`).

    node scripts/office-art/build.mjs            # → src/renderer/src/office/assets/
    node scripts/office-art/scene.mjs out.png 2   # reference scene (engine layout), ×2

Output: `tiles.png`, `agents.png`, `roles.png`, `effects.png`, `manifest.json`
(`OfficeArtManifestV1`, `src/shared/office.ts`) and `preview.png` (every frame,
×2, red dot = anchor). `tests/office-art.test.mjs` regenerates in memory and
fails if the committed PNG pixels or manifest differ.

## Conventions for the engine

- Tile 16×16; character frame 32×48, anchor (16,44) at the feet. Atlases have a
  2 px gutter; 16×16 tiles are edge-extruded, so fractional zoom does not seam.
  Draw with `imageSmoothingEnabled = false` and rounded destination pixels.
- `agent.<claude|codex|gemini|general>` — body; unknown kinds use `general`.
  `role.<lead|reviewer|devops|frontend|backend|docs|designer|general>` — overlay
  on the same frame and anchor, drawn right after the body, same timing.
- Agent/role states: `<idle|working|blocked|done|unknown>:<front|back>`.
  `disconnect` has no art of its own: freeze the current frame. `unknown`
  frames are identical (no motion). Blocked frames already contain the `?`
  bubble; `effect.question` is for other places (e.g. the list or a board).
- `tile.*`: anchor (0,0), state `default`. `object.*`: anchor bottom-centre,
  Y-sorted. Desks `object.desk.front|back|terminal` are 64×48 (4×3 tiles) with
  states `on`/`off`; their anchor is the bottom-centre of the seat rectangle
  (= `seat.anchor` in `office/layout.ts`).
- Seating relative to the desk anchor (see `SEAT_OFFSETS` in `scene.mjs`):
  row facing the viewer (`front`): `object.chair.front` at (0,−28), agent at
  (0,−27); row with backs to the viewer (`back`): agent at (0,+9),
  `object.chair.back` at (0,+10). A shell pane uses `object.desk.terminal`
  without agent or chair.
- Within the same anchor Y, draw in `manifest.layers` order.
- Room: `tile.wall.cap` (top and sides), `tile.wall.face.top` + `.bottom` under
  the top cap, `tile.wall.shadow` on the first floor row, `tile.wall.cap.front`
  for a wall in front of the floor (occludes). Rugs: 9-slice
  `tile.floor.carpet.<red|green|blue>.<tl|t|tr|l|c|r|bl|b|br>`.
  Machines outside the departments: `object.machine.pc`,
  `object.machine.homeserver`, `object.server.rack` on `tile.floor.server`.
- The user node «Вы»: `object.user` (tiles atlas, layer `body`, state `default`,
  4 looping frames: steam and a blink; frame 0 is the still pose). It uses the
  character frame: 32×48, anchor (16,44) at the feet, so it stands on its point
  like an agent; put its label above the head (anchor − ~50 px).
- Effects: `effect.envelope` (anchor centre), `effect.question|alert|error`
  (anchor bottom-centre), `effect.attempt` + `effect.dash` for unconfirmed
  attempts, `effect.cable.h|v|plug` (8×8) for SSH links, `effect.sparkle`,
  `effect.select` (hover/selection ring under the feet).
