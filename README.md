# Jarvis

Your own assistant, in the style of the films: he listens, speaks in a natural voice,
remembers what matters about you, runs a live dashboard of your day, and takes
actions on your Mac. He lives on your MacBook and follows you to your phone, with
one shared memory. Everything runs on your own hardware: no account, no API key,
no subscription, no usage limits, and nothing you say is uploaded.

## What he does

| | |
|---|---|
| **Talk** | Hold the space bar (or hold the glowing core) and speak. Or switch on **hands-free** and just say “Jarvis, …”. Replies are spoken in a neural British voice (ten voices to choose from), streamed sentence by sentence. Esc interrupts |
| **Remembers you** | Say “remember that…” or just talk: he quietly notes lasting things (who people are, what you like, where you need to be) and recalls the relevant ones by meaning in later conversations. Review, pin or delete anything in **Memory** |
| **Daily briefing** | “Brief me”: weather, today's calendar, what is due, unread mail, bills about to go out. Built from real data, never invented |
| **Reminders and tasks** | “Remind me to call the dentist tomorrow at 9.” Spoken reminder and notification when it is due. Now / Week / Later views |
| **Calendar** | Apple Calendar plus any calendar's private ICS link (Google, iCloud, Outlook), with repeating events. “Schedule dinner on Friday at 7” |
| **Inbox** | Unread mail from Apple Mail; “who emailed me?” |
| **Music** | Spotify or Apple Music: what's playing, play, pause, skip, volume, by button or voice |
| **Home** | Your Shortcuts as one-tap tiles and voice commands (“run movie night”), which is how HomeKit lights and scenes are controlled |
| **Money** | Bills, subscriptions and income: monthly outgoings, what's left, and a warning before a bill is due |
| **Notebook, timers** | “Note that the gate code is 4417.” “Set a pasta timer for 10 minutes.” |
| **Mac control** | Open apps and sites, set or mute volume, lock the screen, toggle dark mode |
| **Look things up** | Web search and Wikipedia when he needs a fact |
| **What needs you** | A live shortlist: overdue tasks, the next meeting, unread mail, a bill due, rain on the way |
| **Systems** | CPU, memory and battery gauges, and the state of his own mind, ears and voice |
| **Focus sessions** | “Start a 45 minute focus session on contract law.” He times it, tells you when it's up and logs it: today, the last seven days, time per subject, and a daily streak against your goal |
| **Habits** | “Add a habit called reading”, then “I did my reading”. Seven-day dots and streaks; a nudge in the evening for anything left |
| **Countdowns** | “Count down to my tort exam on 12 January.” “How many days until my exam?” Close ones appear in the briefing and in What needs you |
| **Routines** | One phrase runs several commands in order. “Good night” pauses the music and gives the evening review; make your own in Settings |
| **Evening review** | “How did today go?”: tasks finished, focus time against your goal, habits done and left, and what tomorrow starts with |
| **Your recordings** | If [Hark](https://github.com/Joshbot5000/pdf-reader/tree/claude/hopeful-brahmagupta-y0gpgx) is installed, ask “what was decided in my last meeting?” or “who is doing what from the product sync?”. Open action items from recordings show in What needs you |
| **Clipboard** | Copy any text, then “summarise what I copied” or “explain what I copied”. “Copy that” puts his last answer on the clipboard. The clipboard is only read when you mention it |
| **Summon anywhere** | Press Option+Space in any app to bring him up listening; press again to send. A menu-bar icon gives one-click briefing, review and focus sessions |
| **Phone** | The same Jarvis as a home-screen app on your phone, sharing memory, tasks and conversation live |

## Install on your Mac

1. Install Node.js (LTS) from https://nodejs.org (skip if you already have it).
2. Download this branch as a ZIP (green **Code** button → **Download ZIP**) and unzip it.
3. Double-click **Install Jarvis.command**. If macOS refuses, right-click → **Open** → **Open**.

Jarvis opens, asks your name and town, then downloads his on-device AI once
(about 1.5 GB on an 8 GB Mac, 3 GB on a 16 GB Mac). After that he works offline.

macOS will ask permission the first time he uses the microphone and the first time
he controls an app (Spotify, Mail, Calendar). Allow these or that feature stays off.

## Put him on your phone

On the Mac, click the phone icon in the top bar and scan the code with your phone's
camera. In Safari choose **Share → Add to Home Screen**. He now opens like an app.

Your phone talks to the Mac, which does the thinking, so:

- The Mac must be on and awake (Jarvis keeps running with the window closed).
- **On home Wi-Fi** the scanned link works straight away for the dashboard, typing
  and your keyboard's dictation key.
- **For the microphone button, and to reach him away from home**, iPhones require a
  secure (https) address. The free way: install **Tailscale** on the Mac and the phone,
  sign in to both, run `tailscale serve --bg 7717` in Terminal on the Mac, and paste the
  https address it prints into the pairing panel. Scan the new code.

## How the AI is built in

| Job | Model | Runs on |
|---|---|---|
| Mind (conversation, actions) | Qwen 3.5, 2B / 4B / 9B (4-bit), via llama.cpp | Apple GPU on Apple Silicon |
| Ears (speech to text) | OpenAI Whisper base or small | CPU |
| Voice | Kokoro-82M neural speech | CPU |
| Memory recall | MiniLM sentence embeddings | CPU |

Your data (memory, tasks, notes, chat) is plain JSON in
`~/Library/Application Support/jarvis/data`. Settings → Your data exports or imports
everything in one file.

## Honest limits

- The mind is a small on-device model. It is quick and private, but it will
  sometimes misunderstand or do only one of two things you asked for. The everyday
  commands (reminders, lists, notes, timers, music, “remember…”) are handled directly
  and do not depend on it.
- Built and tested on Linux with a stand-in for the Mac integrations. The parts that
  talk to macOS (Spotify/Music, Mail, Calendar, Shortcuts, volume, lock, the
  permission prompts) are written against Apple's scripting interfaces but have not
  yet been run on a real Mac; likewise live weather and web search, which the build
  machine could not reach. Expect to report a few rough edges.
- Apple Calendar scripting does not expand repeating events; use the calendar's
  ICS link for those.
- The phone is a window onto the Mac, not a second brain: no Mac, no Jarvis.
- There is no bank connection; Money is what you tell him.

## Development

```bash
npm install
npm run dev                 # desktop app with hot reload
npm run build && npm run brain   # the brain alone, headless: prints the address to open
npm test                    # unit tests (time phrases, calendar feeds, parsers)
node tests/chat.mjs  <address> "what's on today?"      # talk to a running brain
node tests/voice.mjs <address> clip.wav wake            # speech in, speech out
JARVIS_FAKE_MAC=1           # use the built-in stand-in for Mac apps
```

`src/brain` is plain Node (agent, tools, memory, integrations, server), `src/workers`
are the three AI engines, `src/ui` is the React interface served to every device,
`src/app` is the Electron shell.
