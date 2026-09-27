// The preloaded performance test library.
// Each test lists its metrics; the first metric is the headline number shown in reports.
// A metric is [key, name, unit, better ('lower' | 'higher' | 'none'), decimals, aliases for file imports].
// Units are the ones US coaches, combines and showcases report in. Imports in other units
// (cm, m, kg, km/h …) are converted automatically; see units.js.

const T = (key, name, category, metrics, opts = {}) => ({ key, name, category, metrics, sides: 'none', attempts: 2, sports: [], aliases: [], ...opts });

export const CATEGORIES = [
  ['speed', 'Speed'], ['agility', 'Agility & change of direction'], ['power', 'Jumps & power'],
  ['force_plate', 'Force plate'], ['strength', 'Strength'], ['conditioning', 'Conditioning'],
  ['sport', 'Sport-specific'], ['body', 'Body & growth'], ['movement', 'Movement & balance']
];

export const TESTS = [
  // ---------- Speed ----------
  T('dash_40yd', '40-yard dash', 'speed', [['time', '40 time', 's', 'lower', 2, ['40', '40 yard', '40yd', 'forty', 'total time', 'time']], ['split_10', '10-yard split', 's', 'lower', 2, ['10 split', '10yd split', 'split 1', '0-10']], ['split_20', '20-yard split', 's', 'lower', 2, ['20 split', '20yd split', 'split 2', '0-20']]],
    { timed: true, sports: ['football'], desc: 'NFL Combine standard. Start from a 3-point stance; electronic timing starts on first movement.' }),
  T('dash_10yd', '10-yard sprint', 'speed', [['time', 'Time', 's', 'lower', 2, ['10 yard', '10yd']]], { timed: true, desc: 'Acceleration. Same start every time.' }),
  T('dash_20yd', '20-yard sprint', 'speed', [['time', 'Time', 's', 'lower', 2, ['20 yard', '20yd']], ['split_10', '10-yard split', 's', 'lower', 2, ['split 1']]], { timed: true }),
  T('dash_30yd', '30-yard dash', 'speed', [['time', 'Time', 's', 'lower', 2, ['30 yard', '30yd']], ['split_10', '10-yard split', 's', 'lower', 2], ['split_20', '20-yard split', 's', 'lower', 2]],
    { timed: true, sports: ['baseball'], desc: 'MLB Draft Combine sprint (since 2021): side-on start, gates every 5 yards.' }),
  T('dash_60yd', '60-yard dash', 'speed', [['time', 'Time', 's', 'lower', 2, ['60 yard', '60yd', '60']], ['split_30', '30-yard split', 's', 'lower', 2]], { timed: true, sports: ['baseball'], desc: 'Baseball showcase standard (e.g. Perfect Game).' }),
  T('sprint_5m', '5 m sprint', 'speed', [['time', 'Time', 's', 'lower', 2, ['5m']]], { timed: true, desc: 'Youth batteries (tennis, soccer).' }),
  T('sprint_10m', '10 m sprint', 'speed', [['time', 'Time', 's', 'lower', 2, ['10m']]], { timed: true, sports: ['soccer'], desc: 'Most-used sprint distance in soccer testing.' }),
  T('sprint_20m', '20 m sprint', 'speed', [['time', 'Time', 's', 'lower', 2, ['20m']], ['split_10', '10 m split', 's', 'lower', 2]], { timed: true, sports: ['soccer', 'basketball'] }),
  T('sprint_30m', '30 m sprint', 'speed', [['time', 'Time', 's', 'lower', 2, ['30m']], ['split_10', '10 m split', 's', 'lower', 2]], { timed: true, sports: ['soccer'] }),
  T('sprint_40m', '40 m sprint', 'speed', [['time', 'Time', 's', 'lower', 2, ['40m']], ['split_10', '10 m split', 's', 'lower', 2], ['split_20', '20 m split', 's', 'lower', 2]], { timed: true }),
  T('flying_10yd', 'Flying 10 yards', 'speed', [['time', 'Time', 's', 'lower', 2, ['flying 10', 'fly 10']]], { timed: true, desc: 'Top speed: build up over 20 yards, time the next 10.' }),
  T('ovr_tru40', 'OVR Tru40', 'speed', [['time', 'Tru40', 's', 'lower', 2, ['tru40', 'tru 40']]], { timed: true, desc: 'OVR\'s standardized 40 converted from a flying 10, 10–20 or 10–40 split.' }),
  T('three_quarter_court', 'Three-quarter-court sprint', 'speed', [['time', 'Time', 's', 'lower', 2, ['3/4 court', 'three quarter sprint']]], { timed: true, sports: ['basketball'], desc: 'NBA Draft Combine: baseline to opposite free-throw line.' }),
  T('sprint_speed', 'Max sprint speed', 'speed', [['speed', 'Top speed', 'mph', 'higher', 1, ['max velocity', 'top speed', 'max speed']]], { desc: 'From timing gates, radar or GPS.' }),

  // ---------- Agility & change of direction ----------
  T('pro_agility', '5-10-5 pro agility (20-yard shuttle)', 'agility', [['time', 'Time', 's', 'lower', 2, ['5-10-5', '5 10 5', 'pro agility', '20 yard shuttle', 'short shuttle']]],
    { timed: true, sides: 'lr', sports: ['football', 'hockey', 'baseball'], desc: 'NFL, NHL and showcase standard. Side = the direction the athlete breaks first; test both.' }),
  T('three_cone', '3-cone drill (L-drill)', 'agility', [['time', 'Time', 's', 'lower', 2, ['3 cone', 'l drill', 'three cone']]], { timed: true, sports: ['football'], desc: 'Cones 5 yards apart in an L.' }),
  T('shuttle_60yd', '60-yard shuttle', 'agility', [['time', 'Time', 's', 'lower', 2, ['60 yard shuttle']]], { timed: true, sports: ['football'], desc: 'NFL Combine: 5, 10 and 15 yards and back.' }),
  T('lane_agility', 'Lane agility', 'agility', [['time', 'Time', 's', 'lower', 2, ['lane agility', 'pro lane']]], { timed: true, sports: ['basketball'], desc: 'NBA Draft Combine: sprint, shuffle, backpedal and shuffle around the lane.' }),
  T('nba_shuttle', 'Basketball shuttle run', 'agility', [['time', 'Time', 's', 'lower', 2, ['shuttle run', 'lane shuttle']]], { timed: true, sports: ['basketball'], desc: 'NBA Draft Combine shuttle across the lane.' }),
  T('five_oh_five', '5-0-5 agility', 'agility', [['time', 'Time', 's', 'lower', 2, ['505', '5-0-5']]], { timed: true, sides: 'lr', desc: 'Timed 5 m in and out of a 180° turn. Side = turning foot.' }),
  T('t_test', 'T-test', 'agility', [['time', 'Time', 's', 'lower', 2, ['t test', 'agility t']]], { timed: true }),
  T('illinois', 'Illinois agility test', 'agility', [['time', 'Time', 's', 'lower', 2, ['illinois']]], { timed: true, sports: ['soccer'] }),
  T('hexagon', 'Hexagon test', 'agility', [['time', 'Time', 's', 'lower', 2, ['hexagon', 'hex']]], { timed: true, sports: ['tennis', 'hockey'] }),
  T('reaction_box', 'Reaction agility ("man in the box")', 'agility', [['time', 'Time', 's', 'lower', 2, ['man in the box', 'reaction']]], { sports: ['baseball'], desc: 'MLB Draft Combine: touch 10 lit targets on 4 pads as fast as possible.' }),

  // ---------- Jumps & power (no force plate needed) ----------
  T('vertical_standing', 'Vertical jump (standing)', 'power', [['height', 'Jump height', 'in', 'higher', 1, ['vertical', 'vert', 'standing vertical', 'no step vertical', 'jump height']], ['reach', 'Max touch', 'in', 'higher', 1]],
    { sports: ['football', 'basketball'], desc: 'Vertec or jump mat. Jump height = touch minus standing reach.' }),
  T('vertical_max', 'Max vertical (approach)', 'power', [['height', 'Jump height', 'in', 'higher', 1, ['max vertical', 'approach vertical', 'running vertical']], ['reach', 'Max touch', 'in', 'higher', 1]], { sports: ['basketball', 'volleyball'], desc: 'NBA Draft Combine: running approach.' }),
  T('broad_jump', 'Broad jump', 'power', [['distance', 'Distance', 'in', 'higher', 0, ['broad', 'standing long jump', 'horizontal jump', 'long jump']]], { desc: 'Standing start, measured to the heel closest to the line. Shown as feet and inches.' }),
  T('single_leg_hop', 'Single-leg hop for distance', 'power', [['distance', 'Distance', 'in', 'higher', 0, ['single leg hop', 'sl hop']]], { sides: 'lr' }),
  T('hop_10_5', '10-5 repeated hop', 'power', [['rsi', 'RSI', 'ratio', 'higher', 2, ['rsi']], ['contact_time', 'Ground contact time', 'ms', 'lower', 0, ['gct', 'contact time']], ['height', 'Jump height', 'in', 'higher', 1]], { desc: 'Ten hops, best five averaged. OVR Jump and jump mats.' }),
  T('med_ball_chest', 'Medicine ball chest pass', 'power', [['distance', 'Distance', 'ft', 'higher', 1, ['chest pass', 'seated med ball', 'med ball chest']], ['ball_weight', 'Ball weight', 'lb', 'none', 0]], { desc: 'Seated, back against a wall. Record ball weight.' }),
  T('med_ball_rotational', 'Rotational medicine ball throw', 'power', [['distance', 'Distance', 'ft', 'higher', 1, ['rotational throw', 'scoop toss']], ['ball_weight', 'Ball weight', 'lb', 'none', 0]], { sides: 'lr', sports: ['baseball', 'softball', 'tennis', 'golf'] }),
  T('med_ball_overhead', 'Overhead backward medicine ball throw', 'power', [['distance', 'Distance', 'ft', 'higher', 1, ['overhead back throw', 'obmb']], ['ball_weight', 'Ball weight', 'lb', 'none', 0]]),
  T('wingate', 'Wingate 30-second bike', 'power', [['peak_power_rel', 'Peak power', 'W/kg', 'higher', 1, ['peak power output', 'peak power (w/kg)']], ['peak_power', 'Peak power', 'W', 'higher', 0], ['mean_power', 'Mean power', 'W', 'higher', 0], ['fatigue_index', 'Fatigue index', '%', 'lower', 1]],
    { attempts: 1, sports: ['hockey'], desc: 'NHL Scouting Combine: 30-second all-out sprint against a resistance set from body mass.' }),

  // ---------- Force plate ----------
  T('cmj', 'Countermovement jump (hands on hips)', 'force_plate', [
    ['jump_height', 'Jump height', 'in', 'higher', 1, ['jump height', 'jump height (imp-mom)', 'jump height(m)']],
    ['rsi_mod', 'RSI-modified', 'ratio', 'higher', 2, ['mrsi', 'rsi-modified', 'rsi modified', 'rsimod']],
    ['peak_power', 'Peak propulsive power', 'W', 'higher', 0, ['peak propulsive power', 'peak power']],
    ['peak_power_rel', 'Relative peak power', 'W/kg', 'higher', 1, ['peak relative propulsive power', 'peak power / bm', 'relative peak power']],
    ['peak_force', 'Peak propulsive force', 'N', 'higher', 0, ['peak propulsive force', 'concentric peak force']],
    ['braking_rfd', 'Braking RFD', 'N/s', 'higher', 0, ['braking rfd', 'eccentric deceleration rfd']],
    ['time_to_takeoff', 'Time to takeoff', 's', 'lower', 3, ['time to takeoff', 'contraction time']],
    ['asymmetry', 'Propulsive asymmetry (L−R)', '%', 'none', 1, ['propulsive impulse asymmetry', 'l|r peak propulsive force', 'asymmetry']]
  ], { attempts: 3, sports: ['all'], desc: 'The most-used force plate test. Hands on hips, self-selected depth. Tracks power and fatigue.' }),
  T('cmj_arms', 'Countermovement jump (arm swing)', 'force_plate', [['jump_height', 'Jump height', 'in', 'higher', 1, ['jump height']], ['peak_power', 'Peak propulsive power', 'W', 'higher', 0], ['peak_power_rel', 'Relative peak power', 'W/kg', 'higher', 1]], { attempts: 3, sports: ['baseball'], desc: 'MLB Draft Combine runs the CMJ with and without arm swing.' }),
  T('sl_cmj', 'Single-leg countermovement jump', 'force_plate', [['jump_height', 'Jump height', 'in', 'higher', 1, ['jump height']], ['peak_power_rel', 'Relative peak power', 'W/kg', 'higher', 1], ['peak_force', 'Peak propulsive force', 'N', 'higher', 0]], { attempts: 3, sides: 'lr', desc: 'Compare left and right for asymmetry.' }),
  T('squat_jump', 'Squat jump', 'force_plate', [['jump_height', 'Jump height', 'in', 'higher', 1, ['jump height']], ['peak_power', 'Peak power', 'W', 'higher', 0], ['peak_power_rel', 'Relative peak power', 'W/kg', 'higher', 1], ['peak_force', 'Peak force', 'N', 'higher', 0]], { attempts: 3, desc: 'Pause at the bottom, no countermovement: concentric-only power.' }),
  T('drop_jump', 'Drop jump', 'force_plate', [['rsi', 'RSI', 'ratio', 'higher', 2, ['rsi', 'reactive strength index']], ['jump_height', 'Jump height', 'in', 'higher', 1], ['contact_time', 'Ground contact time', 'ms', 'lower', 0, ['contact time', 'gct']], ['drop_height', 'Box height', 'in', 'none', 0]], { attempts: 3, desc: 'Step off a box (record height), rebound as fast and high as possible.' }),
  T('cmrj', 'Countermovement rebound jump', 'force_plate', [['rsi', 'Rebound RSI', 'ratio', 'higher', 2, ['rsi']], ['jump_height', 'CMJ height', 'in', 'higher', 1], ['contact_time', 'Rebound contact time', 'ms', 'lower', 0]], { attempts: 3, desc: 'A CMJ followed by one quick rebound. No box needed.' }),
  T('imtp', 'Isometric mid-thigh pull', 'force_plate', [
    ['peak_force', 'Peak force', 'N', 'higher', 0, ['peak force', 'peak vertical force']],
    ['peak_force_rel', 'Relative peak force', 'N/kg', 'higher', 1, ['peak force / bm', 'relative peak force']],
    ['net_peak_force', 'Net peak force', 'N', 'higher', 0, ['net peak force', 'net peak vertical force']],
    ['force_100ms', 'Force at 100 ms', 'N', 'higher', 0, ['force at 100ms', 'force at 100 ms']],
    ['rfd_0_200', 'RFD 0–200 ms', 'N/s', 'higher', 0, ['rfd 0-200', 'rfd - 200ms']],
    ['asymmetry', 'Peak force asymmetry (L−R)', '%', 'none', 1, ['asymmetry']]
  ], { attempts: 3, sports: ['all'], desc: 'The most common isometric strength test: safer and less fatiguing than a 1-rep max.' }),
  T('iso_squat', 'Isometric squat', 'force_plate', [['peak_force', 'Peak force', 'N', 'higher', 0, ['peak force']], ['peak_force_rel', 'Relative peak force', 'N/kg', 'higher', 1]], { attempts: 3 }),
  T('iso_belt_squat', 'Isokinetic squat', 'force_plate', [['peak_force', 'Peak force', 'N', 'higher', 0, ['peak force']], ['peak_power', 'Peak power', 'W', 'higher', 0]], { attempts: 1, sports: ['hockey'], desc: 'NHL Scouting Combine lower-body strength test.' }),

  // ---------- Strength ----------
  T('bench_225', '225 lb bench press reps', 'strength', [['reps', 'Reps', 'reps', 'higher', 0, ['bench press reps', '225 reps']]], { attempts: 1, sports: ['football'], desc: 'NFL Combine. Scale the load for youth and high school.' }),
  T('bench_reps_load', 'Bench press reps at a set load', 'strength', [['reps', 'Reps', 'reps', 'higher', 0], ['load', 'Load', 'lb', 'none', 0]], { attempts: 1, sports: ['hockey'], desc: 'NHL Combine uses a body-mass-based load. Record the load.' }),
  T('bench_1rm', 'Bench press 1RM', 'strength', [['load', '1RM', 'lb', 'higher', 0, ['bench 1rm', 'bench max']]], { attempts: 3 }),
  T('squat_1rm', 'Back squat 1RM', 'strength', [['load', '1RM', 'lb', 'higher', 0, ['squat 1rm', 'squat max']]], { attempts: 3 }),
  T('power_clean_1rm', 'Power clean 1RM', 'strength', [['load', '1RM', 'lb', 'higher', 0, ['clean 1rm', 'power clean']]], { attempts: 3 }),
  T('rep_max_3rm', '3-rep max', 'strength', [['load', 'Load', 'lb', 'higher', 0, ['3rm']]], { attempts: 3, desc: 'Youth-friendly strength test. Name the lift in the notes.' }),
  T('bench_velocity', 'Bench press bar velocity', 'strength', [['mean_velocity', 'Mean velocity', 'm/s', 'higher', 2, ['mean velocity', 'avg velocity', 'velocity']], ['peak_velocity', 'Peak velocity', 'm/s', 'higher', 2, ['peak velocity']], ['load', 'Load', 'lb', 'none', 0, ['load', 'weight']]], { attempts: 3, desc: 'Velocity-based training device (e.g. OVR Velocity). Record the load.' }),
  T('pull_ups', 'Pull-ups', 'strength', [['reps', 'Reps', 'reps', 'higher', 0, ['pull ups', 'pullups']]], { attempts: 1, sports: ['hockey'] }),
  T('grip', 'Grip strength', 'strength', [['force', 'Grip force', 'lb', 'higher', 0, ['grip', 'hand grip']]], { sides: 'lr', sports: ['hockey'], desc: 'Hand dynamometer, each hand.' }),
  T('plank', 'Plank hold', 'strength', [['time', 'Time', 's', 'higher', 0, ['plank']]], { attempts: 1, desc: 'Maximal hold (youth tennis battery).' }),

  // ---------- Conditioning ----------
  T('yoyo_ir1', 'Yo-Yo intermittent recovery level 1', 'conditioning', [['distance', 'Distance', 'm', 'higher', 0, ['yo-yo', 'yoyo ir1', 'distance']], ['level', 'Level reached', 'level', 'higher', 1, ['level', 'stage']]], { attempts: 1, sports: ['soccer', 'basketball'], desc: '2 × 20 m shuttles with 10 s active recovery; speed rises each level.' }),
  T('yoyo_ir2', 'Yo-Yo intermittent recovery level 2', 'conditioning', [['distance', 'Distance', 'm', 'higher', 0, ['yoyo ir2']], ['level', 'Level reached', 'level', 'higher', 1]], { attempts: 1, sports: ['soccer'], desc: 'Starts faster than level 1; for trained athletes.' }),
  T('yoyo_ie2', 'Yo-Yo intermittent endurance level 2', 'conditioning', [['distance', 'Distance', 'm', 'higher', 0]], { attempts: 1, sports: ['soccer'] }),
  T('ift_30_15', '30-15 Intermittent Fitness Test', 'conditioning', [['v_ift', 'Final velocity (VIFT)', 'km/h', 'higher', 1, ['vift', 'final velocity', '30-15']], ['vo2max_est', 'Estimated VO2 max', 'ml/kg/min', 'higher', 1]], { attempts: 1, sports: ['soccer', 'basketball', 'hockey'], desc: '30 s runs, 15 s recovery. Now the most common aerobic test in elite soccer. VIFT sets running speeds for conditioning.' }),
  T('beep_test', 'Beep test (20 m multistage)', 'conditioning', [['level', 'Level', 'level', 'higher', 1, ['beep', 'pacer', 'multistage', 'level']], ['shuttles', 'Total shuttles', 'shuttles', 'higher', 0, ['shuttles', 'laps']], ['vo2max_est', 'Estimated VO2 max', 'ml/kg/min', 'higher', 1]], { attempts: 1, desc: 'Record level as 9.5 for level 9, shuttle 5.' }),
  T('cooper', 'Cooper 12-minute run', 'conditioning', [['distance', 'Distance', 'm', 'higher', 0, ['cooper']]], { attempts: 1 }),
  T('rsa', 'Repeated sprint ability', 'conditioning', [['best', 'Best sprint', 's', 'lower', 2], ['mean', 'Mean sprint', 's', 'lower', 2], ['decrement', 'Decrement', '%', 'lower', 1, ['decrement', 'fatigue']]], { attempts: 1, sports: ['soccer'], desc: 'For example 6 × (15 + 15 m) every 20 s, or 7 × 30 m with 20 s rest. Note the protocol.' }),
  T('vo2max', 'VO2 max (lab)', 'conditioning', [['vo2max', 'VO2 max', 'ml/kg/min', 'higher', 1, ['vo2', 'vo2max']], ['duration', 'Test duration', 's', 'higher', 0]], { attempts: 1, sports: ['hockey'], desc: 'NHL Combine: ramp test on a bike to exhaustion with gas analysis.' }),

  // ---------- Sport-specific ----------
  T('pitch_velocity', 'Pitch velocity', 'sport', [['velocity', 'Velocity', 'mph', 'higher', 1, ['pitch velo', 'fb velo', 'fastball']], ['spin_rate', 'Spin rate', 'rpm', 'higher', 0, ['spin']]], { attempts: 5, sports: ['baseball', 'softball'] }),
  T('exit_velocity', 'Exit velocity', 'sport', [['velocity', 'Exit velocity', 'mph', 'higher', 1, ['exit velo', 'ev']], ['launch_angle', 'Launch angle', 'deg', 'none', 0]], { attempts: 5, sports: ['baseball', 'softball'] }),
  T('bat_speed', 'Bat speed', 'sport', [['speed', 'Bat speed', 'mph', 'higher', 1, ['bat speed']]], { attempts: 5, sports: ['baseball', 'softball'] }),
  T('infield_velocity', 'Infield throwing velocity', 'sport', [['velocity', 'Velocity', 'mph', 'higher', 1, ['if velo', 'infield velo']]], { attempts: 3, sports: ['baseball', 'softball'] }),
  T('outfield_velocity', 'Outfield throwing velocity', 'sport', [['velocity', 'Velocity', 'mph', 'higher', 1, ['of velo', 'outfield velo']]], { attempts: 3, sports: ['baseball', 'softball'] }),
  T('pop_time', 'Catcher pop time', 'sport', [['time', 'Pop time', 's', 'lower', 2, ['pop time']]], { attempts: 3, timed: true, sports: ['baseball', 'softball'] }),
  T('run_speed_fts', 'Sprint speed (Statcast)', 'sport', [['speed', 'Sprint speed', 'ft/s', 'higher', 1, ['sprint speed']]], { attempts: 1, sports: ['baseball'], desc: 'Feet per second in the fastest one-second window.' }),
  T('shot_speed', 'Shot or kick speed', 'sport', [['velocity', 'Speed', 'mph', 'higher', 1, ['shot speed', 'kick speed', 'shot velocity']]], { attempts: 3, sports: ['hockey', 'soccer', 'lacrosse'] }),
  T('serve_speed', 'Serve speed', 'sport', [['velocity', 'Speed', 'mph', 'higher', 1, ['serve speed']]], { attempts: 3, sports: ['tennis', 'volleyball'] }),

  // ---------- Body & growth ----------
  T('height', 'Height', 'body', [['height', 'Height', 'in', 'none', 1, ['height', 'stature', 'standing height']]], { attempts: 1, desc: 'Barefoot. Measure every testing day to track growth.' }),
  T('seated_height', 'Seated height', 'body', [['height', 'Seated height', 'in', 'none', 1, ['sitting height', 'seated height']]], { attempts: 1, desc: 'With standing height, weight and age, used to estimate when a youth athlete\'s growth spurt happens.' }),
  T('weight', 'Body weight', 'body', [['weight', 'Weight', 'lb', 'none', 1, ['weight', 'body mass', 'bodyweight', 'mass']]], { attempts: 1 }),
  T('wingspan', 'Wingspan', 'body', [['length', 'Wingspan', 'in', 'none', 1, ['wingspan', 'arm span']]], { attempts: 1, sports: ['basketball', 'hockey'] }),
  T('standing_reach', 'Standing reach', 'body', [['reach', 'Standing reach', 'in', 'none', 1, ['standing reach']]], { attempts: 1, sports: ['basketball', 'volleyball'] }),
  T('hand_size', 'Hand length and width', 'body', [['length', 'Hand length', 'in', 'none', 2], ['width', 'Hand width', 'in', 'none', 2]], { attempts: 1, sports: ['basketball', 'football'] }),
  T('body_fat', 'Body fat', 'body', [['percent', 'Body fat', '%', 'none', 1, ['body fat', 'bf%']]], { attempts: 1 }),

  // ---------- Movement & balance ----------
  T('y_balance', 'Y-balance test (lower body)', 'movement', [['anterior', 'Anterior reach', 'cm', 'higher', 1, ['anterior']], ['posteromedial', 'Posteromedial reach', 'cm', 'higher', 1, ['posteromedial']], ['posterolateral', 'Posterolateral reach', 'cm', 'higher', 1, ['posterolateral']], ['composite', 'Composite score', '%', 'higher', 1, ['composite']]],
    { attempts: 3, sides: 'lr', sports: ['hockey', 'soccer'], desc: 'Composite = sum of reaches ÷ (3 × leg length) × 100. Compare sides.' }),
  T('fms', 'Functional Movement Screen', 'movement', [['score', 'Total score', 'points', 'higher', 0, ['fms']]], { attempts: 1, sports: ['hockey', 'baseball'], desc: '7 movement patterns scored 0–3; total out of 21.' })
];

