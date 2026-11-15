# Jarvis build log (for resuming across sessions)

Request (Josh, 14 Nov 2026): the "ultimate interactive Jarvis assistant", modelled on his LIFE·OS dashboard photo
(clock, weather, assistant orb with talk, "what needs you", inbox, upcoming, tasks & reminders, home, now playing,
money, notebook, integration status, dock). Must: run unlimited with no API cost, speak in a natural voice, know his
name, keep its own memory database, install on MacBook and phone with shared memory, look like a superhero-film HUD.
Wants it working by 12pm UK time on 14 Nov.

## Architecture (decided)
- Mac app (Electron) = the brain. `src/brain` is plain Node (no Electron imports) so it runs and is tested headless:
  HTTP + WebSocket server (default port 7717), JSON-file store, memory with embeddings, agent with tools.
- AI is local: llama.cpp (Qwen 3.5 GGUF) via node-llama-cpp, run under real Node (Electron's allocator crashes on
  big allocations: see Hark); Whisper + MiniLM via @huggingface/transformers; Kokoro-82M voice via kokoro-js.
- UI (`src/ui`, React + Vite) always talks to the brain over WebSocket, in Electron and on the phone alike.
  Phone installs it as a home-screen app (PWA) from the Mac's address; pairing by QR code + token.
  Microphone on iPhone needs HTTPS: recommended path is Tailscale (`tailscale serve`), which also works away from home.
- Mac integrations (music, mail, calendar, shortcuts/home, system) go through `osascript`; they cannot be tested in the
  Linux build container, so there is a fake implementation (JARVIS_FAKE_MAC=1) for tests. Calendar also supports ICS URLs.
- Code lives on branch `claude/hopeful-brahmagupta-y0gpgx` of Joshbot5000/lore (orphan branch, Jarvis only).
  Hark (the Otter rebuild) is on the same branch name in Joshbot5000/pdf-reader.
- Test models are in /home/user/hark/scratch/models (re-download from Hugging Face if the container was reset).

## Status (updated 14 Nov, ~09:00 UK)
- [x] scaffold, brain server, store
- [x] llm worker with tool calling; agent + tools; memory (tested headless with qwen-2b and qwen-4b)
- [x] speech in / voice out (tests/voice.mjs: transcript, wake-word gating, spoken reply)
- [x] dashboard UI, desktop + phone (tests/look.mjs screenshots, no console errors)
- [x] Electron shell first-run flow (tests/shell.mjs), installer script, packaging config
- [x] README, unit tests
- [ ] NOT yet run on a real Mac: AppleScript integrations, permission prompts, Metal. Live weather / web search
      could not be reached from the build container (network policy), only their parsers are tested.
- [x] Upgrade (14 Nov, afternoon): focus sessions, habits, countdowns, routines, evening review, Hark link
      (src/brain/hark.ts reads Hark's library read-only), clipboard, summon hotkey + menu-bar icon.
      Pure logic in src/brain/life.ts. Test: `node tests/life.mjs [--llm]` (starts its own brain; 25 checks).
- [x] Round 3 (14 Nov, evening), after Josh's first real use ("slow to respond, voice sounds manufactured"):
      * Voice: Kokoro fp32 instead of q8 (cleaner, ~2.5x faster on CPU); padding silence trimmed from every clip
        (was ~0.75 s per sentence) and replaced by a short gap chosen by punctuation; speech starts at the first
        clause; chime when you stop talking; engines warmed at start.
      * Speed: many more instant answers that skip the language model (what's playing, weather, calendar, list,
        mail, home); shorter history and replies; per-reply stage timings ("heard / thought / voice") shown under
        the reply so real numbers from his Mac can guide the next round.
      * Spotify: "what song is this", "play <song/artist/album/playlist>" (finds the Spotify address through a
        web search, then plays it by AppleScript; opens the in-app search if nothing is found).
      * Home Assistant (src/brain/ha.ts) and IMAP mail (src/brain/imap.ts, imapflow). Secrets in secrets.json,
        never in settings, snapshots or exports. Test: `node tests/home.mjs` (stand-in HA + IMAP servers; 31 checks).
      * NOT verified on real hardware/services: Metal speed, real Home Assistant, real Gmail IMAP, DuckDuckGo
        lookups for Spotify (search engine is blocked in the build container).

## How to run the tests here
JARVIS_FAKE_MAC=1 JARVIS_DATA_DIR=/tmp/jv-data JARVIS_MODELS_DIR=/home/user/hark/scratch/models node out/main/headless.js
then tests/chat.mjs, tests/voice.mjs, tests/look.mjs against the printed address; tests/shell.mjs under xvfb-run.

- [x] Round 4 (15 Nov): revision from Josh's study repository (Joshbot5000/Law-Conversion-Course, the default
      `studySource`): src/brain/study.ts. Flashcard quiz by voice or tap with Leitner spaced repetition
      (progress in study.json), marking by keyword coverage plus a contradiction check (the user can overrule),
      law questions answered from the notes, and a spoken caveat when the notes don't cover a legal question.
      Also tuned for his Mac (M1, 8 GB): smaller LLM context; Hark releases its model when idle.
      Test: `node tests/study.mjs <study-folder> [--llm]` (20 checks). Live fetch from github.com is untested
      here (tested against a stand-in server and the cloned folder).
