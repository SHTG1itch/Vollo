import { pool, closePool, query } from './pool.js';
import { hashPassword } from '../utils/auth.js';
import { analyzeScore, matchScore } from '../services/scoring.js';
import { applyMatchToRatings } from '../services/rating.js';
import { recomputeUserStreak, getStreakModifier } from '../services/streak.js';
import { recomputeUserTerritories } from '../services/territory.js';
import { evaluateAchievements } from '../services/achievements.js';
import type { ScoreArray, Surface } from '../types/index.js';

const DAY = 24 * 60 * 60 * 1000;
const isoDaysAgo = (d: number): string => new Date(Date.now() - d * DAY).toISOString();

// ─── Demo cast ─────────────────────────────────────────────────────────────
const USERS = [
  { username: 'srivats', email: 'srivats@vollo.app', display: 'Srivats I.', bio: 'Living on the baseline. NYC.' },
  { username: 'maria',   email: 'maria@vollo.app',   display: 'Maria K.',   bio: 'Clay is home. Brooklyn.' },
  { username: 'alex',    email: 'alex@vollo.app',    display: 'Alex R.',    bio: 'Big serve, bigger ego.' },
  { username: 'jordan',  email: 'jordan@vollo.app',  display: 'Jordan P.',  bio: 'Grinder. Never misses.' },
  { username: 'sam',     email: 'sam@vollo.app',     display: 'Sam T.',     bio: 'Doubles specialist gone solo.' },
] as const;

// Real NYC-area courts, all within ~15km so clusters can form.
const COURTS = [
  { key: 'central',   name: 'Central Park Tennis Center', surface: 'hard',   lat: 40.7896, lng: -73.9618, city: 'New York' },
  { key: 'riverside', name: 'Riverside Clay Courts',      surface: 'clay',   lat: 40.8030, lng: -73.9722, city: 'New York' },
  { key: 'randalls',  name: "Randall's Island Courts",    surface: 'hard',   lat: 40.7930, lng: -73.9220, city: 'New York' },
  { key: 'sutton',    name: 'Sutton East Tennis Club',    surface: 'indoor', lat: 40.7570, lng: -73.9610, city: 'New York' },
  { key: 'watkins',   name: 'Brian Watkins Courts',       surface: 'hard',   lat: 40.7138, lng: -73.9776, city: 'New York' },
  { key: 'mccarren',  name: 'McCarren Park Courts',       surface: 'hard',   lat: 40.7215, lng: -73.9510, city: 'Brooklyn' },
  { key: 'prospect',  name: 'Prospect Park Tennis',       surface: 'hard',   lat: 40.6552, lng: -73.9690, city: 'Brooklyn' },
] as const;

type CourtKey = (typeof COURTS)[number]['key'];

interface MatchSpec {
  user: string;
  opponent?: string;
  opponentName?: string;
  court: CourtKey;
  surface: Surface;
  score: ScoreArray;
  daysAgo: number;
  rpe: number;
}