// Possible values for each metric (in its unit), wide enough for 8-year-olds and pros.
// Anything outside is rejected on upload, which catches numbers typed into the wrong column.
export const RANGES = {
  'dash_40yd.time': [3.8, 12], 'dash_40yd.split_10': [1.2, 3.5], 'dash_40yd.split_20': [2.2, 5.5],
  'dash_10yd.time': [1.2, 3.5], 'dash_20yd.time': [2.2, 5.5], 'dash_20yd.split_10': [1.2, 3.5],
  'dash_30yd.time': [3, 8], 'dash_30yd.split_10': [1.2, 3.5], 'dash_30yd.split_20': [2.2, 5.5],
  'dash_60yd.time': [5.3, 15], 'dash_60yd.split_30': [3, 8],
  'sprint_5m.time': [0.8, 2.5], 'sprint_10m.time': [1.4, 3.5], 'sprint_20m.time': [2.6, 6], 'sprint_20m.split_10': [1.4, 3.5],
  'sprint_30m.time': [3.5, 8], 'sprint_30m.split_10': [1.4, 3.5], 'sprint_40m.time': [4.4, 10], 'sprint_40m.split_10': [1.4, 3.5], 'sprint_40m.split_20': [2.6, 6],
  'flying_10yd.time': [0.8, 2.5], 'ovr_tru40.time': [3.8, 12], 'three_quarter_court.time': [2.6, 6], 'sprint_speed.speed': [8, 28],
  'pro_agility.time': [3.7, 9], 'three_cone.time': [6, 13], 'shuttle_60yd.time': [10, 22], 'lane_agility.time': [9.5, 18], 'nba_shuttle.time': [2.4, 6],
  'five_oh_five.time': [1.9, 4.5], 't_test.time': [8, 18], 'illinois.time': [13, 25], 'hexagon.time': [8, 25], 'reaction_box.time': [3, 30],
  'vertical_standing.height': [6, 50], 'vertical_standing.reach': [60, 150], 'vertical_max.height': [6, 52], 'vertical_max.reach': [60, 155],
  'broad_jump.distance': [30, 150], 'single_leg_hop.distance': [20, 110],
  'hop_10_5.rsi': [0.3, 5], 'hop_10_5.contact_time': [80, 600], 'hop_10_5.height': [2, 30],
  'med_ball_chest.distance': [5, 70], 'med_ball_chest.ball_weight': [1, 30], 'med_ball_rotational.distance': [5, 90], 'med_ball_rotational.ball_weight': [1, 30],
  'med_ball_overhead.distance': [5, 80], 'med_ball_overhead.ball_weight': [1, 30],
  'wingate.peak_power_rel': [4, 30], 'wingate.peak_power': [200, 2500], 'wingate.mean_power': [150, 1500], 'wingate.fatigue_index': [5, 90],
  'cmj.jump_height': [3, 35], 'cmj.rsi_mod': [0.1, 1.5], 'cmj.peak_power': [500, 9000], 'cmj.peak_power_rel': [15, 90], 'cmj.peak_force': [300, 6000],
  'cmj.braking_rfd': [500, 40000], 'cmj.time_to_takeoff': [0.3, 1.5], 'cmj.asymmetry': [-60, 60],
  'cmj_arms.jump_height': [4, 40], 'cmj_arms.peak_power': [500, 9000], 'cmj_arms.peak_power_rel': [15, 90],
  'sl_cmj.jump_height': [1.5, 22], 'sl_cmj.peak_power_rel': [10, 60], 'sl_cmj.peak_force': [200, 4000],
  'squat_jump.jump_height': [3, 33], 'squat_jump.peak_power': [400, 8000], 'squat_jump.peak_power_rel': [15, 85], 'squat_jump.peak_force': [300, 6000],
  'drop_jump.rsi': [0.3, 4], 'drop_jump.jump_height': [3, 35], 'drop_jump.contact_time': [100, 600], 'drop_jump.drop_height': [6, 30],
  'cmrj.rsi': [0.3, 4], 'cmrj.jump_height': [3, 35], 'cmrj.contact_time': [100, 600],
  'imtp.peak_force': [500, 7000], 'imtp.peak_force_rel': [10, 70], 'imtp.net_peak_force': [100, 5000], 'imtp.force_100ms': [100, 6000], 'imtp.rfd_0_200': [500, 50000], 'imtp.asymmetry': [-60, 60],
  'iso_squat.peak_force': [500, 8000], 'iso_squat.peak_force_rel': [10, 80], 'iso_belt_squat.peak_force': [500, 8000], 'iso_belt_squat.peak_power': [200, 6000],
  'bench_225.reps': [0, 60], 'bench_reps_load.reps': [0, 80], 'bench_reps_load.load': [20, 400],
  'bench_1rm.load': [20, 700], 'squat_1rm.load': [20, 1000], 'power_clean_1rm.load': [20, 500], 'rep_max_3rm.load': [10, 900],
  'bench_velocity.mean_velocity': [0.1, 2.5], 'bench_velocity.peak_velocity': [0.2, 3.5], 'bench_velocity.load': [20, 600],
  'pull_ups.reps': [0, 60], 'grip.force': [10, 250], 'plank.time': [5, 900],
  'yoyo_ir1.distance': [40, 4000], 'yoyo_ir1.level': [5, 23], 'yoyo_ir2.distance': [40, 2500], 'yoyo_ir2.level': [11, 23], 'yoyo_ie2.distance': [40, 5000],
  'ift_30_15.v_ift': [8, 26], 'ift_30_15.vo2max_est': [20, 80], 'beep_test.level': [1, 21], 'beep_test.shuttles': [1, 250], 'beep_test.vo2max_est': [15, 85],
  'cooper.distance': [800, 5000], 'rsa.best': [2, 8], 'rsa.mean': [2, 9], 'rsa.decrement': [0, 30], 'vo2max.vo2max': [20, 90], 'vo2max.duration': [60, 1800],
  'pitch_velocity.velocity': [30, 106], 'pitch_velocity.spin_rate': [800, 3500], 'exit_velocity.velocity': [20, 125], 'exit_velocity.launch_angle': [-90, 90],
  'bat_speed.speed': [20, 100], 'infield_velocity.velocity': [30, 100], 'outfield_velocity.velocity': [30, 105], 'pop_time.time': [1.6, 3.5],
  'run_speed_fts.speed': [15, 31], 'shot_speed.velocity': [10, 110], 'serve_speed.velocity': [20, 160],
  'height.height': [36, 90], 'seated_height.height': [18, 50], 'weight.weight': [40, 450], 'wingspan.length': [36, 100], 'standing_reach.reach': [50, 130],
  'hand_size.length': [4, 13], 'hand_size.width': [4, 13], 'body_fat.percent': [2, 60],
  'y_balance.anterior': [10, 150], 'y_balance.posteromedial': [10, 150], 'y_balance.posterolateral': [10, 150], 'y_balance.composite': [40, 150], 'fms.score': [0, 21]
};

