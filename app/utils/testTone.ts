/**
 * A short tone for "can you hear this?" on the pre-join screen.
 *
 * Encoded as a WAV data URI and played through an `<audio>` element rather
 * than straight out of an AudioContext, because the element is the only thing
 * that carries both of the controls this screen needs: `.volume`, so the
 * slider means something, and `setSinkId`, so the tone comes out of the
 * speaker the user just picked. AudioContext has neither portably.
 */

const SAMPLE_RATE = 44100;
const FREQ_HZ = 440;
const DURATION_S = 0.7;
/** Short linear ramps at both ends; a square-edged start clicks. */
const FADE_S = 0.05;
/** Well below full scale — this plays at whatever the user has set already. */
const AMPLITUDE = 0.25;

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);        // PCM chunk size
  view.setUint16(20, 1, true);         // format: PCM
  view.setUint16(22, 1, true);         // channels: mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);         // block align
  view.setUint16(34, 16, true);        // bits per sample
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);

  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, clamped * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

let cachedUrl: string | null = null;

/** Object URL for the tone, built once per page load. */
export function testToneUrl(): string {
  if (cachedUrl) return cachedUrl;
  const total = Math.floor(SAMPLE_RATE * DURATION_S);
  const fade = Math.floor(SAMPLE_RATE * FADE_S);
  const samples = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    let env = 1;
    if (i < fade) env = i / fade;
    else if (i > total - fade) env = (total - i) / fade;
    samples[i] = Math.sin((2 * Math.PI * FREQ_HZ * i) / SAMPLE_RATE) * AMPLITUDE * env;
  }
  cachedUrl = URL.createObjectURL(encodeWav(samples, SAMPLE_RATE));
  return cachedUrl;
}
