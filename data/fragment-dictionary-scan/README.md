# Telegram single-word dictionary scan

This dataset checks single-word English username candidates against the public TG Username API, which checks Telegram presence and queries Fragment when appropriate.

## Status meanings
- `available`: the API observed a clean negative on Telegram and no Fragment listing at check time.
- `fragment_collectible`: Fragment has a collectible record; inspect `fragment_status` and any displayed price.
- `taken`: a public Telegram username resolves or the API reports it claimed.
- `unknown`: the API could not safely establish the state. This is inconclusive, not proof that Fragment has no listing.

## Data
- `initial-unknown.csv` and `initial-available.csv`: a small initial live-check sample from the first 300 eligible words of the Google 10,000/20,000 English frequency list; the API returned inconsistent/partial responses across repeated requests, so these are explicitly provisional and should be rechecked.
- `results/`: resumable scan output from the full dictionary source, when the scheduled workflow runs.
- `state.json`: scan offset in the filtered dictionary word list.

Dictionary source: https://github.com/dwyl/english-words  
Checker: https://tg-username-api.vercel.app/docs

The API is limited to 25 requests/minute and 15 usernames per bulk request. The scanner throttles requests and resumes by offset. Availability is a point-in-time signal and may change.
