# Velocity-based training devices: how their data gets out, and how it gets into Diamond Protocol

Research brief behind the bar-speed connection (`services/vbt.js`, schema 81). Written October 2026 from the vendors'
own pages and the research below; vendors change plans and exports often, so check the current page before relying on
a tier name or a menu path. Where a page couldn't be reached the fact is marked *(unverified)*.

## What every system has in common

Every device measures the barbell (or the body) moving and reports, per rep or per set:

- **Mean velocity** (m/s): the average speed of the concentric (lifting) phase. The number most coaches program with.
  Vitruve reports the *mean propulsive* velocity (the braking part of the lift left out), which runs a little higher
  at light loads; at heavy loads the two are the same.
- **Peak velocity** (m/s): the fastest instant of the rep. Noisier; best for jumps, cleans and throws.
- **Mean and peak power** (W), sometimes **range of motion** (cm or m), **duration**, and a **velocity loss** or
  "fatigue" percentage (how much slower the last rep was than the fastest).

Exports come as a CSV (sometimes Excel), one row per rep or one per set, with an athlete name or an athlete ID the
system made up, a date and time, the exercise, the load (kg or lb) and the numbers above. That is what the import
reads: it matches the columns by their names, folds reps into sets, and refuses anything outside what a person can
lift or move.

## The systems

| System | What it is | Export | Live connection |
| --- | --- | --- | --- |
| **Output Sports** (Capture app, Output Hub) | IMU sensor on the bar or body | Output Hub exports a CSV over any date range, per athlete or group, by exercise and metric. The Capture app syncs to the Hub when online. | An **Open API** on the Pro Teams plan, with pre-built connections to TeamBuildr, Movella and Teamworks AMS (formerly Smartabase). No public documentation found; Output grants access. |
| **GymAware** (RS, PowerTool, GymAware Cloud) | Linear position transducer (the research gold standard) | CSV export on the Essentials+ Cloud tiers. | **Cloud API**: `GET https://cloud.gymaware.com/api/summaries` streams one JSON object per set with `athleteName`, `athleteReference`, `recorded` (UTC seconds), `activityName`, `meanVelocity` and `peakVelocity` (m/s), `meanPower` and `peakPower` (W), `velocityZone`. Included with the Premium or Pro Cloud licence; Cloud 2.0 added "activities" endpoints. Our push endpoint accepts these objects as they are. |
| **GymAware FLEX** | Laser bar tracker | CSV from the FLEX app or GymAware Cloud (Essentials and higher). | Same cloud as GymAware. |
| **Vitruve** (Encoder, Teams) | Linear position transducer | Vitruve Teams: Progress → athlete → exercise → Export → CSV or Excel (30 days, 180 days or everything by plan; mean and peak acceleration included). The athlete app exports one day of one exercise. | No public API. |
| **Enode Pro** (formerly Vmaxpro) | IMU sensor | CSV export on every plan, chosen by athlete, exercise, metric and date range. | API access from the Trainer plan up; documentation on request *(unverified)*. |
| **Perch** | 3D camera over the rack | CSV export of collected data. | A read-only **RPC-style JSON API** (optional add-on) with customer-generated tokens; documentation on GitHub (SBGSports/perch-api-docs, an OpenAPI file). Perch's agreement forbids passing its data to third parties, so a coach's own script forwards their own data. |
| **RepOne Strength** | Linear position transducer | Export from the RepOne app / StrengthOS *(unverified)*. Set metrics: first and last rep average velocity, peak velocity, fastest-ever at a load. | No public API. |
| **Metric VBT** | Phone camera app | Pro plan exports training data for spreadsheets. | No API. |
| **Qwik VBT**, **Spleeft**, **MyLift** | Phone camera apps | CSV/JSON exports (Qwik includes velocity loss). | None. |
| **Tendo**, **EliteForm** | LPT; camera and rack system | Not documented online; export from the system and use "Another device or spreadsheet". | Unknown. |

Discontinued but still in gyms: **PUSH Band** (bought by WHOOP, 2021), **Beast**, **OpenBarbell**, **Bar Sensei**. Their
old CSV exports import as "Another device or spreadsheet".

## How Diamond Protocol takes the data

Two doors, both landing on the athlete's profile (Testing → Bar speed, the app's and portal's Performance tab, the
Timeline):

1. **Push** (`POST /v1/vbt/sets` with a *results*-scope API key): a device vendor, an integrator, or a short script
   posts sets. Fields: `provider`, and per set `athlete` (`athlete_id` ours, `client_id`, or `external_id` + `name` as the
   device knows them), `exercise`, `performed_at`, `set_no`, `reps`, `load` with `load_unit` (lb or kg), `mean_velocity`,
   `peak_velocity`, `best_velocity`, `last_velocity`, `velocity_loss_pct`, `mean_power`, `peak_power`, `rom_cm`,
   `duration_s`, `reps_detail` (per-rep velocities, folded into the set), `external_id` (a resend changes nothing).
   GymAware's camelCase names and epoch times are read as they are.