// Srivats plays across the Manhattan cluster every week (5-week streak) and
// wins enough at central/riverside/randalls/sutton to claim a territory.
const MATCHES: MatchSpec[] = [
  { user: 'srivats', opponent: 'alex',   court: 'central',   surface: 'hard',   score: [[6, 3], [6, 4]],          daysAgo: 2,  rpe: 7 },
  { user: 'srivats', opponent: 'maria',  court: 'riverside', surface: 'clay',   score: [[6, 4], [3, 6], [7, 5]],  daysAgo: 5,  rpe: 9 },
  { user: 'srivats', opponent: 'jordan', court: 'randalls',  surface: 'hard',   score: [[6, 2], [6, 1]],          daysAgo: 9,  rpe: 6 },
  { user: 'srivats', opponent: 'sam',    court: 'sutton',    surface: 'indoor', score: [[7, 6], [6, 4]],          daysAgo: 12, rpe: 8 },
  { user: 'srivats', opponent: 'alex',   court: 'central',   surface: 'hard',   score: [[6, 4], [6, 4]],          daysAgo: 16, rpe: 7 },
  { user: 'srivats', opponent: 'jordan', court: 'riverside', surface: 'clay',   score: [[4, 6], [6, 3], [6, 2]],  daysAgo: 19, rpe: 9 },
  { user: 'srivats', opponent: 'maria',  court: 'randalls',  surface: 'hard',   score: [[6, 7], [4, 6]],          daysAgo: 23, rpe: 10 },
  { user: 'srivats', opponent: 'sam',    court: 'sutton',    surface: 'indoor', score: [[6, 2], [6, 3]],          daysAgo: 26, rpe: 6 },
  { user: 'srivats', opponent: 'alex',   court: 'central',   surface: 'hard',   score: [[6, 1], [6, 0]],          daysAgo: 30, rpe: 5 },
  { user: 'srivats', opponent: 'jordan', court: 'randalls',  surface: 'hard',   score: [[7, 5], [6, 4]],          daysAgo: 33, rpe: 8 },

  // Maria rules Brooklyn clay & Prospect Park.
  { user: 'maria',   opponent: 'jordan', court: 'prospect',  surface: 'hard',   score: [[6, 1], [6, 2]],          daysAgo: 3,  rpe: 6 },
  { user: 'maria',   opponent: 'sam',    court: 'riverside', surface: 'clay',   score: [[6, 0], [6, 1]],          daysAgo: 8,  rpe: 7 },
  { user: 'maria',   opponent: 'alex',   court: 'mccarren',  surface: 'hard',   score: [[6, 4], [7, 5]],          daysAgo: 11, rpe: 8 },
  { user: 'maria',   opponent: 'srivats',court: 'prospect',  surface: 'hard',   score: [[7, 6], [6, 4]],          daysAgo: 18, rpe: 9 },
  { user: 'maria',   opponent: 'jordan', court: 'prospect',  surface: 'hard',   score: [[6, 3], [6, 3]],          daysAgo: 25, rpe: 6 },

  // Supporting cast for richer leaderboards.
  { user: 'alex',    opponent: 'sam',    court: 'central',   surface: 'hard',   score: [[6, 4], [6, 4]],          daysAgo: 4,  rpe: 7 },
  { user: 'alex',    opponent: 'jordan', court: 'watkins',   surface: 'hard',   score: [[6, 7], [6, 3], [6, 4]],  daysAgo: 10, rpe: 9 },
  { user: 'jordan',  opponent: 'sam',    court: 'mccarren',  surface: 'hard',   score: [[6, 2], [6, 3]],          daysAgo: 6,  rpe: 6 },
  { user: 'jordan',  opponent: 'alex',   court: 'watkins',   surface: 'hard',   score: [[6, 4], [4, 6], [7, 6]],  daysAgo: 14, rpe: 10 },
  { user: 'sam',     opponent: 'srivats',court: 'sutton',    surface: 'indoor', score: [[4, 6], [3, 6]],          daysAgo: 7,  rpe: 7 },
];

function genStats(score: ScoreArray, isWinner: boolean): Record<string, number> {
  const games = score.reduce((s, [a, b]) => s + a + b, 0);
  const serves = games * 4;
  const w = isWinner ? 1.4 : 0.8;
  const r = (n: number) => Math.max(0, Math.round(n));
  return {
    first_serve_in: r(serves * 0.62),
    first_serve_total: serves,
    second_serve_in: r(serves * 0.3),
    second_serve_total: r(serves * 0.38),
    aces: r(games * 0.3 * w),
    double_faults: r(games * 0.15 / w),
    forehand_winners: r(games * 0.6 * w),
    forehand_errors: r(games * 0.5 / w),
    backhand_winners: r(games * 0.4 * w),
    backhand_errors: r(games * 0.5 / w),
    volley_winners: r(games * 0.2 * w),
    volley_errors: r(games * 0.15 / w),
    rally_short: r(games * 1.5),
    rally_medium: r(games * 1.0),
    rally_long: r(games * 0.6),
    break_points_won: r(games * 0.2 * w),
    break_points_total: r(games * 0.4),
  };
}