// How to run each built-in test ("How to run it"), so every coach runs it the same way and retests compare.
// A coach can write their own version in the library; theirs replaces this text for the business.
export const PROTOCOLS = {
  dash_40yd: 'Three-point stance with the front hand on the line. Electronic timing starts on first movement; hand timing starts on the first move of the back hand. Run through the finish. Two attempts, at least three minutes apart; record the faster.',
  dash_10yd: 'Same start every time (two-point or three-point; note which). Timing starts on first movement. Two attempts with full rest; record the faster.',
  dash_20yd: 'Two-point start behind the line. Gates at 10 and 20 yards if you have them for the split. Two attempts with full rest.',
  dash_30yd: 'Side-on start like the MLB Draft Combine, or two-point: keep it the same for retests. Gates every 10 yards give the splits. Two attempts with full rest.',
  dash_60yd: 'Two-point start, run through the line. Gate at 30 yards for the split. Two attempts at least four minutes apart.',
  sprint_5m: 'Start 0.5 m behind the first gate in a two-point stance. Two attempts with full rest; record the faster.',
  sprint_10m: 'Start 0.5 m behind the first gate in a two-point stance. Two attempts with at least two minutes of rest.',
  sprint_20m: 'Start 0.5 m behind the first gate. Gate at 10 m for the split. Two attempts with at least two minutes of rest.',
  sprint_30m: 'Start 0.5 m behind the first gate. Gate at 10 m for the split. Two attempts with at least three minutes of rest.',
  sprint_40m: 'Start 0.5 m behind the first gate. Gates at 10 and 20 m for the splits. Two attempts with at least three minutes of rest.',
  flying_10yd: 'Build up over 20 yards, then time the next 10 yards between two gates. The athlete should be at full speed at the first gate. Two attempts with full rest.',
  ovr_tru40: 'Set the OVR gates for the flying 10, 10–20 or 10–40 split as the OVR app shows. The app converts the split to a standardized 40.',
  three_quarter_court: 'Start on the baseline, sprint to the far free-throw line (75 feet). Two attempts; record the faster.',
  sprint_speed: 'Measure top speed with timing gates, radar or GPS over a sprint of at least 30 yards. Record the best reading.',
  pro_agility: 'Straddle the middle line in a three-point stance. Sprint 5 yards and touch the line with the hand, 10 yards back and touch, then 5 yards through the middle. Test breaking left and right; record the faster of each.',
  three_cone: 'Three cones 5 yards apart in an L. Start at cone 1, run to cone 2 and back, around cone 2 to weave cone 3, back around cone 2 and finish at cone 1. Touch the line at each turn.',
  shuttle_60yd: 'Run 5 yards and back, 10 yards and back, then 15 yards and back, touching each line with the hand. Record total time.',
  lane_agility: 'Around the key: sprint forward from the baseline corner, shuffle across the free-throw line, backpedal to the baseline, shuffle back to the start; then reverse. Feet must go outside each cone.',
  nba_shuttle: 'Start under the basket and shuffle to the lane line and back as the NBA Combine does. Keep the distance and number of turns the same for retests.',
  five_oh_five: 'Build up over 10 m, then time the 5 m in and 5 m out around a 180-degree turn on the line. Test turning off each foot; record the faster for each side.',
  t_test: 'Sprint forward 10 yards and touch the cone, shuffle 5 yards left and touch, 10 yards right and touch, 5 yards left back to the middle, then backpedal to the start. No crossing the feet.',
  illinois: '10 m by 5 m course with four cones down the middle 3.3 m apart. Start lying face down at the start line; on the signal, get up, sprint, weave the cones up and back and sprint to the finish.',
  hexagon: 'Stand in the middle of a hexagon with 60 cm sides. Facing forward the whole time, jump out over each side and back in, going clockwise, for three full laps. Record total time.',
  reaction_box: 'Stand in the middle of the four pads. Touch each lit target as fast as possible until 10 targets are done. Two attempts; record the faster.',
  vertical_standing: 'Take standing reach first (flat-footed, one arm straight up). Then, feet still, dip and jump to touch as high as possible. No step. Jump height = touch minus reach. Best of three.',
  vertical_max: 'Take standing reach first. Free approach of up to three steps, jump off one or both feet and touch as high as possible. Jump height = touch minus reach. Best of three.',
  broad_jump: 'Toes behind the line, swing the arms and jump forward, landing on both feet. Measure from the line to the back of the nearest heel. A fall backward is a redo. Best of two.',
  single_leg_hop: 'Stand on one leg with the toe behind the line, hop forward as far as possible and stick the landing on the same leg for two seconds. Measure to the heel. Test both legs.',
  hop_10_5: 'Ten quick hops in place on the jump mat or force plate, hands on hips, as high and fast as possible. The best five are averaged for RSI and contact time.',
  med_ball_chest: 'Sit with the back flat against a wall and legs straight. Two-hand chest pass as far as possible; measure to where the ball first lands. Note the ball weight and keep it the same for retests. Best of two.',
  med_ball_rotational: 'Stand side-on to the throwing area. Scoop the ball from the back hip and throw it as far as possible. Test both sides and keep the ball weight the same for retests.',
  med_ball_overhead: 'Stand with the back to the throwing area, swing the ball down between the legs and throw it back over the head as far as possible. Measure to the first bounce.',
  wingate: 'Warm up on the bike. Set the resistance from body mass (usually 7.5% for athletes), then pedal all out for 30 seconds from a rolling start. The bike records peak power, mean power and the drop-off.',
  cmj: 'Stand still on the plate with hands on hips for the weigh-in. Dip to a comfortable depth and jump as high as possible, landing on the plate. Keep hands on hips the whole time. Three jumps with 30 seconds between.',
  cmj_arms: 'Same as the countermovement jump, but swing the arms freely. Three jumps with 30 seconds between.',
  sl_cmj: 'Stand on one leg on the plate, hands on hips. Dip and jump as high as possible, landing on the same leg. Three jumps per leg; compare the two sides.',
  squat_jump: 'Hands on hips. Squat to about 90 degrees and hold still for three seconds, then jump as high as possible with no dip. Any dip is a redo. Three jumps.',
  drop_jump: 'Step (don\'t jump) off a box of known height onto the plate, then jump as fast and high as possible. Record the box height. Three jumps.',
  cmrj: 'A countermovement jump with hands on hips, then one quick rebound jump as soon as the feet touch down. Three attempts.',
  imtp: 'Set the bar at mid-thigh with knees and hips slightly bent and the torso upright. Take the slack out, then pull as hard and fast as possible for three to five seconds. Two or three pulls with two minutes between.',
  iso_squat: 'Set the bar on the shoulders at a quarter to half squat depth. Take the slack out, then push up as hard and fast as possible for three to five seconds.',
  iso_belt_squat: 'Set up on the isokinetic machine as the maker describes. Record peak force and power from the machine\'s report.',
  bench_225: 'Warm up. Lower 225 lb (or a lighter set load for youth) to touch the chest and press to full lockout for as many reps as possible. No bouncing. A spotter on every rep.',
  bench_reps_load: 'Choose the load (for example a share of body weight) and record it. Reps to failure with the bar touching the chest and a full lockout each rep. A spotter on every rep.',
  bench_1rm: 'Warm up in sets of 5, 3, 2 and 1, then no more than five attempts to a max. Touch the chest, no bounce, hips on the bench. A spotter on every attempt. Only with trained lifters.',
  squat_1rm: 'Warm up in sets of 5, 3, 2 and 1, then no more than five attempts to a max. Thighs to parallel or below. Safety bars or spotters on every attempt. Only with trained lifters.',
  power_clean_1rm: 'Warm up with the empty bar and build in small jumps. Catch above parallel with the bar racked on the shoulders. Stop when technique breaks. Only with trained lifters.',
  rep_max_3rm: 'Warm up, then build to the heaviest load the athlete can lift for three clean reps. Name the lift in the notes and use the same lift for retests.',
  bench_velocity: 'Attach the velocity device as the maker describes. Lift the set load as fast as possible with full range. Record the load. Best of three reps.',
  pull_ups: 'Start from a dead hang with palms facing away. Pull until the chin is over the bar and lower to full extension each rep. No kipping or swinging.',
  grip: 'Stand with the arm by the side and the elbow bent to 90 degrees. Squeeze the dynamometer as hard as possible for three seconds. Two squeezes per hand; record the best of each.',
  plank: 'Forearms and toes on the floor, body in one straight line from head to heels. Stop the clock when the hips sag or pike after one warning.',
  yoyo_ir1: 'Run 2 × 20 m shuttles to the audio beeps with 10 seconds of active recovery between each. Speed rises each level. The test ends after the second missed beep; record total distance.',
  yoyo_ir2: 'Like level 1 but starting faster; for trained athletes. Record total distance at the second missed beep.',
  yoyo_ie2: 'Run 2 × 20 m shuttles to the beeps with 5 seconds of recovery between each. Record total distance at the second missed beep.',
  ift_30_15: 'Run 30-second shuttles over 40 m to the audio, with 15 seconds of walking between; speed rises each stage. Record the speed of the last stage completed (VIFT).',
  beep_test: 'Run 20 m shuttles to the audio beeps; speed rises each level. The test ends when the athlete misses the line twice in a row. Record level and shuttle, like 9.5 for level 9, shuttle 5.',
  cooper: 'Run as far as possible in 12 minutes on a track or measured course. Record total distance in meters.',
  rsa: 'Run the set number of sprints with a fixed rest (for example 6 × 30 m every 20 seconds). Record the best and average sprint and the drop-off. Note the protocol used.',
  vo2max: 'Lab test on a bike or treadmill with gas analysis, with speed or resistance rising until exhaustion. Record VO2 max from the lab report.',
  pitch_velocity: 'After a full warm-up, throw fastballs at full effort from the mound. Radar from behind the catcher. Record the best of five pitches.',
  exit_velocity: 'Hit off a tee or front toss, measured with Rapsodo, HitTrax or a radar. Five swings; record the best.',
  bat_speed: 'Attach the sensor to the knob. Five full-effort swings off a tee or front toss; record the best.',
  infield_velocity: 'Field a ground ball at shortstop and throw across the diamond to first. Crow hop allowed. Radar from behind the target. Best of three.',
  outfield_velocity: 'Crow hop and throw from the outfield to the cut-off or home plate. Radar from behind the target. Best of three.',
  pop_time: 'From the moment the ball hits the catcher\'s mitt until it reaches the fielder\'s glove at second base. Best of three throws.',
  run_speed_fts: 'Taken from Statcast or a similar tracking system: feet per second in the fastest one-second window of a run.',
  shot_speed: 'After a warm-up, shoot or kick at full effort with the radar behind the target. Best of three.',
  serve_speed: 'Full-effort first serves with the radar behind the server or at the net post. Best of three.',
  height: 'Shoes off, heels together against the wall, looking straight ahead. Lower the headboard onto the top of the head and read to the nearest quarter inch. Measure every testing day to track growth.',
  seated_height: 'Sit on a box of known height against the wall with the back straight and hands on the thighs. Measure to the top of the head and subtract the box height. Needed for the growth-spurt estimate.',
  weight: 'Shoes off, light clothing, and at the same time of day when you can. Read to the nearest half pound.',
  wingspan: 'Stand with the back against a wall and arms straight out at shoulder height. Measure fingertip to fingertip.',
  standing_reach: 'Stand flat-footed next to the wall or Vertec and reach straight up with one arm. Measure the highest point of the fingertips.',
  hand_size: 'Hand flat, fingers together. Length from the wrist crease to the tip of the middle finger; width across the knuckles.',
  body_fat: 'Use the same method (calipers, scale or scan) every time and note which. Measure at the same time of day when you can.',
  y_balance: 'Stand on one leg on the center plate and push the reach block as far as possible in each direction (anterior, posteromedial, posterolateral) without touching down. Three reaches per direction per leg; record the composite too.',
  fms: 'Score the seven movement patterns (deep squat, hurdle step, inline lunge, shoulder mobility, active leg raise, push-up, rotary stability) from 0 to 3 each. Record the total out of 21.'
};

