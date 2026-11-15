import { describe, expect, it } from 'vitest';
import { describeWhen, parseWhen, speakable, takeSentences } from '../src/shared/when';
import { expand, parseIcs } from '../src/brain/ics';
import { parseForecast, weatherSentence } from '../src/brain/weather';
import { parseDuck } from '../src/brain/web';
import { splitCommands, wantsAction } from '../src/brain/brain';

const now = new Date(2026, 10, 14, 8, 40); // Saturday 14 Nov 2026, 08:40
const at = (s: string) => { const t = parseWhen(s, now); return t === null ? null : new Date(t).toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); };

describe('parseWhen', () => {
  it('understands everyday phrases', () => {
    expect(at('tomorrow at 9am')).toBe('Sun 15 Nov, 09:00');
    expect(at('tomorrow 5pm')).toBe('Sun 15 Nov, 17:00');
    expect(at('in 20 minutes')).toBe('Sat 14 Nov, 09:00');
    expect(at('in an hour')).toBe('Sat 14 Nov, 09:40');
    expect(at('Friday at 5pm')).toBe('Fri 20 Nov, 17:00');
    expect(at('on friday')).toBe('Fri 20 Nov, 09:00');
    expect(at('tonight')).toBe('Sat 14 Nov, 19:00');
    expect(at('at 5')).toBe('Sat 14 Nov, 17:00');
    expect(at('at 7:30')).toBe('Sun 15 Nov, 07:30');
    expect(at('3rd of March')).toBe('Wed 03 Mar, 09:00');
    expect(at('2026-11-20T14:30')).toBe('Fri 20 Nov, 14:30');
    expect(at('next week')).toBe('Sat 21 Nov, 09:00');
    expect(at('whenever')).toBeNull();
  });
  it('describes times naturally', () => {
    expect(describeWhen(parseWhen('tomorrow at 9am', now)!, now)).toBe('tomorrow at 9am');
    expect(describeWhen(parseWhen('friday 5:30pm', now)!, now)).toBe('Friday at 5:30pm');
  });
});

describe('speech text', () => {
  it('releases whole sentences as text streams in', () => {
    let r = takeSentences('Hello Josh. It is 5');
    expect(r).toEqual({ sentences: ['Hello Josh.'], rest: 'It is 5' });
    r = takeSentences('Dr. Patel moved it. Fine');
    expect(r.sentences).toEqual(['Dr. Patel moved it.']);
    expect(takeSentences('It is 3.5 degrees', true).sentences).toEqual(['It is 3.5 degrees']);
    expect(takeSentences('Done', true)).toEqual({ sentences: ['Done'], rest: '' });
  });
  it('cleans text for speaking', () => {
    expect(speakable('**Done.** See https://x.com/a 19° now')).toBe('Done. See a link 19 degrees now');
  });
});

describe('calendar feeds', () => {
  const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:a', 'SUMMARY:Dentist\\, check-up', 'DTSTART:20261116T100000Z', 'DTEND:20261116T103000Z', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:b', 'SUMMARY:Seminar', 'DTSTART;TZID=Europe/London:20261103T140000', 'DTEND;TZID=Europe/London:20261103T153000', 'RRULE:FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20261231T000000Z', 'EXDATE;TZID=Europe/London:20261119T140000', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:c', 'SUMMARY:Mum birthday', 'DTSTART;VALUE=DATE:20200118', 'RRULE:FREQ=YEARLY', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  it('parses and expands repeats, time zones and exceptions', () => {
    const from = Date.UTC(2026, 10, 14), to = Date.UTC(2026, 10, 28);
    const evs = expand(parseIcs(ics), from, to);
    expect(evs.map((e) => `${e.title} ${new Date(e.start).toISOString().slice(5, 16)}`)).toEqual([
      'Dentist, check-up 11-16T10:00', 'Seminar 11-17T14:00', 'Seminar 11-24T14:00', 'Seminar 11-26T14:00',
    ]);
    const jan = expand(parseIcs(ics), Date.UTC(2027, 0, 1), Date.UTC(2027, 0, 31));
    expect(jan.map((e) => e.title)).toEqual(['Mum birthday']);
    expect(jan[0].allDay).toBe(true);
  });
});

