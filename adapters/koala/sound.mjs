// C-octave synthesis adapted from khuongduy354/koala-client waiting-tone.mjs.
import { spawn } from "node:child_process";
import { once } from "node:events";
function waitingFrequencies(count) {
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("invalid waiting count.");
  return Array.from({ length: Math.min(count, 8) }, (_, index) => 130.812783 * 2 ** index);
}
function waitingChordSource(count) {
  const voices = waitingFrequencies(count);
  if (!voices.length) return null;
  const weights = /* @__PURE__ */ new Map();
  for (const frequency of voices) weights.set(frequency, (weights.get(frequency) ?? 0) + 1);
  const sum = [...weights].map(([frequency, weight]) => `${weight}*sin(2*PI*${frequency}*t)`).join("+");
  return `aevalsrc=0.25*(${sum})/${voices.length}:s=44100`;
}
class WaitingTone {
  player = null;
  count = 0;
  failure = null;
  onFailure = null;
  async update(count) {
    if (this.failure) throw this.failure;
    const source = waitingChordSource(count);
    if (count === this.count) return;
    this.stop();
    if (source === null) return;
    const player = spawn("ffplay", [
      "-nodisp",
      "-autoexit",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      source
    ], { stdio: "ignore" });
    this.player = player;
    this.count = count;
    player.once("close", () => {
      if (this.player !== player) return;
      this.player = null;
      this.count = 0;
      this.failure = new Error("couldn't play waiting tone. check ffplay and your audio device.");
      this.onFailure?.(this.failure);
    });
    try {
      await once(player, "spawn");
    } catch {
      this.stop();
      throw new Error("couldn't start waiting tone. install ffmpeg so ffplay is on PATH.");
    }
  }
  stop() {
    const player = this.player;
    this.player = null;
    this.count = 0;
    player?.kill("SIGTERM");
  }
}
export {
  WaitingTone,
  waitingChordSource,
  waitingFrequencies
};
