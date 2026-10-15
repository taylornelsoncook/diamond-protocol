# The game week: what to do around a game, and why

The research brief behind the game-week helper (`services/gameweek.js`, schema 82): athletes keep their games, races
and competitions, and each day around one takes a colour on their training calendar (green, yellow or red) that cuts
the sets of whatever workout is planned, the way the owner used to colour a season spreadsheet by hand. Written
October 2026 for youth and high-school athletes in team sports. Most of the research is on soccer, where the weekly "match-day minus" pattern
(MD-3, MD-2, MD-1, MD+1...) is studied most; it transfers to other field and court sports in practice, with the usual
caution that a trained athlete recovers faster than an untrained one and an older athlete than a younger one.

The starting rules in the app are a reading of this brief. The owner can change any day's colour or words on
Programs → Game week.

## What the evidence says

**How long a game takes to recover from.** After a competitive soccer match, maximal force drops about 14% and is
still down about 4% at 48 hours, returning by 72 hours; jump and sprint ability usually come back within 24 to 48
hours; soreness peaks around 24 hours and a muscle-damage marker (creatine kinase) stays raised through 72 hours.
In elite youth players, sprint and jump matched pre-game values by 48 hours while the damage markers were still up at
72 hours. So an athlete can *feel* ready a day before their legs are actually back to full force. Two games 48 hours
apart leave the second one played on tired legs.

**What a hard session does over the next two days.** A resistance session that is new or unusually hard raises
soreness at 24 and 48 hours and costs a measurable amount of performance at 48 hours (agility down about 1.7% in
collegiate volleyball players; sprint about 4% slower and jump about 7% lower in untrained adolescent cricketers).
Soreness comes mostly from the lengthening (eccentric) part of lifting and from exercises the athlete isn't used to.
A session the athlete has done before costs much less (the "repeated bout effect").

**How professional clubs lay out the week.** Observed across elite teams: the two days after a match are the
lightest of the week (active recovery, aerobic and technical work, often a day fully off); the load rises from there
and peaks on MD-3, the most demanding day; MD-2 holds speed and tactical work at a lower volume; MD-1 is the one day
every club consistently unloads (a short, sharp session of about 45 minutes with reactivity and small-sided games).
When a team plays three times in a week, the day after one game is already two days before the next, and the
stricter day wins.

**Priming on game day.** Morning "priming" sessions before an afternoon game are mixed: light-load priming shows no
clear gain, heavier and ballistic morning work has improved afternoon jump and power in some studies (rugby, cricket,
field hockey, and 32 elite soccer matches), responses vary a lot between individuals, and the field evidence is thin.
It is a tool for a coach who has tried it with that athlete, not a default for a youth athlete.

**In season for youth.** The NSCA's long-term athletic development position statement asks for rest and recovery to
be prescribed as mandatory blocks of the plan, at least 48 hours of rest before a competition, and more than 7 hours
of sleep (coaches of teenagers commonly aim for 9 to 10). Coaching practice settles on one to two strength sessions a
week in season to keep strength rather than build it, keeping a few important lifts challenging while cutting the
number of sets, and placing the hardest lifting away from competition, never within 24 hours of a game.

## The rules the app starts with

The owner's rule: the workout stays exactly as the coach wrote it (the exercises, reps and weights), and only the
number of sets changes with the day's colour. Green is the workout as written, yellow is one set fewer on every
exercise, red is half the sets (rounded up, never below one). The cut is worked out when the workout is opened, so a
game whose date changes moves every colour and every set count at once; nothing is moved or stored.

| Day | Colour | Sets | The advice athletes read |
| --- | --- | --- | --- |
| Three days out | green | as written | The day for the hardest work of the week: heavy legs, jumps and sprints all fit; by game day the athlete has recovered and feels sharper for it. |
| Two days out | yellow | one fewer | Soreness from heavy or new work peaks a day or two later, right on game day: nothing new, nothing to failure. |
| Day before | red | half | Short and sharp, stop fresh. No long conditioning, no new exercises. Sleep 9 hours or more. |
| Game day | red | half | Only if the coach set up a short activation (fast and light, 6 or more hours before). A familiar meal 3 to 4 hours before, drink through the day, a full warm-up. |
| Day after | red | half | Jump and sprint ability are still down and soreness is near its peak: 20 to 30 minutes of easy movement, mobility, food, water, sleep. |
| Two days after | yellow | one fewer | The legs produce less force for 48 to 72 hours even when they feel fine. Nothing to failure. |
| Three days after | green | as written | Back to full training. |

A day that is both (two days after one game and the day before the next) takes the stricter colour and mentions the
other game. A tournament is one game day per day. A day more than three days from any game is green with no advice.
Races, meets and competitions follow the same days as games. Where the adaptive plan's minimum week is also in force
(half the sets), the deeper of the two cuts applies, never both.

Why cut sets and not the workout: the research above is about how much, not what. Fewer sets of the same lift keeps
the pattern the athlete is used to (the repeated bout effect) and the weight the coach chose, while taking most of the
volume, and so the soreness and fatigue, out of the days that matter. Coaches write one program; the colours do the
rest.

## Sources

- Etiology and recovery of neuromuscular fatigue following competitive soccer match-play (Frontiers in Physiology,
  2017; PMC5661001): force, voluntary activation, jump and soreness over 72 hours.
- Acute post-match fatigue and recovery kinetics of neuromuscular performance and muscle damage after a friendly
  match in elite youth football players (Journal of Functional Morphology and Kinesiology, 2026).
- Impact of post-match fatigue on peak force in elite youth soccer players: 48 to 72 hours post-match using the
  isometric mid-thigh pull (PMC12490303).
- Scheduling concurrent training 48 versus 72 h after simulated match play (PubMed 36635860); Exacerbated impairments
  in neuromuscular function when two bouts of team-sport match simulations are separated by 48 h (PMC10988426).
- Trends assessing neuromuscular fatigue in team sports: a narrative review (Sports, 2022).
- Resistance training acutely impairs agility and spike-specific performance in collegiate volleyball players
  (PMC7559839); Effect of exercise-induced muscle damage on bowling-specific motor skills in adolescent cricketers
  (PMC8309793).
- Microcycles in football: weekly structure from MD-5 to MD+1 (Barça Innovation Hub); Microcycle periodization in
  elite football: 11 evidence-informed principles (2024); In-season training periodization of professional soccer
  players; Influence of a modified versus a typical microcycle on weekly external loads and match-day readiness in
  elite academy soccer players (PMC11307180); Seasonal training-load quantification in elite English Premier League
  soccer players.
- Resistance priming to enhance neuromuscular performance in sport (Sports Medicine review, 2020); The effects of
  morning priming exercise on afternoon performance in female field hockey players (PMC13268173); To train or not to
  train (on match day)? (elite soccer, 2023).
- NSCA position statement on long-term athletic development (2016): rest and recovery as mandatory blocks, 48 hours
  before competition, sleep.
- Effects of variations in resistance training frequency on strength development in well-trained populations and
  implications for in-season athlete training: a systematic review and meta-analysis (PMC8363540).
