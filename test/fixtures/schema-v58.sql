-- Diamond Protocol schema. Money is stored in cents, times as ISO-8601 UTC strings, ids as prefixed strings.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','coach','front_desk')),
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  id TEXT,                               -- version 42: names a device in "signed in on" lists (the token hash never leaves the server)
  kind TEXT,                             -- version 42: web or app (the iPhone app)
  created_at TEXT,                       -- version 42: when they signed in on this device
  last_seen_at TEXT,                     -- version 42: last request (written at most every 5 minutes)
  ip TEXT,                               -- version 42: address at sign-in
  user_agent TEXT                        -- version 42: browser or app at sign-in
);
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  interval TEXT NOT NULL DEFAULT 'month' CHECK (interval IN ('month')),
  trial_days INTEGER NOT NULL DEFAULT 7 CHECK (trial_days >= 0),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS families (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  stripe_customer_id TEXT,
  card_payment_method TEXT,
  card_brand TEXT,
  card_last4 TEXT,
  card_status TEXT NOT NULL DEFAULT 'ok' CHECK (card_status IN ('ok','declining')),
  waiver_version INTEGER,
  waiver_signed_by TEXT,
  waiver_signed_at TEXT,
  created_at TEXT NOT NULL,
  card_exp TEXT                          -- version 41: the saved card's expiry as YYYY-MM (for "expires soon" reminders)
);
CREATE TABLE IF NOT EXISTS guardians (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone TEXT,
  relationship TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  sms_opt_in_at TEXT,                    -- the parent turned texts on in the portal (phone is then stored as +15125550100)
  sms_opt_out_at TEXT,                   -- the parent replied STOP; no texts until they reply START or turn texts on again
  created_at TEXT NOT NULL,
  calendar_token_hash TEXT,              -- version 41: hash of the secret in the parent's private calendar feed link (/cal/<secret>.ics)
  calendar_created_at TEXT
);
CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  athlete_id TEXT,                       -- AVALOP2026: first 3 + last 3 letters + year joined
  email TEXT UNIQUE COLLATE NOCASE,
  family_id TEXT REFERENCES families(id) ON DELETE SET NULL,
  birth_date TEXT,
  sex TEXT CHECK (sex IN ('M','F')),       -- optional; only used for growth-spurt estimates
  sport TEXT,
  position TEXT,
  school TEXT,
  grad_year INTEGER,
  medical_notes TEXT,
  emergency_name TEXT,
  emergency_phone TEXT,
  phone TEXT,
  notes TEXT,
  access_token TEXT NOT NULL UNIQUE,
  card_status TEXT NOT NULL DEFAULT 'ok' CHECK (card_status IN ('ok','declining')),
  stripe_customer_id TEXT,
  card_payment_method TEXT,
  card_brand TEXT,
  card_last4 TEXT,
  archived_at TEXT,                      -- no longer training: hidden from lists, pickers and automatic messages (version 31)
  archived_by TEXT,                      -- who archived them (staff name)
  created_at TEXT NOT NULL,
  card_exp TEXT,                         -- version 41: the saved card's expiry as YYYY-MM
  training_type TEXT CHECK (training_type IN ('hybrid','in_facility','remote'))   -- version 46: how they train, picked by staff (shown under the name)
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  status TEXT NOT NULL CHECK (status IN ('trialing','active','past_due','paused','canceled')),
  trial_ends_at TEXT,
  current_period_start TEXT NOT NULL,
  current_period_end TEXT NOT NULL,
  canceled_at TEXT,
  trial_reminded_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  pending_plan_id TEXT REFERENCES plans(id),   -- version 46: the plan it moves to at the next renewal ("wait till the end of the membership")
  pending_set_at TEXT
);
CREATE INDEX IF NOT EXISTS subscriptions_client ON subscriptions(client_id);
CREATE INDEX IF NOT EXISTS subscriptions_due ON subscriptions(status, current_period_end);
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  fee_cents INTEGER NOT NULL DEFAULT 0,             -- version 51: a card processing fee passed to the payer, inside amount_cents
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','paid','failed','void')),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_retry_at TEXT,
  payment_ref TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL,
  -- version 38 (batch B6, billing): what has been refunded (each refund in invoice_refunds), the last card reminder,
  -- a void with its reason, and how a payment recorded by hand arrived (NULL = charged or paid online by card).
  refunded_cents INTEGER NOT NULL DEFAULT 0,
  reminded_at TEXT,
  voided_at TEXT,
  void_reason TEXT,
  paid_method TEXT,
  paid_reference TEXT,
  -- version 43: automatic charges tried (the first charge and the scheduled retries). Only these count toward canceling
  -- after MAX_ATTEMPTS; a retry the owner or a parent starts
  -- adds to attempts but not here.
  auto_attempts INTEGER NOT NULL DEFAULT 0,
  note TEXT                               -- version 46: what a one-off charge was for (the price difference of a plan change)
);
CREATE INDEX IF NOT EXISTS invoices_client ON invoices(client_id);
-- Version 38: each refund of a membership payment, dated when the money went back. source 'stripe' is a refund made in
-- the Stripe dashboard (the webhook brings the invoice up to Stripe's total).
CREATE TABLE IF NOT EXISTS invoice_refunds (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  reason TEXT,
  source TEXT NOT NULL DEFAULT 'app' CHECK (source IN ('app','stripe')),
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS invoice_refunds_invoice ON invoice_refunds(invoice_id);
CREATE INDEX IF NOT EXISTS invoice_refunds_created ON invoice_refunds(created_at);
CREATE INDEX IF NOT EXISTS invoices_retry ON invoices(status, next_retry_at);
CREATE TABLE IF NOT EXISTS exercises (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  video_url TEXT,
  instructions TEXT,
  created_at TEXT NOT NULL,
  category TEXT,                                 -- version 40: Speed, Power, Lower body... (programs.js CATEGORIES)
  poster_url TEXT                                -- version 48: the still shown before the video plays (the video library upload)
);
CREATE TABLE IF NOT EXISTS programs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  level TEXT,
  weeks INTEGER NOT NULL DEFAULT 4 CHECK (weeks BETWEEN 1 AND 52),
  created_at TEXT NOT NULL,
  for_sale INTEGER NOT NULL DEFAULT 0,   -- sold online in the parent portal and at /shop (version 26)
  price_cents INTEGER
);
CREATE TABLE IF NOT EXISTS workouts (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  week INTEGER NOT NULL,
  day INTEGER NOT NULL,
  title TEXT NOT NULL,
  warmup_id TEXT REFERENCES routines(id) ON DELETE SET NULL,     -- version 58: the warm-up block attached to this workout
  cooldown_id TEXT REFERENCES routines(id) ON DELETE SET NULL,   -- version 58: the cool-down block
  UNIQUE (program_id, week, day)
);
CREATE TABLE IF NOT EXISTS workout_exercises (
  id TEXT PRIMARY KEY,
  workout_id TEXT NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  exercise_id TEXT NOT NULL REFERENCES exercises(id),
  position INTEGER NOT NULL,
  prescription TEXT NOT NULL,
  load_test TEXT,                                -- version 21: weight as a percent of this tested max (squat_1rm...)
  load_pct INTEGER,
  sets INTEGER,                                  -- version 49: structured set details; prescription is the short text built from them
  reps TEXT,                                     -- "8", "8-10", "5/side", "40 sec", "max"
  tempo TEXT,
  rest_seconds INTEGER,
  target_rpe REAL,
  load_text TEXT,                                -- a load the coach types ("135 lb", "BW"), beside the percent of a tested max
  group_label TEXT,                              -- A, B, C: exercises sharing a label in one workout are one group
  group_kind TEXT CHECK (group_kind IN ('superset','circuit','block')),
  note TEXT                                      -- a cue for this slot
);
CREATE INDEX IF NOT EXISTS workout_exercises_exercise ON workout_exercises(exercise_id);   -- the library's use counts (a big video library)
CREATE TABLE IF NOT EXISTS program_phases (           -- version 50: the planner's phases (base, build, peak, deload...) as bands across weeks
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('base','build','peak','deload','test','other')),
  start_week INTEGER NOT NULL,
  end_week INTEGER NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS program_phases_program ON program_phases(program_id, start_week);
CREATE TABLE IF NOT EXISTS assignments (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS assignments_client ON assignments(client_id, active);
CREATE TABLE IF NOT EXISTS workout_logs (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  -- Version 43: deleting a program or workout keeps the athlete's log (the assignment and workout become empty, and the
  -- snapshot below says what it was).
  assignment_id TEXT REFERENCES assignments(id) ON DELETE SET NULL,   -- empty when logged on the weight-room screen by an athlete not on that program
  workout_id TEXT REFERENCES workouts(id) ON DELETE SET NULL,
  notes TEXT,
  completed_at TEXT NOT NULL,
  session_id TEXT REFERENCES class_sessions(id) ON DELETE SET NULL,   -- logged on the weight-room screen during this session (version 23)
  rpe INTEGER,                                   -- version 40: how hard it felt, 1 to 10
  started_at TEXT,                               -- version 40: first set logged in the app (for time taken)
  request_id TEXT,                               -- version 40: the phone's id for this Finish, so a resend saves nothing twice
  edited_at TEXT,                                -- version 40: reopened and saved again by the athlete
  -- version 43: what the workout was, written when its program or workout is deleted, so the history still reads right
  program_id TEXT,
  program_name TEXT,
  workout_title TEXT,
  workout_week INTEGER,
  workout_day INTEGER,
  exercises_snapshot TEXT                        -- JSON [{id, exercise_id, name, prescription, done}]
);
CREATE INDEX IF NOT EXISTS workout_logs_client ON workout_logs(client_id, completed_at);
CREATE TABLE IF NOT EXISTS exercise_logs (
  workout_log_id TEXT NOT NULL REFERENCES workout_logs(id) ON DELETE CASCADE,
  workout_exercise_id TEXT NOT NULL REFERENCES workout_exercises(id) ON DELETE CASCADE,
  PRIMARY KEY (workout_log_id, workout_exercise_id)
);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  scope TEXT NOT NULL DEFAULT 'full' CHECK (scope IN ('read','results','full'))   -- version 42: read only, read and send results, or full access
);
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  label TEXT,                            -- version 42: a name for the receiving system
  previous_secret TEXT,                  -- version 42: after a new signing secret, the old one also signs until previous_secret_until
  previous_secret_until TEXT,
  secret_rotated_at TEXT,
  failures INTEGER NOT NULL DEFAULT 0    -- version 42: failed tries in a row (3 or more = failing)
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_created ON events(created_at);
-- Version 42 rebuilt this table: test events have no event row (event_id empty, event_type and payload instead), and a
-- delivery is marked 'sending' while one server copy sends it, so nothing sends it twice.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event_id TEXT REFERENCES events(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending','sending','succeeded','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  response_code INTEGER,
  last_error TEXT,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL,
  event_type TEXT,                       -- version 42: a test event's type
  payload TEXT,                          -- version 42: a test event's body
  test INTEGER NOT NULL DEFAULT 0,       -- version 42: sent with Send test event
  last_attempt_at TEXT,                  -- version 42
  duration_ms INTEGER,                   -- version 42: how long the receiver took to answer
  response_body TEXT                     -- version 42: the start of the receiver's answer
);
CREATE INDEX IF NOT EXISTS deliveries_pending ON webhook_deliveries(status, next_attempt_at);

