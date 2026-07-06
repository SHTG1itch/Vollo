import React, { useCallback, useRef, useState } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type ViewToken,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useNavigation } from '@react-navigation/native';
import { Button, Screen } from '../components/ui';
import { Icon, type IconName } from '../components/icons';
import { TennisBall, VolloWordmark } from '../components/VolloLogo';
import { tapLight } from '../lib/haptics';
import { colors, font, fonts, spacing } from '../theme';

/** Bump the suffix to re-show the guide after a major feature overhaul. */
export const QUICKSTART_SEEN_KEY = 'vollo.quickstart.seen.v1';

export async function hasSeenQuickstart(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(QUICKSTART_SEEN_KEY)) != null;
  } catch {
    // If storage is unreadable, err on not nagging the user every launch.
    return true;
  }
}

function markQuickstartSeen(): void {
  AsyncStorage.setItem(QUICKSTART_SEEN_KEY, new Date().toISOString()).catch(() => {});
}

type Page = {
  key: string;
  icon: IconName | 'logo';
  title: string;
  body: string;
  bullets: { icon: IconName; text: string }[];
};

const PAGES: Page[] = [
  {
    key: 'welcome',
    icon: 'logo',
    title: 'Welcome to Vollo',
    body: 'The social home for your tennis. Log every match, watch your rating climb, claim your home courts, and push the players around you to keep up.',
    bullets: [
      { icon: 'plus-circle', text: 'Log matches in under a minute' },
      { icon: 'map', text: 'Claim territory on the court map' },
      { icon: 'users', text: 'Follow friends and trade kudos' },
    ],
  },
  {
    key: 'log',
    icon: 'plus-circle',
    title: 'Log every match',
    body: 'Tap the Log tab after you play. Enter the score set by set, pick the court and surface, and add stats like aces or longest rally when you have them. Tag your opponent so the match links to their profile.',
    bullets: [
      { icon: 'locate', text: 'Pick the court you played at — that claims it for your map' },
      { icon: 'users', text: 'Tag a Vollo opponent to link the head-to-head' },
      { icon: 'plus', text: 'Add photos and a title to tell the story' },
    ],
  },
  {
    key: 'rating',
    icon: 'shield',
    title: 'Ratings & verified wins',
    body: 'Every logged match moves your Vollo rating — win against stronger players and it climbs faster. When you tag an opponent they can confirm the score, which marks the match verified and makes your rating count for more.',
    bullets: [
      { icon: 'shield', text: 'Verified matches carry a badge everyone can trust' },
      { icon: 'target', text: 'Your rating converges as you log more matches' },
      { icon: 'trophy', text: 'Climb court leaderboards with every win' },
    ],
  },
  {
    key: 'map',
    icon: 'map',
    title: 'Own the map',
    body: 'The Map tab shows courts near you. Winning matches at a court makes it yours — string courts together and your territory grows. Rivals can take sectors back, so defend your turf.',
    bullets: [
      { icon: 'locate', text: 'Find nearby courts, or add one that is missing' },
      { icon: 'map', text: 'Your territory is drawn in green, rivals in purple' },
      { icon: 'trophy', text: 'Each court has its own leaderboard to top' },
    ],
  },
  {
    key: 'progress',
    icon: 'target',
    title: 'Track your progress',
    body: 'Vollo turns your match history into a training story: set weekly and season goals, chase personal records, review your training-log calendar, and get a season recap at the end of the year.',
    bullets: [
      { icon: 'target', text: 'Goals — set match or win targets and track them live' },
      { icon: 'trophy', text: 'Trophy case — your records and biggest wins' },
      { icon: 'user', text: 'Training log & season recap live on your profile' },
    ],
  },
  {
    key: 'social',
    icon: 'users',
    title: 'Play together',
    body: 'Follow players to fill your feed, give kudos and comments on their matches, join or start clubs with their own leaderboards, and send challenges when you want a real fight.',
    bullets: [
      { icon: 'search', text: 'Find players and courts from search' },
      { icon: 'users', text: 'Clubs group your crew with a shared leaderboard' },
      { icon: 'bell', text: 'Challenges and tags land in your Alerts tab' },
    ],
  },
  {
    key: 'privacy',
    icon: 'user',
    title: 'You are in control',
    body: 'Prefer to fly under the radar? Make your account private in Settings — new followers then need your approval, and only followers see your matches and stats. Your territory and leaderboard spots stay on the public game board unless you flip their own switch off. You can block anyone, and reopen this guide from Settings anytime.',
    bullets: [
      { icon: 'shield', text: 'Private account — followers only, approval required' },
      { icon: 'map', text: 'Territory & leaderboards have their own visibility switch' },
      { icon: 'plus-circle', text: 'Ready? Log your first match and claim a court' },
    ],
  },
];

