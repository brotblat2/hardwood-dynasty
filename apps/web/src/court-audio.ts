import type { GameState } from '../../../packages/contracts/index.ts';

type Sound = 'bounce' | 'squeak' | 'rim' | 'whistle' | 'net' | 'crowd';

export function createCourtAudio() {
  let context: AudioContext | undefined;
  let noise: AudioBuffer | undefined;
  let events = 0;
  let priorTick = -1;
  let floorBall = false;
  let lastBounce = -Infinity;
  let lastSqueak = -Infinity;
  let velocity: { x: number; z: number } | undefined;
  let inFlight = false;

  function start() {
    if (context || !window.AudioContext) {
      if (context?.state === 'suspended') void context.resume().catch(() => undefined);
      return;
    }
    try {
      context = new AudioContext();
      noise = context.createBuffer(1, Math.round(context.sampleRate * 1.4), context.sampleRate);
      const samples = noise.getChannelData(0);
      for (let i = 0; i < samples.length; i++) samples[i] = (Math.random() - 0.5) * 2;
      void context.resume().catch(() => undefined);
    } catch { /* Audio support is optional. */ }
  }

  function play(sound: Sound, gain = 1) {
    if (!context || context.state !== 'running' || !noise) return;
    const ctx = context;
    const when = ctx.currentTime;
    const length = sound === 'crowd' ? 0.95 : sound === 'whistle' ? 0.28 : (sound === 'net' ? 0.16 : 0.12);
    const out = ctx.createGain();
    const level = ({ bounce: 0.11, squeak: 0.044, rim: 0.075, whistle: 0.06, net: 0.11, crowd: 0.13 } as const)[sound] * gain;
    out.gain.setValueAtTime(0.0001, when);
    out.gain.exponentialRampToValueAtTime(level, when + (sound === 'crowd' ? 0.14 : 0.009));
    out.gain.exponentialRampToValueAtTime(0.0001, when + length);
    out.connect(ctx.destination);
    if (sound === 'net' || sound === 'crowd' || sound === 'squeak') {
      const buffer = ctx.createBufferSource();
      buffer.buffer = noise;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(sound === 'net' ? 2900 : sound === 'squeak' ? 2200 : 540, when);
      if (sound === 'squeak') filter.frequency.exponentialRampToValueAtTime(820, when + length);
      filter.Q.value = sound === 'squeak' ? 5.5 : 1.2;
      buffer.connect(filter).connect(out);
      buffer.start(when, Math.random() * 0.3);
      buffer.stop(when + length);
    }
    if (sound === 'bounce' || sound === 'rim' || sound === 'whistle') {
      const oscillator = ctx.createOscillator();
      oscillator.type = sound === 'bounce' ? 'triangle' : sound === 'rim' ? 'square' : 'sine';
      oscillator.frequency.setValueAtTime(sound === 'bounce' ? 148 : sound === 'rim' ? 720 : 2390, when);
      oscillator.frequency.exponentialRampToValueAtTime(sound === 'bounce' ? 52 : sound === 'rim' ? 420 : 2050, when + length);
      oscillator.connect(out);
      oscillator.start(when);
      oscillator.stop(when + length);
    }
  }

  function update(state: GameState, controlledId: string) {
    if (state.tick === priorTick) return;
    if (priorTick < 0 || state.tick < priorTick || state.events.length < events) events = state.events.length;
    priorTick = state.tick;
    for (; events < state.events.length; events++) {
      const event = state.events[events];
      if (event.type === 'score') { play('net'); play('crowd'); }
      if (event.type === 'miss' && inFlight) play('rim', 0.48);
      if (event.type === 'foul' || event.type === 'period' || event.type === 'timeout') play('whistle');
    }
    inFlight = state.ball.kind === 'shot';
    const low = state.ball.position.y < 0.26;
    if (low && !floorBall && state.tick - lastBounce > 9) {
      play('bounce', state.ball.kind === 'loose' ? 0.79 : 1);
      lastBounce = state.tick;
    }
    floorBall = low;
    const current = state.players.find(player => player.id === controlledId)?.velocity;
    if (current && velocity && Math.hypot(current.x, current.z) > 2 && state.tick - lastSqueak > 15 &&
        Math.hypot(current.x - velocity.x, current.z - velocity.z) > 0.48) {
      play('squeak');
      lastSqueak = state.tick;
    }
    velocity = current ? { ...current } : undefined;
  }
  return { start, update, dispose() { if (context) void context.close().catch(() => undefined); } };
}
