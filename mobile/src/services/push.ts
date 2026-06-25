import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { api } from '../api/client';

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

    const tokenResponse = await Notifications.getExpoPushTokenAsync();
    if (tokenResponse?.data) {
      await api.registerPushToken(tokenResponse.data, Platform.OS);
    }
  } catch {
    /* push is optional */
  }
}
