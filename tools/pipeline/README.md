# Set-data pipeline

Turns 17Lands' public datasets (https://www.17lands.com/public_datasets, CC BY 4.0)
into the small per-set tables the overlay downloads at runtime (`src/main/setData.js`).

Per set (~100–200 KB JSON):
- per-card GIH/OH/GP win rates and ATA (stand-in when the live 17Lands endpoint drops a set)
- per-card GIH WR inside each two-color deck (archetype-specific card quality)
- per-card wheel rates by pick (is it still there 8 picks later?)
- two-color deck win rates, all players and top players
- a pick model trained on top players' drafts (pool-aware factorization, ~33 floats per card)
- a deck win model (`value`, see below)

## Deck win model

`winModel.js` fits a logistic regression of game wins on deck contents, controlling for the
player's skill bucket, rank and play/draw: a value per card, the archetype (pair) effect, and
learned costs for deck shape — creatures short of 11/13/15, two-drops short of 2/4, removal
short of 4, too many 6+ drops. Card traits come from Scryfall (`cards.js`). It also stores
"phantom" future picks per pair (what drafters who ended in that pair took at each pick).
The overlay (`src/main/winValue.js`) scores a pick by how much it raises the projected deck's
win chance, blended with the top-player pick model (`WIN_RULE` in `signalAnalyzer.js`).

Checked with `win-policy.js` on held-out drafts (games and drafts held out by draft id):

- card values beat the 17Lands-style deck average at predicting held-out games
- where the rule and the top-player model disagree, drafters who took the rule's pick won more
  matches within their skill bucket: HOB +0.31pp per pick (t 5.4), SOS +0.04 (t 1.0),
  ECL +0.35 (t 7.8; never tuned on), about 5 such picks per draft
- in simulated pods, decks scored by a model fitted on the *other* half of the data:
  +1.1 (HOB) / +2.9 (SOS) / +4.2 (ECL) points of deck value, with higher average GIH WR

Pure win value (no blend) loses to imitation once the judge is independent — it chases its
own noise — so keep λ > 0. Observational evidence, not a controlled experiment.

## Recency

Formats drift: the field learns which commons are good. `recency-research.js` predicts a set's
last week from the weeks before. Weighting later drafts more helped on HOB, SOS and ECL: the
pick model is best with a ~10-day half-life (+0.3–0.6 points top-1 on the last week); average
pick and wheel rates drift faster and are best at ~4 days (average-pick error down ~60%).
`build-set.js` uses those (`PICK_HALF_LIFE_DAYS`, `STATS_HALF_LIFE_DAYS`). Whole-period
held-out agreement dips slightly as a result — the trade is deliberate.

```sh
node --max-old-space-size=12000 tools/pipeline/recency-research.js HOB --half-lives off,10,7,4
```

## Pack-2 forecast

Pack 2 is passed from the left; in pack 1 the cards missing from your returning packs went to
the left side. `pack2-research.js` checks whether that predicts what reaches you in pack 2:
it does (HOB / SOS / ECL), about 1.4× as much per unit as the ordinary pack-1 signal, which
the overlay now adds to its pack-2 color signals (`LEFT_TAKE_WEIGHT` in `signalAnalyzer.js`).

## New sets (before public data)

Public datasets arrive 2–3 weeks into a set. Until then the app builds the deck win model from
a cross-set prior (`src/main/valuePrior.json`, from `build-prior.js` over the published tables):
deck value per 17Lands GIH z (0.043–0.053 log-odds in every set), deck-shape costs, future-pick
quality by pick, and an archetype term from live pair win rates. Re-run when sets are added:

```sh
gh release download set-data -R rocketvish/arena-overlay -p '*.json' -D <dir>
node tools/pipeline/build-prior.js <dir>
```

The win rule also tries one splash color per pair (B+ or better, one off-color pip, at a discount
that fixing for that color reduces) and fades the top-player tilt over the draft.
`newset-research.js` replays held-out drafts pretending the set is new (prior from the other
sets): against the old model-free scorer, and for the splash / tilt changes, the outcome
differences were within noise on HOB / SOS / ECL (|t| ≤ 1.5, mixed signs). They were kept for
behavior — committing to a pair, filling creature / two-drop / removal gaps, a splash threshold
— not for a measured win-rate gain.

```sh
node --max-old-space-size=12000 tools/pipeline/newset-research.js HOB          # old vs prior vs table
node --max-old-space-size=12000 tools/pipeline/newset-research.js HOB --tilt   # ablations
node --max-old-space-size=12000 tools/pipeline/newset-research.js HOB --vacuum # vs best card in a vacuum
```

`--vacuum` judges the pool-aware rule against picking the best card alone (top GIH, or top GIH
in your top two colors). Taking the table's pick where they disagree: +0.08 / +0.07 / +0.19pp
match win per pick vs top GIH and +0.16 / +0.08 / +0.07 vs top GIH in colors (HOB / SOS / ECL),
positive in all six, each |t| < 2. The prior alone is about even with them (mixed signs).

## Pro-practice checks (tested, not adopted)

Ideas from expert Limited content (Sierkovitz / 17Lands analyses, LR, PVDDR), each tested on
HOB / SOS / ECL against the shipped model before adopting:

