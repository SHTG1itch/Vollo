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

export interface YearInReview {
  year: number;
  totals: {
    matches: number;
    wins: number;
    losses: number;
    minutes: number;
    games_won: number;
    aces: number;
    kudos_received: number;
  };
  monthly: { month: number; matches: number; wins: number }[];
  top_opponent: { name: string; matches: number; wins: number; losses: number } | null;
  favorite_court: { court_id: string; name: string; matches: number } | null;
  favorite_surface: { surface: Surface; matches: number; win_rate: number } | null;
  longest_win_streak: number;
}

/**
 * A player's season recap (the Strava "Year in Sport" analog). Same
 * counted-only rule as everything else; the year boundary is the viewer's
 * local time via tzOffset (minutes behind UTC).
 */
export async function getYearInReview(userId: string, year: number, tzOffset: number): Promise<YearInReview> {
  // All queries share the same local-time year window.
  const WIN = `m.user_id = $1 AND m.${COUNTED}
    AND m.played_at - make_interval(mins => $3) >= make_date($2, 1, 1)::timestamp
    AND m.played_at - make_interval(mins => $3) <  make_date($2 + 1, 1, 1)::timestamp`;
  const params = [userId, year, tzOffset];

  const totals = await queryOne<{
    matches: string; wins: string; minutes: string; games_won: string;
  }>(
    `SELECT COUNT(*) AS matches,
            COUNT(*) FILTER (WHERE m.result = 'win') AS wins,
            COALESCE(SUM(m.duration_minutes), 0) AS minutes,
            COALESCE(SUM(m.games_won), 0) AS games_won
       FROM matches m WHERE ${WIN}`,
    params,
  );

  const aces = await queryOne<{ aces: string }>(
    `SELECT COALESCE(SUM(s.aces), 0) AS aces
       FROM matches m JOIN match_stats s ON s.match_id = m.id
      WHERE ${WIN}`,
    params,
  );

  const kudos = await queryOne<{ c: string }>(
    `SELECT COUNT(*) AS c
       FROM kudos k JOIN matches m ON m.id = k.match_id
      WHERE ${WIN}`,
    params,
  );

  const monthlyRows = await query<{ month: string; matches: string; wins: string }>(
    `SELECT EXTRACT(MONTH FROM m.played_at - make_interval(mins => $3))::int AS month,
            COUNT(*) AS matches,
            COUNT(*) FILTER (WHERE m.result = 'win') AS wins
       FROM matches m WHERE ${WIN}
      GROUP BY 1 ORDER BY 1`,
    params,
  );
  const byMonth = new Map(monthlyRows.map((r) => [Number(r.month), r]));
  const monthly = Array.from({ length: 12 }, (_, i) => {
    const r = byMonth.get(i + 1);
    return { month: i + 1, matches: Number(r?.matches ?? 0), wins: Number(r?.wins ?? 0) };
  });

  const topOpponent = await queryOne<{ name: string; matches: string; wins: string; losses: string }>(
    `SELECT COALESCE(ou.display_name, m.opponent_name) AS name,
            COUNT(*) AS matches,
            COUNT(*) FILTER (WHERE m.result = 'win') AS wins,
            COUNT(*) FILTER (WHERE m.result = 'loss') AS losses
       FROM matches m LEFT JOIN users ou ON ou.id = m.opponent_id
      WHERE ${WIN} AND COALESCE(ou.display_name, m.opponent_name) IS NOT NULL
      GROUP BY 1 ORDER BY COUNT(*) DESC, 1 ASC LIMIT 1`,
    params,
  );

  const favoriteCourt = await queryOne<{ court_id: string; name: string; matches: string }>(
    `SELECT c.id AS court_id, c.name, COUNT(*) AS matches
       FROM matches m JOIN courts c ON c.id = m.court_id
      WHERE ${WIN}
      GROUP BY c.id, c.name ORDER BY COUNT(*) DESC, c.name ASC LIMIT 1`,
    params,
  );

  const favoriteSurface = await queryOne<{ surface: Surface; matches: string; win_rate: string }>(
    `SELECT m.surface, COUNT(*) AS matches,
            ROUND(100.0 * COUNT(*) FILTER (WHERE m.result = 'win') / COUNT(*)) AS win_rate
       FROM matches m WHERE ${WIN}
      GROUP BY m.surface ORDER BY COUNT(*) DESC LIMIT 1`,
    params,
  );

  const streak = await queryOne<{ len: string }>(
    `SELECT COUNT(*) AS len
       FROM (
         SELECT m.result,
                ROW_NUMBER() OVER (ORDER BY m.played_at, m.id)
              - ROW_NUMBER() OVER (PARTITION BY m.result ORDER BY m.played_at, m.id) AS grp
           FROM matches m WHERE ${WIN}
       ) t
      WHERE result = 'win'
      GROUP BY grp ORDER BY len DESC LIMIT 1`,
    params,
  );

  const matches = Number(totals?.matches ?? 0);
  const wins = Number(totals?.wins ?? 0);
  return {
    year,
    totals: {
      matches,
      wins,
      losses: matches - wins,
      minutes: Number(totals?.minutes ?? 0),
      games_won: Number(totals?.games_won ?? 0),
      aces: Number(aces?.aces ?? 0),
      kudos_received: Number(kudos?.c ?? 0),
    },
    monthly,
    top_opponent: topOpponent
      ? {
          name: topOpponent.name,
          matches: Number(topOpponent.matches),
          wins: Number(topOpponent.wins),
          losses: Number(topOpponent.losses),
        }
      : null,
    favorite_court: favoriteCourt
      ? { court_id: favoriteCourt.court_id, name: favoriteCourt.name, matches: Number(favoriteCourt.matches) }
      : null,
    favorite_surface: favoriteSurface
      ? {
          surface: favoriteSurface.surface,
          matches: Number(favoriteSurface.matches),
          win_rate: Number(favoriteSurface.win_rate),
        }
      : null,
    longest_win_streak: Number(streak?.len ?? 0),
  };
}

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