describe('weather and web parsing', () => {
  it('reads an Open-Meteo forecast', () => {
    const w = parseForecast({ current: { temperature_2m: 8.6, apparent_temperature: 5.2, weather_code: 61, wind_speed_10m: 12.4, precipitation: 0.3, is_day: 1 },
      daily: { time: ['2026-11-14', '2026-11-15'], weather_code: [61, 3], temperature_2m_max: [10.1, 9], temperature_2m_min: [4.4, 3], precipitation_probability_max: [80, 20] },
      hourly: { time: ['2026-11-14T09:00'], temperature_2m: [8], weather_code: [61], precipitation_probability: [70] } }, 'Stockport');
    expect(w.temp).toBe(9);
    expect(w.label).toBe('Light rain');
    expect(weatherSentence(w)).toBe('light rain and 9° in Stockport, feels like 5°. High of 10°, low of 4°, with a 80% chance of rain');
  });
  it('reads search results', () => {
    const hits = parseDuck('<div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=1">Example <b>Title</b></a><a class="result__snippet" href="x">A <b>short</b> snippet.</a></div>');
    expect(hits).toEqual([{ title: 'Example Title', snippet: 'A short snippet.', url: 'https://example.com/a' }]);
  });
});

describe('compound commands', () => {
  it('splits two requests and leaves ordinary sentences alone', () => {
    expect(splitCommands('Turn the volume down to 30 and open Safari')).toEqual(['Turn the volume down to 30', 'open Safari']);
    expect(splitCommands('Play some music, then set a timer for five minutes.')).toEqual(['Play some music', 'set a timer for five minutes']);
    expect(splitCommands('Remind me to buy bread and butter')).toEqual(['Remind me to buy bread and butter']);
    expect(splitCommands("What's on my calendar today, and do I have any unread emails?")).toHaveLength(1);
    expect(splitCommands('Add milk to my list and remind me to call mum tomorrow at 5')).toEqual(['Add milk to my list', 'remind me to call mum tomorrow at 5']);
  });
});

describe('wantsAction', () => {
  it('tells requests from questions and chat', () => {
    for (const t of ['Open Safari', 'Jarvis, could you turn the volume down?', 'please remind me to call mum', "I've finished calling the dentist", 'Can you play some music?', 'Track Spotify, 11.99 a month', 'look up the weather in Paris']) expect(wantsAction(t), t).toBe(true);
    for (const t of ['Do I have any unread emails?', "What's on today?", 'How are you?', 'Who wrote Pride and Prejudice?', 'Good morning', 'What should I focus on today?', 'I think we should order pizza']) expect(wantsAction(t), t).toBe(false);
  });
});