// Starting presets for a testing day. Added once to a new business; after that the owner's edits stand.
export const DEFAULT_PRESETS = [
  ['Combine', ['height', 'weight', 'dash_40yd', 'pro_agility', 'three_cone', 'vertical_standing', 'broad_jump']],
  ['Force plate', ['cmj', 'squat_jump', 'drop_jump', 'imtp']],
  ['Baseball showcase', ['height', 'weight', 'dash_60yd', 'dash_30yd', 'pitch_velocity', 'exit_velocity', 'infield_velocity', 'outfield_velocity', 'pop_time']],
  ['Basketball', ['height', 'wingspan', 'standing_reach', 'vertical_standing', 'vertical_max', 'lane_agility', 'nba_shuttle', 'three_quarter_court']],
  ['Hockey', ['grip', 'broad_jump', 'cmj', 'pro_agility', 'bench_reps_load', 'pull_ups', 'y_balance', 'wingate']],
  ['Soccer', ['sprint_10m', 'sprint_30m', 'cmj', 'five_oh_five', 'ift_30_15', 'yoyo_ir1']],
  ['Youth', ['height', 'seated_height', 'weight', 'sprint_5m', 'sprint_10m', 'vertical_standing', 'broad_jump', 'five_oh_five', 'plank', 'beep_test']]
];
