import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Memo } from '../src/meta/memo.ts';
import { transcribe } from '../src/meta/voice.ts';
import { Cast, designVoice, heardMatch, heardOk, previewText, profileKey, reusableDesign, speechRequest, stockVoices, storyLines, voiceCandidates, voiceLine } from '../src/sound/voices.ts';
import { soundQuality, ttsModel } from '../src/sound/cost.ts';
import { decode, encodeMp3, RATE, type Pcm } from '../src/sound/pcm.ts';
import { forgetEffect, soundEffect } from '../src/sound/sources.ts';
import { AUDIO_VALIDATION, makeSounds, seedLibrary } from '../src/sound/make.ts';
import type { SoundPlan } from '../src/sound/plan.ts';
import { spokenLine } from '../src/play/sound.ts';
import { Story } from '../src/story/schema.ts';
import { World } from '../src/world/schema.ts';
import { soundData } from '../src/sound/data.ts';
import { WorldFiles } from '../src/world/files.ts';
import { scene } from './fixtures/scene.ts';

vi.mock('../src/meta/voice.ts', () => ({ transcribe: vi.fn() }));
vi.mock('../src/sound/sources.ts', () => ({ elevenKey: () => 'test', soundEffect: vi.fn(), forgetEffect: vi.fn(), elevenMusic: vi.fn(), musicgen: vi.fn(), MUSICGEN_MODEL: 'test' }));
vi.mock('../src/sound/pcm.ts', async (original) => ({ ...await original<object>(), decode: vi.fn(), encodeMp3: vi.fn(() => Buffer.from('encoded')) }));
let root: string, memo: Memo;
const tone = (hz = 220): Pcm => {
  const left = Float32Array.from({ length: RATE * 2 }, (_, i) => .15 * Math.sin(2 * Math.PI * hz * i / RATE));
  return { left, right: left.slice() };
};
const profile = { gender: 'male' as const, age: 'child' as const, language: 'Polish', sound: 'warm and curious' };
const actor = () => Cast.parse({ hero: { voice: 'voice', profile } }).hero;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-audio-'));
  vi.stubEnv('DIORAMA_CACHE', root); vi.stubEnv('DIORAMA_CONFIG_DIR', root); vi.stubEnv('DIORAMA_SOUND', 'final');
  memo = new Memo(path.join(root, 'memo'));
  vi.clearAllMocks();
  vi.mocked(decode).mockReturnValue(tone());
  vi.mocked(soundEffect).mockResolvedValue(Buffer.from('raw'));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); fs.rmSync(root, { recursive: true, force: true }); });

test('quality defaults to final, with an explicit cheaper draft and no conflicting flags', () => {
  delete process.env.DIORAMA_SOUND;
  expect(soundQuality()).toBe('final'); expect(ttsModel()).toBe('eleven_multilingual_v2');
  expect(soundQuality(['--draft'])).toBe('draft'); expect(ttsModel()).toBe('eleven_flash_v2_5');
  expect(() => soundQuality(['--draft', '--final'])).toThrow('choose');
});

test('casting retains Polish voices and prefers the native language over a closer English age', async () => {
  const voices = [
    { voice_id: 'en', name: 'English', category: 'premade', labels: { gender: 'male', age: 'young', language: 'en' } },
    { voice_id: 'pl', name: 'Polish', category: 'professional', labels: { gender: 'male', age: 'middle_aged', language: 'pl' } },
  ];
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ voices })));
  expect(await stockVoices()).toHaveLength(2);
  expect(voiceCandidates(voices, profile).map((v) => v.voice_id)).toEqual(['pl']);
});

test('reused designs must match language and personality; old gender-only entries are ignored', () => {
  fs.mkdirSync(path.join(root, 'voices'));
  fs.writeFileSync(path.join(root, 'voices/designs.json'), JSON.stringify([
    { gender: 'male', age: 'child', generated: 'old', description: 'robot' },
    { gender: 'male', age: 'child', generated: 'en', description: 'English', profileKey: profileKey({ ...profile, language: 'English' }) },
    { gender: 'male', age: 'child', generated: 'robot', description: 'robot', profileKey: profileKey({ ...profile, sound: 'squeaky toy robot' }) },
    { gender: 'male', age: 'child', generated: 'right', description: 'warm Polish', profileKey: profileKey(profile) },
  ]));
  expect(reusableDesign(profile, new Set())?.generated).toBe('right');
  expect(reusableDesign(profile, new Set(['right']))).toBeUndefined();
});