import { dayKey, daysUntil, focusStats, inDays, isFocusStop, matchCountdown, matchHabit, parseFocus, spokenMinutes, streak } from '../src/brain/life';
import { harkContext, pickRecordings, readHark } from '../src/brain/hark';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('focus, habits and countdowns', () => {
  it('understands how people ask for a focus session', () => {
    expect(parseFocus('start a 45 minute focus session on contract law')).toEqual({ minutes: 45, subject: 'Contract law' });
    expect(parseFocus('focus for 25 minutes')).toEqual({ minutes: 25, subject: '' });
    expect(parseFocus('study tort for an hour')).toEqual({ minutes: 60, subject: 'Tort' });
    expect(parseFocus("let's focus")).toEqual({ minutes: 25, subject: '' });
    expect(parseFocus('start a focus session')).toEqual({ minutes: 25, subject: '' });
    expect(parseFocus('start a pomodoro')).toEqual({ minutes: 25, subject: '' });
    expect(parseFocus('focus on my essay for an hour and a half')).toEqual({ minutes: 90, subject: 'Essay' });
    expect(parseFocus('start a ninety minute deep work block on the dissertation')).toEqual({ minutes: 90, subject: 'Dissertation' });
    expect(parseFocus('revise equity and trusts for 40 minutes')).toEqual({ minutes: 40, subject: 'Equity and trusts' });
  });
  it('leaves other requests alone', () => {
    for (const t of ['start a timer for 5 minutes', 'how much have I focused today', 'play some focus music', 'what time is it', 'open my study notes', 'start the washing machine', 'I need to study for my exam tomorrow']) expect(parseFocus(t)).toBeNull();
    expect(isFocusStop('stop the focus session')).toBe(true);
    expect(isFocusStop("I'm done studying")).toBe(true);
    expect(isFocusStop('stop the music')).toBe(false);
  });
  it('counts streaks, keeping one alive until the day is over', () => {
    expect(streak(['2026-11-12', '2026-11-13', '2026-11-14'], '2026-11-14')).toBe(3);
    expect(streak(['2026-11-12', '2026-11-13'], '2026-11-14')).toBe(2);
    expect(streak(['2026-11-10', '2026-11-12'], '2026-11-14')).toBe(0);
    expect(streak(['2026-10-31', '2026-11-01'], '2026-11-01')).toBe(2);
  });
  it('adds up focus time', () => {
    const now = new Date(2026, 10, 14, 20).getTime();
    const at = (d: number, h: number) => new Date(2026, 10, d, h).getTime();
    const st = focusStats([{ id: 'a', subject: 'Tort', start: at(14, 9), minutes: 50 }, { id: 'b', subject: 'Contract', start: at(14, 14), minutes: 25 }, { id: 'c', subject: 'Tort', start: at(13, 10), minutes: 45 }, { id: 'd', subject: '', start: at(1, 10), minutes: 99 }], now);
    expect(st.today).toBe(75);
    expect(st.week).toBe(120);
    expect(st.streak).toBe(2);
    expect(st.bySubject).toEqual([['Tort', 95], ['Contract', 25]]);
    expect(st.last7).toEqual([0, 0, 0, 0, 0, 45, 75]);
    expect(dayKey(at(14, 23))).toBe('2026-11-14');
    expect(spokenMinutes(95)).toBe('1 hour 35 minutes');
    expect(spokenMinutes(1)).toBe('1 minute');
  });
  it('finds the habit or countdown someone means', () => {
    const habits = [{ id: '1', name: 'Workout', days: [], at: 0 }, { id: '2', name: 'Read 20 pages', days: [], at: 0 }, { id: '3', name: 'Meditate', days: [], at: 0 }];
    expect(matchHabit(habits, 'my workout')?.id).toBe('1');
    expect(matchHabit(habits, 'reading')?.id).toBe('2');
    expect(matchHabit(habits, 'meditation')?.id).toBe('3');
    expect(matchHabit(habits, 'the tort essay')).toBeUndefined();
    const cds = [{ id: 'x', title: 'Tort exam', date: 0 }, { id: 'y', title: 'Holiday in Lisbon', date: 0 }];
    expect(matchCountdown(cds, 'my tort exam')?.id).toBe('x');
    expect(matchCountdown(cds, 'lisbon')?.id).toBe('y');
    expect(matchCountdown(cds, 'christmas')).toBeUndefined();
    const now = new Date(2026, 10, 14, 23, 30).getTime();
    expect(daysUntil(new Date(2026, 10, 15, 0, 5).getTime(), now)).toBe(1);
    expect(inDays(0)).toBe('today');
    expect(inDays(12)).toBe('in 12 days');
    expect(inDays(21)).toBe('in 3 weeks');
  });
});

describe('Hark link', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-hark-'));
  const put = (id: string, meeting: object, paras: object[]) => {
    fs.mkdirSync(path.join(dir, 'conversations', id), { recursive: true });
    fs.writeFileSync(path.join(dir, 'conversations', id, 'meeting.json'), JSON.stringify(meeting));
    fs.writeFileSync(path.join(dir, 'conversations', id, 'transcript.json'), JSON.stringify(paras));
  };
  put('a1', { title: 'Weekly product sync', status: 'ready', createdAt: Date.now() - 864e5, duration: 1260, speakers: [{ id: 'S1', name: 'Priya', named: true }, { id: 'S2', name: 'Speaker 2' }],
    summary: { overview: 'The team set the launch date.', keyPoints: ['Launch moves to 3 March'], decisions: ['Ship without the press release'], actions: [{ text: 'Recruit 50 beta customers', owner: 'George', due: 'Friday', done: false }, { text: 'Book the venue', done: true }] } },
    [{ sp: 'S1', text: 'I think the launch should move to the third of March.' }, { sp: 'S2', text: 'The password reset email is still slow.' }]);
  put('b2', { title: 'Landlord call', status: 'ready', createdAt: Date.now() - 5 * 864e5, duration: 300, speakers: [], summary: { overview: 'Boiler repair agreed.', keyPoints: [], decisions: [], actions: [] } }, []);
  put('c3', { title: 'Half done', status: 'processing', createdAt: Date.now() }, []);
  fs.mkdirSync(path.join(dir, 'conversations', 'junk'));
  it('reads finished conversations, newest first', () => {
    const recs = readHark(dir)!;
    expect(recs.map((r) => r.title)).toEqual(['Weekly product sync', 'Landlord call']);
    expect(recs[0]).toMatchObject({ minutes: 21, speakers: ['Priya'] });
    expect(readHark(path.join(dir, 'nope'))).toBeNull();
  });
  it('picks the recording a question is about and quotes it', () => {
    const recs = readHark(dir)!;
    expect(pickRecordings(recs, 'what did the landlord say about the boiler?')[0].title).toBe('Landlord call');
    expect(pickRecordings(recs, 'what was decided in my last meeting?').map((r) => r.title)).toEqual(['Weekly product sync']);
    const ctx = harkContext(dir, recs, 'when is the launch according to the product sync?');
    expect(ctx).toContain('Launch moves to 3 March');
    expect(ctx).toContain('George: Recruit 50 beta customers (due Friday)');
    expect(ctx).not.toContain('Book the venue');
    expect(ctx).toContain('Priya: “I think the launch should move to the third of March.”');
    expect(ctx).toContain('Other recordings: “Landlord call”');
  });
});

