import React, { useCallback, useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { api, ApiError } from '../api/client';
import { Button, Card, EmptyState, Loading, Muted, SectionHeader, SegmentedControl } from '../components/ui';
import { ProgressBar } from '../components/charts';
import { Stepper } from '../components/Stepper';
import { showToast } from '../components/Toast';
import { notifySuccess } from '../lib/haptics';
import { colors, font, fonts, spacing } from '../theme';
import type { Goal, GoalMetric, GoalPeriod } from '../types';

export const METRIC_LABELS: Record<GoalMetric, string> = {
  matches: 'Matches played',
  wins: 'Matches won',
  hours: 'Hours on court',
};

export function goalTitle(g: Goal): string {
  return `${g.period === 'weekly' ? 'Weekly' : 'Monthly'} · ${METRIC_LABELS[g.metric]}`;
}

export function goalCaption(g: Goal): string {
  const fmt = (n: number) => (g.metric === 'hours' ? `${n}h` : String(n));
  return `${fmt(g.current)} / ${fmt(g.target)}`;
}

export function GoalsScreen() {
  const [goals, setGoals] = useState<Goal[] | null>(null);
  const [metric, setMetric] = useState<GoalMetric>('matches');
  const [period, setPeriod] = useState<GoalPeriod>('weekly');
  const [target, setTarget] = useState(3);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    void api
      .getGoals()
      .then((r) => setGoals(r.goals))
      .catch(() => setGoals((g) => g ?? []));
  }, []);
  useEffect(load, [load]);

  // Hours goals move in half-hour steps; count goals in whole ones.
  const step = metric === 'hours' ? 0.5 : 1;
  const switchMetric = (m: GoalMetric) => {
    setMetric(m);
    setTarget((t) => Math.max(1, Math.round(t)));
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.setGoal({ metric, period, target });
      notifySuccess();
      showToast('Goal set. Go get it! 🎾', 'success');
      load();
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : 'Could not save the goal — please try again.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const confirmRemove = (g: Goal) =>
    Alert.alert('Remove goal', `Stop tracking "${goalTitle(g)}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.deleteGoal(g.id);
            setGoals((list) => (list ?? []).filter((x) => x.id !== g.id));
          } catch (e) {
            showToast(e instanceof ApiError ? e.message : 'Could not remove the goal — please try again.', 'error');
          }
        },
      },
    ]);

  if (goals === null) return <Loading />;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={styles.content}>
      <Card style={{ gap: spacing.md }}>
        <SectionHeader title="Set a goal" />
        <SegmentedControl
          options={[
            { label: 'Matches', value: 'matches' as GoalMetric },
            { label: 'Wins', value: 'wins' as GoalMetric },
            { label: 'Hours', value: 'hours' as GoalMetric },
          ]}
          value={metric}
          onChange={switchMetric}
        />
        <SegmentedControl
          options={[
            { label: 'Weekly', value: 'weekly' as GoalPeriod },
            { label: 'Monthly', value: 'monthly' as GoalPeriod },
          ]}
          value={period}
          onChange={setPeriod}
        />
        <Stepper
          label={metric === 'hours' ? 'Target hours' : `Target ${metric}`}
          value={target}
          onChange={setTarget}
          min={step}
          max={200}
          step={step}
        />
        <Button label="Save goal" onPress={save} loading={saving} />
        <Muted style={{ textAlign: 'left' }}>
          One goal per metric and period — saving again just changes the target. Weeks start on Monday.
        </Muted>
      </Card>

      {goals.length === 0 ? (
        <EmptyState
          icon="🎯"
          title="No goals yet"
          subtitle="Set a weekly or monthly target and watch the bar fill as you play."
        />
      ) : (
        <Card style={{ gap: spacing.lg }}>
          <SectionHeader title="Your goals" />
          {goals.map((g) => (
            <View key={g.id} style={{ gap: spacing.xs }}>
              <ProgressBar
                label={goalTitle(g)}
                pct={(g.current / g.target) * 100}
                caption={goalCaption(g)}
                color={g.current >= g.target ? colors.win : colors.primary}
              />
              <View style={styles.goalFooter}>
                {g.current >= g.target ? (
                  <Text style={styles.goalDone}>Goal hit! 🏆</Text>
                ) : (
                  <Muted style={{ textAlign: 'left' }}>
                    {g.metric === 'hours'
                      ? `${Math.max(0, Math.round((g.target - g.current) * 10) / 10)}h to go`
                      : `${Math.max(0, g.target - g.current)} to go`}
                  </Muted>
                )}
                <Text style={styles.remove} onPress={() => confirmRemove(g)}>
                  Remove
                </Text>
              </View>
            </View>
          ))}
        </Card>
      )}

      <View style={{ height: spacing.xxl }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.md },
  goalFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  goalDone: { color: colors.win, fontFamily: fonts.bold, fontSize: font.small },
  remove: { color: colors.textFaint, fontSize: font.tiny, fontFamily: fonts.bold, padding: 4 },
});
