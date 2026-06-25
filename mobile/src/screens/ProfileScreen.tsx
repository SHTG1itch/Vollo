import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { api } from '../api/client';
import { useAuth } from '../store/auth';
import { Avatar, Button, Card, Loading, Muted, Stat } from '../components/ui';
import { FormDots, ProgressBar, RallyDistribution, SplitBar } from '../components/charts';
import { SurfaceBadge } from '../components/SurfaceBadge';
import { colors, font, radius, spacing, surfaceColors } from '../theme';
import type {
  Achievement,
  HeadToHead,
  MatchCard,
  ProfileAnalytics,
  ProfileResponse,
  StreakState,
  Surface,
  SurfaceRating,
} from '../types';
import { formatScoreLine, timeAgo } from '../utils/format';

type Nav = NativeStackNavigationProp<RootStackParamList>;

export function ProfileView({ username, isSelf }: { username: string; isSelf: boolean }) {
  const navigation = useNavigation<Nav>();
  const logout = useAuth((s) => s.logout);

  const [profile, setProfile] = useState<ProfileResponse | null>(null);
  const [analytics, setAnalytics] = useState<ProfileAnalytics | null>(null);
  const [ratings, setRatings] = useState<SurfaceRating[]>([]);
  const [achievements, setAchievements] = useState<Achievement[]>([]);
  const [streak, setStreak] = useState<StreakState | null>(null);
  const [territories, setTerritories] = useState<{ id: string; district_name: string; court_count: number; area_sqkm: number }[]>([]);
  const [h2h, setH2h] = useState<HeadToHead[]>([]);
  const [recent, setRecent] = useState<MatchCard[]>([]);
  const [following, setFollowing] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void (async () => {
      try {
        const prof = await api.getProfile(username);
        if (!active) return;
        setProfile(prof);
        setFollowing(prof.viewer_is_following);

        const [a, r, ach, st, terr, hh, feed] = await Promise.allSettled([
          api.getAnalytics(username),
          api.getRatings(username),
          api.getAchievements(username),
          api.getStreak(username),
          api.getUserTerritories(prof.user.id),
          api.getHeadToHead(username),
          api.getUserFeed(prof.user.id, { limit: 5 }),
        ]);
        if (!active) return;
        if (a.status === 'fulfilled') setAnalytics(a.value.analytics);
        if (r.status === 'fulfilled') setRatings(r.value.ratings);
        if (ach.status === 'fulfilled') setAchievements(ach.value.achievements);
        if (st.status === 'fulfilled') setStreak(st.value.streak);
        if (terr.status === 'fulfilled') setTerritories(terr.value.territories);
        if (hh.status === 'fulfilled') setH2h(hh.value.head_to_head);
        if (feed.status === 'fulfilled') setRecent(feed.value.matches);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [username]);

  const toggleFollow = async () => {
    if (!profile) return;
    const was = following;
    setFollowing(!was);
    try {
      if (was) await api.unfollow(username);
      else await api.follow(username);
    } catch {
      setFollowing(was);
    }
  };

  if (loading) return <Loading />;
  if (!profile) return <Muted style={{ padding: spacing.xl }}>Profile not found.</Muted>;

  const avgRating =
    ratings.length > 0 ? Math.round(ratings.reduce((s, r) => s + r.rating, 0) / ratings.length) : 1000;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={styles.content}>
      {/* Header */}
      <Card style={{ gap: spacing.md }}>
        <View style={styles.headerRow}>
          <Avatar name={profile.user.display_name} uri={profile.user.avatar_url} size={64} />
          <View style={{ flex: 1 }}>
            <Text style={styles.name}>{profile.user.display_name}</Text>
            <Text style={styles.handle}>@{profile.user.username}</Text>
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
          <View style={{ flexDirection: 'row', gap: spacing.sm }}>
            <Button label="Edit profile" variant="secondary" onPress={() => navigation.navigate('EditProfile')} style={{ flex: 1, height: 42 }} />
            <Button label="Log out" variant="ghost" onPress={logout} style={{ flex: 1, height: 42 }} />
          </View>
        ) : (
          <Button label={following ? 'Following' : 'Follow'} variant={following ? 'secondary' : 'primary'} onPress={toggleFollow} style={{ height: 42 }} />
        )}
      </Card>

      {/* Vollo rating + streak */}
      <View style={{ flexDirection: 'row', gap: spacing.md }}>
        <Card style={styles.miniCard}>
          <Text style={styles.miniLabel}>VOLLO RATING</Text>
          <Text style={styles.miniValue}>{avgRating}</Text>
          {analytics ? <Text style={styles.miniSub}>{analytics.playstyle}</Text> : null}
        </Card>
        <Card style={styles.miniCard}>
          <Text style={styles.miniLabel}>STREAK</Text>
          <Text style={styles.miniValue}>
            🔥 {streak?.current_streak_weeks ?? 0}w
          </Text>
          <Text style={styles.miniSub}>×{(streak?.streak_modifier ?? 1).toFixed(1)} court boost</Text>
        </Card>
      </View>

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
              <Text style={styles.ratingValue}>{r.rating}</Text>
              <Text style={styles.ratingSub}>peak {r.peak_rating} · {r.wins}W {r.losses}L</Text>
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

      {/* Territories */}
      {territories.length > 0 ? (
        <Card style={{ gap: spacing.sm }}>
          <SectionTitle>Territories</SectionTitle>
          {territories.map((t) => (
            <View key={t.id} style={styles.territoryRow}>
              <Text style={styles.territoryName}>🗺️ {t.district_name}</Text>
              <Text style={styles.territorySub}>{t.court_count} courts · {t.area_sqkm.toFixed(1)} km²</Text>
            </View>
          ))}
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
  if (!user) return <Loading />;
  return <ProfileView username={user.username} isSelf />;
}

export function UserProfileScreen({ route }: NativeStackScreenProps<RootStackParamList, 'UserProfile'>) {
  const user = useAuth((s) => s.user);
  return <ProfileView username={route.params.username} isSelf={user?.username === route.params.username} />;
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.md },
  headerRow: { flexDirection: 'row', gap: spacing.md, alignItems: 'center' },
  name: { color: colors.text, fontSize: font.h2, fontWeight: '800' },
  handle: { color: colors.textDim, fontSize: font.small },
  home: { color: colors.textFaint, fontSize: font.tiny, marginTop: 2 },
  bio: { color: colors.textDim, fontSize: font.body },
  statsRow: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.md },
  miniCard: { flex: 1, gap: 2 },
  miniLabel: { color: colors.textFaint, fontSize: font.tiny, fontWeight: '700', letterSpacing: 0.5 },
  miniValue: { color: colors.text, fontSize: font.h2, fontWeight: '900' },
  miniSub: { color: colors.primary, fontSize: font.tiny, fontWeight: '600' },
  sectionTitle: { color: colors.text, fontWeight: '800', fontSize: font.h3 },
  subhead: { color: colors.textDim, fontWeight: '700', fontSize: font.small },
  winRate: { color: colors.text, fontWeight: '700' },
  ratingRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  ratingValue: { color: colors.text, fontWeight: '800', fontSize: font.body, width: 50 },
  ratingSub: { color: colors.textFaint, fontSize: font.tiny, flex: 1 },
  territoryRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  territoryName: { color: colors.text, fontWeight: '700' },
  territorySub: { color: colors.textDim, fontSize: font.small },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  badge: { alignItems: 'center', width: 76, gap: 2, backgroundColor: colors.surfaceAlt, borderRadius: radius.md, padding: spacing.sm },
  badgeTitle: { color: colors.textDim, fontSize: 9, textAlign: 'center', fontWeight: '600' },
  h2hRow: { flexDirection: 'row', justifyContent: 'space-between' },
  h2hName: { color: colors.text, fontWeight: '600' },
  h2hRecord: { fontWeight: '800', fontSize: font.body },
  matchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  matchResult: { fontWeight: '900', width: 18 },
  matchScore: { color: colors.text, fontWeight: '700', width: 110 },
  matchMeta: { color: colors.textFaint, fontSize: font.tiny, flex: 1 },
});