test('Voice Design auditions the actual language and does not select the highest pitch', async () => {
  const sample = previewText(['Cześć! Szukam jabłka. Pomożesz mi?']);
  expect(sample).not.toContain('And so'); expect(sample.length).toBeGreaterThanOrEqual(100);
  vi.mocked(transcribe).mockResolvedValue(sample);
  vi.mocked(decode).mockReturnValueOnce(tone(220)).mockReturnValueOnce(tone(400));
  const fetch = vi.fn().mockResolvedValue(Response.json({ previews: [
    { generated_voice_id: 'natural', language: 'pl', audio_base_64: 'YQ==' },
    { generated_voice_id: 'highest', language: 'pl', audio_base_64: 'Yg==' },
  ] }));
  vi.stubGlobal('fetch', fetch);
  const design = await designVoice(memo, profile, ['Cześć! Szukam jabłka. Pomożesz mi?']);
  expect(design.generated).toBe('natural');
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ text: sample, voice_description: expect.stringContaining('Native Polish') });
});

const spokenSample = previewText(['Cześć! Szukam jabłka. Pomożesz mi?']);

test('a busy transcriber does not fail a designed voice: it stays pending, and the paid previews are kept', async () => {
  vi.mocked(transcribe).mockRejectedValue(new Error('transcribe voice-preview:a: closed 4000 Audio processing backlog too large'));
  vi.mocked(decode).mockReturnValue(tone(260));
  const fetch = vi.fn().mockResolvedValue(Response.json({ previews: [{ generated_voice_id: 'kept', language: 'pl', audio_base_64: 'YQ==' }] }));
  vi.stubGlobal('fetch', fetch);
  await expect(designVoice(memo, profile, ['Cześć! Szukam jabłka. Pomożesz mi?'])).rejects.toThrow(/validation pending/);
  vi.mocked(transcribe).mockResolvedValue(spokenSample);
  expect((await designVoice(memo, profile, ['Cześć! Szukam jabłka. Pomożesz mi?'])).generated).toBe('kept');
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('speech sends dialogue context separately, and only supported models receive language_code', () => {
  const line = { speaker: 'hero', text: 'Pomogę ci!', previousText: 'Zgubiłem jabłko.', nextText: 'Dziękuję!' };
  const final = speechRequest(line, actor(), 'eleven_multilingual_v2', 1);
  expect(final).toMatchObject({ text: 'Pomogę ci!', previous_text: 'Zgubiłem jabłko.', next_text: 'Dziękuję!' });
  expect(final).not.toHaveProperty('language_code');
  expect(speechRequest(line, actor(), 'eleven_flash_v2_5', 1)).toHaveProperty('language_code', 'pl');
});

test('different speakers keep identical text, and ambiguous branches do not leak context', () => {
  const world = World.parse({ title: 'Test', pitch: 'A quiet garden adventure.', style: 'painted in soft colours', start: 'garden', hero: { key: 'hero', looks: 'a small dragon' }, places: [{ key: 'garden', shows: 'a quiet green garden', mood: 'calm', things: [{ key: 'owl', role: 'npc', looks: 'a small white owl' }], exits: [] }] });
  const story = Story.parse({ intro: 'Start.', items: [], interactions: [], endings: [{ key: 'end', title: 'End', text: 'End.' }], dialogues: [{ npc: 'owl', place: 'garden', start: 'hello', lines: [
    { key: 'hello', says: 'Cześć!', choices: [{ text: 'Cześć!', next: 'reply' }, { text: 'Hej!', next: 'reply' }] },
    { key: 'reply', says: 'Witaj.', choices: [] },
  ] }] });
  const lines = storyLines(world, story);
  expect(lines).toContainEqual({ speaker: 'hero', text: 'Goodbye.' });
  expect(storyLines({ ...world, language: 'Polish' }, story)).toContainEqual({ speaker: 'hero', text: 'Do widzenia.' });
  expect(lines.filter((l) => l.text === 'Cześć!').map((l) => l.speaker)).toEqual(['owl', 'hero']);
  expect(lines.find((l) => l.text === 'Witaj.')).not.toHaveProperty('previousText');
  const sound = { files: {}, shots: {}, places: {}, bySpeaker: { owl: { 'Cześć!': { file: 'owl.mp3', seconds: 1 } }, hero: { 'Cześć!': { file: 'hero.mp3', seconds: 2 } } } };
  expect(spokenLine(sound, 'Cześć!', 'hero')?.file).toBe('hero.mp3');
});

test('failed speech transcripts never publish audio and Unicode text is actually compared', async () => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response('audio')));
  vi.mocked(transcribe).mockResolvedValue('zupełnie inne zdanie');
  const write = vi.fn();
  await expect(voiceLine(memo, { speaker: 'hero', text: 'Znalazłem twoje jabłko!' }, actor(), write)).rejects.toThrow('speech rejected');
  expect(write).not.toHaveBeenCalled();
  expect(heardMatch('你好', '再见')).toBe(0);
  expect(heardMatch('łódź', 'lodz')).toBeLessThan(1);
  expect(heardOk('Hi', 0)).toBe(false);
});

