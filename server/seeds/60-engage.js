// Demo accountability, performance and education content.
'use strict';
const { get, all, insert, setSetting } = require('../db');
const { addDays } = require('../lib');
const { todayLocal } = require('../services/booking');
const e = require('../services/engage');

function seed() {
  const T = todayLocal();
  const coach = get("SELECT * FROM staff WHERE role='coach' LIMIT 1") || get('SELECT * FROM staff LIMIT 1');
  const A = (first) => get('SELECT * FROM athletes WHERE first_name=?', first);
  setSetting('rankings_enabled', true);

  // Education: one course and two standalone lessons.
  const course = insert('courses', { title: 'Recovery basics', description: 'Four short lessons on how to recover so every session counts.' });
  const lessons = [
    ['Why sleep is your best supplement', 'Growth, speed and focus all depend on it.', 'Most of your adaptation happens while you sleep. Athletes your age need 8 to 10 hours.\n\nTonight: phone out of the bedroom, lights out at the same time, and a cool, dark room.', 4],
    ['Hydration you can actually follow', 'A simple plan for training days.', 'Drink a full bottle with breakfast, another before training, and sip during.\n\nCheck your color: pale yellow means you are on track.', 3],
    ['Soreness vs. pain', 'When to push and when to tell a coach.', 'Soreness is dull, in the muscle, and eases as you warm up. Pain is sharp, in a joint, or gets worse as you move.\n\nIf it is pain, stop and tell your coach.', 3],
    ['The 10-minute cool-down', 'What to do right after a hard session.', 'Walk for 3 minutes, then hips, calves and upper back for 2 minutes each.\n\nThen eat something with protein within an hour.', 5],
  ].map(([title, summary, body, minutes], ord) => insert('lessons', { title, summary, body, minutes, course_id: course, ord }));
  const fuel = insert('lessons', { title: 'Fuel before a game', summary: 'What to eat 3 hours, 1 hour and 15 minutes out.', body: '3 hours out: a real meal with carbs and protein.\n\n1 hour out: something small and easy, like a banana.\n\n15 minutes out: water only.', minutes: 4 });
  insert('lessons', { title: 'Mindset: next play', summary: 'How great athletes reset after a mistake.', body: 'Name it, let it go, and focus on your next job. Take one breath and pick one cue word.', minutes: 3 });

  const ava = A('Ava'), chidi = A('Chidi'), kevin = A('Kevin'), emma = A('Emma');
  const team = get('SELECT id FROM team_contracts ORDER BY id LIMIT 1');
  if (coach && ava) {
    e.assign({ course_id: course, athlete_id: ava.id, due_date: addDays(T, 7), note: 'Start with sleep. Takes 15 minutes total.' }, coach);
    insert('lesson_progress', { lesson_id: lessons[0], athlete_id: ava.id });
  }
  if (coach && team) e.assign({ lesson_id: fuel, team_id: team.id, due_date: addDays(T, 3) }, coach);

  // Daily check-ins over the last 10 days, a few with red flags.
  const rows = [
    [ava, [8.5, 4, 2, 4, 4], [8, 4, 3, 4, 5], [9, 5, 2, 5, 4], [7.5, 3, 3, 4, 4], [8, 4, 2, 4, 5], [8.5, 4, 2, 5, 5]],
    [chidi, [7, 3, 3, 3, 4], [6.5, 3, 4, 3, 3], [5.5, 2, 4, 2, 3]],
    [kevin, [7, 3, 3, 3, 3], [8, 4, 2, 4, 4]],
    [emma, [9, 5, 1, 5, 5], [8.5, 4, 2, 4, 4], [9, 4, 2, 5, 5]],
  ];
  for (const [a, ...days] of rows) {
    if (!a) continue;
    days.forEach(([sleep_hours, hydration, soreness, energy, mood], i) => {
      insert('checkins', { athlete_id: a.id, date: addDays(T, -(days.length - 1 - i)), sleep_hours, hydration, soreness, energy, mood });
    });
  }

  // Goals, messages and test targets.
  if (coach) {
    if (team) {
      e.createGoal({ team_id: team.id, kind: 'sessions', target: 2, title: 'Make 2 team sessions this week' }, coach.id);
      insert('coach_messages', { team_id: team.id, staff_id: coach.id, body: 'Great energy on Tuesday. Hydrate before Thursday, it will be hot on the field.' });
    }
    if (ava) {
      e.createGoal({ athlete_id: ava.id, kind: 'workouts', target: 3, title: '3 workouts this week' }, coach.id);
      e.createGoal({ athlete_id: ava.id, kind: 'checkins', target: 5, title: 'Check in 5 days' }, coach.id);
      e.createGoal({ athlete_id: ava.id, kind: 'custom', target: 4, title: '10 minutes of mobility' }, coach.id);
      insert('coach_messages', { athlete_id: ava.id, staff_id: coach.id, body: 'Your broad jump is up 5 inches since summer. Keep the landings quiet and we will chase 6 feet 8.' });
      for (const [name, target] of [['Standing broad jump', 80], ['20-yard sprint', 3.35]]) {
        const t = get('SELECT id FROM tests WHERE name=?', name);
        if (t) e.setTarget({ athlete_id: ava.id, test_id: t.id, target, due_date: addDays(T, 60) }, coach.id);
      }
    }
    if (chidi) insert('coach_messages', { athlete_id: chidi.id, staff_id: coach.id, body: 'Saw your check-in: short on sleep this week. Lights out by 10 before Friday.' });
  }
  void all;
}

module.exports = { seed };
