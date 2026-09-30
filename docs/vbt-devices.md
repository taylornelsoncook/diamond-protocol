# Velocity-based training devices: getting their data into an athlete's profile

The owner wants every VBT system on the market to feed an athlete's profile: sets with velocity, and maxes updated
from them. This note says what each system offers today, from their public pages (read on 2026-09-30), and how we'd
bring each one in. Our own rules stay: results land in a profile only by Athlete ID, our internal ids or a device id the
coach linked by hand, never by name; imports are all or nothing with every problem listed; the athlete is always chosen
by the person doing the import.

## The systems

| System | What it is | Gets data out how | What we'd build |
| --- | --- | --- | --- |
| **GymAware RS / FLEX** (Kinetic) | Tethered unit (RS) and a laser barbell tracker (FLEX); GymAware Cloud | A **Cloud API** (free with the Premium cloud license): `GET https://cloud.gymaware.com/api/summaries` streams one JSON object per set. Also multi-day **CSV export** from the Cloud (Standard and Premium). FLEX Stronger syncs to the Cloud on Premium and exports CSV on its own. | An automatic pull like WHOOP and Oura (API key in Render, a job every few hours, athletes matched by the device's athlete id linked once by the coach), plus a CSV import format. |
| **Vitruve** | Tethered unit; Vitruve Hub (teams) | **API access** (an API key made in the Hub's settings, owners only) and **export integrations** that push data to other platforms automatically; **CSV or Excel** export of an athlete's history (30 or 180 days or all, by plan). | A pull with the API key, and the CSV/Excel format. |
| **Output Sports** | Wearable sensor (IMU); Output Capture app | A **Sports Data API** (used by TeamBuildr, Teamworks/Smartabase, Kinduct, Rockdaisy); **spreadsheet export** by athlete or group, any time range, by exercise or metric. | A pull once we have API access from Output, and the spreadsheet format. |
| **Perch** (Catapult) | Camera on the rack; Perch web app | **Open API** for athlete-management systems (TeamBuildr has an integration guide) and **CSV export** at set and rep level with chosen columns (mean and peak velocity, mean and peak power, eccentric time, and more). | The CSV format first (columns are chosen, so we match them by name), then the API. |
| **Enode Pro** | Sensor on the bar; Enode portal | **CSV export** of everything or by athlete, exercise, metric and date range; **API documentation** for pulling data into your own system (they already connect TeamBuildr and RockDaisy). | The CSV format, then the API. |
| **RepOne** (Tether) | Tethered unit; RepOne Personal and RepOne Coach apps | Public pages describe the coach software and Bluetooth metrics (velocity, position, range of motion); no public export or API page found. | Ask RepOne. Until then, a spreadsheet mapped by hand. |
| **Metric VBT** | Phone camera app | **Spreadsheet export** (Metric Pro) with 13 rep-level metrics (mean and peak velocity, range of motion, tempo, power) and an estimated 1RM. No API. | The spreadsheet format. |
| **Tendo Unit / Tendo Power Analyzer** | Tethered unit | **Excel export** from the Power Analyzer software; the MyUnit app keeps profiles on the phone. | The Excel format. |
| **EliteForm** | Rack-mounted camera system | Emails coaches an **Excel** "EF Data Points" report (all reps and sets from the previous day). No public API. | The Excel format; the coach uploads the emailed file. |
| **Spleeft, Qwik VBT and other phone apps** | Camera apps | Exports vary; Spleeft has coach features. | The generic spreadsheet mapping (already built for outside data). |

## How it plugs into what we have

1. **Import formats.** `services/dataimport.js` already recognizes files by their columns (WHOOP, Oura, Garmin, Strava,
   TrainingPeaks) and has a hand mapping for any spreadsheet. Each VBT system becomes a `SOURCES` entry with where its
   export lives, and a format that reads athlete, date, exercise, set, rep, weight, reps and velocity (mean and peak),
   power and range of motion. Sets land as logged sets against the athlete's profile with the velocity kept beside
   them; the best set of a lift updates the estimated max the same day (the same Epley estimate the app uses), and a
   true 1RM attempt lands as a max on file. Everything is all or nothing with a preview, like every import.
2. **Automatic pulls.** For GymAware, Vitruve, Output, Perch and Enode, a job like `wearable-sync`: keys in Render,
   a pull every few hours, the device's athletes linked once to profiles by the coach (the same `athlete_links` the
   testing devices use), nothing ever matched by name.
3. **Where it shows.** The athlete app's Performance tab (maxes, strength by exercise) and the client page's Testing
   tab, with velocity beside each set in the workout history. Later: a load-velocity profile per lift.

## What we need from the owner before building

- **Which devices the business owns or plans to buy.** The first format should be one we can test against a real file.
- **A real export file from each** (a CSV or Excel from the coach app or portal, with the athlete names changed if you
  like). The public pages don't show the exact column names, and the container this is built in can't open the
  vendors' sites, so a sample file is the only reliable way to match columns right the first time.
- **API keys where a system has an API** (GymAware Premium cloud, Vitruve Hub, Output, Perch, Enode), set in Render
  like the WHOOP and Oura keys, never pasted in chat.

Build order once files are in hand: the device the business uses first, then GymAware and Vitruve (the two with public
APIs and the largest install base), then Perch, Enode and Output, then the phone apps and Excel-only systems.