async function seed(): Promise<void> {
  console.log('[seed] truncating…');
  await query(
    `TRUNCATE users, courts, matches, match_stats, kudos, comments, follows,
              user_streaks, territories, user_ratings, achievements,
              notifications, push_tokens RESTART IDENTITY CASCADE`,
  );

  // Users
  const passwordHash = await hashPassword('volley123');
  const userId = new Map<string, string>();
  for (const u of USERS) {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (username, email, password_hash, display_name, bio,
                          home_geom, home_label)
       VALUES ($1, $2, $3, $4, $5, ST_SetSRID(ST_MakePoint(-73.9712, 40.7831), 4326), 'Manhattan, NY')
       RETURNING id`,
      [u.username, u.email, passwordHash, u.display, u.bio],
    );
    userId.set(u.username, rows[0]!.id);
    await query('INSERT INTO user_streaks (user_id) VALUES ($1)', [rows[0]!.id]);
  }
  console.log(`[seed] ${USERS.length} users`);

  // Courts
  const courtId = new Map<string, string>();
  for (const c of COURTS) {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO courts (name, surface, geom, city, created_by)
       VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326), $5, $6)
       RETURNING id`,
      [c.name, c.surface, c.lng, c.lat, c.city, userId.get('srivats')],
    );
    courtId.set(c.key, rows[0]!.id);
  }
  console.log(`[seed] ${COURTS.length} courts`);

  // Matches — insert chronologically so Elo evolves naturally.
  const ordered = [...MATCHES].sort((a, b) => b.daysAgo - a.daysAgo);
  const matchIds: string[] = [];
  for (const m of ordered) {
    const a = analyzeScore(m.score);
    const uid = userId.get(m.user)!;
    const oppId = m.opponent ? userId.get(m.opponent) ?? null : null;
    const playedAt = isoDaysAgo(m.daysAgo);

    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO matches
         (user_id, opponent_id, opponent_name, court_id, surface, score_array, result,
          sets_won, sets_lost, games_won, games_lost, match_score, streak_modifier,
          rpe_index, played_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,0,1,$12,$13)
       RETURNING id`,
      [uid, oppId, m.opponent ? null : m.opponentName ?? null, courtId.get(m.court), m.surface,
       JSON.stringify(m.score), a.result, a.setsWon, a.setsLost, a.gamesWon, a.gamesLost, m.rpe, playedAt],
    );
    const id = rows[0]!.id;
    matchIds.push(id);

    const s = genStats(m.score, a.result === 'win');
    const keys = Object.keys(s);
    await pool.query(
      `INSERT INTO match_stats (match_id, ${keys.join(', ')})
       VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(', ')})`,
      [id, ...keys.map((k) => s[k])],
    );

    await applyMatchToRatings(pool, {
      userId: uid,
      opponentId: oppId,
      surface: m.surface,
      result: a.result,
      gamesWon: a.gamesWon,
      gamesLost: a.gamesLost,
    });
  }
  console.log(`[seed] ${ordered.length} matches + stats + ratings`);

  // Streaks → then apply each user's modifier to their match scores.
  for (const id of userId.values()) await recomputeUserStreak(id);
  await query(
    `UPDATE matches m
        SET streak_modifier = us.streak_modifier,
            match_score = ROUND((m.games_won - m.games_lost) * us.streak_modifier, 2)
       FROM user_streaks us
      WHERE us.user_id = m.user_id`,
  );
  console.log('[seed] streaks + match scores');

  // Territories + achievements (now that leaderboards are populated).
  for (const id of userId.values()) {
    await recomputeUserTerritories(id);
    await evaluateAchievements(id);
  }

  // A little social activity.
  const srivats = userId.get('srivats')!;
  const maria = userId.get('maria')!;
  await query('INSERT INTO follows (follower_id, following_id) VALUES ($1,$2),($2,$1) ON CONFLICT DO NOTHING', [srivats, maria]);
  for (const id of matchIds.slice(0, 6)) {
    await query('INSERT INTO kudos (match_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, maria]);
  }

  const terr = await query<{ c: string }>('SELECT COUNT(*) AS c FROM territories');
  console.log(`[seed] done — ${terr[0]!.c} territories generated`);
  console.log('[seed] login with username "srivats" / password "volley123"');
}

seed()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    closePool().finally(() => process.exit(1));
  });
