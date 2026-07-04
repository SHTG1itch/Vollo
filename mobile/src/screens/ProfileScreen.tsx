import React, { useEffect, useState } from 'react';
import { Alert, Image, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { api } from '../api/client';
import { useAuth } from '../store/auth';
import { Avatar, Button, Card, ErrorState, Loading, Muted, Stat } from '../components/ui';
import { CountUp } from '../components/CountUp';
import { showToast } from '../components/Toast';
import { tapMedium } from '../lib/haptics';
import { FormDots, ProgressBar, RallyDistribution, SplitBar } from '../components/charts';
import { SurfaceBadge } from '../components/SurfaceBadge';
import { colors, font, fonts, radius, spacing, surfaceColors } from '../theme';
import { goalCaption, goalTitle } from './GoalsScreen';
import type {
  Achievement,
  Goal,
  HeadToHead,
  MatchCard,
  ProfileAnalytics,
  ProfileResponse,
  StreakState,
  Surface,
  SurfaceRating,
  Territory,
} from '../types';
import { formatScoreLine, timeAgo } from '../utils/format';

const HEX6 = /^#[0-9A-Fa-f]{6}$/;

type Nav = NativeStackNavigationProp<RootStackParamList>;

export function ProfileView({ username, isSelf }: { username: string; isSelf: boolean }) {
  const navigation = useNavigation<Nav>();

  const [goals, setGoals] = useState<Goal[]>([]);
  const [profile, setProfile] = useState<ProfileResponse | null>(null);
  const [analytics, setAnalytics] = useState<ProfileAnalytics | null>(null);
  const [ratings, setRatings] = useState<SurfaceRating[]>([]);
  const [achievements, setAchievements] = useState<Achievement[]>([]);
  const [streak, setStreak] = useState<StreakState | null>(null);
  const [territories, setTerritories] = useState<Territory[]>([]);
  const [h2h, setH2h] = useState<HeadToHead[]>([]);
  const [recent, setRecent] = useState<MatchCard[]>([]);
  const [following, setFollowing] = useState(false);
  const [followLoading, setFollowLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    if (!profile) setLoading(true); // a pull-to-refresh keeps the screen, not a full loader
    setError(null);
    void (async () => {
      try {
        const prof = await api.getProfile(username);
        if (!active) return;
        setProfile(prof);
        setFollowing(prof.viewer_is_following);

        // A private profile we don't follow (or one we've blocked) exposes no
        // content — don't fire the section requests that would all 403.
        if (prof.restricted || prof.viewer_has_blocked) {
          setAnalytics(null);
          setRatings([]);
          setAchievements([]);
          setStreak(null);
          setTerritories([]);
          setH2h([]);
          setRecent([]);
          return;
        }

        const [a, r, ach, st, terr, hh, feed, gl] = await Promise.allSettled([
          api.getAnalytics(username),
          api.getRatings(username),
          api.getAchievements(username),
          api.getStreak(username),
          api.getUserTerritories(prof.user.id),
          api.getHeadToHead(username),
          api.getUserFeed(prof.user.id, { limit: 5 }),
          // Goals are personal — only the owner sees (or has) them.
          isSelf ? api.getGoals() : Promise.resolve({ goals: [] as Goal[] }),
        ]);
        if (!active) return;
        if (gl.status === 'fulfilled') setGoals(gl.value.goals);
        if (a.status === 'fulfilled') setAnalytics(a.value.analytics);
        if (r.status === 'fulfilled') setRatings(r.value.ratings);
        if (ach.status === 'fulfilled') setAchievements(ach.value.achievements);
        if (st.status === 'fulfilled') setStreak(st.value.streak);
        if (terr.status === 'fulfilled') setTerritories(terr.value.territories);
        if (hh.status === 'fulfilled') setH2h(hh.value.head_to_head);
        if (feed.status === 'fulfilled') setRecent(feed.value.matches);
      } catch (e) {
        // getProfile failed — distinguish a transient network error from a 404.
        if (active) setError(e instanceof Error ? e.message : 'Failed to load profile');
      } finally {
        if (active) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username, reloadKey]);

  const onRefresh = () => {
    setRefreshing(true);
    setReloadKey((k) => k + 1);
  };

  const adjustFollowerCount = (delta: number) =>
    setProfile((p) =>
      p ? { ...p, stats: { ...p.stats, follower_count: Math.max(0, p.stats.follower_count + delta) } } : p,
    );

  const toggleFollow = async () => {
    if (!profile || followLoading) return;
    tapMedium();
    const was = following;
    // Optimistically flip the button AND the follower count, revert both on error.
    setFollowing(!was);
    adjustFollowerCount(was ? -1 : 1);
    setFollowLoading(true);
    try {
      if (was) await api.unfollow(username);
      else await api.follow(username);
      // (Un)following a private account gains/loses content access — refetch.
      if (profile.user.is_private) setReloadKey((k) => k + 1);
    } catch {
      setFollowing(was);
      adjustFollowerCount(was ? 1 : -1);
      showToast('Could not update — please try again.', 'error');
    } finally {
      setFollowLoading(false);
    }
  };

  const [blockLoading, setBlockLoading] = useState(false);
  const setBlockedState = (next: boolean) => {
    setProfile((p) => (p ? { ...p, viewer_has_blocked: next } : p));
    setBlockLoading(false);
    setReloadKey((k) => k + 1);
  };
  const confirmBlock = () => {
    if (!profile) return;
    Alert.alert(
      `Block @${profile.user.username}?`,
      "You won't see each other's matches, profiles or comments, and any follows between you are removed.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Block',
          style: 'destructive',
          onPress: async () => {
            setBlockLoading(true);
            try {
              await api.blockUser(username);
              setFollowing(false);
              setBlockedState(true);
              showToast(`Blocked @${profile.user.username}`, 'success');
            } catch {
              setBlockLoading(false);
              showToast('Could not block — please try again.', 'error');
            }
          },
        },
      ],
    );
  };
  const unblock = async () => {
    if (!profile || blockLoading) return;
    setBlockLoading(true);
    try {
      await api.unblockUser(username);
      setBlockedState(false);
      showToast(`Unblocked @${profile.user.username}`, 'success');
    } catch {
      setBlockLoading(false);
      showToast('Could not unblock — please try again.', 'error');
    }
  };

  if (loading) return <Loading />;
  if (error && !profile)
    return <ErrorState message={error} onRetry={() => setReloadKey((k) => k + 1)} />;
  if (!profile) return <Muted style={{ padding: spacing.xl }}>Profile not found.</Muted>;

  // No matches yet → no rating to average; show "—" rather than a fake 1000.
  const avgRating =
    ratings.length > 0 ? Math.round(ratings.reduce((s, r) => s + r.rating, 0) / ratings.length) : null;

  // Public gear loadout (what this player uses).
  const eq = profile.user.equipment ?? {};
  const gear = [
    eq.racquet ? { icon: '🎾', label: 'Racquet', value: eq.racquet } : null,
    eq.strings || eq.string_tension
      ? { icon: '🧵', label: 'Strings', value: [eq.strings, eq.string_tension].filter(Boolean).join(' · ') }
      : null,
    eq.shoes ? { icon: '👟', label: 'Shoes', value: eq.shoes } : null,
  ].filter(Boolean) as { icon: string; label: string; value: string }[];

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
    >
      {/* Header */}
      <Card style={styles.headerCard}>
        <View style={[styles.cover, { backgroundColor: profile.user.color ?? colors.primarySoft }]}>
          {profile.user.cover_url ? (
            <Image source={{ uri: profile.user.cover_url }} style={styles.coverImg} resizeMode="cover" />
          ) : null}
        </View>
        <View style={styles.headerRow}>
          <Avatar name={profile.user.display_name} uri={profile.user.avatar_url} size={72} />
          <View style={{ flex: 1 }}>
            <Text style={styles.name}>{profile.user.display_name}</Text>
            <Text style={styles.handle}>
              @{profile.user.username}
              {profile.user.is_private ? ' · 🔒' : ''}
            </Text>
            {profile.user.home_label ? <Text style={styles.home}>📍 {profile.user.home_label}</Text> : null}
          </View>
        </View>
        {profile.user.bio ? <Text style={styles.bio}>{profile.user.bio}</Text> : null}

        <View style={styles.statsRow}>
          <Stat label="Matches" value={profile.stats.match_count} />
          <Stat label="Territories" value={profile.stats.territory_count} color={colors.primary} />
          <Stat label="Followers" value={profile.stats.follower_count} />
          <Stat label="Following" value={profile.stats.following_count} />
        </View>

        {isSelf ? (
          <View style={{ gap: spacing.sm }}>
            <View style={{ flexDirection: 'row', gap: spacing.sm }}>
              <Button label="Edit profile" variant="secondary" onPress={() => navigation.navigate('EditProfile')} style={{ flex: 1, height: 42 }} />
              <Button label="Settings" variant="ghost" onPress={() => navigation.navigate('Settings')} style={{ flex: 1, height: 42 }} />
            </View>
            <Button label="⚔️ Matches & challenges" variant="ghost" onPress={() => navigation.navigate('ScheduledMatches')} style={{ height: 42 }} />
          </View>
        ) : profile.viewer_has_blocked ? (
          <View style={{ gap: spacing.sm }}>
            <Muted>You&apos;ve blocked this player. They can&apos;t see your matches or profile.</Muted>
            <Button label="Unblock" variant="secondary" onPress={unblock} loading={blockLoading} style={{ height: 42 }} />
          </View>
        ) : (
          <View style={{ gap: spacing.sm }}>
            <View style={{ flexDirection: 'row', gap: spacing.sm }}>
              <Button
                label={following ? 'Following' : 'Follow'}
                variant={following ? 'secondary' : 'primary'}
                onPress={toggleFollow}
                loading={followLoading}
                disabled={followLoading}
                style={{ flex: 1, height: 42 }}
              />
              <Button
                label="⚔️ Challenge"
                variant="primary"
                onPress={() =>
                  navigation.navigate('ScheduleMatch', {
                    opponentId: profile.user.id,
                    opponentName: profile.user.display_name,
                    opponentUsername: profile.user.username,
                    challenge: true,
                  })
                }
                style={{ flex: 1, height: 42 }}
              />
            </View>
            <Pressable onPress={confirmBlock} accessibilityRole="button" hitSlop={8}>
              <Text style={styles.blockLink}>Block @{profile.user.username}</Text>
            </Pressable>
          </View>
        )}
      </Card>

      {/* Private profile the viewer doesn't follow — nothing below will load. */}
      {!isSelf && profile.restricted ? (
        <Card style={{ alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.xl }}>
          <Text style={{ fontSize: 34 }}>🔒</Text>
          <Text style={styles.lockTitle}>This account is private</Text>
          <Muted>Follow {profile.user.display_name} to see their matches and stats.</Muted>
        </Card>
      ) : null}

      {/* Vollo rating + streak (hidden while the profile's content is inaccessible) */}
      {profile.restricted || profile.viewer_has_blocked ? null : (
      <View style={{ flexDirection: 'row', gap: spacing.md }}>
        <Card style={styles.miniCard}>
          <Text style={styles.miniLabel}>VOLLO RATING</Text>
          {avgRating != null ? (
            <CountUp value={avgRating} style={styles.miniValue} />
          ) : (
            <Text style={styles.miniValue}>—</Text>
          )}
          {analytics && avgRating != null ? <Text style={styles.miniSub}>{analytics.playstyle}</Text> : null}
        </Card>
        <Card style={styles.miniCard}>
          <Text style={styles.miniLabel}>STREAK</Text>
          <Text style={styles.miniValue}>
            🔥 {streak?.current_streak_weeks ?? 0}w
          </Text>
          <Text style={styles.miniSub}>×{(streak?.streak_modifier ?? 1).toFixed(1)} court boost</Text>
        </Card>
      </View>
      )}

      {/* Goals (own profile only) */}
      {isSelf ? (
        <Card style={{ gap: spacing.md }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <SectionTitle>Goals</SectionTitle>
            <Pressable onPress={() => navigation.navigate('Goals')} accessibilityRole="button" hitSlop={8}>
              <Text style={styles.territoryGo}>{goals.length > 0 ? 'Manage →' : 'Set a goal →'}</Text>
            </Pressable>
          </View>
          {goals.length === 0 ? (
            <Muted style={{ textAlign: 'left' }}>Set a weekly or monthly target to stay on your game.</Muted>
          ) : (
            goals.map((g) => (
              <ProgressBar
                key={g.id}
                label={goalTitle(g)}
                pct={(g.current / g.target) * 100}
                caption={goalCaption(g)}
                color={g.current >= g.target ? colors.win : colors.primary}
              />
            ))
          )}
        </Card>
      ) : null}

      {/* Gear (public equipment) */}
      {gear.length > 0 ? (
        <Card style={{ gap: spacing.sm }}>
          <SectionTitle>Gear</SectionTitle>
          {gear.map((g) => (
            <View key={g.label} style={styles.gearRow}>
              <Text style={styles.gearIcon}>{g.icon}</Text>
              <Text style={styles.gearLabel}>{g.label}</Text>
              <Text style={styles.gearValue} numberOfLines={1}>{g.value}</Text>
            </View>
          ))}
        </Card>
      ) : null}

      {/* Recent form */}
      {analytics && analytics.recent_form.length > 0 ? (
        <Card style={{ gap: spacing.sm }}>
          <SectionTitle>Recent form</SectionTitle>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <FormDots form={analytics.recent_form} />
            <Text style={styles.winRate}>{analytics.overall.win_rate}% win rate</Text>
          </View>
        </Card>
      ) : null}

      {/* Surface partitioning */}
      {analytics && analytics.by_surface.length > 0 ? (
        <Card style={{ gap: spacing.md }}>
          <SectionTitle>Win rate by surface</SectionTitle>
          {analytics.by_surface.map((s) => (
            <ProgressBar
              key={s.surface}
              label={`${s.surface[0].toUpperCase()}${s.surface.slice(1)} (${s.wins}-${s.losses})`}
              pct={s.win_rate}
              color={surfaceColors[s.surface]}
            />
          ))}
        </Card>
      ) : null}

      {/* Ratings per surface */}
      {ratings.length > 0 ? (
        <Card style={{ gap: spacing.sm }}>
          <SectionTitle>Surface ratings</SectionTitle>
          {ratings.map((r) => (
            <View key={r.surface} style={styles.ratingRow}>
              <SurfaceBadge surface={r.surface as Surface} small />
              <Text style={styles.ratingValue}>
                {r.rating}
                {r.rating_deviation != null ? <Text style={styles.ratingPm}> ±{r.rating_deviation}</Text> : null}
              </Text>
              <Text style={styles.ratingSub}>
                peak {r.peak_rating} · {r.wins}W {r.losses}L{r.rating_deviation >= 150 ? ' · provisional' : ''}
              </Text>
            </View>
          ))}
        </Card>
      ) : null}

      {/* Stat matrix */}
      {analytics && analytics.overall.matches > 0 ? (
        <Card style={{ gap: spacing.lg }}>
          <SectionTitle>Stat matrix</SectionTitle>
          <View style={{ gap: spacing.md }}>
            <ProgressBar label="1st serve in" pct={analytics.serve.first_serve_pct} />
            <ProgressBar label="2nd serve in" pct={analytics.serve.second_serve_pct} color={colors.accent} />
            <ProgressBar label="Break point conversion" pct={analytics.serve.break_point_conversion} color={colors.warning} />
          </View>
          <View style={{ gap: spacing.md }}>
            <SplitBar label="Forehand" positive={analytics.strokes.forehand.winners} negative={analytics.strokes.forehand.errors} />
            <SplitBar label="Backhand" positive={analytics.strokes.backhand.winners} negative={analytics.strokes.backhand.errors} />
            <SplitBar label="Volley" positive={analytics.strokes.volley.winners} negative={analytics.strokes.volley.errors} />
          </View>
          {analytics.rally.short + analytics.rally.medium + analytics.rally.long > 0 ? (
            <View style={{ gap: spacing.sm }}>
              <Text style={styles.subhead}>Rally distribution</Text>
              <RallyDistribution short={analytics.rally.short} medium={analytics.rally.medium} long={analytics.rally.long} />
            </View>
          ) : null}
        </Card>
      ) : null}

      {/* Territories — tap a zone to fly to it on the Domination Map */}
      {territories.length > 0 ? (
        <Card style={{ gap: spacing.sm }}>
          <SectionTitle>Territories</SectionTitle>
          {territories.map((t) => {
            const dot = t.owner_color && HEX6.test(t.owner_color) ? t.owner_color : colors.primary;
            return (
              <Pressable
                key={t.id}
                style={styles.territoryRow}
                onPress={() =>
                  navigation.navigate('Tabs', {
                    screen: 'Map',
                    params: { focusLat: t.center.lat, focusLng: t.center.lng, focusTerritoryId: t.id },
                  })
                }
                accessibilityRole="button"
                accessibilityLabel={`View ${t.district_name} on the map`}
              >
                <View style={[styles.zoneDot, { backgroundColor: dot }]} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.territoryName}>{t.district_name}</Text>
                  <Text style={styles.territorySub}>{t.court_count} courts · {t.area_sqkm.toFixed(1)} km²</Text>
                </View>
                <Text style={styles.territoryGo}>View on map →</Text>
              </Pressable>
            );
          })}
        </Card>
      ) : null}

      {/* Achievements */}
      {achievements.length > 0 ? (
        <Card style={{ gap: spacing.sm }}>
          <SectionTitle>Achievements</SectionTitle>
          <View style={styles.badges}>
            {achievements.map((a) => (
              <View key={a.code} style={styles.badge}>
                <Text style={{ fontSize: 22 }}>{a.icon}</Text>
                <Text style={styles.badgeTitle}>{a.title}</Text>
              </View>
            ))}
          </View>
        </Card>
      ) : null}

      {/* Head to head */}
      {h2h.length > 0 ? (
        <Card style={{ gap: spacing.sm }}>
          <SectionTitle>Rivalries</SectionTitle>
          {h2h.slice(0, 6).map((h, i) => (
            <View key={i} style={styles.h2hRow}>
              <Text style={styles.h2hName}>{h.opponent_name}</Text>
              <Text style={styles.h2hRecord}>
                <Text style={{ color: colors.win }}>{h.wins}</Text>
                {' – '}
                <Text style={{ color: colors.loss }}>{h.losses}</Text>
              </Text>
            </View>
          ))}
        </Card>
      ) : null}

      {/* Recent matches */}
      {recent.length > 0 ? (
        <Card style={{ gap: spacing.sm }}>
          <SectionTitle>Recent matches</SectionTitle>
          {recent.map((m) => (
            <Pressable key={m.id} style={styles.matchRow} onPress={() => navigation.navigate('MatchDetail', { matchId: m.id })}>
              <Text style={[styles.matchResult, { color: m.result === 'win' ? colors.win : colors.loss }]}>
                {m.result === 'win' ? 'W' : 'L'}
              </Text>
              <Text style={styles.matchScore}>{formatScoreLine(m.score_array)}</Text>
              <Text style={styles.matchMeta}>{m.court_name ?? m.surface} · {timeAgo(m.played_at)}</Text>
            </Pressable>
          ))}
        </Card>
      ) : null}

      <View style={{ height: spacing.xxl }} />
    </ScrollView>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <Text style={styles.sectionTitle}>{children}</Text>;
}

export function MeScreen() {
  const user = useAuth((s) => s.user);
  const insets = useSafeAreaInsets();
  // The Me tab has no navigation header — pad past the status bar/notch.
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top }}>
      {user ? <ProfileView username={user.username} isSelf /> : <Loading />}
    </View>
  );
}

