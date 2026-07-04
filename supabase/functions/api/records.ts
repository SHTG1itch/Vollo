// Personal records ("trophy case") — a player's all-time bests, computed on
// read from counted matches only (auto/verified), so verification flips and
// deletes never leave a stale record behind.
import { query, queryOne } from './db.ts';
import { toIso } from './mappers.ts';
import type { ScoreArray, Surface } from './types.ts';

export interface PersonalRecords {
  total_matches: number;
  first_match_at: string | null;
  longest_win_streak: { count: number; started_at: string; ended_at: string } | null;
  peak_rating: { surface: Surface; rating: number } | null;
  biggest_win: { match_id: string; score_array: ScoreArray; margin: number; played_at: string } | null;
  most_aces: { match_id: string; aces: number; played_at: string } | null;
  longest_match: { match_id: string; duration_minutes: number; played_at: string } | null;
  busiest_month: { month: string; matches: number } | null;
  comeback_wins: number;
}

const COUNTED = `verification_status IN ('auto','verified')`;

export async function getPersonalRecords(userId: string): Promise<PersonalRecords> {
  const totals = await queryOne<{ total: string; first_at: unknown }>(
    `SELECT COUNT(*) AS total, MIN(played_at) AS first_at
       FROM matches WHERE user_id = $1 AND ${COUNTED}`,
    [userId],
  );

  // Gaps-and-islands: consecutive wins in played_at order form one group.
  const streak = await queryOne<{ len: string; started_at: unknown; ended_at: unknown }>(
    `SELECT COUNT(*) AS len, MIN(played_at) AS started_at, MAX(played_at) AS ended_at
       FROM (
         SELECT played_at, result,
                ROW_NUMBER() OVER (ORDER BY played_at, id)
              - ROW_NUMBER() OVER (PARTITION BY result ORDER BY played_at, id) AS grp
           FROM matches WHERE user_id = $1 AND ${COUNTED}
       ) t
      WHERE result = 'win'
      GROUP BY grp
      ORDER BY len DESC, started_at ASC
      LIMIT 1`,
    [userId],
  );

  const peak = await queryOne<{ surface: Surface; peak_rating: string }>(
    `SELECT surface, peak_rating FROM user_ratings
      WHERE user_id = $1 AND matches_played > 0
      ORDER BY peak_rating DESC LIMIT 1`,
    [userId],
  );

  const biggestWin = await queryOne<{ id: string; score_array: ScoreArray; margin: string; played_at: unknown }>(
    `SELECT id, score_array, games_won - games_lost AS margin, played_at
       FROM matches
      WHERE user_id = $1 AND ${COUNTED} AND result = 'win'
      ORDER BY games_won - games_lost DESC, played_at ASC
      LIMIT 1`,
    [userId],
  );

  const mostAces = await queryOne<{ id: string; aces: string; played_at: unknown }>(
    `SELECT m.id, s.aces, m.played_at
       FROM matches m JOIN match_stats s ON s.match_id = m.id
      WHERE m.user_id = $1 AND m.${COUNTED} AND s.aces > 0
      ORDER BY s.aces DESC, m.played_at ASC
      LIMIT 1`,
    [userId],
  );

  const longestMatch = await queryOne<{ id: string; duration_minutes: string; played_at: unknown }>(
    `SELECT id, duration_minutes, played_at
       FROM matches
      WHERE user_id = $1 AND ${COUNTED} AND duration_minutes IS NOT NULL
      ORDER BY duration_minutes DESC, played_at ASC
      LIMIT 1`,
    [userId],
  );

  const busiestMonth = await queryOne<{ month: string; matches: string }>(
    `SELECT to_char(date_trunc('month', played_at), 'YYYY-MM') AS month, COUNT(*) AS matches
       FROM matches WHERE user_id = $1 AND ${COUNTED}
      GROUP BY 1 ORDER BY COUNT(*) DESC, 1 DESC LIMIT 1`,
    [userId],
  );

  // A comeback: won the match after dropping the first set.
  const comebacks = await query<{ c: string }>(
    `SELECT COUNT(*) AS c
       FROM matches
      WHERE user_id = $1 AND ${COUNTED} AND result = 'win'
        AND (score_array->0->>0)::int < (score_array->0->>1)::int`,
    [userId],
  );

  return {
    total_matches: Number(totals?.total ?? 0),
    first_match_at: totals?.first_at ? toIso(totals.first_at) : null,
    longest_win_streak: streak
      ? { count: Number(streak.len), started_at: toIso(streak.started_at), ended_at: toIso(streak.ended_at) }
      : null,
    peak_rating: peak ? { surface: peak.surface, rating: Number(peak.peak_rating) } : null,
    biggest_win: biggestWin
      ? {
          match_id: biggestWin.id,
          score_array: biggestWin.score_array,
          margin: Number(biggestWin.margin),
          played_at: toIso(biggestWin.played_at),
        }
      : null,
    most_aces: mostAces
      ? { match_id: mostAces.id, aces: Number(mostAces.aces), played_at: toIso(mostAces.played_at) }
      : null,
    longest_match: longestMatch
      ? {
          match_id: longestMatch.id,
          duration_minutes: Number(longestMatch.duration_minutes),
          played_at: toIso(longestMatch.played_at),
        }
      : null,
    busiest_month: busiestMonth
      ? { month: busiestMonth.month, matches: Number(busiestMonth.matches) }
      : null,
    comeback_wins: Number(comebacks[0]?.c ?? 0),
  };
}
