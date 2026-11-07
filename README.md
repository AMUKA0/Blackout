# Blackout

Six rescue actors keep working toward one goal (reach every survivor in time) while their links fail. Built for the Neptune North challenge at GreatUniHack.

## What's in the repo

- `src/shared/`: the world (floods and buildings from a seed), the rule brain, and the knowledge merge. These run on every device.
- `src/sim/`: a headless simulator running the scripted fault timeline in `src/shared/faults.ts`, plus the 50-map baseline.
- `src/net/`: the hub (Laptop A), Gemini, and the n8n link.
- `src/live/`: the live actors, the HQ dashboard, the phone page, and the radio.
- `public/`: pages, fonts, and the pre-rendered ElevenLabs clips.

## One-time setup

1. Install Node 24, then run `npm install` in the repo.
2. **Laptop A only:** put `ELEVENLABS_API_KEY`, `N8N_URL` and `N8N_API_KEY` in `.env.local`. Never paste them into chat.
3. **Laptop A only:** sign in to Google (see docs on Vertex: the `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION=global` and `GOOGLE_GENAI_USE_VERTEXAI=true` user variables). Open a new terminal afterwards so it sees them.
4. Laptop B needs no keys. It reaches Gemini through Laptop A, so it loses Gemini when its radio is off.

## Run it

### Rehearsal on one laptop

Use two terminals on Laptop A:

```bash
npm run a
```

```bash
npm run b
```

Then:

1. Open `http://localhost:8080/` and click **Turn on radio**.
2. Open `http://localhost:8080/phone` in a second window, keep it in front, and tap **Start Scout 4**.
3. Click **Start mission** on the dashboard.

### The real demo on three devices

1. Join both laptops and the phone to the **same phone hotspot**, not venue Wi-Fi.
2. On both laptops, set that network to **Private**, and allow Node through the firewall when Windows asks.
3. **Laptop A:** run `npm run a`. It prints Laptop A's IP address.
4. **Laptop B:** run `$env:HUB="<laptop A ip>"; npm run b` in PowerShell. Its Wi-Fi is its radio: switch Wi-Fi off on stage to cut it off, and back on to reconnect. It notices within about 3 seconds either way. (`$env:SCRIPTED_RADIO="1"` brings back the automatic t28 to t72 cut-off.)
5. **Phone:** open `http://<laptop A ip>:8080/phone` and tap **Start Scout 4**. Set the screen timeout to the maximum. Airplane mode is its radio switch.
6. **Laptop A:** open `http://localhost:8080/`, click **Turn on radio**, then **Start mission**. The mission lasts 100 seconds.

Each laptop also shows its own craft at `http://localhost:8081/` (Laptop A) and `http://localhost:8082/` (Laptop B). The laptop serves that page itself, so it keeps working while its radio is off. Put Laptop B's view on its screen for the demo.

The seed defaults to 13; set `$env:SEED` before `npm run a` to change it. If you change it, also run `node scripts/plan.ts <seed>` for Argon's standing orders.

## Other commands

```bash
npm test                 # merge laws, determinism, convergence, n8n outbox
npm run sim -- 13 mesh   # one headless mission, prints events
npm run baseline -- 50   # 3 conditions x 50 seeds, refreshes public/baseline.json
npm run n8n:deploy       # create or update the n8n workflow
```
