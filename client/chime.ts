/** "嘀哩嘀哩": a short, bright two-note chirp played twice, like an IM message.
 * Synthesized with WebAudio, so there is no audio file to load or cache. */
const NOTES: [delay: number, frequency: number][] = [
  [0, 1568], // 嘀 G6
  [0.085, 2093], // 哩 C7
  [0.2, 1568], // 嘀
  [0.285, 2349], // 哩 D7, a touch higher at the end so it sounds cheerful
];
const VOLUME = 0.09;

function pluck(context: AudioContext, at: number, frequency: number) {
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(VOLUME, at + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.11);
  gain.connect(context.destination);
  // A sine fundamental with a faint octave gives a soft "bell" rather than a beep.
  for (const [multiple, level, type] of [[1, 1, 'sine'], [2, 0.18, 'triangle']] as const) {
    const oscillator = context.createOscillator(), partial = context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency * multiple, at);
    // A tiny upward glide on each note keeps it playful.
    oscillator.frequency.exponentialRampToValueAtTime(frequency * multiple * 1.03, at + 0.05);
    partial.gain.value = level;
    oscillator.connect(partial); partial.connect(gain);
    oscillator.onended = () => { oscillator.disconnect(); partial.disconnect(); };
    oscillator.start(at); oscillator.stop(at + 0.12);
  }
  setTimeout(() => gain.disconnect(), 600);
}

export function playChime(context: AudioContext) {
  const now = context.currentTime + 0.01;
  for (const [delay, frequency] of NOTES) pluck(context, now + delay, frequency);
}
