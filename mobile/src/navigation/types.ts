import type { NavigatorScreenParams } from '@react-navigation/native';

export type TabParamList = {
  Feed: undefined;
  Map: undefined;
  Log: undefined;
  Alerts: undefined;
  Me: undefined;
};

export type RootStackParamList = {
  Login: undefined;
  Register: undefined;
  Tabs: NavigatorScreenParams<TabParamList> | undefined;
  MatchDetail: { matchId: string };
  Court: { courtId: string };
  Courts: undefined;
  Leaderboard: { courtId: string; courtName?: string };
  UserProfile: { username: string };
  EditProfile: undefined;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace ReactNavigation {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface RootParamList extends RootStackParamList {}
  }
}
