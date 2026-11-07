# Blackout

Six rescue actors keep working toward one goal (reach every survivor in time) while their links fail. Built for the Neptune North challenge at GreatUniHack.

## What exists now

- `src/shared/`: the world from a seed, the rule brain, and the knowledge merge. These run on every device.
- `src/sim/`: a headless simulator running the scripted fault timeline in `src/shared/faults.ts`.
- `src/net/`: the hub (Laptop A), the device runner (Laptop B), heartbeats, clock sync, and the radio-off switch.
- `public/`: the phone page (Scout 4) and the HQ device-check dashboard.

## Commands

Node 24 runs the TypeScript directly. There's no build step.

```bash
npm install
npm test                 # merge laws, determinism, convergence
npm run sim -- 3 mesh    # one mission, prints events, writes out/run-3-mesh.json
npm run baseline -- 50   # 3 conditions x 50 seeds, picks demo seeds
```

## Running on the real devices

1. Join both laptops and the phone to the **same phone hotspot**. Don't use venue Wi-Fi, because it usually blocks devices from talking to each other.
2. On both laptops, set the hotspot network to **Private** (Settings > Network > the Wi-Fi network > Network profile). When Windows asks, allow Node through the firewall on private networks.
3. On Laptop A, run `npm run hub` in one terminal. It builds the web pages and prints the phone URL and Laptop B's `HUB` address. Then run `npm run laptop -- A` in a second terminal for S1 and R1.
4. On Laptop B, run `$env:HUB="<laptop A ip>"; npm run laptop -- B` in PowerShell. Its radio switches off and on by itself at the scripted ticks. Press `r` to toggle it by hand.
5. On the phone, open `http://<laptop A ip>:8080/phone`, tap **Start**, and set the screen timeout to the maximum. Airplane mode is its radio switch.
6. Open `http://localhost:8080/` on Laptop A for the HQ dashboard, then press `s` in the hub terminal to start a 100-second mission. The seed is set with `$env:SEED`, and defaults to 3.

If the hotspot fails, use Windows Mobile Hotspot on Laptop A instead.
