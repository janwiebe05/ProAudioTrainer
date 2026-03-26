# Contributing

Danke fuer dein Interesse an ProAudioTrainer.

## Wie du beitragen kannst

- Bug Reports mit reproduzierbaren Schritten
- Feature Requests mit Use Case aus Audio-Praxis
- Pull Requests fuer Fixes, Refactoring und neue Trainer-Module
- Dokumentation (README, API, Setup)

## Development Setup

1. Fork erstellen und Branch anlegen: `feature/kurze-beschreibung`
2. Lokal starten (bevorzugt via Docker):
   - `cp .env.example .env`
   - `docker compose up -d --build`
3. Aenderungen implementieren
4. Manuell pruefen (Login, Modul, Score, API)
5. Pull Request mit klarer Beschreibung erstellen

## Pull Request Checklist

- Scope ist klein und fokussiert
- Keine Secrets oder persoenlichen Daten im Commit
- README/Docs aktualisiert, falls Verhalten geaendert wurde
- Rueckwaertskompatibilitaet bedacht (API und JSON-Strukturen)

## Coding Notes

- Behalte den bestehenden Vanilla-JS Stil bei
- Kommentiere komplexe Audio-Logik knapp und zielgerichtet
- Aendere keine unzusammenhaengenden Bereiche in einem PR
