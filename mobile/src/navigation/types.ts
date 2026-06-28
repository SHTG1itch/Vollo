import type { NavigatorScreenParams } from '@react-navigation/native';

export type TabParamList = {
  Feed: undefined;
  // Optional focus target: fly to and highlight a player's domination zone
  // (used by the "view on map" action on a profile's territory).
  Map: { focusLat?: number; focusLng?: number; focusTerritoryId?: string } | undefined;
  // A court just added from the Log flow is handed back here to auto-select.
  Log: { newCourtId?: string } | undefined;
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
  // origin tells the screen where to return the created court; lat/lng seed the pin.
  AddCourt: { origin?: 'log' | 'courts' | 'map'; lat?: number; lng?: number } | undefined;
  Leaderboard: { courtId: string; courtName?: string };
  UserProfile: { username: string };
  EditProfile: undefined;
  UserSearch: undefined;
  Settings: undefined;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace ReactNavigation {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface RootParamList extends RootStackParamList {}
  }
}
