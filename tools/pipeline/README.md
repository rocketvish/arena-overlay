# Set-data pipeline

Turns 17Lands' public datasets (https://www.17lands.com/public_datasets, CC BY 4.0)
into the small per-set tables the overlay downloads at runtime (`src/main/setData.js`).

Per set (~100–200 KB JSON):
- per-card GIH/OH/GP win rates and ATA (stand-in when the live 17Lands endpoint drops a set)
- per-card GIH WR inside each two-color deck (archetype-specific card quality)
- per-card wheel rates by pick (is it still there 8 picks later?)
- two-color deck win rates, all players and top players
- a pick model trained on top players' drafts (pool-aware factorization, ~33 floats per card)

Public data appears ~2 weeks (drafts) / ~3 weeks (games) into a set. Until then the
overlay runs on live 17Lands numbers and its model-free weights.

## Build

```sh
node --max-old-space-size=8192 tools/pipeline/build-set.js FRA          # → data/sets/FRA.json
```

Downloads 50–300 MB per set into the OS temp dir (reused on reruns) and takes 1–3 minutes.
Also writes held-out top-player drafts (`eval.<SET>.PremierDraft.json.gz`) to that cache.

## Measure and tune

```sh
node scripts/eval-picks.js FRA --table data/sets/FRA.json --eval <cache>/eval.FRA.PremierDraft.json.gz
node scripts/tune-weights.js --set HOB <table> <eval> --set EOE <table> <eval>            # with model
node scripts/tune-weights.js --no-model --set HOB <table> <eval> --set EOE <table> <eval> # before a set's data exists
```

`eval-picks` reports how often the overlay's top recommendation matches the pick a top
player actually made. Tune on one set, check the printed test halves of the others,
then copy the printed weights into `WEIGHTS_MODEL` / `WEIGHTS_BASE` in `signalAnalyzer.js`.

## Automatic updates

`.github/workflows/set-data.yml` runs daily: `update-sets.js` checks the 8 newest expansions,
compares 17Lands' dataset dates with the published tables, rebuilds what's new or changed and
publishes. Run it by hand from the Actions tab (optionally with set codes / force), or locally:

```sh
node tools/pipeline/update-sets.js --dry-run      # what would change
node tools/pipeline/update-sets.js FRA            # build + publish if the data exists
```

## Publish

```sh
node tools/pipeline/publish.js data/sets/FRA.json data/sets/EOE.json …
```

Uploads to the `set-data` pre-release (needs the GitHub CLI). It's a pre-release so the
app's auto-updater, which follows the latest stable release, ignores it.
