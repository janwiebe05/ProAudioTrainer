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
  cheaper; EV avoids SmartScreen's reputation-building delay), then
  configure `bundle.windows.certificateThumbprint` in `tauri.conf.json`
  for local builds against a certificate installed in the Windows cert
  store, or the equivalent Azure Trusted Signing / signtool secrets for
  CI. (Note: `TAURI_SIGNING_PRIVATE_KEY`/`_PASSWORD`, mentioned below,
  are for the *auto-updater*'s signature, not Authenticode — two
  unrelated signing mechanisms that happen to share "signing" in the name.)
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

Configured via `tauri-plugin-updater` + `tauri-plugin-process` (for the
restart-after-install). The app checks `tauri.conf.json`'s
`plugins.updater.endpoints` on every startup (see `app.js`'s
`checkForUpdates()`) — pointed at
`https://github.com/<owner>/<repo>/releases/latest/download/latest.json`,
the file `tauri-apps/tauri-action` publishes automatically alongside the
installers when `.github/workflows/tauri-build.yml` runs on a tag push
(update the owner/repo in that URL if the repo ever moves).

**Before this does anything real, you must generate your own signing
keypair** — do not reuse a key someone else generated for you, since
whoever holds the private key can sign arbitrary update payloads your
users' installs will trust and auto-install:

```bash
cargo install tauri-cli --version "^2.0" --locked   # if not already installed
cargo tauri signer generate -w ~/.tauri/proaudiotrainer.key
```

This prompts for a password (recommended — an unprotected private key is
one leaked laptop away from being able to push malicious "updates" to
every install). Then:

1. Copy the printed **public** key into `tauri.conf.json`'s
   `plugins.updater.pubkey` (replacing the placeholder value there).
2. Add two **repo secrets** (Settings → Secrets and variables → Actions):
   `TAURI_SIGNING_PRIVATE_KEY` (the full contents of the private key file)
   and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (the password you set above).
   `.github/workflows/tauri-build.yml` already reads both.
3. Push a version tag (e.g. `v0.1.0`) — the workflow builds, signs, and
   publishes a draft GitHub Release with the installers *and* the signed
   `latest.json`/`.sig` files the updater endpoint expects.

The placeholder pubkey currently checked into `tauri.conf.json` came from
a throwaway keypair generated without a password while wiring this up —
harmless (a public key can't sign anything), but replace it with your own
before publishing a real release, and never commit the private half
either way.