2. **Import** (Testing → Devices & imports → Import a bar-speed export): the system's CSV or Excel file. Columns are
   matched by name (Athlete, Date, Exercise, Set, Rep, Load (kg), Mean Velocity (m/s)…), one row per rep is folded into
   sets, the load unit is read from the header, problems are listed by row and column, and nothing saves until the
   file is clean. Undo removes what an import brought in.

**Who the set belongs to** follows the results rule: our Athlete ID, our ids, or a device ID or name the coach linked
once. Anything else waits (never matched by name on its own); linking a waiting name or ID sends those sets to the
athlete and remembers the link, so the next export lands straight away. One link covers test results and bar speed.

## What the profile shows

- **Load-velocity profile**: the fastest rep at each load over the last 90 days, a straight line fitted through them
  (least squares; needs three loads spread at least 15% apart and a downward slope; r² says how straight).
- **Estimated max**: the load where the line reaches the **minimum velocity threshold** (MVT), the mean velocity of a
  true one-rep max. It is an estimate: the owner sets the thresholds on API & integrations → Bar speed devices.
- **Loads for a target speed** (1.00, 0.75 and 0.50 m/s), the fastest and heaviest set, the typical velocity loss, and
  the **speed at the athlete's usual load** over time (the trend that shows strength changing without testing).
- **Recent sessions** set by set; a loss over 20% is flagged (the set was pushed close to the limit).

### Threshold starting values

| Lift family | MVT (mean velocity at 1RM) | Basis |
| --- | --- | --- |
| Squat (and lunges) | 0.30 m/s | Adult back squat studies cluster near 0.30; untrained early-adolescent girls 0.28 to 0.29 (mean propulsive). |
| Bench press (and presses) | 0.17 m/s | Adult values 0.15 to 0.20; youth bench studies tested 0.10 to 0.20. |
| Deadlift (pulls, rows) | 0.15 m/s | Adult deadlift values 0.10 to 0.20; no youth value found. |
| Anything else | 0.30 m/s | A conservative default. |
| Cleans, snatches, jumps, throws | none | Ballistic lifts have no 1RM velocity; speed and power are the measure. |

Individual thresholds beat group ones for the squat (errors of 5 to 6 kg against 8 to 10 kg in trained women);
the bench press is forgiving either way. A two-point profile (two loads) is valid in research, but we ask for three so a
single bad rep can't set the max.

## Sources

- Output Sports: product features and API integrations pages (Open API; TeamBuildr, Movella, Teamworks); the Hub
  features post; "VBT unpacked: mean and peak velocity"; "Guide to load-velocity profiling".
- GymAware: Cloud API integration guide (summaries endpoint and fields); Zendesk "API Integration", "Export",
  "Parameters explained", "What's changing in the new GymAware Cloud" (Cloud 2.0 activities endpoints); FLEX metrics
  pages; the SimpliFaster FLEX review.
- Vitruve: support "Metrics calculated by Vitruve", "Export training history (Vitruve Teams)", "How to export the
  training history"; validity studies (PLOS ONE 2024; MPEES 2023).
- Enode: Enode Pro plans page (CSV on every plan, API from Trainer); "How is power calculated"; the TeamBuildr Enode
  integration guide; reliability study (Life, 2024).
- Perch: "Does Perch integrate with third-party software?"; API agreement; SBGSports/perch-api-docs on GitHub; the
  TeamBuildr Perch integration guide.
- RepOne: metrics and privacy pages. Metric VBT: App Store listing and VBTcoach review. Qwik VBT: store listings.
- Thresholds and profiles: "Prediction of one repetition maximum using reference minimum velocity threshold values in
  young and middle-aged resistance-trained males" (2021); "Group versus individualised minimum velocity thresholds in
  the prediction of maximal strength in trained female athletes" (2020); "Load–velocity relationship and 1RM estimation
  of the free-weight squat in untrained early-adolescent females" (Sports, 2026); "Can the velocity profile in the
  bench press and the bench pull sufficiently estimate the one repetition maximum in youth elite cross-country ski and
  biathlon athletes?" (2025); Weakley et al., "Velocity-based training: from theory to application" (Strength and
  Conditioning Journal, 2021).
- Device validity overview: "A systematic review using a multi-layered criteria framework for assessing the validity
  and reliability of velocity monitoring devices in resistance training" (2025).
