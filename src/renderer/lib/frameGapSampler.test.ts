import { describe, expect, it } from "vitest";
import { createFrameGapSampler, type FrameGap } from "./frameGapSampler.js";

function fakeTimer() {
  let pending: (() => void) | null = null;
  let clock = 1000;
  let inactive = false;
  const reported: FrameGap[] = [];
  const sampler = createFrameGapSampler({
    schedule: (callback) => {
      pending = callback;
      return 1;
    },
    cancel: () => {
      pending = null;
    },
    now: () => clock,
    isInactive: () => inactive,
    onGap: (gap) => reported.push(gap),
  });
  return {
    sampler,
    reported,
    /** Fire the pending tick `elapsed` ms after it was scheduled. */
    tick: (elapsed: number) => {
      clock += elapsed;
      const callback = pending;
      pending = null;
      callback?.();
    },
    advance: (elapsed: number) => {
      clock += elapsed;
    },
    isRunning: () => pending !== null,
    setInactive: (next: boolean) => {
      inactive = next;
      sampler.sync();
    },
  };
}

describe("frame gap sampler", () => {
  it("records only ticks more than 50 ms late, with when the tick was due", () => {
    const timer = fakeTimer();
    timer.sampler.sync();
    timer.tick(100);
    timer.tick(130);
    timer.tick(250);
    timer.tick(100);

    expect(timer.sampler.gaps()).toEqual([{ start: 1330, duration: 150 }]);
    expect(timer.reported).toEqual([{ start: 1330, duration: 150 }]);
  });

  it("stops while inactive and does not count the inactive time as a stall", () => {
    const timer = fakeTimer();
    timer.sampler.sync();
    timer.tick(100);
    timer.setInactive(true);
    expect(timer.isRunning()).toBe(false);

    timer.advance(8000);
    timer.setInactive(false);
    timer.tick(100);

    expect(timer.sampler.gaps()).toEqual([]);
  });

  it("ignores lateness that is the machine sleeping rather than a stall", () => {
    const timer = fakeTimer();
    timer.sampler.sync();
    timer.tick(60_000);

    expect(timer.sampler.gaps()).toEqual([]);
  });

  it("keeps only the newest 256 stalls", () => {
    const timer = fakeTimer();
    timer.sampler.sync();
    for (let index = 0; index < 300; index += 1) timer.tick(200 + index);

    const gaps = timer.sampler.gaps();
    expect(gaps).toHaveLength(256);
    expect(gaps.at(-1)?.duration).toBe(399);
    expect(gaps[0]?.duration).toBe(144);
  });
});
