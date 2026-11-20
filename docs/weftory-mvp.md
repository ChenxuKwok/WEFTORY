# WEFTORY on Apple Silicon

WEFTORY is a workspace in the LobsterAI desktop application. It produces one
vertical video from one SKU and one virtual model. The app handles production
while it is running and resumes durable jobs when reopened.

## Local development

Use the Node and npm versions in `package.json`. Install the locked
dependencies and run `npm run electron:dev:openclaw` for the first startup.
For subsequent starts use `npm run electron:dev`. Keep FFmpeg and ffprobe with
libx264 and the subtitles filter at `/opt/homebrew/bin` or `/usr/local/bin`
for development.

Open **WEFTORY → Run a demo**. Review the storyboard, approve it and inspect
the 21-second demo render. Return it for rework and regenerate a shot to
exercise versioning. Approve the new render and export it from the review page.

## Live setup

1. Configure the existing desktop text model. In WEFTORY Setup, save a
   mainland Ark API key, one Seedream endpoint and one Seedance 2.x endpoint.
   The setup check verifies Ark authentication and video-task listing.
   Endpoint access and reference support require a sample generation.
2. Enter conservative per-request costs in CNY for the selected account.
   The queue reserves these amounts before submission. They are estimates.
   Changing setup applies to new runs. Increase an existing run's cap from
   its retry form. Inspect the vendor's task list before retrying a submission
   with an unknown result.
3. Import authorized JPEG or PNG photos, create the SKU and save a model.
   Prefer the matching official virtual portrait image reference as an
   `asset://…` ID. The first-frame route requires confirmation that the
   selected endpoint permits the reference. Verify SKU details and model
   consistency before approving a real render.
4. For Feishu, enable one bot in the existing IM settings and bind it to
   one operator's `open_id` in WEFTORY Setup. Grant the bot permissions to
   receive private messages, upload files and send messages. Use
   `/wft create SKU`, `/wft status ID`, `/wft pending`,
   `/wft approve-plan ID VERSION`, `/wft cancel ID` or the review command
   returned by `status`. An approved render is sent as an attachment.
   Use `/wft deliver ID` for a failed attachment. For uncertain delivery,
   check the private conversation first and use `/wft deliver ID confirm`
   only if manual resending is appropriate.

## macOS packaging

Build on Apple Silicon with `npm run dist:weftory:mac`. Set
`WEFTORY_MEDIA_DIR` to an absolute path containing reviewed standalone ARM64
`ffmpeg` and `ffprobe` binaries, `THIRD-PARTY-NOTICES.txt` and any license
files under `licenses/`. The notice should identify the exact source,
build configuration and distribution materials for the binaries and linked
libraries. The build checks platform, architecture, linkage and required
features. Keep the corresponding license and source materials available
through the approved release process.

Use the repository's signing and notarization configuration for distribution.
The release check uses the installed ARM64 app, three real sample runs,
a forced restart, a single-shot rework, and an approved Feishu attachment.

## Implementation progress · 2026-11-20

- Implemented the Apple Silicon workspace, SQLite-backed queue, budget
  reservations, editable six-shot storyboards, single-shot rework, and review
  tied to the current render's SHA-256. Added Ark adapters and authenticated
  Feishu commands and attachment delivery.
- Verified the demo in Electron from storyboard approval through playback,
  rework, reapproval, and native export. FFprobe confirmed H.264 at 1080×1920,
  30 fps, and 21 seconds. The exported file matched the approved render hash.
  Automated tests covered restart recovery and ambiguous paid submissions.
- The full suite passed with 9,224 tests passed and 180 skipped. Electron
  compilation, the production build, and changed-file lint passed.
- Built and checked the local ad-hoc-signed DMG at
  `release/weftory/WEFTORY-2026.11.16-arm64.dmg`. The disk-image checksum, ARM64
  app signature, bundled media tools, and compiled WEFTORY plugin were verified.
  The build omitted POPO, an optional upstream plugin whose registry timed out.
- Release acceptance still requires three real samples from an installed app
  using authorized SKU and portrait assets, a live Feishu attachment, and
  Developer ID signing and Apple notarization.
