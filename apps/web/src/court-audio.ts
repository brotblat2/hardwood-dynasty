import type { GameState } from '../../../packages/contracts/index.ts';

type Sound = 'bounce' | 'squeak' | 'rim' | 'whistle' | 'net' | 'crowd' | 'buzzer' | 'block' | 'dunk' | 'green';

export function createCourtAudio() {
  let context: AudioContext | undefined;
  let noise: AudioBuffer | undefined;
  let events = 0;
  let priorTick = -1;
  let floorBall = false;
  let lastBounce = -Infinity;
  let lastSqueak = -Infinity;
  let lastFeedbackTick = -1;
  let velocity: { x: number; z: number } | undefined;
  let inFlight = false;
  let dunkPending = false;

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
    if (sound === 'buzzer') {
      const out = ctx.createGain();
      out.gain.setValueAtTime(0.0001, when);
      out.gain.exponentialRampToValueAtTime(0.08 * gain, when + 0.015);
      out.gain.setValueAtTime(0.075 * gain, when + 0.44);
      out.gain.exponentialRampToValueAtTime(0.0001, when + 0.55);
      out.connect(ctx.destination);
      for (const freq of [195, 201]) {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(freq, when);
        osc.connect(out);
        osc.start(when);
        osc.stop(when + 0.55);
      }
      return;
    }
    if (sound === 'green') {
      for (const [offset, freq] of [[0, 880], [0.04, 1320]] as const) {
        const out = ctx.createGain();
        out.gain.setValueAtTime(0.0001, when + offset);
        out.gain.exponentialRampToValueAtTime(0.05 * gain, when + offset + 0.01);
        out.gain.exponentialRampToValueAtTime(0.0001, when + offset + 0.14);
        out.connect(ctx.destination);
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, when + offset);
        osc.connect(out);
        osc.start(when + offset);
        osc.stop(when + offset + 0.14);
      }
      return;
    }
    if (sound === 'dunk') {
      const out = ctx.createGain();
      out.gain.setValueAtTime(0.0001, when);
      out.gain.exponentialRampToValueAtTime(0.14 * gain, when + 0.008);
      out.gain.exponentialRampToValueAtTime(0.0001, when + 0.22);
      out.connect(ctx.destination);
      const thud = ctx.createOscillator();
      thud.type = 'triangle';
      thud.frequency.setValueAtTime(110, when);
      thud.frequency.exponentialRampToValueAtTime(42, when + 0.16);
      thud.connect(out);
      thud.start(when);
      thud.stop(when + 0.18);
      const rattle = ctx.createOscillator();
      rattle.type = 'square';
      rattle.frequency.setValueAtTime(520, when + 0.01);
      rattle.frequency.exponentialRampToValueAtTime(340, when + 0.18);
      const rGain = ctx.createGain();
      rGain.gain.setValueAtTime(0.035 * gain, when + 0.01);
      rGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.2);
      rattle.connect(rGain).connect(ctx.destination);
      rattle.start(when + 0.01);
      rattle.stop(when + 0.2);
      return;
    }
    const length = sound === 'crowd' ? 0.95 : sound === 'whistle' ? 0.28 : sound === 'net' ? 0.16 : sound === 'block' ? 0.09 : 0.12;
    const out = ctx.createGain();
    const level = ({ bounce: 0.11, squeak: 0.044, rim: 0.075, whistle: 0.06, net: 0.11, crowd: 0.13, block: 0.11 } as const)[sound] * gain;
    out.gain.setValueAtTime(0.0001, when);
    out.gain.exponentialRampToValueAtTime(level, when + (sound === 'crowd' ? 0.14 : 0.009));
    out.gain.exponentialRampToValueAtTime(0.0001, when + length);
    out.connect(ctx.destination);
    if (sound === 'net' || sound === 'crowd' || sound === 'squeak' || sound === 'block') {
      const buffer = ctx.createBufferSource();
      buffer.buffer = noise;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(sound === 'net' ? 2900 : sound === 'squeak' ? 2200 : sound === 'block' ? 1400 : 540, when);
      if (sound === 'squeak') filter.frequency.exponentialRampToValueAtTime(820, when + length);
      filter.Q.value = sound === 'squeak' ? 5.5 : sound === 'block' ? 2.1 : 1.2;
      buffer.connect(filter).connect(out);
      buffer.start(when, Math.random() * 0.3);
      buffer.stop(when + length);
    }
    if (sound === 'bounce' || sound === 'rim' || sound === 'whistle' || sound === 'block') {
      const oscillator = ctx.createOscillator();
      oscillator.type = sound === 'bounce' || sound === 'block' ? 'triangle' : sound === 'rim' ? 'square' : 'sine';
      oscillator.frequency.setValueAtTime(sound === 'bounce' ? 148 : sound === 'block' ? 280 : sound === 'rim' ? 720 : 2390, when);
      oscillator.frequency.exponentialRampToValueAtTime(sound === 'bounce' ? 52 : sound === 'block' ? 90 : sound === 'rim' ? 420 : 2050, when + length);
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
      if (event.type === 'shot') dunkPending = !!event.detail?.startsWith('Dunk') || !!event.detail?.startsWith('Alley-oop');
      if (event.type === 'score') {
        if (dunkPending) { play('dunk'); dunkPending = false; }
        play('net');
        play('crowd');
      }
      if (event.type === 'miss') {
        dunkPending = false;
        if (inFlight) play('rim', 0.48);
      }
      if (event.type === 'block') { dunkPending = false; play('block'); }
      if (event.type === 'period' || (event.type === 'turnover' && event.detail === 'Shot clock violation')) play('buzzer');
      if (event.type === 'foul' || event.type === 'timeout') play('whistle');
    }
    if (state.shotFeedback?.green && state.shotFeedback.playerId === controlledId && state.shotFeedback.tick !== lastFeedbackTick) {
      lastFeedbackTick = state.shotFeedback.tick;
      play('green');
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
