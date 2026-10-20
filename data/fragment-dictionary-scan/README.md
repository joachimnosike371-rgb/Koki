# Telegram / Fragment uncommon dictionary scan

This scan intentionally avoids the most popular English words. It excludes words in the top-20k English-frequency list, then prioritizes readable single words of 5–11 letters that are more plausible as usernames. It is a candidate strategy, not a guarantee of commercial value.

## Status meanings
- `available`: the API observed a clean negative on Telegram and no Fragment listing at check time.
- `fragment_collectible`: Fragment has a collectible record; inspect `fragment_status` and any displayed price.
- `taken`: a public Telegram username resolves or the API reports it claimed.
- `unknown`: the API could not safely establish the state. This is inconclusive, not proof that Fragment has no listing.

## Data
- `initial-unknown.csv` and `initial-available.csv`: provisional initial sample from common words. These are retained for audit only and are not the new scan strategy.
- `results/`: resumable output from the uncommon-word scan.
- `state.json`: checkpoint. A strategy version change resets the offset so no candidates are silently skipped.

Sources: [dwyl English word list](https://github.com/dwyl/english-words), [Google 10k/20k frequency list](https://github.com/first20hours/google-10000-english), and [TG Username API docs](https://tg-username-api.vercel.app/docs).

The API is limited to 25 requests/minute and 15 usernames per bulk request. The scanner throttles requests and resumes by checkpoint. Results are point-in-time; `unknown` must be rechecked and is not the same as available.
