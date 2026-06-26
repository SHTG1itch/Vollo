import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { api } from '../api/client';

// Show notifications even when the app is foregrounded.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

/** The EAS project id is required by getExpoPushTokenAsync in standalone builds. */
function projectId(): string | undefined {
  return Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId ?? undefined;
}

/**
 * Best-effort Expo push registration. Expo's free push service relays to APNs
 * and FCM at no cost. Any failure (Expo Go limitations, denied permission,
 * simulator) is swallowed — push is a bonus, never a blocker.
 */
export async function registerForPush(): Promise<void> {
  try {
    const settings = await Notifications.getPermissionsAsync();
    let granted = settings.granted;
    if (!granted) {
      const req = await Notifications.requestPermissionsAsync();
      granted = req.granted;
    }
    if (!granted) return;

    const pid = projectId();
    const tokenResponse = await Notifications.getExpoPushTokenAsync(pid ? { projectId: pid } : undefined);
    if (tokenResponse?.data) {
      await api.registerPushToken(tokenResponse.data, Platform.OS);
    }
  } catch {
    /* push is optional */
  }
}
