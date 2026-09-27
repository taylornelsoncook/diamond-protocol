// Every coach screen module. Each exports routes: [{ path, nav, title, roles?, render(ctx) }].
import * as today from './today.js';
import * as schedule from './schedule.js';
import * as pos from './pos.js';
import * as clients from './clients.js';
import * as crm from './crm.js';
import * as teams from './teams.js';
import * as billing from './billing.js';
import * as testing from './testing.js';
import * as programs from './programs.js';
import * as education from './education.js';
import * as integrations from './integrations.js';
import * as staff from './staff.js';
export const screens = [today, schedule, pos, clients, crm, teams, billing, testing, programs, education, integrations, staff];
