# Vollo Privacy Policy

Effective August 16, 2026

Vollo is a tennis activity and social app. This policy explains the information
Vollo processes, why it is needed, and the controls available to you.

## Information Vollo processes

- **Account information:** email address, username, display name, authentication
  provider identifiers, and encrypted authentication session data.
- **Profile and social information:** optional profile and cover photos, equipment,
  follows, blocks, clubs, comments, kudos, reports, and privacy preferences.
- **Tennis activity:** matches, scores, statistics, opponents, scheduled matches,
  goals, ratings, achievements, and courts associated with activity.
- **Location:** foreground device location when you ask to find nearby courts, and
  any home base or court location you deliberately save. Vollo does not request
  background location access.
- **Notifications:** an Expo push token and platform when remote notifications are
  available and you grant permission. The current GitHub Android release provides
  in-app alerts but is not configured for remote Android push delivery.
- **Security and operations:** short-lived login-attempt records, request metadata,
  and sanitized service logs needed to prevent abuse and operate the service.

Vollo does not include advertising, third-party analytics, a crash-reporting SDK,
contact-book access, background location tracking, microphone recording, or camera
access. Photos are selected through the operating system's photo picker.

## How information is used

Information is used to authenticate accounts, provide app features, calculate
ratings and territories, display content according to privacy and blocking choices,
deliver alerts, prevent abuse, investigate reports, and maintain service reliability.
Vollo does not sell personal information or use it for targeted advertising.

## When information is visible or shared

Your profile and activity may be visible to other Vollo users as described in the
app. A private account limits matches and statistics to approved followers, while
your name and profile remain discoverable. Blocking makes the two accounts mutually
invisible in supported social surfaces.

Vollo uses service providers only as needed to operate the app:

- Supabase for authentication, database, file storage, and Edge Functions.
- Expo for app builds and, when configured, push-notification relay.
- Google or Apple when you choose provider sign-in.
- OpenStreetMap, Overpass, and Nominatim for court and map data; Geoapify may be
  used as a geocoding fallback.

These providers process information under their own terms and may operate in other
countries. Public court and map requests may include the requested map area or
coordinates, but Vollo does not send your account password to mapping providers.

## Retention and deletion

Account content is retained while your account exists unless removed earlier.
Login-attempt records expire after 24 hours. Read notifications expire after 180
days and all notifications expire after 365 days. Operational caches and delivery
records have bounded retention.

You can permanently delete your account in **Settings → Delete account**. Deletion
removes the authentication account and cascades owned relational data; associated
stored media is queued for deletion. Some information may remain briefly in backups
or security logs until their normal retention period expires.

## Your choices

You can edit your profile, make your account private, hide competitive information,
block other users, decline notification or location permission, remove photos, and
delete your account from the app. If you cannot access the app, open a repository
issue without including private account information and request a private contact
path from the maintainer.

## Children

Vollo is not directed to children under 13. Do not create an account if you are
under 13.

## Changes and contact

Material changes will update the effective date and the published policy. For
privacy questions, use the repository's GitHub Issues without posting sensitive
information. Security vulnerabilities should be reported privately as described in
[SECURITY.md](SECURITY.md).
