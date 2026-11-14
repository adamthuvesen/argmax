const deadline = performance.now() + 20000;
while (performance.now() < deadline && !document.querySelector(".session-link, .project-group")) await new Promise(r => setTimeout(r, 20));
const m = Object.fromEntries(performance.getEntriesByType("mark").map(e => [e.name, Math.round(e.startTime)]));
const fcp = performance.getEntriesByType("paint").find(p => p.name === "first-contentful-paint");
const nav = performance.getEntriesByType("navigation")[0];
return { resp: Math.round(nav.responseEnd), dcl: Math.round(nav.domContentLoadedEventEnd), fcp: Math.round(fcp?.startTime ?? -1), firstPaint: m["argmax:first-paint"], firstContent: m["argmax:first-content"], timeOrigin: performance.timeOrigin };
