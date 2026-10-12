# Virginia Wage Floor

Tracks Virginia's state minimum wage and forecasts the CPI-indexed rate from 2029 through 2070.

**Live site:** https://pinkrose237.github.io/vaminimumwage/ · **Media kit:** https://pinkrose237.github.io/vaminimumwage/media.html

## How the 2029 rate is set

[Va. Code § 40.1-28.10](https://law.lis.virginia.gov/vacode/title40.1/chapter3/section40.1-28.10/), as amended in 2026 (HB 1 / SB 1, Chapters 350 and 351), sets these rates:

| Effective | Rate |
|---|---|
| Jan 1, 2026 | $12.77 |
| Jan 1, 2027 | $13.75 |
| Jan 1, 2028 | $15.00 |
| Jan 1, 2029 onward | adjusted every year by CPI-U |

By **October 1** each year, the Commissioner of Labor and Industry sets the next January's rate. It is the current rate plus the percentage increase in the U.S. city average CPI-U "during the most recent calendar year". The adjustment can never be less than zero. DOLI has applied this as the December-to-December change, so the rate effective January 1 of year *Y* uses the CPI change in year *Y − 2*.

## How it stays current

`.github/workflows/site.yml` rebuilds and redeploys the site on every push and on a schedule built around when the numbers can actually change:

| When (UTC) | Why |
|---|---|
| Daily, 10th–16th of each month | BLS CPI release window (8:30 a.m. ET) |
| January 1 | The new rate takes effect, so the "current" images roll over |
| Weekdays, January–April | General Assembly session, Governor's action and reconvened session |
| July 1–3 | New laws take effect and the Code of Virginia updates |
| Every Monday, May–December | DOLI announcements, statute changes, special sessions |
| Daily, Sept 20–Oct 2 | Run-up to DOLI's October 1 deadline |
| Daily, 12th–20th of Feb, May, Aug and Nov | Philadelphia Fed Survey of Professional Forecasters |

`scripts/update.mjs` checks each source:

| Source | Endpoint | Result |
|---|---|---|
| CPI-U (NSA and SA) | BLS public API, series `CUUR0000SA0` and `CUSR0000SA0` | Committed to `data/cpi.json` automatically |
| Inflation outlook | Philadelphia Fed SPF release page | Committed to `data/assumptions.json` when the table parses cleanly, otherwise opened as a PR |
| DOLI announcements | `doli.virginia.gov/wp-json/wp/v2/posts?search=minimum wage` | Committed when it matches the finished CPI calculation, otherwise opened as a PR |
| **Law (statute text)** | Code of Virginia API `law.lis.virginia.gov/api/CoVSectionsGetSectionDetailsJson/40.1-28.10/` | Always a **pull request** with the text diff and a proposed `data/law.json` |
| **Law (bills)** | LIS bill data `lis.blob.core.windows.net/lisfiles/{YYYY}{session}/BILLS.CSV` | A tracking issue per session for any bill mentioning "minimum wage" |

If a source fails three runs in a row, the workflow opens an issue.

### AI assist (optional)

When text needs reading rather than parsing (a statute rewrite, an unusual DOLI post, or an SPF table the parser can't read), the updater asks **Muse Spark 1.3 Contributor** (`opencode/muse-spark-1.3-contributor-free`) on OpenCode Zen. It runs through the official OpenCode CLI, so no key is needed for the free model.

- Model output is checked against the source. Every rate, date and percentage must appear in the original text.
- AI-derived changes only ever arrive as pull requests or issues, never as direct commits.
- The CLI runs in an empty temporary directory with no GitHub token in its environment. Its tools are set to "ask", which can't be approved in a headless run. The update stops if the repository changes during the call.

Settings (repository **Settings → Secrets and variables → Actions**):

| Name | Type | Purpose |
|---|---|---|
| `AI_ENABLED` | variable | Set to `false` to turn off AI |
| `AI_MODEL` | variable | Override the model, e.g. `opencode/muse-spark-1.3` (paid) |
| `OPENCODE_API_KEY` | secret | Needed only for paid Zen models |
| `BLS_API_KEY` | secret | Optional free [BLS key](https://data.bls.gov/registrationEngine/) for higher API limits |

## Local development

```bash
npm install
npx playwright install chromium
npm run build          # writes _site/ (HTML, data, media PNGs and ZIP)
npm run serve          # http://localhost:8080
node scripts/update.mjs --dry   # check sources without committing
```

Data lives in `data/`: `law.json` (statutory and announced rates), `cpi.json`, `assumptions.json`, and `watch.json` (monitor state). Templates are in `src/`, and the shared projection math is in `src/engine.js`.

Estimates are independent projections, not official DOLI figures.