export function UserProfileScreen({ route }: NativeStackScreenProps<RootStackParamList, 'UserProfile'>) {
  const user = useAuth((s) => s.user);
  return <ProfileView username={route.params.username} isSelf={user?.username === route.params.username} />;
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.md },
  headerCard: { gap: spacing.md, paddingTop: 0, overflow: 'hidden' },
  cover: { height: 104, marginHorizontal: -spacing.lg, marginBottom: spacing.xs },
  coverImg: { width: '100%', height: '100%' },
  headerRow: { flexDirection: 'row', gap: spacing.md, alignItems: 'center' },
  name: { color: colors.text, fontSize: font.h2 + 2, fontFamily: fonts.display, letterSpacing: 0.2 },
  handle: { color: colors.textDim, fontSize: font.small },
  home: { color: colors.textFaint, fontSize: font.tiny, marginTop: 2 },
  bio: { color: colors.textDim, fontSize: font.body },
  statsRow: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.md },
  miniCard: { flex: 1, gap: 2 },
  miniLabel: { color: colors.textFaint, fontSize: font.tiny, fontFamily: fonts.bold, letterSpacing: 0.5 },
  miniValue: { color: colors.text, fontSize: font.h1, fontFamily: fonts.display },
  miniSub: { color: colors.primary, fontSize: font.tiny, fontFamily: fonts.bold },
  sectionTitle: { color: colors.textDim, fontFamily: fonts.bold, fontSize: font.small, textTransform: 'uppercase', letterSpacing: 0.5 },
  subhead: { color: colors.textDim, fontFamily: fonts.bold, fontSize: font.small },
  winRate: { color: colors.onAccent, fontFamily: fonts.bold, fontSize: font.small, backgroundColor: colors.accent, paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.pill, overflow: 'hidden' },
  ratingRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  ratingValue: { color: colors.text, fontFamily: fonts.bold, fontSize: font.body, minWidth: 50 },
  ratingPm: { color: colors.textFaint, fontFamily: fonts.bold, fontSize: font.tiny },
  ratingSub: { color: colors.textFaint, fontSize: font.tiny, flex: 1, textAlign: 'right' },
  gearRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  gearIcon: { fontSize: 16, width: 22 },
  gearLabel: { color: colors.textDim, fontSize: font.small, fontFamily: fonts.bold, width: 72 },
  gearValue: { color: colors.text, fontSize: font.small, fontFamily: fonts.medium, flex: 1 },
  territoryRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 2 },
  zoneDot: { width: 14, height: 14, borderRadius: 4, borderWidth: 1, borderColor: colors.border },
  territoryName: { color: colors.text, fontFamily: fonts.bold },
  territorySub: { color: colors.textDim, fontSize: font.small },
  territoryGo: { color: colors.primary, fontSize: font.tiny, fontFamily: fonts.bold },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  badge: { alignItems: 'center', width: 76, gap: 2, backgroundColor: colors.surfaceAlt, borderRadius: radius.md, padding: spacing.sm },
  badgeTitle: { color: colors.textDim, fontSize: 9, textAlign: 'center', fontFamily: fonts.bold },
  h2hRow: { flexDirection: 'row', justifyContent: 'space-between' },
  h2hName: { color: colors.text, fontFamily: fonts.bold },
  h2hRecord: { fontFamily: fonts.bold, fontSize: font.body },
  matchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  matchResult: { fontFamily: fonts.bold, width: 18 },
  matchScore: { color: colors.text, fontFamily: fonts.bold, width: 110 },
  matchMeta: { color: colors.textFaint, fontSize: font.tiny, flex: 1 },
  blockLink: { color: colors.textFaint, fontSize: font.tiny, fontFamily: fonts.bold, textAlign: 'center', paddingVertical: 2 },
  lockTitle: { color: colors.text, fontSize: font.h3, fontFamily: fonts.heading },
});
