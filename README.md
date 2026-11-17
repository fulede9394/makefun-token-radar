# makefun-token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/fulede9394/makefun-token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/fulede9394/makefun-token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token Launch Radar is a dashboard ranking 200 protocols that record no token by what a launch would be worth, with a concrete farm plan for each one. It reads a sealed DefiLlama snapshot (758 protocols, 2026-11-14), covers all 40 of the snapshot's watchlist, and ranks by implied value from TVL, seven-day growth and how long each protocol has run with no token recorded.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <path to snapshot.json>
```

Then open `out/dashboard/index.html` in a desktop browser. The board is sortable and filterable, and clicking a row opens its detail view with the farm plan.

---

<sub>Entered on [make.fun](https://make.fun/?ref=5kkq1ant&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
