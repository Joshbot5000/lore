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

## Status
- [ ] scaffold, brain server, store
- [ ] llm worker with tool calling; agent + tools; memory
- [ ] speech in / voice out
- [ ] dashboard UI (desktop + phone)
- [ ] Electron shell, installer, phone pairing
- [ ] Mac integrations
- [ ] end-to-end test run, README, push
