import { query, queryOne } from './db.ts';
import type { Surface } from './types.ts';

const pct = (num: number, den: number): number => (den > 0 ? Number(((num / den) * 100).toFixed(1)) : 0);
const ratio = (a: number, b: number): number => (b > 0 ? Number((a / b).toFixed(2)) : a);

export interface SurfaceSplit {
  surface: Surface;
  matches: number;
  wins: number;
  losses: number;
  win_rate: number;
  games_won: number;
  games_lost: number;
}

export interface ProfileAnalytics {
  overall: { matches: number; wins: number; losses: number; win_rate: number };
  by_surface: SurfaceSplit[];
  serve: {
    first_serve_pct: number;
    second_serve_pct: number;
    aces: number;
    double_faults: number;
    break_point_conversion: number;
  };
  strokes: {
    forehand: { winners: number; errors: number; ratio: number };
    backhand: { winners: number; errors: number; ratio: number };
    volley: { winners: number; errors: number; ratio: number };
  };
  rally: { short: number; medium: number; long: number; short_pct: number; medium_pct: number; long_pct: number };
  playstyle: string;
  recent_form: Array<'W' | 'L'>;
  avg_rpe: number;
}

/** The complete multi-dimensional performance profile for a user. */
export async function getProfileAnalytics(userId: string): Promise<ProfileAnalytics> {
  // Analytics only reflect matches that count — pending (unverified) and
  // rejected matches are excluded everywhere below for competitive integrity.
  const overallRow = await queryOne<{ matches: string; wins: string; losses: string; avg_rpe: string | null }>(
    `SELECT COUNT(*) AS matches,
            COUNT(*) FILTER (WHERE result='win')  AS wins,
            COUNT(*) FILTER (WHERE result='loss') AS losses,
            AVG(rpe_index) AS avg_rpe
       FROM matches WHERE user_id = $1 AND verification_status IN ('auto', 'verified')`,
    [userId],
  );

  const surfaceRows = await query<{
    surface: Surface; matches: string; wins: string; losses: string; games_won: string; games_lost: string;
  }>(
    `SELECT surface,
            COUNT(*) AS matches,
            COUNT(*) FILTER (WHERE result='win')  AS wins,
            COUNT(*) FILTER (WHERE result='loss') AS losses,
            COALESCE(SUM(games_won),0)  AS games_won,
            COALESCE(SUM(games_lost),0) AS games_lost
       FROM matches WHERE user_id = $1 AND verification_status IN ('auto', 'verified')
      GROUP BY surface
      ORDER BY surface`,
    [userId],
  );

  const s = await queryOne<Record<string, string | null>>(
    `SELECT
        COALESCE(SUM(ms.first_serve_in),0)     AS fs_in,
        COALESCE(SUM(ms.first_serve_total),0)  AS fs_tot,
        COALESCE(SUM(ms.second_serve_in),0)    AS ss_in,
        COALESCE(SUM(ms.second_serve_total),0) AS ss_tot,
        COALESCE(SUM(ms.aces),0)               AS aces,
        COALESCE(SUM(ms.double_faults),0)      AS df,
        COALESCE(SUM(ms.forehand_winners),0)   AS fh_w,
        COALESCE(SUM(ms.forehand_errors),0)    AS fh_e,
        COALESCE(SUM(ms.backhand_winners),0)   AS bh_w,
        COALESCE(SUM(ms.backhand_errors),0)    AS bh_e,
        COALESCE(SUM(ms.volley_winners),0)     AS v_w,
        COALESCE(SUM(ms.volley_errors),0)      AS v_e,
        COALESCE(SUM(ms.rally_short),0)        AS r_s,
        COALESCE(SUM(ms.rally_medium),0)       AS r_m,
        COALESCE(SUM(ms.rally_long),0)         AS r_l,
        COALESCE(SUM(ms.break_points_won),0)   AS bp_w,
        COALESCE(SUM(ms.break_points_total),0) AS bp_t
       FROM match_stats ms JOIN matches m ON m.id = ms.match_id
      WHERE m.user_id = $1 AND m.verification_status IN ('auto', 'verified')`,
    [userId],
  );
  const n = (k: string): number => Number(s?.[k] ?? 0);

  const recentRows = await query<{ result: 'win' | 'loss' }>(
    `SELECT result FROM matches
      WHERE user_id = $1 AND verification_status IN ('auto', 'verified')
      ORDER BY played_at DESC LIMIT 10`,
    [userId],
  );

  const by_surface: SurfaceSplit[] = surfaceRows.map((r) => ({
    surface: r.surface,
    matches: Number(r.matches),
    wins: Number(r.wins),
    losses: Number(r.losses),
    win_rate: pct(Number(r.wins), Number(r.matches)),
    games_won: Number(r.games_won),
    games_lost: Number(r.games_lost),
  }));

  const rallyTotal = n('r_s') + n('r_m') + n('r_l');

  return {
    overall: {
      matches: Number(overallRow?.matches ?? 0),
      wins: Number(overallRow?.wins ?? 0),
      losses: Number(overallRow?.losses ?? 0),
      win_rate: pct(Number(overallRow?.wins ?? 0), Number(overallRow?.matches ?? 0)),
    },
    by_surface,
    serve: {
      first_serve_pct: pct(n('fs_in'), n('fs_tot')),
      second_serve_pct: pct(n('ss_in'), n('ss_tot')),
      aces: n('aces'),
      double_faults: n('df'),
      break_point_conversion: pct(n('bp_w'), n('bp_t')),
    },
    strokes: {
      forehand: { winners: n('fh_w'), errors: n('fh_e'), ratio: ratio(n('fh_w'), n('fh_e')) },
      backhand: { winners: n('bh_w'), errors: n('bh_e'), ratio: ratio(n('bh_w'), n('bh_e')) },
      volley: { winners: n('v_w'), errors: n('v_e'), ratio: ratio(n('v_w'), n('v_e')) },
    },
    rally: {
      short: n('r_s'),
      medium: n('r_m'),
      long: n('r_l'),
      short_pct: pct(n('r_s'), rallyTotal),
      medium_pct: pct(n('r_m'), rallyTotal),
      long_pct: pct(n('r_l'), rallyTotal),
    },
    playstyle: derivePlaystyle(by_surface, { short: n('r_s'), medium: n('r_m'), long: n('r_l') }),
    recent_form: recentRows.map((r) => (r.result === 'win' ? 'W' : 'L')),
    avg_rpe: Number(Number(overallRow?.avg_rpe ?? 0).toFixed(1)),
  };
}

