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
  expires_at TEXT NOT NULL
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
  created_at TEXT NOT NULL
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
  created_at TEXT NOT NULL
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
  created_at TEXT NOT NULL
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
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS subscriptions_client ON subscriptions(client_id);
CREATE INDEX IF NOT EXISTS subscriptions_due ON subscriptions(status, current_period_end);
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
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
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS invoices_client ON invoices(client_id);
CREATE INDEX IF NOT EXISTS invoices_retry ON invoices(status, next_retry_at);
CREATE TABLE IF NOT EXISTS exercises (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  video_url TEXT,
  instructions TEXT,
  created_at TEXT NOT NULL
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
  UNIQUE (program_id, week, day)
);
CREATE TABLE IF NOT EXISTS workout_exercises (
  id TEXT PRIMARY KEY,
  workout_id TEXT NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  exercise_id TEXT NOT NULL REFERENCES exercises(id),
  position INTEGER NOT NULL,
  prescription TEXT NOT NULL,
  load_test TEXT,                                -- version 21: weight as a percent of this tested max (squat_1rm...)
  load_pct INTEGER
);
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
  assignment_id TEXT REFERENCES assignments(id) ON DELETE CASCADE,   -- empty when logged on the weight-room screen by an athlete not on that program
  workout_id TEXT NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  notes TEXT,
  completed_at TEXT NOT NULL,
  session_id TEXT REFERENCES class_sessions(id) ON DELETE SET NULL    -- logged on the weight-room screen during this session (version 23)
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
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_created ON events(created_at);
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending','succeeded','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  response_code INTEGER,
  last_error TEXT,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL
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
  audience TEXT NOT NULL,                        -- {group, age_min, age_max, sport}
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sending','sent')),
  created_by TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE TABLE IF NOT EXISTS campaign_recipients (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  name TEXT,
  family_id TEXT REFERENCES families(id) ON DELETE CASCADE,
  client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
  lead_id TEXT REFERENCES leads(id) ON DELETE SET NULL,
  token TEXT NOT NULL UNIQUE,
  links TEXT,                                    -- the original links, in order, for the counted redirects
  sent_at TEXT NOT NULL,
  clicked_at TEXT,
  unsubscribed_at TEXT
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
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS sales_created ON sales(created_at);
CREATE INDEX IF NOT EXISTS sales_ref ON sales(payment_ref);
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
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('logged','sent','failed')),
  error TEXT,
  created_at TEXT NOT NULL
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
  source TEXT NOT NULL CHECK (source IN ('inquiry','signup_unfinished','manual','phone','walk_in','event','referral')),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','signed_up','evaluation','member','lost')),
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
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS leads_status ON leads(status, next_follow_up_at);
CREATE INDEX IF NOT EXISTS leads_email ON leads(email);

-- Pay links: a page a parent opens from an email or text to pay one thing without signing in: a membership payment
-- that didn't go through, an unpaid session, a pack, or a set amount. The link is the token; it expires after 30 days.
CREATE TABLE IF NOT EXISTS pay_links (
  id TEXT PRIMARY KEY,
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
CREATE TABLE IF NOT EXISTS team_roster (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES team_contracts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  athlete_id TEXT,
  position TEXT,
  grad_year INTEGER,
  client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,   -- when the athlete also trains with you privately
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS team_attendance (
  session_id TEXT NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE,
  roster_id TEXT NOT NULL REFERENCES team_roster(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, roster_id)
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
  protocol TEXT,                                 -- version 33: the coach's own "how to run it" (NULL = the built-in text)
  edited TEXT NOT NULL DEFAULT '[]'              -- version 33: fields a coach changed on a built-in test; the library refresh leaves them alone
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
  min_value REAL,                                -- version 33: the coach's possible range (NULL = the built-in range)
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
  athletes TEXT NOT NULL DEFAULT '[]',          -- [{client_id} | {roster_id}] expected on the day
  notes TEXT,
  shared_at TEXT,                               -- results become visible to parents once the coach shares the day
  parent_note TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS perf_results (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES perf_sessions(id) ON DELETE SET NULL,
  client_id TEXT REFERENCES clients(id) ON DELETE CASCADE,
  roster_id TEXT REFERENCES team_roster(id) ON DELETE CASCADE,
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
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS clients_athlete_id ON clients(athlete_id);
CREATE UNIQUE INDEX IF NOT EXISTS roster_athlete_id ON team_roster(athlete_id);
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
  actor_type TEXT NOT NULL,                     -- staff, api_key, parent, public
  actor_id TEXT,
  actor_name TEXT,
  role TEXT,
  action TEXT NOT NULL,                         -- e.g. "PATCH /v1/clients/:id"
  target TEXT,                                  -- the record's ID from the URL
  status INTEGER,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log(at);

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
  quiz TEXT                                     -- JSON [{q, choices, answer}]; pass it to finish the lesson (version 24)
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

-- ---------- Version 33: test library presets and progress report share links (batch B10) ----------
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