import { namesRecording } from '../src/brain/hark';
describe('recognising a question about a recording', () => {
  const recs = [{ title: 'Weekly product sync' }, { title: 'Landlord call' }, { title: 'Morning conversation, 14 Nov' }] as never;
  it('needs the title, not just one common word', () => {
    expect(namesRecording(recs, 'who is recruiting the beta customers from the product sync?')).toBe(true);
    expect(namesRecording(recs, 'what did we agree in the landlord call')).toBe(true);
    expect(namesRecording(recs, 'what is my weekly shop budget')).toBe(false);
    expect(namesRecording(recs, 'good morning')).toBe(false);
    expect(namesRecording(recs, 'call my landlord')).toBe(false);
  });
});

import { matchEntities, parseHomeCommand, type HaEntity } from '../src/brain/ha';
import { musicRequest, spotifyUri } from '../src/brain/web';
describe('home commands', () => {
  const e = (id: string, name: string, state = 'off', extra: Partial<HaEntity> = {}): HaEntity => ({ id, name, domain: id.split('.')[0], state, ...extra });
  const home = [e('light.kitchen_ceiling', 'Kitchen ceiling'), e('light.kitchen_counter', 'Kitchen counter'), e('light.lamp', 'Lamp', 'on', { brightness: 60 }), e('light.bedroom', 'Bedroom light'), e('switch.kitchen_kettle', 'Kitchen kettle'),
    e('scene.movie_night', 'Movie night'), e('climate.heating', 'Heating', 'heat', { temperature: 19, current: 18.4 }), e('cover.blinds', 'Living room blinds', 'open'), e('lock.front_door', 'Front door', 'locked')];
  const ids = (t: string) => { const c = parseHomeCommand(t, home); return c && 'targets' in c ? `${c.domain}.${c.service}:${c.targets.map((x) => x.id.split('.')[1]).join(',')}${c.data ? ':' + JSON.stringify(c.data) : ''}` : c && 'answer' in c ? c.answer : null; };
  it('turns things on and off', () => {
    expect(ids('turn on the kitchen lights')).toBe('homeassistant.turn_on:kitchen_ceiling,kitchen_counter');
    expect(ids('turn the lamp off')).toBe('homeassistant.turn_off:lamp');
    expect(ids('switch off the kitchen kettle')).toBe('homeassistant.turn_off:kitchen_kettle');
    expect(ids('turn off all the lights')).toBe('homeassistant.turn_off:kitchen_ceiling,kitchen_counter,lamp,bedroom');
    expect(ids('bedroom light on')).toBe('homeassistant.turn_on:bedroom');
  });
  it('handles brightness, heating, scenes, blinds and locks', () => {
    expect(ids('dim the lamp to 30 percent')).toBe('light.turn_on:lamp:{"brightness_pct":30}');
    expect(ids('set the heating to 21 degrees')).toBe('climate.set_temperature:heating:{"temperature":21}');
    expect(ids('activate movie night')).toBe('scene.turn_on:movie_night');
    expect(ids('close the living room blinds')).toBe('cover.close_cover:blinds');
    expect(ids('unlock the front door')).toBe('lock.unlock:front_door');
  });
  it('answers questions about the home', () => {
    expect(ids('is the lamp on')).toBe('Lamp is on, at 60 percent.');
    expect(ids("what's the temperature")).toBe('Heating is at 18.4 degrees, set to 19.');
  });
  it('leaves everything else alone', () => {
    for (const t of ['turn off the music', 'set a timer for 10 minutes', 'turn up the volume', 'open spotify', 'set the volume to 30', 'turn on do not disturb', 'what time is it', 'remind me to lock the front door at 9']) expect(parseHomeCommand(t, home)).toBeNull();
    expect(matchEntities(home, 'garage')).toEqual([]);
  });
});
describe('music requests', () => {
  it('works out what is being asked for', () => {
    expect(musicRequest('Blinding Lights by The Weeknd')).toEqual({ query: 'Blinding Lights by The Weeknd', kind: 'track' });
    expect(musicRequest('some Fleetwood Mac')).toEqual({ query: 'Fleetwood Mac', kind: 'artist' });
    expect(musicRequest('the album Rumours')).toEqual({ query: 'Rumours', kind: 'album' });
    expect(musicRequest('my deep focus playlist on spotify')).toEqual({ query: 'deep focus', kind: 'playlist' });
    expect(musicRequest('bohemian rhapsody')).toEqual({ query: 'bohemian rhapsody', kind: null });
  });
  it('picks the right Spotify address from search results', () => {
    const hits = [{ title: 'Rumours - Album by Fleetwood Mac | Spotify', snippet: '', url: 'https://open.spotify.com/album/1bt6q2SruMsBtcerNVtpZB' }, { title: 'Dreams - song and lyrics by Fleetwood Mac | Spotify', snippet: '', url: 'https://open.spotify.com/intl-de/track/0ofHAoxe9vBkTCp2UQIavz?si=x' }, { title: 'Something else', snippet: '', url: 'https://example.com/track/abc' }];
    expect(spotifyUri(hits, null)).toMatchObject({ uri: 'spotify:track:0ofHAoxe9vBkTCp2UQIavz', title: 'Dreams' });
    expect(spotifyUri(hits, 'album')?.uri).toBe('spotify:album:1bt6q2SruMsBtcerNVtpZB');
    expect(spotifyUri(hits, 'playlist')?.uri).toBe('spotify:track:0ofHAoxe9vBkTCp2UQIavz');
    expect(spotifyUri([hits[2]], null)).toBeNull();
  });
});