export function QuickstartScreen() {
  const navigation = useNavigation();
  const { width } = useWindowDimensions();
  const [page, setPage] = useState(0);
  const listRef = useRef<FlatList<Page>>(null);
  const lastPage = page === PAGES.length - 1;

  // Mark seen the moment the guide opens: even if the user force-quits halfway,
  // it must not ambush them on every launch (it stays reopenable from Settings).
  React.useEffect(markQuickstartSeen, []);

  // FlatList requires a referentially-stable callback — useCallback([]) keeps it.
  const onViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const idx = viewableItems[0]?.index;
    if (idx != null) setPage(idx);
  }, []);

  const close = useCallback(() => {
    if (navigation.canGoBack()) navigation.goBack();
  }, [navigation]);

  const next = useCallback(() => {
    tapLight();
    if (lastPage) {
      close();
      return;
    }
    listRef.current?.scrollToIndex({ index: page + 1, animated: true });
  }, [lastPage, page, close]);

  return (
    <Screen edges={['top', 'bottom']}>
      <View style={styles.topBar}>
        <VolloWordmark size={24} />
        {!lastPage ? (
          <Pressable onPress={close} hitSlop={12} accessibilityRole="button" accessibilityLabel="Skip the guide">
            <Text style={styles.skip}>Skip</Text>
          </Pressable>
        ) : null}
      </View>

      <FlatList
        ref={listRef}
        data={PAGES}
        keyExtractor={(p) => p.key}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={{ itemVisiblePercentThreshold: 60 }}
        getItemLayout={(_, index) => ({ length: width, offset: width * index, index })}
        renderItem={({ item }) => (
          <View style={[styles.page, { width }]}>
            <View style={styles.hero}>
              {item.icon === 'logo' ? (
                <TennisBall size={72} />
              ) : (
                <Icon name={item.icon} size={64} color={colors.primary} strokeWidth={1.6} />
              )}
            </View>
            <Text style={styles.title}>{item.title}</Text>
            <Text style={styles.body}>{item.body}</Text>
            <View style={styles.bullets}>
              {item.bullets.map((b) => (
                <View key={b.text} style={styles.bullet}>
                  <View style={styles.bulletIcon}>
                    <Icon name={b.icon} size={18} color={colors.primary} />
                  </View>
                  <Text style={styles.bulletText}>{b.text}</Text>
                </View>
              ))}
            </View>
          </View>
        )}
      />

      <View style={styles.footer}>
        <View style={styles.dots} accessibilityLabel={`Page ${page + 1} of ${PAGES.length}`}>
          {PAGES.map((p, i) => (
            <View key={p.key} style={[styles.dot, i === page && styles.dotActive]} />
          ))}
        </View>
        <Button label={lastPage ? "Let's play" : 'Next'} onPress={next} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  skip: { color: colors.textDim, fontFamily: fonts.bold, fontSize: font.small },
  page: { paddingHorizontal: spacing.xl, paddingTop: spacing.lg, gap: spacing.md },
  hero: {
    width: 116,
    height: 116,
    borderRadius: 58,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    marginBottom: spacing.sm,
  },
  title: { color: colors.text, fontSize: font.h1, fontFamily: fonts.display, textAlign: 'center' },
  body: { color: colors.textDim, fontSize: font.body, fontFamily: fonts.body, textAlign: 'center', lineHeight: 22 },
  bullets: { gap: spacing.md, marginTop: spacing.md },
  bullet: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  bulletIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bulletText: { flex: 1, color: colors.text, fontSize: font.small, fontFamily: fonts.medium, lineHeight: 19 },
  footer: { padding: spacing.lg, gap: spacing.lg },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 7 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.border },
  dotActive: { backgroundColor: colors.primary, width: 20 },
});
