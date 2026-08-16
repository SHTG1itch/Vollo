export const PRIVACY_EFFECTIVE_DATE = 'August 16, 2026';

export const PRIVACY_SECTIONS = [
  {
    title: 'Information Vollo processes',
    body: 'Vollo processes your account details, profile and social activity, tennis matches and statistics, selected photos, courts you use, foreground location when you request nearby courts, and saved privacy choices. Vollo does not request background location, contacts, microphone, or camera access.',
  },
  {
    title: 'How information is used',
    body: 'Information is used to authenticate you, provide app features, calculate ratings and territories, enforce privacy and blocking choices, prevent abuse, review reports, and keep the service reliable. Vollo does not sell personal information or use it for targeted advertising.',
  },
  {
    title: 'Visibility and providers',
    body: 'Your profile and activity may be visible to other Vollo users according to your settings. Vollo uses Supabase for authentication, data, storage, and API hosting; Expo for builds and optional push relay; Google or Apple when you choose provider sign-in; and OpenStreetMap services for court and map data.',
  },
  {
    title: 'Retention and deletion',
    body: 'Account content is retained while your account exists. Login-attempt records expire after 24 hours; read notifications after 180 days; and all notifications after 365 days. Settings → Delete account permanently removes your account and queues associated stored media for deletion.',
  },
  {
    title: 'Your choices',
    body: 'You can edit your profile, make your account private, hide competitive information, block users, decline permissions, remove photos, and delete your account. The current Android release provides in-app alerts without requesting remote-notification permission.',
  },
  {
    title: 'Children and questions',
    body: 'Vollo is not directed to children under 13. For privacy questions, use the Vollo GitHub repository without posting private account information. Report security vulnerabilities through GitHub private vulnerability reporting, not a public issue.',
  },
] as const;