import { coverage, deckStats, grade, matchDecks, parseCsv, parseDeck, parseNotes, pickCards, record, studyContext, vocabulary, type Progress } from '../src/brain/study';
describe('revision', () => {
  const csv = 'Question,Answer\nWhat is an offer?,"A definite statement of the terms on which the offeror is willing to be bound, made with the intention that it becomes binding as soon as it is accepted."\nWhat happened in Hyde v Wrench (1840)?,"Wrench offered his farm for £1,000; Hyde offered £950, then tried to accept the original offer. The counter-offer had destroyed it, so there was no contract."\n"Say ""hello""",plain\n';
  const deck = parseDeck('flashcards/contract-agreement.csv', csv)!;
  const tort = parseDeck('flashcards/tort-negligence-core.csv', 'Question,Answer\nWhat four things must a claimant prove to win in negligence?,"A duty of care, a breach of that duty, causation and damage that is not too remote."\n')!;
  it('reads flashcard files', () => {
    expect(parseCsv('a,"b,c"\r\n"d ""e""",f\n')).toEqual([['a', 'b,c'], ['d "e"', 'f']]);
    expect(deck).toMatchObject({ id: 'contract-agreement', module: 'contract', name: 'Contract agreement' });
    expect(deck.cards).toHaveLength(3);
    expect(deck.cards[2]).toMatchObject({ q: 'Say "hello"', a: 'plain' });
    expect(deck.cards[0].key).toBe(parseDeck('x/contract-agreement.csv', csv)!.cards[0].key);
  });
  it('marks spoken answers by substance, not wording', () => {
    const a = deck.cards[0].a;
    expect(grade("it's a definite statement of terms that the offeror intends to be bound by once it's accepted", a)).toBe('right');
    expect(grade('a statement of terms someone is willing to be bound by', a)).not.toBe('wrong');
    expect(grade('an invitation for other people to negotiate', a)).toBe('wrong');
    expect(grade('', a)).toBe('wrong');
    expect(grade('duty, breach, causation, and the damage must not be too remote', tort.cards[0].a)).toBe('right');
    expect(grade('duty and breach', tort.cards[0].a)).toBe('close');
    const fisher = "A shopkeeper displayed a flick knife in his window and was charged with 'offering for sale' a prohibited weapon. The display was only an invitation to treat, not an offer, so he was not guilty.";
    expect(grade('The shopkeeper was found guilty because the knife was on sale', fisher)).toBe('wrong');
    expect(grade("the shopkeeper displayed a flick knife, the display was an invitation to treat and not an offer so he wasn't guilty", fisher)).toBe('right');
    expect(grade('He left the crossing gate open and someone died, so he was not guilty of manslaughter', 'A railway gatekeeper left the level-crossing gate open and a person was killed. His contractual duty created a duty to the public, so he was guilty of manslaughter by omission.')).toBe('wrong');
    expect(coverage('the counter offer destroyed the original offer so no contract', deck.cards[1].a)).toBeGreaterThan(0.4);
  });
  it('spaces cards out and brings missed ones back', () => {
    const p: Progress = {};
    const now = 1_000_000_000_000;
    record(p, 'a', true, now);
    expect(p.a).toMatchObject({ box: 1, seen: 1, right: 1 });
    expect(p.a.due - now).toBe(864e5);
    record(p, 'a', true, now);
    expect(p.a.due - now).toBe(3 * 864e5);
    record(p, 'a', false, now);
    expect(p.a).toMatchObject({ box: 0, seen: 3, right: 2 });
    expect(p.a.due - now).toBe(600000);
    const prog: Progress = { [deck.cards[0].key]: { box: 3, due: now + 5 * 864e5, seen: 3, right: 3 }, [deck.cards[1].key]: { box: 0, due: now - 1, seen: 1, right: 0 } };
    expect(pickCards([deck], prog, 10, now).map((c) => c.q)).toEqual([deck.cards[1].q, deck.cards[2].q]);
    expect(deckStats([deck], prog, now)[0]).toMatchObject({ total: 3, due: 1, fresh: 1, solid: 1 });
  });
  it('finds the deck someone asks for', () => {
    expect(matchDecks([deck, tort], 'contract').map((d) => d.id)).toEqual(['contract-agreement']);
    expect(matchDecks([deck, tort], 'tort law').map((d) => d.id)).toEqual(['tort-negligence-core']);
    expect(matchDecks([deck, tort], 'negligence').map((d) => d.id)).toEqual(['tort-negligence-core']);
    expect(matchDecks([deck, tort], '')).toHaveLength(2);
    expect(matchDecks([deck, tort], 'land law')).toHaveLength(0);
  });
  it('answers law questions from the notes, and only law questions', () => {
    const notes = parseNotes('notes/contract/ch01-agreement-map.md', '# Chapter 1: Agreement\n\n```mermaid\nflowchart TD\n A-->B\n```\n\n## Ending an offer\n\n**Counter-offer** — a response that changes the terms; it **rejects** the original offer.\n- **Hyde v Wrench (1840)** — Wrench offered his farm for £1,000; Hyde offered £950, which was refused. The counter-offer had destroyed the original offer.\n');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ module: 'contract', title: 'Chapter 1: Agreement: Ending an offer' });
    expect(notes[0].text).not.toContain('flowchart');
    const lib = { decks: [deck, tort], notes };
    const v = vocabulary(lib);
    expect(studyContext(lib, v, 'What happened in Hyde v Wrench?')).toContain('counter-offer had destroyed');
    expect(studyContext(lib, v, 'what does a claimant have to prove in negligence')).toContain('duty of care');
    for (const q of ["what's the weather like", 'remind me to call mum', 'what time is my seminar tomorrow', 'play some jazz', 'how are my habits going']) expect(studyContext(lib, v, q)).toBe('');
  });
});

