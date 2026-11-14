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