- **Curve beyond two-drops** (`curve-research.js`): simulated mana spent on turns 1–4 and hinges on
  3/4/5-drop counts. No consistent held-out gain (t −2.3 … +1.3, mixed signs). Too few three-drops
  and too many four-drops cost ~0.3–0.45pp per card in every set, but even those two terms alone
  don't predict better. Real decks barely vary in curve (spent T1–4 sd ≈ 0.5 mana).
- **Selective inclusion** (`inclusion.js`, `newset-research.js --inclusion`): discount cards that
  drafters bench even when on color (Meek Attack: maindecked 2% vs ~90% for its value). Picks
  agree more with drafters (+1–2pp), but outcomes are mixed: −0.27 / +0.46 / +0.13pp per pick (|t| ≤ 1.4).
- **Trophy objective**: Premier and Quick Draft gem payouts are nearly linear in match win rate
  (Premier ~37–39 gems per point between 55% and 60%), so maximizing expected gems instead of win rate
  moves pick scores by ~5%. Trophy *count* is convex, but gems are the reward.
- **Format "underdrafted color" prior** (ATA vs GIH residual by color): already in the model as
  the per-pair phantom future picks (what drafters who ended in a pair actually got later). The
  ATA residual disagrees with that realized value (HOB r = −0.92: the late color is the weak one).

Second round (`expert-research.js`, `pack-baseline-research.js`, `newset-research.js --splash`):

- **Card × player skill** (17Lands "Learning from the Best"): one shrunk slope per card on the
  skill bucket. Worse held-out in every set (t −1.3 / −1.3 / −3.7) — it overfits. Not adopted.
- **Deck shape by color pair** (Sierkovitz, "Finding Plans"): per-pair shape hinges. No gain
  (t −1.1 / −0.1 / −1.1). Not adopted.
- **Per-pack ATA baselines for openness** (Sierkovitz, "Data-Based Heuristics"): per-pack ATA
  differs from the global one by only ~0.2 picks, and the read predicts the next 3 picks' color
  quality no better (r 0.124 vs 0.126, 0.124 vs 0.125, 0.116 vs 0.116). Not adopted.
- **Splash and fixing**: splash decks win 2–4.5 points less per game with cards and skill held
  constant (HOB −4, SOS −4, ECL −2.4), and fixing doesn't change it (flat across 0 / 1 / 2 / 3+
  fixers). The app's splash cost was a token 0.01 log-odds; replays with 0.13: +0.56 / −0.14 /
  +0.37pp match win per changed pick (t 1.7 / −0.4 / 0.9). **Adopted** (`SPLASH.deckCost`). Dropping
  the per-fixer bonus too made no measurable difference, so the fixing rule stays.

## Synergy lane (recommendations only)

Cards that 17Lands' overall win rate undersells get their own recommendation, never a change to
the base ranking, when the lane they belong to is open (one of your likely pairs, or both
colors reading open with at least some confidence). Evidence: GIH WR inside one color pair at
least 2.5 points above overall (200+ games, full tables), top drafters taking it well above its
win rate (pick-model residual ≥ 1 SD), or an explicit combo with your pool.

## Opponent read (in game)

Per card, the table stores how each two-color archetype runs it (`cards[id].deck[P]` =
[share of decks, mean copies]). `src/main/opponentRead.js` infers the opponent's archetype from
every card they've revealed plus their lands, then the odds they hold each instant-speed card
(random hand drawn from what they haven't shown — a floor, since players hold tricks).
`opp-research.js` treats held-out 17Lands decks as the opponent: on HOB the archetype is right
92% after one spell + lands and 96–98% after 3–5 (colors alone: 82–89%), and "does the deck run
this instant" is nearly as well calibrated as knowing the archetype outright.

```sh
node --max-old-space-size=12000 tools/pipeline/opp-research.js HOB
```

## Quick Draft

17Lands publishes no Quick Draft datasets, so tables are Premier-only. In a Quick Draft the
app fetches 17Lands' live Quick Draft card ratings (current sets only) and uses the bots'
pick / last-seen positions for signals and wheel odds, plus each color's shift vs Premier
(the bots' standing color bias) for the win model's expected future picks. That part is
reasoned, not validated — there's no Quick Draft outcome data to test it on.

```sh
node --max-old-space-size=8192 tools/pipeline/win-research.js HOB          # held-out game prediction
node --max-old-space-size=12000 tools/pipeline/win-policy.js HOB --taus 0.05 --lambdas 0.01,0.02
```

Public data appears ~2 weeks (drafts) / ~3 weeks (games) into a set. As soon as the draft
data is out, a **draft-only** table is built and published (pick model, wheel rates, ATA;
`source.partial = 'draft-only'`); the full table replaces it when the game data appears.
Until then the app runs on live 17Lands numbers and the cross-set prior (below).

Note: the live `card_ratings/data` endpoint ignores date parameters and serves a rolling
recent window, so its game counts can go *down* and low-play cards drop to "no GIH" — that's
the endpoint, not a stale cache.

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
publishes. Whenever a table changes it also rebuilds the cross-set prior and publishes it as
`valuePrior.json`, which the app downloads daily (the bundled copy is the fallback). Run it by hand from the Actions tab (optionally with set codes / force), or locally:

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