import { relevant, toolsFor, visibleText, trimPcm } from '../src/brain/brain';
import { parseMusic, parseSayVoices, wavSamples } from '../src/brain/mac';
import { eventOver } from '../src/shared/when';
describe('quick and correct replies', () => {
  it('hides a model\'s private reasoning, even mid-stream', () => {
    expect(visibleText('<think>the user wants safari</think>Opening Safari.')).toBe('Opening Safari.');
    expect(visibleText('<think>still thinking about')).toBe('');
    expect(visibleText('Hello <thi')).toBe('Hello ');
    expect(visibleText('Sure. <think>hmm</think> Done.')).toBe('Sure.  Done.');
    expect(visibleText('2 < 3 is true')).toBe('2 < 3 is true');
  });
  it('gives the model only the tools a request points at', () => {
    expect(toolsFor('Open Safari for me', true, false)).toEqual(['open_app_or_website']);
    expect(toolsFor('remind me to water the plants', true, false)).toEqual(['add_task']);
    expect(toolsFor('How should I spend this evening?', false, false)).toEqual([]);
    expect(toolsFor('Who won the 1966 World Cup?', false, true)).toEqual(['web_search']);
    expect(toolsFor('set a timer and play some music and open mail and lock the screen', true, false).length).toBeLessThanOrEqual(3);
  });
  it('only shows the model the parts of the day a question is about', () => {
    const on = (q: string) => Object.entries(relevant(q)).filter(([, v]) => v).map(([k]) => k);
    expect(on('tell me a joke')).toEqual([]);
    expect(on('do I need a coat?')).toEqual(['weather']);
    expect(on('how should I spend this evening?')).toEqual(['weather', 'calendar', 'tasks']);
    expect(on('what did that email from Sam say')).toEqual(['mail']);
    expect(on('can I afford another subscription')).toEqual(['money']);
  });
});
describe('calendar, music and voices on the Mac', () => {
  const at = (d: number, h = 0, m = 0) => new Date(2026, 10, d, h, m).getTime();
  it('drops an all-day event once its day has passed, however the end is written', () => {
    const now = at(15, 9);
    expect(eventOver({ start: at(14), end: at(15), allDay: true }, now)).toBe(true); // ends at midnight
    expect(eventOver({ start: at(14), end: at(14, 23, 59), allDay: true }, now)).toBe(true); // ends 23:59
    expect(eventOver({ start: at(14), end: at(15, 1), allDay: true }, now)).toBe(true); // shifted by a time zone
    expect(eventOver({ start: at(15), end: at(16), allDay: true }, now)).toBe(false); // today
    expect(eventOver({ start: at(14), end: at(17), allDay: true }, now)).toBe(false); // spans today
    expect(eventOver({ start: at(15), end: at(15), allDay: true }, now)).toBe(false); // zero length, today
    expect(eventOver({ start: at(15, 8), end: at(15, 8, 30) }, now)).toBe(true);
    expect(eventOver({ start: at(15, 8), end: at(15, 10) }, now)).toBe(false);
  });
  it('reads what is playing', () => {
    expect(parseMusic('Spotify', 'off')).toBeNull();
    expect(parseMusic('Spotify', 'playing\nBlinding Lights\nThe Weeknd\nAfter Hours\nhttps://i.scdn.co/image/x\n42,5\n200040\n63')).toEqual({ app: 'Spotify', state: 'playing', title: 'Blinding Lights', artist: 'The Weeknd', album: 'After Hours', art: 'https://i.scdn.co/image/x', position: 42.5, duration: 200.04, volume: 63 });
    expect(parseMusic('Music', 'paused\nSong\nBand\n\n\n10\n185.3\n40')).toMatchObject({ state: 'paused', title: 'Song', duration: 185.3, art: undefined });
    expect(parseMusic('Spotify', 'paused\n\n\n\n\n0\n0\n50')).toEqual({ app: 'Spotify', state: 'stopped', volume: 50 });
  });
  it('lists Mac voices and reads their audio', () => {
    expect(parseSayVoices('Albert              en_US    # Hello\nJamie (Premium)     en_GB    # Hello\nAmélie              fr_CA    # Bonjour').map((v) => v.id)).toEqual(['mac:Jamie (Premium)', 'mac:Albert']);
    const wav = Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVEfmt \x10\0\0\0', 'latin1'), Buffer.alloc(16), Buffer.from('LIST\x04\0\0\0abcddata\x06\0\0\0', 'latin1'), Buffer.from([1, 0, 2, 0, 3, 0])]);
    expect([...wavSamples(wav)]).toEqual([1, 0, 2, 0, 3, 0]);
    const pcm = Buffer.alloc(24000 * 2);
    for (let i = 6000; i < 12000; i++) pcm.writeInt16LE(8000, i * 2);
    expect(trimPcm(pcm).length / 2).toBeLessThan(7500);
  });
});
