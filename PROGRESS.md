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

- [x] Round 5 (15 Nov): voice. Josh: "still sounds way too stunted and robotic". Changes: sentences that arrive
      while the voice is busy are synthesised together as one passage (first passage short, later ones up to
      300 chars) instead of one clip per sentence; clause-splitting removed; pace 1.0; default voice is now a
      blend (bm_george*0.55+bm_fable*0.45; blending done in src/workers/tts.ts by overriding generate_from_ids);
      Mac system voices via `say` (src/brain/mac.ts voices/speak) selectable in Settings.
      Nobody has listened to any of this: the build container has no audio. Voice choice has to be made by ear
      on his Mac. Not done, needs his decision: a cloud voice (needs an account/key, sends replies off the Mac).

- [x] Round 6 (15 Nov): Josh's report from real use on his M1/8 GB (model = qwen-2b): replies took ~12 s, speech
      started then stalled, voice robotic, Gmail would not add, a past all-day event still showed, Spotify card
      said nothing playing while controls worked.
      * ROOT CAUSE of the delay (measured with the new per-reply stats in src/workers/llm.ts): any request that
        "wants an action" sent all 14 tool schemas (2,600 tokens to read) and the 2B model then wrote 260 tokens,
        leaked <think>, and called several wrong tools. Plain questions read 500-900 tokens and rambled.
        Fix: everyday commands are handled directly in quick() (open, volume, mute, lock, dark mode, schedule,
        tick off, track money, timers, weather elsewhere, greetings...); the model gets at most 3 tools chosen by
        wording (toolsFor), max 2 tool calls, a short persona, only the context sections the question touches
        (relevant), 4 messages of history, <think> stripped (visibleText), and is stopped after 2 sentences.
        Now ~250-300 tokens read, ~30 written. Note-taking (learn) is deferred and aborted by a new question.
      * Speech stall: a short first sentence was spoken alone and the long next passage took longer to make than
        the first took to play. Fix: short openers wait for the next sentence; passage length is limited by how
        much audio is already queued and the measured speed of the voice (playEnd/voiceRate in speakOut).
      * Cloud voices: src/brain/cloudvoice.ts (ElevenLabs flash v2.5, OpenAI gpt-4o-mini-tts), MP3 decoded in the
        browser; keys in secrets.json; falls back to the built-in voice with a notice if the provider fails.
      * Spotify: status script rewritten (each property in its own try, player state compared as a constant,
        newline-separated). The old `player state as string` is the suspected cause. Polls every 2.5 s.
      * Calendar: Apple Calendar is now read from the start of today (was: events starting after now, which
        dropped today's all-day and in-progress events); all-day events judged by date (eventOver); feed
        fetches time out; refresh on wake, at midnight, every 5 min, and by a button. CAUSE OF HIS STALE
        EVENT NOT CONFIRMED: the health check prints raw event times so it can be seen if it recurs.
      * Gmail: server's own refusal text is shown; step-by-step with links; Apple Mail fallback explained.
        Cause not confirmed (most likely a normal password instead of an app password).
      * Settings -> Health check (brain.diagnose()) for copy-paste diagnostics.
      Tests: home.mjs 54, life.mjs 25, study.mjs 20, unit 34. Still untested on real hardware/services.

- [x] Round 7 (15 Nov): Josh on the round-6 build: Spotify card shows "syntax error" and "1 integration failing";
      speech lags the text and stops for seconds after each full stop; wants cards to click through.
      * Spotify syntax error: my AppleScript used `st` as a variable (a reserved word, as in "1st"), in BOTH
        earlier versions, so it never compiled on a real Mac. Now read with JavaScript for Automation
        (musicJxa, executed for real in unit tests with a stub Application) with an AppleScript fallback that
        uses long names only. This was almost certainly the "1 integration failing" too; the label now names
        what is failing and shows why when clicked.
      * Speech: (1) ears and voice engines now run under plain Node in the Mac app, like the mind (Electron
        helper processes get low priority / efficiency cores on Apple Silicon: suspected cause of slow
        synthesis; NOT measured); audio to the speech engine is base64 so JSON IPC works. (2) Cloud voices are
        streamed as raw audio and played as they arrive. (3) If the built-in voice cannot keep ahead of its
        own speech (voiceRate < 1.6) the whole reply is spoken in one go instead of stalling between sentences.
        (4) A long opening sentence starts at its first clause.
      * Click-through: brain action openItem (email -> Gmail conversation via X-GM-THRID or message:// in
        Mail; inbox; event -> Calendar `show`, or Google Calendar day; song -> spotify: address). Phones get a
        web address back and open it themselves.
      Tests: home.mjs 56, life.mjs 25, study.mjs 20, unit 38, shell ok. Real Mac still unverified.
