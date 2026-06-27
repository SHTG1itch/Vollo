import { query, queryOne } from './db.ts';
import { notify } from './notifications.ts';
import type { Achievement } from './types.ts';

interface AchievementDef {
  code: string;
  title: string;
  description: string;
  icon: string;
  earned: (s: AchievementSnapshot) => boolean;
}

interface AchievementSnapshot {
  total: number;
  clayWins: number;
  grassWins: number;
  hardWins: number;
  indoorWins: number;
  maxRpe: number;
  hasComeback: boolean;
  streakWeeks: number;
  territoryCount: number;
}

/** The full badge catalogue. Add freely — evaluation is idempotent. */
export const ACHIEVEMENTS: AchievementDef[] = [
  { code: 'first_serve',   title: 'First Serve',     description: 'Logged your first match.',                 icon: '🎾', earned: (s) => s.total >= 1 },
  { code: 'centurion',     title: 'Centurion',       description: 'Logged 100 matches.',                      icon: '💯', earned: (s) => s.total >= 100 },
  { code: 'clay_grinder',  title: 'Clay Grinder',    description: 'Won 10 matches on clay.',                  icon: '🟠', earned: (s) => s.clayWins >= 10 },
  { code: 'grass_server',  title: 'Grass Server',    description: 'Won 10 matches on grass.',                 icon: '🟢', earned: (s) => s.grassWins >= 10 },
  { code: 'hard_hitter',   title: 'Hard Hitter',     description: 'Won 10 matches on hard court.',            icon: '🔵', earned: (s) => s.hardWins >= 10 },
  { code: 'indoor_specialist', title: 'Indoor Specialist', description: 'Won 10 matches indoors.',            icon: '🏟️', earned: (s) => s.indoorWins >= 10 },
  { code: 'comeback_king', title: 'Comeback King',   description: 'Won a match after dropping the first set.', icon: '🔄', earned: (s) => s.hasComeback },
  { code: 'iron_arm',      title: 'Iron Arm',        description: 'Logged a match at maximum exertion (RPE 10).', icon: '💪', earned: (s) => s.maxRpe >= 10 },
  { code: 'on_fire',       title: 'On Fire',         description: 'Held a 4-week activity streak.',           icon: '🔥', earned: (s) => s.streakWeeks >= 4 },
  { code: 'unstoppable',   title: 'Unstoppable',     description: 'Held an 8-week activity streak.',          icon: '⚡', earned: (s) => s.streakWeeks >= 8 },
  { code: 'territory_lord',title: 'Territory Lord',  description: 'Claimed your first territory.',            icon: '🗺️', earned: (s) => s.territoryCount >= 1 },
  { code: 'empire',        title: 'Empire Builder',  description: 'Control 3 or more territories at once.',   icon: '🏰', earned: (s) => s.territoryCount >= 3 },
];

async function snapshot(userId: string): Promise<AchievementSnapshot> {
  const agg = await queryOne<{
    total: string;
    clay_wins: string;
    grass_wins: string;
    hard_wins: string;
    indoor_wins: string;
    max_rpe: number | null;
    has_comeback: boolean;
  }>(
    `SELECT
        COUNT(*)                                                   AS total,
        COUNT(*) FILTER (WHERE surface='clay'   AND result='win')  AS clay_wins,
        COUNT(*) FILTER (WHERE surface='grass'  AND result='win')  AS grass_wins,
        COUNT(*) FILTER (WHERE surface='hard'   AND result='win')  AS hard_wins,
        COUNT(*) FILTER (WHERE surface='indoor' AND result='win')  AS indoor_wins,
        MAX(rpe_index)                                             AS max_rpe,
        bool_or(result='win' AND (score_array->0->>1)::int > (score_array->0->>0)::int) AS has_comeback
       FROM matches WHERE user_id = $1`,
    [userId],
  );
  const streak = await queryOne<{ current_streak_weeks: number }>(
    'SELECT current_streak_weeks FROM user_streaks WHERE user_id = $1',
    [userId],
  );
  const terr = await queryOne<{ c: string }>(
    'SELECT COUNT(*) AS c FROM territories WHERE user_id = $1',
    [userId],
  );

  return {
    total: Number(agg?.total ?? 0),
    clayWins: Number(agg?.clay_wins ?? 0),
    grassWins: Number(agg?.grass_wins ?? 0),
    hardWins: Number(agg?.hard_wins ?? 0),
    indoorWins: Number(agg?.indoor_wins ?? 0),
    maxRpe: agg?.max_rpe ?? 0,
    hasComeback: agg?.has_comeback ?? false,
    streakWeeks: streak?.current_streak_weeks ?? 0,
    territoryCount: Number(terr?.c ?? 0),
  };
}

/**
 * Evaluate the catalogue for a user and award any newly-earned badges.
 * Idempotent: existing badges are skipped via the unique (user_id, code) index.
 * Returns the codes newly awarded this run.
 */
export async function evaluateAchievements(userId: string): Promise<string[]> {
  const s = await snapshot(userId);
  const newlyAwarded: string[] = [];

  for (const def of ACHIEVEMENTS) {
    if (!def.earned(s)) continue;
    const inserted = await queryOne<{ code: string }>(
      `INSERT INTO achievements (user_id, code, title, description, icon)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, code) DO NOTHING
       RETURNING code`,
      [userId, def.code, def.title, def.description, def.icon],
    );
    if (inserted) {
      newlyAwarded.push(def.code);
      await notify({
        userId,
        type: 'achievement',
        title: `${def.icon} Achievement unlocked`,
        body: `${def.title} — ${def.description}`,
        data: { code: def.code },
        push: false,
      }).catch(() => {});
    }
  }
  return newlyAwarded;
}

export async function getAchievements(userId: string): Promise<Achievement[]> {
  return query<Achievement>(
    `SELECT code, title, description, icon, created_at
       FROM achievements WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
}
