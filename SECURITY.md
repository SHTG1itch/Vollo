# Security Policy

## Supported release

Only the latest APK published under [GitHub Releases](https://github.com/SHTG1itch/Vollo/releases/latest)
is supported. Download APKs only from this repository and verify the SHA-256 shown
in the release notes and root README before installing.

## Report a vulnerability privately

Do not disclose security vulnerabilities, credentials, tokens, private user data,
or exploitation details in a public issue. Use GitHub's
[private vulnerability report](https://github.com/SHTG1itch/Vollo/security/advisories/new)
instead. Include the affected version, reproduction steps, impact, and any proposed
fix. The maintainer will review the report and coordinate disclosure when practical.

## Public identifiers are not secrets

The mobile app necessarily contains its Supabase URL and anonymous client key,
Google OAuth client IDs, EAS project ID, package name, and signing-certificate
fingerprints. These identify public clients but grant no administrator access.
Database authorization must remain enforced by the sealed REST schema, Edge
Function authentication, and database permissions.

Never commit or publish Supabase service-role keys, database connection strings,
Supabase access tokens, OAuth client secrets, Firebase service-account keys, Android
signing keystores/passwords, Apple signing material, user sessions, or production
data. The repository's full-history secret-scanning workflow checks every push and
pull request for such material.
