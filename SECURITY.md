# Security Policy

## Supported Scope

Diese Richtlinie gilt fuer den Code in diesem Repository.

## Reporting a Vulnerability

Bitte melde Sicherheitsprobleme verantwortungsvoll und nicht oeffentlich als Issue.

Sende eine E-Mail mit:

- betroffener Komponente
- reproduzierbarem Ablauf
- moeglichem Impact
- optionalem Fix-Vorschlag

## Public Release Checklist

Vor einem oeffentlichen Release:

1. `.env` und lokale Konfigurationsdateien sind nicht eingecheckt
2. Commit-Historie auf API-Keys/Secrets pruefen (z. B. gitleaks)
3. Standardpasswoerter nach erstem Login aendern
4. Upload-Verzeichnisse ohne private Audiodaten halten