const plan = (prompt: string): SoundPlan => ({ music: { prompt: 'warm music' }, places: {}, steps: {}, shots: [{ on: 'ending', prompt, level: 2, seconds: 2 }] });
test('a library finale is reused only for the same prompt and quality', async () => {
  seedLibrary('shot-ending', { file: 'old.mp3', kind: 'shot', level: 2, seconds: 2, source: 'elevenlabs', prompt: 'drums and jars', quality: 'final', flags: [], validation: AUDIO_VALIDATION }, Buffer.from('old'));
  const write = vi.fn((id) => `${id}.mp3`);
  const own = await makeSounds(memo, plan('bell and envelope'), write, { only: ['shot'] });
  expect(own.sounds['shot-ending'].prompt).toBe('bell and envelope');
  expect(soundEffect).toHaveBeenCalledTimes(1);
  await makeSounds(memo, plan('bell and envelope'), write, { only: ['shot'] });
  expect(soundEffect).toHaveBeenCalledTimes(1); // exact-match library reuse
});

test('persistent bad loops are excluded from the manifest and reported after bounded retries', async () => {
  const silent = { left: new Float32Array(RATE * 2), right: new Float32Array(RATE * 2) };
  vi.mocked(decode).mockReturnValue(silent);
  const write = vi.fn();
  const p = { ...plan('bell'), places: { garden: { bed: 'gentle birds', loops: [], floors: {} } } };
  const result = await makeSounds(memo, p, write, { only: ['bed'] });
  expect(soundEffect).toHaveBeenCalledTimes(3);
  // Rejected takes are forgotten, so a rerun asks for new ones instead of replaying the same three.
  expect(forgetEffect).toHaveBeenCalledTimes(3);
  expect(result.sounds).toEqual({}); expect(result.failures['garden-bed']).toContain('rejected');
  expect(write).not.toHaveBeenCalled(); expect(encodeMp3).not.toHaveBeenCalled();
});

test('clipped effects and hissy ambience are rejected before normalisation can hide the defect', async () => {
  const clipped = { left: new Float32Array(RATE).fill(1), right: new Float32Array(RATE).fill(1) };
  vi.mocked(decode).mockReturnValue(clipped);
  const write = vi.fn();
  const shot = await makeSounds(memo, plan('bell'), write, { only: ['shot'] });
  expect(shot.failures['shot-ending']).toContain('clipped');
  let seed = 7;
  const noise = Float32Array.from({ length: RATE * 2 }, () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5) * 0.2);
  vi.mocked(decode).mockReturnValue({ left: noise, right: noise.slice() });
  const bed = await makeSounds(memo, { ...plan('bell'), places: { garden: { bed: 'gentle birds', loops: [], floors: {} } } }, write, { only: ['bed'] });
  expect(bed.failures['garden-bed']).toContain('hiss');
  expect(write).not.toHaveBeenCalled();
});

test('game data excludes old mismatched effects and rejected loops while preserving speaker identity', async () => {
  await scene(root);
  const files = new WorldFiles('w', root);
  files.write(files.path('sound.json'), { ...plan('bell and envelope'), places: { room: { bed: 'quiet birds', loops: [], floors: {} } } });
  const entry = { kind: 'shot', level: 2, seconds: 2, source: 'elevenlabs', flags: [], quality: 'draft' };
  files.write(files.path('sound/sounds.json'), { sounds: {
    'shot-ending': { ...entry, file: 'sound/ending.mp3', prompt: 'drums and jars' },
    'room-bed': { ...entry, kind: 'bed', file: 'sound/bed.mp3', prompt: 'quiet birds', flags: ['does not loop well: one event and silence'] },
  } });
  for (const f of ['sound/ending.mp3', 'sound/bed.mp3', 'hero.mp3', 'owl.mp3']) files.write(files.path(f), Buffer.from('kept'));
  files.write(files.path('voices.json'), { cast: {}, lines: ['hero', 'owl'].map((speaker) => ({ speaker, text: 'Cześć!', file: `${speaker}.mp3`, seconds: 1, heard: 'Cześć!', match: 1, flags: [] })) });
  const data = soundData(files)!;
  expect(data.files).toEqual({});
  expect(data.shots.ending).toBeUndefined();
  expect(data.lines).not.toHaveProperty('Cześć!');
  expect(spokenLine(data, 'Cześć!', 'owl')?.file).toBe('owl.mp3');
});
