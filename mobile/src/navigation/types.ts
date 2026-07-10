import type { NavigatorScreenParams } from '@react-navigation/native';
import type { Surface } from '../types';

export type TabParamList = {
  Feed: undefined;
  // Optional focus target: fly to and highlight a player's domination zone
  // (used by the "view on map" action on a profile's territory).
  Map: { focusLat?: number; focusLng?: number; focusTerritoryId?: string } | undefined;
  // A court just added from the Log flow is handed back here to auto-select.
  // Prefill params let "Log result" on a scheduled match seed the opponent/court.
  Log:
    | {
        newCourtId?: string;
        prefillOpponentId?: string;
        prefillOpponentName?: string;
        prefillCourtId?: string;
        prefillSurface?: Surface;
        scheduledMatchId?: string;
      }
    | undefined;
  Alerts: undefined;
  Me: undefined;
};

export type RootStackParamList = {
  Login: undefined;
  Register: undefined;
  ForgotPassword: undefined;
  ResetPassword: undefined;
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
  Goals: undefined;
  Records: { username: string };
  TrainingLog: { username: string };
  YearInReview: { username: string; year?: number };
  Clubs: undefined;
  Club: { clubId: string };
  CreateClub: undefined;
  ScheduledMatches: undefined;
  // Propose a match; opponent is prefilled when launched from their profile.
  // `challenge` frames it as a competitive challenge (combative copy + alert).
  ScheduleMatch:
    | { opponentId?: string; opponentName?: string; opponentUsername?: string; challenge?: boolean }
    | undefined;
  Quickstart: undefined;
};

declare global {
   
  namespace ReactNavigation {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface RootParamList extends RootStackParamList {}
  }
}