/**
 * Label the player's identity from their strongest surface and rally tendency,
 * e.g. Clay Court Grinder vs Fast Grass Server.
 */
export function derivePlaystyle(
  surfaces: SurfaceSplit[],
  rally: { short: number; medium: number; long: number },
): string {
  const ranked = surfaces.filter((s) => s.matches >= 3).sort((a, b) => b.win_rate - a.win_rate);
  const best = ranked[0];
  const rallyTotal = rally.short + rally.medium + rally.long;

  const surfaceLabel: Record<Surface, string> = {
    clay: 'Clay Court Grinder',
    grass: 'Grass Court Server',
    hard: 'Hard Court Specialist',
    indoor: 'Indoor Tactician',
  };

  if (!best) return 'Developing Player';

  if (rallyTotal >= 10) {
    const longShare = rally.long / rallyTotal;
    const shortShare = rally.short / rallyTotal;
    if (best.surface === 'clay' && longShare > 0.35) return 'Clay Court Grinder';
    if (shortShare > 0.5) return `Aggressive ${surfaceLabel[best.surface].split(' ').slice(-1)[0]}`;
  }
  return surfaceLabel[best.surface];
}

export interface HeadToHead {
  opponent_id: string | null;
  opponent_name: string;
  matches: number;
  wins: number;
  losses: number;
}

/** Head-to-head records against every opponent the user has faced. Registered
 * opponents retain their own privacy/block boundary when a third party views
 * this profile; the owner can always see their complete record. */
export async function getHeadToHead(userId: string, viewerId: string | null): Promise<HeadToHead[]> {
  const rows = await query<{
    opponent_id: string | null;
    opponent_name: string;
    matches: string;
    wins: string;
    losses: string;
  }>(
    `SELECT opponent_id,
            concat_ws(' & ',
              COALESCE(o.display_name, m.opponent_name, 'Unknown'),
              CASE WHEN m.match_format = 'doubles'
                   THEN COALESCE(o2.display_name, m.opponent2_name, 'Unknown') END
            ) AS opponent_name,
            COUNT(*) AS matches,
            COUNT(*) FILTER (WHERE result='win')  AS wins,
            COUNT(*) FILTER (WHERE result='loss') AS losses
       FROM matches m
       LEFT JOIN users o ON o.id = m.opponent_id
       LEFT JOIN users o2 ON o2.id = m.opponent2_id
      WHERE m.user_id = $1
        AND m.verification_status IN ('auto', 'verified')
        AND (m.opponent_id IS NOT NULL OR m.opponent_name IS NOT NULL)
        AND (
          m.opponent_id IS NULL OR m.user_id = $2
          OR (
            NOT EXISTS (
              SELECT 1 FROM blocks b
               WHERE (b.blocker_id = $2 AND b.blocked_id = m.opponent_id)
                  OR (b.blocker_id = m.opponent_id AND b.blocked_id = $2)
            )
            AND (
              NOT o.is_private
              OR EXISTS (
                SELECT 1 FROM follows f
                 WHERE f.follower_id = $2 AND f.following_id = m.opponent_id
              )
            )
          )
        )
        AND (
          m.opponent2_id IS NULL OR m.user_id = $2
          OR (
            NOT EXISTS (
              SELECT 1 FROM blocks b
               WHERE (b.blocker_id = $2 AND b.blocked_id = m.opponent2_id)
                  OR (b.blocker_id = m.opponent2_id AND b.blocked_id = $2)
            )
            AND (
              NOT o2.is_private
              OR EXISTS (
                SELECT 1 FROM follows f
                 WHERE f.follower_id = $2 AND f.following_id = m.opponent2_id
              )
            )
          )
        )
      GROUP BY opponent_id, opponent2_id,
               concat_ws(' & ', COALESCE(o.display_name, m.opponent_name, 'Unknown'),
                 CASE WHEN m.match_format = 'doubles'
                      THEN COALESCE(o2.display_name, m.opponent2_name, 'Unknown') END)
      ORDER BY matches DESC`,
    [userId, viewerId],
  );
  return rows.map((r) => ({
    opponent_id: r.opponent_id,
    opponent_name: r.opponent_name,
    matches: Number(r.matches),
    wins: Number(r.wins),
    losses: Number(r.losses),
  }));
}