-- ---- In-person business: where you train, what you sell, how you got paid ----
CREATE TABLE IF NOT EXISTS locations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('facility','mobile','park','client_home','other')),
  address_line1 TEXT, city TEXT, state TEXT, postal_code TEXT, country TEXT NOT NULL DEFAULT 'US',
  stripe_location_id TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  checkin_code TEXT,                     -- the code in the door poster's QR link (/here/<code>); version 16
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS readers (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  location_id TEXT NOT NULL REFERENCES locations(id),
  provider_reader_id TEXT NOT NULL,
  device_type TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('session','pack','gear','other')),
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  sessions INTEGER NOT NULL DEFAULT 0 CHECK (sessions >= 0),
  credit_type TEXT NOT NULL DEFAULT 'private' CHECK (credit_type IN ('private','group')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  track_stock INTEGER NOT NULL DEFAULT 0,        -- version 17: count what's on the shelf (gear)
  low_stock_at INTEGER                           -- warn on Today at or below this many (per size)
);
-- Sizes or colors of a product (version 17). Stock is kept per size when a product has them.
CREATE TABLE IF NOT EXISTS product_variants (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sku TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS product_variants_product ON product_variants(product_id);
-- Stock is a ledger (version 17): what's on hand is the sum of the moves. A sale takes stock out, a full refund
-- puts it back, a delivery adds it, a count sets it to what's really on the shelf.
CREATE TABLE IF NOT EXISTS stock_moves (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id TEXT REFERENCES product_variants(id) ON DELETE SET NULL,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('sale','refund','received','count','adjust')),
  sale_id TEXT REFERENCES sales(id) ON DELETE SET NULL,
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS stock_moves_product ON stock_moves(product_id, variant_id);
-- Google review requests sent to families (version 18). One per family every 6 months at most.
CREATE TABLE IF NOT EXISTS review_requests (
  id TEXT PRIMARY KEY,
  family_id TEXT REFERENCES families(id) ON DELETE CASCADE,
  client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
  reason TEXT NOT NULL CHECK (reason IN ('milestone','pr')),
  detail TEXT,
  token TEXT NOT NULL UNIQUE,
  sent_to TEXT,
  sent_at TEXT NOT NULL,
  clicked_at TEXT,
  opted_out_at TEXT
);
CREATE INDEX IF NOT EXISTS review_requests_family ON review_requests(family_id, sent_at);
-- Announcement emails to a group (version 19). Opens aren't tracked; clicks on links are.
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  audience TEXT NOT NULL,                        -- {group, age_min, age_max, sport, stages}
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sending','sent')),
  created_by TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  channel TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email','text'))   -- version 45: group texts too
);
CREATE TABLE IF NOT EXISTS campaign_recipients (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  email TEXT,                                    -- version 45: empty for a group text (phone instead)
  name TEXT,
  family_id TEXT REFERENCES families(id) ON DELETE CASCADE,
  client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
  lead_id TEXT REFERENCES leads(id) ON DELETE SET NULL,
  token TEXT NOT NULL UNIQUE,
  links TEXT,                                    -- the original links, in order, for the counted redirects
  sent_at TEXT NOT NULL,
  clicked_at TEXT,
  unsubscribed_at TEXT,
  phone TEXT                                     -- version 45: a group text went to this number
);
CREATE INDEX IF NOT EXISTS campaign_recipients_campaign ON campaign_recipients(campaign_id);
-- Addresses that asked for no more announcement or review emails (receipts and booking emails still go).
CREATE TABLE IF NOT EXISTS email_optouts (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  source TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sales (
  id TEXT PRIMARY KEY,
  fee_cents INTEGER NOT NULL DEFAULT 0,             -- version 51: a card processing fee passed to the payer, inside amount_cents
  client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
  location_id TEXT NOT NULL REFERENCES locations(id),
  method TEXT NOT NULL CHECK (method IN ('tap_to_pay','reader','card_on_file','cash','online')),   -- online: paid through a pay link (version 15)
  status TEXT NOT NULL CHECK (status IN ('pending','succeeded','failed','canceled','refunded','partially_refunded')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  refunded_cents INTEGER NOT NULL DEFAULT 0,
  save_card INTEGER NOT NULL DEFAULT 0,
  reader_id TEXT REFERENCES readers(id),
  payment_ref TEXT,
  client_secret TEXT,
  card_brand TEXT, card_last4 TEXT,
  failure_reason TEXT,
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  -- version 36 (batch B5, point of sale): a discount on the whole sale (amount_cents is what was paid after it),
  -- the counter's request id (a second press of Charge returns the first sale), and the emailed receipt
  -- (receipt_opt: NULL = the automatic-receipt setting decides, 1 = send, 0 = don't; receipt_token opens the printable page).
  discount_cents INTEGER NOT NULL DEFAULT 0,
  discount_reason TEXT,
  request_id TEXT,
  receipt_opt INTEGER,
  receipt_email TEXT,
  receipt_sent_at TEXT,
  receipt_token TEXT,
  -- version 38 (batch B6): the unpaid booking this sale pays for, checked when the sale is made (before, a note
  -- 'booking:<id>' did this, so anyone could mark any booking paid by typing it in a note).
  booking_id TEXT REFERENCES bookings(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS sales_created ON sales(created_at);
CREATE INDEX IF NOT EXISTS sales_ref ON sales(payment_ref);
CREATE INDEX IF NOT EXISTS sales_completed ON sales(completed_at);
CREATE INDEX IF NOT EXISTS sales_request ON sales(request_id);
CREATE INDEX IF NOT EXISTS sales_receipt ON sales(receipt_token);
-- Version 36: each refund of a sale, so the day's takings count a refund on the day the money went back.
CREATE TABLE IF NOT EXISTS sale_refunds (
  id TEXT PRIMARY KEY,
  sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  kind TEXT NOT NULL DEFAULT 'refund' CHECK (kind IN ('refund','undo')),
  reason TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sale_refunds_created ON sale_refunds(created_at);
CREATE INDEX IF NOT EXISTS sale_refunds_sale ON sale_refunds(sale_id);
CREATE TABLE IF NOT EXISTS sale_items (
  id TEXT PRIMARY KEY,
  sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id TEXT REFERENCES products(id),
  name TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  sessions INTEGER NOT NULL DEFAULT 0,
  variant_id TEXT                                -- version 17: the size sold
);
-- Session credits are a ledger per type: +N when a pack is bought, -1 per booking or walk-in check-in,
-- +1 back when a booking is canceled in time, negative on refund.
CREATE TABLE IF NOT EXISTS session_credits (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  credit_type TEXT NOT NULL DEFAULT 'private' CHECK (credit_type IN ('private','group')),
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('purchase','check_in','refund','adjustment','booking','cancel')),
  sale_id TEXT REFERENCES sales(id) ON DELETE SET NULL,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS credits_client ON session_credits(client_id);
CREATE TABLE IF NOT EXISTS check_ins (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  location_id TEXT NOT NULL REFERENCES locations(id),
  covered_by TEXT NOT NULL CHECK (covered_by IN ('membership','credit')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS check_ins_client ON check_ins(client_id, created_at);

-- ---- Scheduling: recurring classes, camps, clinics, evaluations, team sessions, privates ----
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS class_series (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('group','camp','clinic','team','evaluation')),
  description TEXT,
  location_id TEXT NOT NULL REFERENCES locations(id),
  weekdays TEXT NOT NULL,                -- JSON array, 0 = Sunday
  start_time TEXT NOT NULL,              -- HH:MM in the business time zone
  duration_min INTEGER NOT NULL CHECK (duration_min BETWEEN 10 AND 600),
  capacity INTEGER NOT NULL CHECK (capacity BETWEEN 1 AND 500),
  age_min INTEGER, age_max INTEGER,
  drop_in_cents INTEGER,                 -- price of one session, if sold singly
  registration_cents INTEGER,            -- camps and clinics: price for the whole series
  start_date TEXT NOT NULL,              -- YYYY-MM-DD
  end_date TEXT,                         -- YYYY-MM-DD; open-ended classes repeat until archived
  contract_id TEXT REFERENCES team_contracts(id) ON DELETE SET NULL,   -- team sessions belong to a contract
  coach_id TEXT REFERENCES users(id) ON DELETE SET NULL,               -- who leads it (version 31)
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS class_sessions (
  id TEXT PRIMARY KEY,
  series_id TEXT REFERENCES class_series(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('group','camp','clinic','team','evaluation','private')),
  location_id TEXT NOT NULL REFERENCES locations(id),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  capacity INTEGER NOT NULL,
  age_min INTEGER, age_max INTEGER,
  drop_in_cents INTEGER,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','canceled')),
  created_at TEXT NOT NULL,
  workout_id TEXT REFERENCES workouts(id) ON DELETE SET NULL,   -- shown on the weight-room screen (version 23)
  coach_id TEXT REFERENCES users(id) ON DELETE SET NULL,         -- who leads it: the class's coach, or a sub for this one session (version 31)
  slot_date TEXT,                        -- version 39: the class day (YYYY-MM-DD) a class session stands for, even after it moves to another day
  staff_note TEXT,                       -- version 39: a note for staff on this one session (never shown to families)
  UNIQUE (series_id, starts_at)
);
CREATE INDEX IF NOT EXISTS class_sessions_time ON class_sessions(starts_at);
CREATE INDEX IF NOT EXISTS class_sessions_coach ON class_sessions(coach_id, starts_at);
CREATE TABLE IF NOT EXISTS enrollments (
  id TEXT PRIMARY KEY,
  series_id TEXT NOT NULL REFERENCES class_series(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('recurring','registration')),
  sale_id TEXT REFERENCES sales(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('booked','waitlisted','canceled','late_canceled','attended','no_show')),
  coverage TEXT NOT NULL CHECK (coverage IN ('membership','credit','paid','registration','unpaid','none')),
  credit_type TEXT,
  sale_id TEXT REFERENCES sales(id),
  enrollment_id TEXT REFERENCES enrollments(id) ON DELETE SET NULL,
  booked_by TEXT,
  reminded_at TEXT,                      -- reminder text handled (sent, or skipped because nobody in the family gets texts)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  note TEXT,                             -- version 41: the parent's note for the coach on a private or evaluation
  UNIQUE (session_id, client_id)
);
CREATE INDEX IF NOT EXISTS bookings_client ON bookings(client_id);
CREATE TABLE IF NOT EXISTS availability (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('private','evaluation')),
  location_id TEXT NOT NULL REFERENCES locations(id),
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  slot_minutes INTEGER NOT NULL CHECK (slot_minutes BETWEEN 15 AND 240),
  price_cents INTEGER,                   -- evaluations: price; privates use private credits or this drop-in price
  coach_id TEXT REFERENCES users(id) ON DELETE SET NULL,   -- whose hours these are (version 31); empty = the place decides
  created_at TEXT NOT NULL
);
-- Days a coach (or, with no user_id, the whole facility) is off: their private and evaluation times aren't offered.
CREATE TABLE IF NOT EXISTS time_off (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,              -- YYYY-MM-DD in the business time zone, inclusive
  end_date TEXT NOT NULL,
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);

-- ---- Parent portal sign-in and email ----
CREATE TABLE IF NOT EXISTS login_codes (
  id TEXT PRIMARY KEY,
  guardian_id TEXT NOT NULL REFERENCES guardians(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE TABLE IF NOT EXISTS portal_sessions (
  token_hash TEXT PRIMARY KEY,
  guardian_id TEXT NOT NULL REFERENCES guardians(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT,                       -- version 41: signed-in devices (Family tab): when, the browser, last used
  user_agent TEXT,
  last_seen_at TEXT
);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('logged','sent','failed')),
  error TEXT,
  created_at TEXT NOT NULL,
  sensitive INTEGER NOT NULL DEFAULT 0   -- version 42: held a password or a private link; never sent to another address
);
-- Text messages sent to parents (out) and their replies (in). Without Twilio settings they're only logged here.
CREATE TABLE IF NOT EXISTS texts (
  id TEXT PRIMARY KEY,
  direction TEXT NOT NULL CHECK (direction IN ('out','in')),
  phone TEXT NOT NULL,
  family_id TEXT REFERENCES families(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('logged','sent','failed','held','received')),
  error TEXT,
  provider_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS texts_family ON texts(family_id);

-- Leads: families who asked about training (public form, unfinished sign-up, or added by staff) but haven't joined yet.
CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  parent_name TEXT NOT NULL,
  email TEXT COLLATE NOCASE,
  phone TEXT,
  athlete_name TEXT,
  athlete_age INTEGER,
  sport TEXT,
  message TEXT,
  -- version 45: social, camp, team (a school or club), import (CSV) and client (put back in the pipeline from a profile)
  source TEXT NOT NULL CHECK (source IN ('inquiry','signup_unfinished','manual','phone','walk_in','event','referral','social','camp','team','import','client')),
  -- version 45: trial (a free trial membership) between evaluation and member
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','signed_up','evaluation','trial','member','lost')),
  texts_ok INTEGER NOT NULL DEFAULT 0,       -- they ticked "text me about this" on the form
  follow_up_step INTEGER NOT NULL DEFAULT 0, -- 0: thank-you, 1: 2-day nudge, 2: 7-day last note, 3: done
  next_follow_up_at TEXT,                    -- NULL when follow-up has stopped
  last_contacted_at TEXT,
  notes TEXT,
  lost_reason TEXT,
  family_id TEXT REFERENCES families(id) ON DELETE SET NULL,
  converted_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  coach_id TEXT REFERENCES users(id) ON DELETE SET NULL,  -- version 43: the coach the owner gave this lead to (coaches see only theirs)
  -- version 45 (CRM): when it reached its stage, the last time anyone worked it (stale after 7 days), the client it
  -- became (converted or linked), why it was lost (a reason key, plus a note), and who said texts are OK and how
  stage_changed_at TEXT,
  last_activity_at TEXT,
  client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
  lost_note TEXT,
  texts_ok_source TEXT,
  texts_ok_at TEXT
);
CREATE INDEX IF NOT EXISTS leads_status ON leads(status, next_follow_up_at);
CREATE INDEX IF NOT EXISTS leads_email ON leads(email);

-- Pay links: a page a parent opens from an email or text to pay one thing without signing in: a membership payment
-- that didn't go through, an unpaid session, a pack, or a set amount. The link is the token; it expires after 30 days.
CREATE TABLE IF NOT EXISTS pay_links (
  id TEXT PRIMARY KEY,
  fee_cents INTEGER NOT NULL DEFAULT 0,             -- version 51: a card processing fee passed to the payer, inside amount_cents
  token TEXT NOT NULL UNIQUE,
  client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('invoice','booking','product','custom')),
  invoice_id TEXT REFERENCES invoices(id) ON DELETE SET NULL,
  booking_id TEXT REFERENCES bookings(id) ON DELETE SET NULL,
  product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','settled','canceled')),   -- settled: paid some other way first
  checkout_ref TEXT,
  checkout_started_at TEXT,
  payment_ref TEXT,
  sale_id TEXT REFERENCES sales(id) ON DELETE SET NULL,
  sent_to TEXT,
  sent_at TEXT,
  paid_at TEXT,
  expires_at TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pay_links_invoice ON pay_links(invoice_id);
CREATE INDEX IF NOT EXISTS pay_links_client ON pay_links(client_id, status);

-- Check-in tablets: a browser at the front desk opened with a secret link (/kiosk#<key>) where athletes tap their name.
CREATE TABLE IF NOT EXISTS kiosks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  location_id TEXT NOT NULL REFERENCES locations(id),
  key_hash TEXT NOT NULL UNIQUE,
  last_seen_at TEXT,
  revoked_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);

-- ---- Team contracts: schools and clubs pay a monthly fee; athletes are on a roster ----
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'school' CHECK (kind IN ('school','club','other')),
  contact_name TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  billing_address TEXT,
  notes TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS team_contracts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                    -- e.g. Varsity Football
  monthly_cents INTEGER NOT NULL CHECK (monthly_cents >= 0),
  start_date TEXT NOT NULL,              -- first billing period starts here; each period is one month
  end_date TEXT,                         -- last day covered; no invoices for periods starting after it
  terms_days INTEGER NOT NULL DEFAULT 30 CHECK (terms_days BETWEEN 0 AND 120),
  po_number TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
  next_period_start TEXT NOT NULL,       -- YYYY-MM-DD of the next period to invoice
  notes TEXT,
  created_at TEXT NOT NULL
);
-- One profile per athlete (version 37): every roster line links a client, and results, device links and attendance
-- are kept on that client. name and athlete_id are copies of the client's, kept for older integrations.
CREATE TABLE IF NOT EXISTS team_roster (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES team_contracts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  athlete_id TEXT,
  position TEXT,
  grad_year INTEGER,
  client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,   -- the athlete's profile (always set since version 37)
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
-- Who was at a team session (version 37: by client; before that by roster line).
CREATE TABLE IF NOT EXISTS team_attendance (
  session_id TEXT NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, client_id)
);
CREATE TABLE IF NOT EXISTS team_invoices (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,           -- DP-2026-0001
  contract_id TEXT NOT NULL REFERENCES team_contracts(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lines TEXT NOT NULL,                   -- JSON [{description, amount_cents}]
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  period_start TEXT, period_end TEXT,    -- YYYY-MM-DD; null for one-off invoices
  issued_on TEXT NOT NULL,
  due_on TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','paid','void')),
  public_token TEXT NOT NULL UNIQUE,     -- the link emailed to the school's billing contact
  checkout_ref TEXT,
  paid_on TEXT, paid_method TEXT, paid_reference TEXT,
  sent_at TEXT, reminded_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (contract_id, period_start)
);
CREATE INDEX IF NOT EXISTS team_invoices_status ON team_invoices(status, due_on);

-- ---- Performance testing ----
CREATE TABLE IF NOT EXISTS perf_tests (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT,
  sides TEXT NOT NULL DEFAULT 'none' CHECK (sides IN ('none','lr')),
  attempts INTEGER NOT NULL DEFAULT 2 CHECK (attempts BETWEEN 1 AND 10),
  timed INTEGER NOT NULL DEFAULT 0,              -- can be hand-timed with the stopwatch
  sports TEXT NOT NULL DEFAULT '[]',
  aliases TEXT NOT NULL DEFAULT '[]',
  builtin INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  protocol TEXT,                                 -- version 34: the coach's own "how to run it" (NULL = the built-in text)
  edited TEXT NOT NULL DEFAULT '[]'              -- version 34: fields a coach changed on a built-in test; the library refresh leaves them alone
);
CREATE TABLE IF NOT EXISTS perf_metrics (
  test_id TEXT NOT NULL REFERENCES perf_tests(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  unit TEXT NOT NULL,
  better TEXT NOT NULL CHECK (better IN ('lower','higher','none')),
  decimals INTEGER NOT NULL DEFAULT 2,
  aliases TEXT NOT NULL DEFAULT '[]',
  sort INTEGER NOT NULL DEFAULT 0,
  min_value REAL,                                -- version 34: the coach's possible range (NULL = the built-in range)
  max_value REAL,
  PRIMARY KEY (test_id, key)
);
-- A testing day: a combine, an evaluation, or a team's preseason testing.
CREATE TABLE IF NOT EXISTS perf_sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  date TEXT NOT NULL,
  location_id TEXT REFERENCES locations(id),
  contract_id TEXT REFERENCES team_contracts(id) ON DELETE SET NULL,
  test_keys TEXT NOT NULL DEFAULT '[]',
  athletes TEXT NOT NULL DEFAULT '[]',          -- [{client_id}] expected on the day (before version 37 also {roster_id})
  notes TEXT,
  shared_at TEXT,                               -- results become visible to parents once the coach shares the day
  parent_note TEXT,
  created_at TEXT NOT NULL,
  notified_at TEXT                              -- when families were last emailed about this day (version 35)
);
CREATE TABLE IF NOT EXISTS perf_results (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES perf_sessions(id) ON DELETE SET NULL,
  client_id TEXT REFERENCES clients(id) ON DELETE CASCADE,
  roster_id TEXT REFERENCES team_roster(id) ON DELETE CASCADE,   -- before version 37 only: results now always go to client_id
  test_id TEXT NOT NULL REFERENCES perf_tests(id),
  metric TEXT NOT NULL,
  side TEXT CHECK (side IN ('L','R')),
  attempt INTEGER,
  value REAL NOT NULL,                          -- in the metric's unit
  entered_value REAL, entered_unit TEXT,        -- exactly what the device or coach sent
  timing TEXT CHECK (timing IN ('electronic','hand')),
  source TEXT NOT NULL,                         -- manual, stopwatch, api, csv:<provider>, hawkin …
  device TEXT,
  external_id TEXT,                             -- the device's own ID for this result (prevents duplicates)
  notes TEXT,
  recorded_at TEXT NOT NULL,
  voided INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  CHECK ((client_id IS NULL) <> (roster_id IS NULL))
);
CREATE INDEX IF NOT EXISTS perf_results_client ON perf_results(client_id, test_id, recorded_at);
CREATE INDEX IF NOT EXISTS perf_results_roster ON perf_results(roster_id, test_id, recorded_at);
CREATE UNIQUE INDEX IF NOT EXISTS perf_results_external ON perf_results(source, external_id) WHERE external_id IS NOT NULL;
-- Who's who on each device: the athlete's ID or name in OVR, Hawkin, VALD …
CREATE TABLE IF NOT EXISTS athlete_links (
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  external_name TEXT,
  client_id TEXT REFERENCES clients(id) ON DELETE CASCADE,
  roster_id TEXT REFERENCES team_roster(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (provider, external_id)
);
CREATE TABLE IF NOT EXISTS integrations (
  provider TEXT PRIMARY KEY,
  config TEXT NOT NULL DEFAULT '{}',            -- credentials and saved column mappings; secrets are never returned by the API
  status TEXT NOT NULL DEFAULT 'connected',
  last_sync_at TEXT, sync_cursor TEXT, last_error TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS import_batches (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  filename TEXT,
  total_rows INTEGER NOT NULL,
  imported INTEGER NOT NULL DEFAULT 0,
  duplicates INTEGER NOT NULL DEFAULT 0,
  pending TEXT NOT NULL DEFAULT '[]',           -- rows waiting for an athlete match
  errors TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  -- Undo an upload (version 35): what it wrote, so it can be taken back out.
  kind TEXT,                                    -- upload (Upload results) or import (device file); NULL = can't be undone
  source_label TEXT,                            -- where the file came from, as the coach chose it
  result_source TEXT,                           -- perf_results.source of what it saved
  session_id TEXT,
  replaced INTEGER NOT NULL DEFAULT 0,
  unchanged INTEGER NOT NULL DEFAULT 0,
  prs INTEGER NOT NULL DEFAULT 0,
  added_tests TEXT NOT NULL DEFAULT '[]',       -- tests the upload put on the testing day
  created_by TEXT,
  undone_at TEXT, undone_by TEXT, undo_summary TEXT
);
-- One row per result an upload saved or sent to waiting (version 35). replaced = results it set aside (voided), restored on undo.
CREATE TABLE IF NOT EXISTS import_batch_items (
  batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  result_id TEXT,
  value REAL,
  replaced TEXT NOT NULL DEFAULT '[]',
  queue_id TEXT
);

CREATE INDEX IF NOT EXISTS import_batch_items_batch ON import_batch_items(batch_id);
CREATE INDEX IF NOT EXISTS perf_results_session ON perf_results(session_id);
CREATE UNIQUE INDEX IF NOT EXISTS clients_athlete_id ON clients(athlete_id);
CREATE UNIQUE INDEX IF NOT EXISTS locations_checkin_code ON locations(checkin_code);

-- A checked upload waiting for the coach to confirm. Saved results always come from here, never from the browser.
CREATE TABLE IF NOT EXISTS upload_previews (
  id TEXT PRIMARY KEY,
  filename TEXT,
  options TEXT NOT NULL,                        -- session, date, test
  headers TEXT NOT NULL,
  rows TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Results that arrived without an Athlete ID or a link the coach confirmed. They wait here
-- until the coach links them to a profile (or discards them). Nothing is ever guessed.
CREATE TABLE IF NOT EXISTS results_queue (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,                       -- api, hawkin, ovr, vald, generic …
  source TEXT NOT NULL,
  identity TEXT NOT NULL,                       -- how the sender identified the athlete (device ID or name)
  athlete_ref TEXT NOT NULL,                    -- {external_id, name, email} as sent
  item TEXT NOT NULL,                           -- the result, already checked apart from who it belongs to
  session_id TEXT REFERENCES perf_sessions(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','linked','discarded')),
  result_id TEXT,
  resolved_at TEXT,
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS results_queue_status ON results_queue(status, provider, identity);

-- Who did what: every change made by staff, API keys and parents, plus sign-ins. Never stores request bodies.
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  actor_type TEXT NOT NULL,                     -- staff, api_key, parent, athlete (their app link), public, system
  actor_id TEXT,
  actor_name TEXT,
  role TEXT,
  action TEXT NOT NULL,                         -- e.g. "PATCH /v1/clients/:id"
  target TEXT,                                  -- the record's ID from the URL
  status INTEGER,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log(at);

-- ---- Background jobs ----
-- One row per finished run (kept 30 days). The webhook sender, which runs every 15 seconds, only records failures.
CREATE TABLE IF NOT EXISTS job_runs (
  id TEXT PRIMARY KEY,
  job TEXT NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'schedule' CHECK (trigger IN ('schedule','manual')),
  status TEXT NOT NULL CHECK (status IN ('ok','skipped','failed')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER,
  result TEXT,
  error TEXT,
  instance TEXT
);
CREATE INDEX IF NOT EXISTS job_runs_job ON job_runs(job, started_at);
CREATE INDEX IF NOT EXISTS job_runs_started ON job_runs(started_at);
-- Per job: which server copy holds it until when (so copies sharing this database don't both run it), and alert state.
CREATE TABLE IF NOT EXISTS job_state (
  job TEXT PRIMARY KEY,
  lease_until TEXT,
  holder TEXT,
  fail_streak INTEGER NOT NULL DEFAULT 0,
  last_ok_at TEXT,
  alerted_at TEXT
);

-- ---- Terms, privacy and data requests ----
-- Each parent's acceptance of each version of the terms and privacy policy.
CREATE TABLE IF NOT EXISTS consents (
  id TEXT PRIMARY KEY,
  guardian_id TEXT REFERENCES guardians(id) ON DELETE SET NULL,
  family_id TEXT REFERENCES families(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('terms','privacy')),
  version INTEGER NOT NULL,
  accepted_by TEXT NOT NULL,                    -- name and email at the time, kept even if the account is deleted
  ip TEXT,
  accepted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS consents_guardian ON consents(guardian_id, kind);
-- A parent's request for a copy of their data or to delete it.
CREATE TABLE IF NOT EXISTS data_requests (
  id TEXT PRIMARY KEY,
  family_id TEXT REFERENCES families(id) ON DELETE SET NULL,
  family_name TEXT,
  requested_by TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('export','delete')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','declined')),
  note TEXT,
  resolution TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
-- New families signing themselves up, waiting for the emailed code.
CREATE TABLE IF NOT EXISTS signup_requests (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  payload TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  ip TEXT,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

-- ---- Accountability, performance targets and education (version 12) ----
-- One daily check-in per athlete per day (in the business time zone). Parents can fill it in too.
CREATE TABLE IF NOT EXISTS daily_checkins (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  date TEXT NOT NULL,                           -- YYYY-MM-DD
  sleep_hours REAL CHECK (sleep_hours BETWEEN 0 AND 16),
  hydration INTEGER CHECK (hydration BETWEEN 1 AND 5),
  soreness INTEGER CHECK (soreness BETWEEN 1 AND 5),
  energy INTEGER CHECK (energy BETWEEN 1 AND 5),
  mood INTEGER CHECK (mood BETWEEN 1 AND 5),
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (client_id, date)
);
CREATE INDEX IF NOT EXISTS daily_checkins_date ON daily_checkins(date);
-- Weekly goals (Monday to Sunday) for one athlete or everyone on a team roster.
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  client_id TEXT REFERENCES clients(id) ON DELETE CASCADE,
  contract_id TEXT REFERENCES team_contracts(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('workouts','sessions','checkins','custom')),
  target INTEGER NOT NULL CHECK (target BETWEEN 1 AND 14),
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL,
  ended_at TEXT,
  CHECK ((client_id IS NULL) <> (contract_id IS NULL))
);
CREATE TABLE IF NOT EXISTS goal_checks (
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  PRIMARY KEY (goal_id, client_id, date)
);
-- Notes from coaches to one athlete or a whole team. Read state is kept per athlete.
-- Skill badges a coach awards by hand (version 22): "Sprint start", "Hinge pattern". Athletes and parents see them.
CREATE TABLE IF NOT EXISTS skill_badges (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  description TEXT,
  category TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS badge_awards (
  id TEXT PRIMARY KEY,
  badge_id TEXT NOT NULL REFERENCES skill_badges(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  note TEXT,
  awarded_by TEXT,
  awarded_at TEXT NOT NULL,
  UNIQUE (badge_id, client_id)
);
CREATE TABLE IF NOT EXISTS coach_messages (
  id TEXT PRIMARY KEY,
  client_id TEXT REFERENCES clients(id) ON DELETE CASCADE,
  contract_id TEXT REFERENCES team_contracts(id) ON DELETE CASCADE,
  staff_id TEXT,
  staff_name TEXT,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  from_kind TEXT NOT NULL DEFAULT 'coach',       -- version 20: coach, athlete or parent (replies)
  author_name TEXT,                              -- who wrote a reply
  guardian_id TEXT,                              -- the parent who wrote it
  staff_read_at TEXT,                            -- when a coach saw a reply
  CHECK ((client_id IS NULL) <> (contract_id IS NULL))
);
CREATE TABLE IF NOT EXISTS message_reads (
  message_id TEXT NOT NULL REFERENCES coach_messages(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  read_at TEXT NOT NULL,
  PRIMARY KEY (message_id, client_id)
);
-- Parents keep their own read state (version 30): a parent opening the messages doesn't clear them for the athlete.
CREATE TABLE IF NOT EXISTS guardian_message_reads (
  message_id TEXT NOT NULL REFERENCES coach_messages(id) ON DELETE CASCADE,
  guardian_id TEXT NOT NULL REFERENCES guardians(id) ON DELETE CASCADE,
  read_at TEXT NOT NULL,
  PRIMARY KEY (message_id, guardian_id)
);
-- A coach's target for one test (the test's headline number), in that metric's unit.
CREATE TABLE IF NOT EXISTS test_targets (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  test_id TEXT NOT NULL REFERENCES perf_tests(id) ON DELETE CASCADE,
  target REAL NOT NULL,
  due_date TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (client_id, test_id)
);
CREATE TABLE IF NOT EXISTS courses (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  published INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'athletes' CHECK (audience IN ('athletes','parents')),   -- parent courses show in the parent portal (version 25)
  age_min INTEGER,                                                                           -- for parents of athletes this age (version 25)
  age_max INTEGER,
  for_sale INTEGER NOT NULL DEFAULT 0,                                                       -- sold online; locked for athletes who haven't bought it (version 26)
  price_cents INTEGER
);
CREATE TABLE IF NOT EXISTS lessons (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT,
  body TEXT,                                    -- plain text; blank lines start new paragraphs
  video_url TEXT,
  minutes INTEGER,
  course_id TEXT REFERENCES courses(id) ON DELETE SET NULL,
  position INTEGER NOT NULL DEFAULT 0,
  published INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  quiz TEXT,                                    -- JSON [{q, choices, answer}]; pass it to finish the lesson (version 24)
  -- version 46: the Education tab it's under and who reads it: athlete (athletes and their parents), parent (parents in the
  -- portal), coach (staff and the public /learn page), blog and research (athletes and parents). A lesson in a course
  -- takes the course's audience (athlete or parent).
  category TEXT NOT NULL DEFAULT 'athlete' CHECK (category IN ('athlete','parent','coach','blog','research'))
);
CREATE TABLE IF NOT EXISTS lesson_progress (
  lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  completed_at TEXT NOT NULL,
  PRIMARY KEY (lesson_id, client_id)
);
-- Programs and courses bought online (version 26). A refund of the sale ends access.
CREATE TABLE IF NOT EXISTS purchases (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('program','course')),
  item_id TEXT NOT NULL,
  title TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  sale_id TEXT REFERENCES sales(id) ON DELETE SET NULL,
  guardian_id TEXT REFERENCES guardians(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','refunded')),
  created_at TEXT NOT NULL,
  refunded_at TEXT
);
CREATE INDEX IF NOT EXISTS purchases_client ON purchases(client_id, item_kind, item_id);
-- Open-spot offers (version 27): a family is told a class it fits has room; the first to tap the link gets the spot.
CREATE TABLE IF NOT EXISTS spot_offers (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  client_ids TEXT NOT NULL,                       -- the family's athletes who fit, comma separated
  sent_to TEXT,
  sent_by TEXT,
  sent_at TEXT NOT NULL,
  opened_at TEXT,
  booking_id TEXT REFERENCES bookings(id) ON DELETE SET NULL,
  booked_at TEXT,
  price_cents INTEGER,                            -- a trial offer's special price (0 = free); NULL for a standard offer at the usual cover (version 32)
  UNIQUE (session_id, family_id)
);
-- Progress notes for parents (version 28): one per athlete per testing day, drafted by the app, approved by a coach.
CREATE TABLE IF NOT EXISTS progress_notes (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  perf_session_id TEXT NOT NULL REFERENCES perf_sessions(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'draft' CHECK (source IN ('draft','ai','edited')),
  approved_at TEXT,
  approved_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (client_id, perf_session_id)
);
-- Daily money checks (version 29): one row per business day checked. Findings hold ids and amounts, never names.
CREATE TABLE IF NOT EXISTS money_checks (
  id TEXT PRIMARY KEY,
  check_date TEXT NOT NULL UNIQUE,                -- YYYY-MM-DD, business time
  status TEXT NOT NULL CHECK (status IN ('ok','problems','error')),
  findings TEXT NOT NULL,                         -- JSON list
  totals TEXT NOT NULL,                           -- JSON {card_payments, recorded_cents, stripe_cents}
  stripe_checked INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  ran_at TEXT NOT NULL,
  ran_by TEXT,
  alerted_at TEXT,
  reviewed_at TEXT,
  reviewed_by TEXT
);
-- What each parent has read of the parent courses (version 25).
CREATE TABLE IF NOT EXISTS guardian_lesson_progress (
  lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  guardian_id TEXT NOT NULL REFERENCES guardians(id) ON DELETE CASCADE,
  completed_at TEXT NOT NULL,
  PRIMARY KEY (lesson_id, guardian_id)
);
-- Quiz tries (version 24). The latest passing try finishes the lesson.
CREATE TABLE IF NOT EXISTS quiz_attempts (
  id TEXT PRIMARY KEY,
  lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  score INTEGER NOT NULL,
  total INTEGER NOT NULL,
  passed INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS quiz_attempts_client ON quiz_attempts(client_id, lesson_id);
-- A certificate for finishing every lesson in a course (version 24). The token makes a shareable page at /certificate#<token>.
CREATE TABLE IF NOT EXISTS course_certificates (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  issued_at TEXT NOT NULL,
  UNIQUE (course_id, client_id)
);
-- A lesson or a course assigned to an athlete or a team roster, with an optional due date.
CREATE TABLE IF NOT EXISTS lesson_assignments (
  id TEXT PRIMARY KEY,
  lesson_id TEXT REFERENCES lessons(id) ON DELETE CASCADE,
  course_id TEXT REFERENCES courses(id) ON DELETE CASCADE,
  client_id TEXT REFERENCES clients(id) ON DELETE CASCADE,
  contract_id TEXT REFERENCES team_contracts(id) ON DELETE CASCADE,
  due_date TEXT,
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  CHECK ((lesson_id IS NULL) <> (course_id IS NULL)),
  CHECK ((client_id IS NULL) <> (contract_id IS NULL))
);
-- ---- Version 44 (batch B11): Education, coach side ----
-- The first time an athlete (or a parent with them) opened a lesson, so coaches see "Opened" before "Finished".
CREATE TABLE IF NOT EXISTS lesson_views (
  lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  opened_at TEXT NOT NULL,
  PRIMARY KEY (lesson_id, client_id)
);
-- Reading reminders a coach sent: one row per athlete reminded. An assignment is reminded at most every 12 hours,
-- and an athlete gets at most one reading reminder every 12 hours, whichever assignment it was for.
CREATE TABLE IF NOT EXISTS lesson_reminders (
  id TEXT PRIMARY KEY,
  assignment_id TEXT REFERENCES lesson_assignments(id) ON DELETE SET NULL,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  sent_by TEXT,
  sent_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS lesson_reminders_client ON lesson_reminders(client_id, sent_at);
CREATE INDEX IF NOT EXISTS lesson_reminders_assignment ON lesson_reminders(assignment_id, sent_at);
-- Staff notes on a client: dated, with the author. Pinned notes show at the top of the client page; coach-only notes
-- are never shown to front desk.
CREATE TABLE IF NOT EXISTS client_notes (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  author_id TEXT,
  author_name TEXT NOT NULL,
  body TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  coach_only INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS client_notes_client ON client_notes(client_id, created_at);
-- The client list looks up each client's parents and team rosters.
CREATE INDEX IF NOT EXISTS guardians_family ON guardians(family_id);
CREATE INDEX IF NOT EXISTS team_roster_client ON team_roster(client_id);

-- ---------- Version 34: test library presets and progress report share links (batch B10) ----------
-- A named set of tests to start a testing day from (Combine, Force plate...). test_keys: ordered perf_tests keys.
CREATE TABLE IF NOT EXISTS test_presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  test_keys TEXT NOT NULL DEFAULT '[]',
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
-- A private link to one athlete's progress report (the family view) that works without signing in until it expires
-- or is turned off. Only a hash of the link's secret is stored, so the database never holds a working link.
CREATE TABLE IF NOT EXISTS report_links (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('staff','parent')),
  created_by_id TEXT,
  created_by_name TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  views INTEGER NOT NULL DEFAULT 0,
  last_viewed_at TEXT
);
CREATE INDEX IF NOT EXISTS report_links_client ON report_links(client_id, created_at);
-- The test library's usage counts, record boards and "can it be deleted" checks look results up by test.
CREATE INDEX IF NOT EXISTS perf_results_test ON perf_results(test_id, metric);

-- ---------- Version 37: one profile per athlete ----------
-- Athlete IDs that still find a profile: a team roster line's own ID from before version 37 (the athlete's profile
-- has another ID now), so sheets and devices using the old ID keep landing on the right athlete. Never shown as an ID.
CREATE TABLE IF NOT EXISTS athlete_id_aliases (
  athlete_id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  source TEXT NOT NULL,                         -- roster: a roster line's ID from before version 37
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS team_attendance_client ON team_attendance(client_id);
CREATE INDEX IF NOT EXISTS athlete_id_aliases_client ON athlete_id_aliases(client_id);

-- ---------- Version 39: Schedule and Today (batches B2 and B3) ----------
-- Follow-ups on Today: "Reached out" or "Mark reviewed" hides an item (an athlete to check on, a check-in that needs a
-- look) from everyone's Today until a date, and says who did it. key is unique per item: risk:<client id> or
-- flag:<client id>:<check-in date>.
CREATE TABLE IF NOT EXISTS today_snoozes (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('risk','flag')),
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  until TEXT NOT NULL,                          -- YYYY-MM-DD in the business time zone: hidden through this day
  action TEXT NOT NULL,                         -- reached_out, reviewed or noted
  note TEXT,
  created_by_id TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS today_snoozes_until ON today_snoozes(until);

-- ---------- Version 40: programs builder and set-by-set workout logging ----------
-- Each set an athlete logs: weight (lb) and reps. workout_exercise_id has no foreign key, so the coach can change the
-- program later and the athlete's history stays; exercise_id and exercise_name keep "last time" and bests following the
-- exercise across programs.
CREATE TABLE IF NOT EXISTS workout_sets (
  id TEXT PRIMARY KEY,
  workout_log_id TEXT NOT NULL REFERENCES workout_logs(id) ON DELETE CASCADE,
  workout_exercise_id TEXT NOT NULL,
  exercise_id TEXT,
  exercise_name TEXT NOT NULL,
  set_no INTEGER NOT NULL CHECK (set_no BETWEEN 1 AND 12),
  weight REAL,
  reps INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (workout_log_id, workout_exercise_id, set_no)
);
CREATE INDEX IF NOT EXISTS workout_sets_exercise ON workout_sets(exercise_id);
CREATE UNIQUE INDEX IF NOT EXISTS workout_logs_request ON workout_logs(client_id, request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS workout_logs_workout ON workout_logs(workout_id);

-- ---------- Version 41: parent portal (batches B12 and B13) ----------
-- A parent asks to switch plans, pause or cancel a membership. Nothing about billing changes: the owner is emailed, sees
-- it on the client page and makes the change (or says no) by hand. One open request per athlete.
CREATE TABLE IF NOT EXISTS membership_requests (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  subscription_id TEXT REFERENCES subscriptions(id) ON DELETE SET NULL,
  guardian_id TEXT REFERENCES guardians(id) ON DELETE SET NULL,
  guardian_name TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('switch','pause','cancel')),
  plan_id TEXT REFERENCES plans(id) ON DELETE SET NULL,   -- switch: the plan they'd like
  note TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','declined','withdrawn')),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  resolution_note TEXT
);
CREATE INDEX IF NOT EXISTS membership_requests_client ON membership_requests(client_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS membership_requests_open ON membership_requests(client_id) WHERE status = 'open';
-- A parent signing up (or adding a child) said their child already has a profile, with its Athlete ID. When the name
-- and birth year match a profile with no family, it joins the family at once ('attached'). Otherwise the new athlete is
-- made as usual and, if the ID belongs to a profile with no family, the owner is asked to check and merge ('open').
CREATE TABLE IF NOT EXISTS profile_claims (
  id TEXT PRIMARY KEY,
  family_id TEXT REFERENCES families(id) ON DELETE CASCADE,
  guardian_id TEXT REFERENCES guardians(id) ON DELETE SET NULL,
  guardian_name TEXT,
  athlete_id TEXT NOT NULL,                     -- the ID as the parent typed it (upper case)
  claimed_client_id TEXT REFERENCES clients(id) ON DELETE CASCADE,   -- the existing profile
  new_client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,      -- the athlete the parent's form made (open claims)
  status TEXT NOT NULL CHECK (status IN ('attached','open','merged','dismissed')),
  reason TEXT,                                  -- open: why it wasn't attached at once (name, birth year, no birthday on file)
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT
);
CREATE INDEX IF NOT EXISTS profile_claims_status ON profile_claims(status, created_at);

-- ---------- Version 42: API & integrations, Staff & security (batch B14) ----------
-- Every request made with an API key, kept 30 days: never the body or the query string.
CREATE TABLE IF NOT EXISTS api_requests (
  id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER NOT NULL,
  duration_ms INTEGER,
  ip TEXT,
  error TEXT                             -- the error message sent back
);
CREATE INDEX IF NOT EXISTS api_requests_key ON api_requests(key_id, at);
CREATE INDEX IF NOT EXISTS api_requests_at ON api_requests(at);
-- "Forgot password" links for staff: only a hash of the secret, single use, 30 minutes.
CREATE TABLE IF NOT EXISTS password_resets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS password_resets_user ON password_resets(user_id, created_at);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS webhook_deliveries_endpoint ON webhook_deliveries(endpoint_id, created_at);

-- ---------- Version 43: owner decisions (charge attempts, late approvals) ----------
-- Every membership charge tried, with Stripe's PaymentIntent id, so a bank approval that arrives late can always be
-- matched to its invoice, even after a pay link or a hand payment replaced the invoice's payment_ref, or after the
-- charge call errored before an id came back (the attempt's id travels in the charge's metadata). source says who
-- started the try: automatic (the first charge, the scheduled retries), new_card (a family saved a new card; counts as
-- automatic), owner (Retry or Retry all) or parent (the portal's Try again); manual = owner or parent, which don't count
-- toward canceling. A late approval of an invoice already paid another way (or voided) is refunded automatically, once:
-- late_outcome says how that went, and the owner's Today alert stays until handled_at.
CREATE TABLE IF NOT EXISTS invoice_charges (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  manual INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'automatic' CHECK (source IN ('automatic','new_card','owner','parent')),
  amount_cents INTEGER NOT NULL,
  ref TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','declined','error')),
  error TEXT,
  created_at TEXT NOT NULL,
  settled_at TEXT,
  late_outcome TEXT CHECK (late_outcome IN ('refunded','refund_failed')),
  late_reason TEXT,
  late_at TEXT,
  refund_ref TEXT,
  refund_error TEXT,
  handled_at TEXT,
  handled_by TEXT
);
CREATE INDEX IF NOT EXISTS invoice_charges_invoice ON invoice_charges(invoice_id);
CREATE INDEX IF NOT EXISTS invoice_charges_ref ON invoice_charges(ref);
CREATE INDEX IF NOT EXISTS invoice_charges_late ON invoice_charges(late_outcome, handled_at);
CREATE INDEX IF NOT EXISTS leads_coach ON leads(coach_id);

-- ---------- Version 45: CRM (batch B15) ----------
-- Every stage a lead has been in: moved by staff (by_name) or on its own (auto = 1, reason says what happened).
CREATE TABLE IF NOT EXISTS lead_stage_history (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  from_stage TEXT,
  to_stage TEXT NOT NULL,
  auto INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  by_id TEXT,
  by_name TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS lead_stage_history_lead ON lead_stage_history(lead_id, at);
-- Contact with a lead or a family: notes, calls (with how they went), and emails and texts sent from the lead page or
-- the client profile (texts also stay in the texts log). A family's rows go when the family is deleted; a lead's with
-- the lead. token: the email's own "stop these emails" link (/u/<token>).
CREATE TABLE IF NOT EXISTS lead_activity (
  id TEXT PRIMARY KEY,
  lead_id TEXT REFERENCES leads(id) ON DELETE CASCADE,
  family_id TEXT REFERENCES families(id) ON DELETE CASCADE,
  client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('note','call','email','text')),
  outcome TEXT,                                  -- calls: reached, voicemail, no_answer; emails and texts: how it went
  subject TEXT,
  body TEXT,
  sent_to TEXT,
  token TEXT UNIQUE,
  by_id TEXT,
  by_name TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS lead_activity_lead ON lead_activity(lead_id, at);
CREATE INDEX IF NOT EXISTS lead_activity_family ON lead_activity(family_id, at);
-- Follow-up tasks on a lead or a family, due on a day in the business time zone, for one staff member.
CREATE TABLE IF NOT EXISTS crm_tasks (
  id TEXT PRIMARY KEY,
  lead_id TEXT REFERENCES leads(id) ON DELETE CASCADE,
  family_id TEXT REFERENCES families(id) ON DELETE CASCADE,
  client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  due_date TEXT NOT NULL,                        -- YYYY-MM-DD
  assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  done_at TEXT,
  done_by TEXT,
  created_by_id TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS crm_tasks_assignee ON crm_tasks(assignee_id, done_at, due_date);
CREATE INDEX IF NOT EXISTS crm_tasks_lead ON crm_tasks(lead_id);
CREATE INDEX IF NOT EXISTS crm_tasks_family ON crm_tasks(family_id);
-- Email and text templates for one-to-one messages from the lead page and the client profile (the owner edits them).
CREATE TABLE IF NOT EXISTS message_templates (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('email','text')),
  name TEXT NOT NULL,
  subject TEXT,
  body TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS leads_client ON leads(client_id);

-- ---------- Version 47: outside data (Settings → Data import, the parent portal) ----------
-- One file brought in for one athlete: a wearable's export (WHOOP cycles, sleeps or workouts) or another table mapped by
-- hand. created_by_kind: staff or a parent. Undo removes what it saved (undone_at).
CREATE TABLE IF NOT EXISTS data_imports (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  source TEXT NOT NULL,                          -- a dataimport.js FORMATS key: whoop_cycles, oura_daily, garmin_activities, apple_health, fitbit, custom...
  file_kind TEXT NOT NULL,                       -- csv, xlsx, sheet, pdf, apple_health, fitbit (version 54 dropped the fixed list, so a new kind needs no migration)
  filename TEXT,
  rows INTEGER NOT NULL DEFAULT 0,
  days INTEGER NOT NULL DEFAULT 0,
  workouts INTEGER NOT NULL DEFAULT 0,
  from_day TEXT,
  to_day TEXT,
  created_by TEXT,
  created_by_kind TEXT NOT NULL DEFAULT 'staff' CHECK (created_by_kind IN ('staff','parent')),
  created_at TEXT NOT NULL,
  undone_at TEXT,
  undone_by TEXT
);
CREATE INDEX IF NOT EXISTS data_imports_client ON data_imports(client_id, created_at);
-- One number per athlete, metric and day (the day they woke up, for sleep and recovery). metric is a known key
-- (recovery_pct, hrv_ms...) or custom:<name> with its own label and unit. A newer import of the same day replaces it.
CREATE TABLE IF NOT EXISTS athlete_metrics (
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  day TEXT NOT NULL,                             -- YYYY-MM-DD
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  label TEXT,
  unit TEXT,
  source TEXT NOT NULL,
  import_id TEXT REFERENCES data_imports(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (client_id, metric, day)
);
CREATE INDEX IF NOT EXISTS athlete_metrics_import ON athlete_metrics(import_id);
-- The value an import replaced (a different number for the same athlete, metric and day), so undoing that import puts it
-- back. prior_import_id is the import that had saved it (empty: none, or it came in before this table).
CREATE TABLE IF NOT EXISTS data_import_replaced (
  import_id TEXT NOT NULL REFERENCES data_imports(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  metric TEXT NOT NULL,
  day TEXT NOT NULL,
  value REAL NOT NULL,
  label TEXT,
  unit TEXT,
  source TEXT NOT NULL,
  prior_import_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (import_id, metric, day)
);
CREATE INDEX IF NOT EXISTS data_import_replaced_prior ON data_import_replaced(prior_import_id);
-- Workouts a wearable recorded (not the programs athletes log in the app: those are workout_logs).
CREATE TABLE IF NOT EXISTS athlete_workouts (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  day TEXT,
  minutes REAL,
  activity TEXT,
  strain REAL,
  calories REAL,
  avg_hr REAL,
  max_hr REAL,
  import_id TEXT REFERENCES data_imports(id) ON DELETE SET NULL,
  UNIQUE (client_id, source, started_at)
);
CREATE INDEX IF NOT EXISTS athlete_workouts_client ON athlete_workouts(client_id, started_at);
CREATE INDEX IF NOT EXISTS athlete_workouts_import ON athlete_workouts(import_id);
-- Version 52: wearable accounts linked for automatic pulls (services/wearables.js). Tokens for the provider's API; the
-- data pulled lands in athlete_metrics and athlete_workouts with source whoop_sync / oura_sync.
CREATE TABLE IF NOT EXISTS wearable_connections (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('whoop','oura')),
  provider_user_id TEXT,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at TEXT,
  scopes TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','needs_reconnect')),
  connected_by_kind TEXT NOT NULL DEFAULT 'parent' CHECK (connected_by_kind IN ('staff','parent')),
  connected_by TEXT,
  connected_at TEXT NOT NULL,
  last_sync_at TEXT,
  last_sync_days INTEGER,
  last_error TEXT,
  history_from TEXT,                                  -- how far back the history walk has reached (wearables.js pullHistory)
  history_empty INTEGER NOT NULL DEFAULT 0,           -- empty chunks in a row so far
  history_found INTEGER NOT NULL DEFAULT 0,           -- something has come back at some point (empties count toward stopping only after that)
  history_done INTEGER NOT NULL DEFAULT 0,
  UNIQUE (client_id, provider)
);
-- The one-time code a sign-in was started with, so the provider's answer can only land on the athlete it was for (20 minutes).
CREATE TABLE IF NOT EXISTS wearable_auth_states (
  state TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  by_kind TEXT NOT NULL,
  by_id TEXT,
  return_to TEXT NOT NULL,
  created_at TEXT NOT NULL
);
-- Version 53: form checks (services/formchecks.js). An athlete films a set and sends it to the coach; the clip itself
-- lives in the owner's private bucket under object_key (never on this disk), and goes after expires_at.
CREATE TABLE IF NOT EXISTS form_checks (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  exercise_id TEXT REFERENCES exercises(id) ON DELETE SET NULL,
  exercise_name TEXT NOT NULL,
  workout_exercise_id TEXT,
  workout_title TEXT,
  note TEXT,
  object_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes INTEGER,
  duration_s REAL,
  status TEXT NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading','sent','answered')),
  created_at TEXT NOT NULL,
  sent_at TEXT,
  answered_at TEXT,
  coach_id TEXT,
  coach_name TEXT,
  reply TEXT,
  reply_object_key TEXT,
  reply_content_type TEXT,
  reply_bytes INTEGER,
  reply_status TEXT CHECK (reply_status IN ('uploading','sent')),
  reply_etag TEXT,
  reply_pending_key TEXT,
  reply_pending_type TEXT,
  reply_pending_bytes INTEGER,
  reply_pending_at TEXT,
  etag TEXT,
  seen_by_athlete_at TEXT,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_form_checks_client ON form_checks(client_id, created_at);
CREATE INDEX IF NOT EXISTS idx_form_checks_status ON form_checks(status, sent_at);
-- Objects the store wouldn't delete when their form check went (a removed clip, a deleted family): the daily job tries again.
CREATE TABLE IF NOT EXISTS form_check_orphans (
  object_key TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  last_error TEXT
);
-- Version 55: progression steps for one athlete on one exercise (services/progression.js): suggested after two workouts
-- hitting every set at the top of the range, approved or dismissed by a coach; approved steps add up in the app.
CREATE TABLE IF NOT EXISTS progressions (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  exercise_id TEXT NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('weight','reps','sets')),
  amount REAL NOT NULL,
  basis TEXT,
  status TEXT NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested','approved','dismissed','removed')),   -- removed: an approved step the coach took back out
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_progressions_client ON progressions(client_id, exercise_id, status);
-- Version 56: a coach swapped one athlete's exercise in one slot of a workout (an injury, no equipment), from the live
-- session view (services/live.js). The plan itself doesn't change; the app, the screen and the log follow the swap.
CREATE TABLE IF NOT EXISTS exercise_swaps (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  workout_exercise_id TEXT NOT NULL REFERENCES workout_exercises(id) ON DELETE CASCADE,
  exercise_id TEXT NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
  reason TEXT,
  session_id TEXT REFERENCES class_sessions(id) ON DELETE SET NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  by_kind TEXT NOT NULL DEFAULT 'coach' CHECK (by_kind IN ('coach','athlete')),   -- version 57: an athlete's own pick from the coach's list
  UNIQUE (client_id, workout_exercise_id)
);
-- Version 57: the swaps an athlete may pick on their own for an exercise (services/substitutions.js): "no barbell",
-- "knee", "at home"... Library data, not personal; a pick becomes an exercise_swaps row with by_kind 'athlete'.
CREATE TABLE IF NOT EXISTS exercise_alternatives (
  id TEXT PRIMARY KEY,
  exercise_id TEXT NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
  alt_exercise_id TEXT NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
  tag TEXT NOT NULL DEFAULT 'other' CHECK (tag IN ('no_barbell','no_equipment','at_home','knee','shoulder','back','easier','harder','other')),
  note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (exercise_id, alt_exercise_id)
);
-- Version 58: warm-up and cool-down blocks (services/routines.js), written once and attached to workouts by
-- workouts.warmup_id / cooldown_id. Shown with the workout everywhere; nothing in a block is logged.
CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('warmup','cooldown')),
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS routine_exercises (
  id TEXT PRIMARY KEY,
  routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  exercise_id TEXT NOT NULL REFERENCES exercises(id),
  position INTEGER NOT NULL,
  prescription TEXT NOT NULL,
  note TEXT
);
