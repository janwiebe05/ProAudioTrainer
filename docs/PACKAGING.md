# Packaging the desktop app (Windows / macOS / Linux)

ProAudioTrainer's desktop build is a [Tauri](https://tauri.app) app: a Rust
backend (`src-tauri/`, using the portable `paw-core` crate for all audio
DSP and a local SQLite database) plus the existing plain HTML/CSS/JS
frontend (`frontend/`) — no Node build step, no bundler.

Everything below was developed and tested in a **Linux-only container**.
Building a real Windows `.exe`/`.msi` or a real macOS `.app`/`.dmg`
genuinely requires running `cargo tauri build` *on that OS* — Tauri does
not cross-compile GUI installers from Linux. Two ways to get real
artifacts:

## Option A — GitHub Actions (no Windows/Mac hardware needed)

`.github/workflows/tauri-build.yml` builds Windows, macOS (universal
Intel+Apple Silicon), and Linux on GitHub's own runners.

- **Manual run:** Actions tab → "Build Desktop App" → *Run workflow*.
  Artifacts (unsigned) show up as workflow artifacts to download.
- **Release run:** push a tag like `v0.1.0` — it also creates a draft
  GitHub Release with the installers attached.

This is the practical default: it needs no local Windows/Mac machine at
all, just a GitHub repo.

## Option B — Building locally on real hardware

### Windows

1. Install [Rust](https://rustup.rs) (stable toolchain).
2. Install the **Microsoft C++ Build Tools** (Visual Studio Installer →
   "Desktop development with C++" workload). Tauri needs the MSVC linker.
3. `cargo install tauri-cli --version "^2.0" --locked`
4. From the repo root: `cargo tauri build`
5. Installer lands in `target/release/bundle/nsis/*.exe` (and `msi/*.msi`
   if you add `"msi"` to `tauri.conf.json`'s `bundle.targets`).

WebView2 (the runtime the app's UI renders in) ships with Windows 10/11 by
default; the NSIS installer bundles a fallback bootstrapper for machines
that somehow don't have it.

### macOS

1. Install Xcode Command Line Tools: `xcode-select --install`
2. Install [Rust](https://rustup.rs). For a universal binary (Intel +
   Apple Silicon in one file): `rustup target add aarch64-apple-darwin
   x86_64-apple-darwin`
3. `cargo install tauri-cli --version "^2.0" --locked`
4. `cargo tauri build --target universal-apple-darwin` (or omit `--target`
   for a single-architecture build matching your own Mac).
5. Output: `target/universal-apple-darwin/release/bundle/macos/*.app` and
   `.../dmg/*.dmg`.

### Linux (reference — this is what was actually verified in-container)

```bash
sudo apt-get install libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev \
  libssl-dev libayatana-appindicator3-dev build-essential
cargo install tauri-cli --version "^2.0" --locked
cargo tauri build --bundles deb   # or: appimage
```

This exact sequence was run during development — the resulting
`ProAudioTrainer_0.1.0_amd64.deb` was inspected directly (`dpkg-deb -c`) to
confirm the EchoThief impulse-response library (148 files) is correctly
bundled as a Tauri **resource** (`usr/lib/ProAudioTrainer/EchoThief/…`),
not just embedded frontend assets — see the `bundle.resources` entry in
`tauri.conf.json`. The same mechanism applies unchanged on Windows/macOS.

## Code signing & notarization (for real distribution)

Unsigned builds work fine for testing, but:

- **Windows** without an Authenticode signature triggers a SmartScreen
  "unknown publisher" warning. Get a code-signing certificate (OV is
  cheaper; EV avoids SmartScreen's reputation-building delay), then set
  the `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
  repo secrets used by the CI workflow (or configure
  `bundle.windows.certificateThumbprint` in `tauri.conf.json` for local
  builds against a certificate already installed in the Windows cert
  store).
- **macOS** without a Developer ID signature + notarization is blocked by
  Gatekeeper until the user right-click → *Open*s it once. Real
  distribution needs a paid [Apple Developer Program](https://developer.apple.com/programs/)
  membership ($99/yr): a "Developer ID Application" certificate for
  signing, and `xcrun notarytool` (or the `APPLE_ID`/`APPLE_PASSWORD`/
  `APPLE_TEAM_ID`/`APPLE_CERTIFICATE*` secrets the CI workflow already
  wires up) for notarization.

Neither is required to *try* the app — only for handing it to other people
without a scary OS warning in the way.

## Auto-updates

Not yet configured. Tauri has a built-in updater plugin
(`tauri-plugin-updater`) that works well once there's a stable release
channel to point it at — worth adding once the app is further along, not
before.
