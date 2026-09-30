# Bringing the programming side closer to Relay Athletic

The owner asked for Relay Athletic (relayathletic.com) to be the sample for programming. This note says what Relay
does, what we already have, what is new, and the order to build it in. Each numbered step is one pull request.

## What Relay Athletic is

A strength-and-conditioning platform for coaches: build workouts (by voice or by hand), lay out a periodized program on
a visual canvas, assign it to an athlete, a group or the whole roster with a start date, and the athlete's phone shows
today's session with sets, reps, load, tempo and rest. Athletes log every set, rate the session, track readiness
(sleep, soreness), keep their own 1RMs, and see strength curves and PRs. Coaches see compliance and readiness trends
across the roster, reuse templates, export to PDF and Excel, message athletes, and sell programs from a branded page.
Pricing is per seat (coach or athlete), from about $10 a month for one seat to $300 a month for 1,000.

## Where we already match Relay

| Relay | Diamond Protocol |
| --- | --- |
| Voice AI builds a session | Programs → Dictate a workout (and Build from a PDF or photo) |
| Sets, reps, load %, tempo, rest, RPE | Structured set details on every exercise |
| Blocks, supersets, circuits | Groups A1/A2 with the flowing superset in the app |
| Visual mesocycle with phases | Whole plan view with phases and Progress weeks |
| 1,200 exercises with video | Our own library with the owner's videos and stills |
| Athlete logs sets, rates the session | The athlete app: sets, effort 1 to 10, notes, offline |
| Readiness: sleep, soreness | Daily check-ins plus WHOOP and Oura, lighter days by the coach's rules |
| Messages per athlete | Coach messages, form checks with video |
| Programs sold online | The store page and the parent portal |
| PRs | New bests after each workout, progression steps |
| Warm-ups and cool-downs | Routine blocks attached to workouts |

## What Relay has that we don't (the gaps)

1. **A dated training calendar.** Relay assigns with a start date; every session lands on a day; the athlete sees a
   calendar and today's session is right there; the coach adjusts one athlete's copy without touching the master.
   We showed the "next workout" in sequence with no dates. **Built in this pull request.**
2. **Athlete 1RM management.** Relay lets an athlete set and update their own 1RMs and, when there's no test,
   estimates the 1RM from logged sets so percentage targets scale on their own. We only use tested maxes from Testing.
3. **Strength curves and volume over time.** Per lift, per block, per season, for the athlete and the coach. We have
   the numbers (every set is stored, the monthly report already estimates 1RMs) but no screen.
4. **Compliance across the roster.** Who did their sessions this week, who is behind. We flag "quiet" athletes after
   seven days; the calendar now gives us "missed" per workout, which makes a roster view possible.
5. **Assign to a group or the whole roster in one go.** We assign one athlete at a time.
6. **Templates.** Save a program, a session or a run of exercises as a template and reuse it. We copy programs,
   weeks and workouts, but there's no template library.
7. **Bulk edits across sessions** ("every back squat in weeks 3 to 6, plus 5 percent") and dragging a session to another
   day in the builder.
8. **PDF and Excel export of a program**, with the phases and the business's name on it.
9. **Exercise tags** by movement, muscle and equipment (we have one category).
10. **Custom readiness questions.** Relay lets the coach change the daily questionnaire; ours is fixed.

Left out on purpose: Relay's per-seat pricing and marketplace commission model don't apply (this platform is the
business's own), and their MCP server is a developer feature.

## The plan, in build order

1. **Training calendar** (this pull request, schema 62). Assign with a start date and training days; every workout
   dated; done, today, missed, upcoming; the app opens on today's; the athlete opens any workout from a week strip;
   the coach sees the calendar on the client page, changes the schedule, and moves one workout for one athlete.
2. **Athlete maxes** (built, second pull request). An athlete, a parent or a coach enters and updates the max for the
   lifts a program uses; when nothing is tested or entered the weight comes from an estimated 1RM out of their logged
   sets (Epley, the same formula the monthly report uses), and a new estimate can be saved as the max in one tap after
   a workout. Owner decision: a typed max changes the weights at once, no coach approval. Percent-of-max weights now
   work for every athlete, not just those who came to a testing day. **Next for this step: VBT devices** (GymAware,
   Vitruve, Output, Perch, Enode, RepOne, FLEX, Metric, Tendo, EliteForm) feeding sets and maxes into the profile.
3. **Progress per lift** (built across the second and fifth pull requests): a weekly trend per lift and strength by
   exercise (step 2), then training volume: this week against last, twelve weeks of sets, the program's phases with
   what was done in each, and the most-logged exercises, on the Performance tab and the client page.
4. **Roster compliance** (built, third pull request). On Today and the Programs page: this week's planned versus done
   per athlete, who missed two in a row, with a team filter. Reads the calendar built in step 1.
5. **Assign to a team** (built, fourth pull request). Pick a team and a start date; each athlete gets their own
   assignment and calendar; athletes on another program are named and moved only on a second yes. Still to come:
   pushing one schedule change to everyone on a program.
6. **Templates** (built, sixth pull request). Save any program or workout as a template and start from it (New
   program → Start from; Add day → Start from). Still to come: a template for a run of exercises inside a workout.
7. **Bulk edits** (built, ninth pull request): change one exercise across a run of weeks in one go from the Whole
   plan view. Still to come: dragging a session to another day in the builder.
8. **Export a program** (built, seventh pull request): a printable page (the browser saves it as a PDF) with the
   plan grid, phases and every workout, and an Excel workbook with a plan sheet, a sheet per workout and the phases.
9. **Exercise tags** (built, eighth pull request): movement, muscles and equipment on every exercise, filters in the
   library and the builder's picker, and columns in the import list.
10. **Custom check-in questions**, chosen by the coach, feeding the same readiness rules.

Steps 2 to 4 are the biggest wins after the calendar, because they turn the data the app already collects into what
parents and athletes see. Each one is a day or two of work with tests.
