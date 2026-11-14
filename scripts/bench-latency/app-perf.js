// The app's own timing records (interaction marks, frame gaps, IPC round trips),
// when the build carries them. The probe's numbers stay the primary result;
// these cross-check that the in-app instrumentation agrees.
const perf = window.__argmaxPerf;
if (!perf) return null;
return {
  interactions: typeof perf.interactions === "function" ? perf.interactions() : null,
  frames: typeof perf.frames === "function" ? perf.frames() : null,
  ipc: typeof perf.ipc === "function" ? perf.ipc() : null,
};
