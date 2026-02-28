# PLAN.md — ProAudioTrainer v2 Architecture

## Übersicht

ProAudioTrainer v2 ist ein webbasiertes EQ-Trainingssystem mit Vintage-Hardware-Ästhetik. Es trainiert das Gehör zur Frequenzerkennung mit realistischem Zeit-Punktesystem.

## Architektur-Entscheidungen

### Backend — Node.js + Express
- **Gründe:**
  - Schnelle API, perfekt für WebAudio
  - Dateiverarbeitung (Multer)
  - JWT-Auth ist Standard
  - Fileystem-Storage ist ausreichend (kein DB overhead)

### Frontend — Vanilla JS + Canvas
- **Gründe:**
  - WebAudio API direkt nutzen
  - Frequenz-Visualisierung mit Canvas
  - Kein Framework-Overhead
  - 100% Kontrolle über Audio-Engine

### Storage — Dateisystem
- **Gründe:**
  - Keine Datenbank nötig
  - JSON für User/Scores simpel & performant
  - Uploads im `backend/uploads/` Ordner
  - Persistenz über Docker-Volumes

### Auth — JWT
- **Gründe:**
  - Stateless (keine Sessions nötig)
  - Perfekt für REST APIs
  - localStorage für Token (Frontend)
  - Refresh-Token Model später einfach erweiterbar

## Design-Philosophie

### Vintage Rack Unit Look
**Inspirationen:** SSL, Neve, UREI Hardware

**Visuelle Elemente:**
- Dunkelgrau/Anthrazit Chassis (`#1c1c1c` – `#333`)
- Warmgold Metallic-Akzente (`#c9a84c` – `#d4af37`)
- LED-Emulatoren mit Glow-Effekten
- Schrauben-Details (CSS-only)
- Horizontale Rippen-Struktur

**Keine Emojis** — echte Icons/Symbole nur wo nötig

**Typografie:**
- `Barlow Condensed` für Labels (70er/80er Vibe)
- `Share Tech Mono` für Zahlen/Werte
- Hohe Schriftengewichte (600–800)
- Breite Letter-Spacing

## Komponenten-Breakdown

### Login Screen
- Vollbild VU-Meter-Animation
- Einfach: Username + Passwort
- Schrauben-Details am Chassis
- Error-LED bei Fehler

### EQ Trainer Module
**Game State:**
- 3 Leben (LED-Indikator)
- Score, Level (1-3), Runden, Streak
- Phase: idle → listening → guessing → revealed → gameover

**Punkte-Formel:**
```javascript
maxTime = 10 sekunden
maxPoints = 1000
timeFactor = max(0, 1 - (seconds / maxTime))
precisionFactor = 1 - (octaveDist / tolerance)
points = round(maxPoints × timeFactor × precisionFactor)
points = max(0, points)
```

**Schwierigkeiten:**
- Level 1: ±1 Oktave
- Level 2: ±½ Oktave
- Level 3: ±¼ Oktave

**Audio Processing:**
- Dry/Wet-Gain-Mixing für A/B Vergleich
- Peaking EQ auf Zielfrequenz (+9dB, Q=2.0)
- Web Audio API AnalyserNode für Spectrum

**Canvas Visualization:**
- Logarithmische Frequenzachse (20Hz – 20kHz)
- Echtzeit Spektrum-Anzeige
- Toleranz-Zone (grün)
- Target-Marker (gold)
- Guess-Marker (orange)
- Mouse-Tracking für Live-Frequenz-Anzeige

### Sound Library Module
**Features:**
- Multi-File Upload (Drag & Drop)
- Metadaten: Name, Dauer, Größe, Upload-Datum
- Active-Toggle (für EQ Trainer)
- Delete-Action
- Preview-Button (kurzes Abspielen)

**Datenverwaltung:**
- JSON-Array in `backend/src/data/library.json`
- Physische Dateien in `backend/uploads/`
- UUID als Datei-ID

### Highscore System
**Speicherung:**
- JSON-Array: `backend/src/data/scores.json`
- Pro Score: username, score, rounds, level, streak, date
- Serverseitig sortiert (Top 10)

**Display:**
- Global Highscores in der Sidebar
- Nach jeder Session automatisch aktualisiert

## API Design

**REST Conventions:**
- GET — Read (Daten, Audio-Stream)
- POST — Create (Login, Score, Upload)
- PATCH — Update (Active-Flag)
- DELETE — Remove (Datei)

**Error Handling:**
- HTTP Status Codes (401, 404, 400, 500)
- JSON Error Objects: `{ error: "message" }`
- Consistent Error Messages (Deutsch für User)

**Auth Strategy:**
- POST /login → Token
- Alle geschützten Endpoints: `Authorization: Bearer <token>`
- JWT Verify in Middleware

## Sicherheit

✓ Passwörter mit bcrypt gehasht
✓ JWT Expiration (24h)
✓ CORS eingeschränkt
✓ Input-Validierung (Datei-Typen)
✓ File-Upload Limit (200MB)
✓ Keine Secrets im Code

## Performance-Optimierungen

✓ Canvas requestAnimationFrame (60fps)
✓ Audio-Buffer dekodierung async
✓ VU-Meter Update 800ms Intervale
✓ CSS Transitions statt JS-Animations
✓ Gzip via Nginx
✓ Static Files caching

## Skalierbarkeit

**Aktuelle Lösung:** Dateisystem (Single Container)

**Zukünftige Verbesserungen:**
1. PostgreSQL für Scores/Users (Skalierbarkeit)
2. S3/MinIO für Audio-Uploads
3. Redis für Session-Cache
4. Horizontal Scaling mit Load Balancer
5. WebSocket für Real-time Highscores

## Fehlerhandling

**Frontend:**
- Toast Notifications für User-Feedback
- Graceful API-Error Fallbacks
- Audio-Fehler → Neustart-Button

**Backend:**
- Try/Catch auf allen Routes
- Konsistent formatierte Fehler
- Health Check Endpoint
- Docker Health Checks

## Testing

**Manuell getestet:**
- Login/Logout Flow
- File Upload (verschiedene Formate)
- EQ Trainer Rundenablauf
- Score-Berechnung
- Browser-Kompatibilität

**Production-Ready Checklist:**
✓ Error Boundaries
✓ Input Validation
✓ Secure Default Config
✓ Health Checks
✓ Logging (Console)
✓ Docker Multi-Stage Build
✓ Volume Persistence

## Deployment

**Docker Compose:**
- 2 Services: Backend + Frontend
- Health Checks auf beide
- Named Volumes für Persistenz
- Bridge Network für Service-Kommunikation

**Production Checklist:**
1. `.env` mit sicherem JWT_SECRET
2. `docker-compose up -d --build`
3. Warten auf Health Checks
4. Test Login + Upload
5. Nginx https (optional, via Proxy)

## Zukünftige Features

- [ ] Dynamics Trainer (Kompression)
- [ ] Reverb Analyzer
- [ ] Frequency Matching Game
- [ ] Multiplayer Leaderboards
- [ ] Export Training-Statistiken
- [ ] Audio-Analysetools
- [ ] Custom EQ-Profile
- [ ] Mobile-App (React Native)
