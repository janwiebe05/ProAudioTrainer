# ProAudioTrainer v2 — EQ Recognition System

Hochpräzision-EQ-Trainingssystem mit Vintage-Hardware-Ästhetik. Trainiere dein Gehör zur Frequenzerkennung mit realistischem Zeit-Punktesystem.

## Features

✓ **User Authentication** — JWT-basierte Anmeldung (Standard: admin/admin1!)
✓ **Sound Library** — Hochladen und Verwalten von Audiodateien (WAV, MP3, OGG, FLAC, AIFF, M4A)
✓ **EQ Trainer** — Frequenzerkennung mit 3 Schwierigkeitsstufen
✓ **Zeit-Punktesystem** — 1000 Punkte bei sofortiger Antwort, linear fallend bis 10 Sekunden
✓ **Highscores** — Serverseitige Speicherung, Global Top 10
✓ **Premium Design** — Vintage Rack-Unit Optik (SSL/Neve inspiriert)
✓ **Docker Ready** — Komplett containerisiert

## Tech Stack

- **Backend**: Node.js + Express (kein TypeScript)
- **Frontend**: Vanilla JS + HTML + CSS (keine Frameworks)
- **Storage**: Dateisystem (JSON + Audio-Uploads)
- **Auth**: JWT
- **Container**: Docker + docker-compose
- **Reverse Proxy**: Nginx

## Installation & Start

1. **Repository klonen und ins Verzeichnis wechseln:**
```bash
cd pro-audio-trainer-v2
```

2. **Environment-Datei erstellen (optional):**
```bash
cp .env.example .env
```

3. **Docker Container starten:**
```bash
docker-compose up -d --build
```

4. **Browser öffnen:**
```
http://localhost:8090
```

## Anmeldedaten

**Standard-Benutzer:**
- **Username:** `admin`
- **Passwort:** `admin1!`

## Verwendung

### EQ Trainer

1. Öffne die **Sound Library** und lade Audiodateien hoch
2. Markiere Dateien als "ACTIVE" um sie im Training zu verwenden (oder nutze alle)
3. Starte eine neue Runde und wähle deine Schwierigkeit:
   - **Level I:** ±1 Oktave Toleranz
   - **Level II:** ±½ Oktave Toleranz
   - **Level III:** ±¼ Oktave Toleranz
4. Höre der Audiodatei mit EQ (B) an
5. Klicke die angehobene Frequenz auf der Grafik

### Punktesystem

```
Max. Punkte: 1000 (sofort richtig)
Zeitfaktor: Linear fallend über 10 Sekunden
Nach 10s: 0 Punkte (aber keine Minus)
Genauigkeit: Bonus basierend auf Abweichung
Streak: +10% Bonus ab 3x hintereinander richtig
```

### Sound Library

- **Upload:** Datei(en) per Drag & Drop oder Datei-Dialog
- **Eigenschaften:** Name, Größe, Dauer, Upload-Datum
- **Aktionen:** Vorhören, Löschen, Als aktiv markieren

## Dateistruktur

```
pro-audio-trainer-v2/
├── backend/
│   ├── src/
│   │   ├── server.js           # Express Server
│   │   ├── routes/             # API-Endpoints
│   │   ├── middleware/         # Auth-Middleware
│   │   └── data/               # JSON-Storage (users, library, scores)
│   ├── uploads/                # Hochgeladene Audio-Dateien
│   ├── package.json
│   └── Dockerfile
├── frontend/
│   ├── index.html              # Login + App-Shell
│   ├── app.js                  # Main App Logic
│   ├── style.css               # Basis-Styles + Design System
│   ├── style-modules.css       # Modul-spezifische Styles
│   └── modules/
│       ├── eq-trainer.js       # EQ Training Modul
│       └── sound-library.js    # Sound Library Modul
├── nginx/
│   └── nginx.conf              # Reverse Proxy Config
├── docker-compose.yml          # Container Orchestration
├── .env.example                # Environment Template
└── README.md                   # Diese Datei
```

## API Endpoints

### Authentication
- `POST /api/auth/login` — Login (username, password)
- `POST /api/auth/verify` — Token Verifikation

### Sound Library
- `GET /api/library` — Alle Dateien
- `POST /api/library/upload` — Datei(en) hochladen
- `PATCH /api/library/:id/active` — Active-Flag toggeln
- `DELETE /api/library/:id` — Datei löschen
- `GET /api/library/:id/audio` — Audio streamen
- `GET /api/library/random` — Zufällige aktive Datei

### Scores
- `POST /api/scores` — Score speichern
- `GET /api/scores/highscores` — Top 10 Global
- `GET /api/scores/me` — Eigene Top 10

## Ports & Services

| Service | Port | URL |
|---------|------|-----|
| Frontend (Nginx) | 8090 | `http://localhost:8090` |
| Backend (Express) | 3001 | `http://localhost:3001/api` |

## Umgebungsvariablen

```env
JWT_SECRET=proaudio-secret-change-in-prod    # Ändern in Production!
NODE_ENV=production                          # oder development
PORT=3001                                    # Backend Port (intern)
```

## Troubleshooting

**"Connection refused" beim Start:**
- Stelle sicher, dass Port 8090 nicht belegt ist
- Nutze `docker-compose logs` für Fehlerdiagnose

**Audio-Upload schlägt fehl:**
- Maximale Dateigröße: 200 MB
- Unterstützte Formate: WAV, MP3, OGG, FLAC, AIFF, M4A

**Fehler "No audio files":**
- Lade Dateien in der Sound Library hoch
- Markiere mindestens eine Datei als "ACTIVE"

## Performance & Sicherheit

✓ JWT-Authentifizierung
✓ CORS aktiviert
✓ Health Checks für alle Services
✓ Multi-stage Docker Builds
✓ Input-Validierung auf Backend
✓ 200MB Upload-Limit
✓ Dateisystem-Speicherung (keine DB nötig)

## Lizenz

Open Source — frei nutzbar und erweiterbar.

---

**Version:** 2.0 | **Letztes Update:** 2026-02-28
