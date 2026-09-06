import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const icnsPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src-tauri/icons/icon.icns");

function parseIcns(icns: Buffer) {
  const chunks: { type: string; data: Buffer }[] = [];
  for (let offset = 8; offset < icns.length; ) {
    const type = icns.subarray(offset, offset + 4).toString("ascii");
    const length = icns.readUInt32BE(offset + 4);
    chunks.push({ type, data: icns.subarray(offset, offset + length) });
    offset += length;
  }
  return chunks;
}

function pngWidth(chunk: { data: Buffer }) {
  const png = chunk.data.subarray(8);
  if (png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return null;
  return png.readUInt32BE(16);
}

describe("macOS app icon", () => {
  it("leads the icns with a 256px PNG so 1Password's approval prompt is not 16px", () => {
    const icns = readFileSync(icnsPath);
    const chunks = parseIcns(icns);
    const types = chunks.map(({ type }) => type);

    const lead = chunks[0];
    if (!lead) throw new Error("icns has no chunks");

    expect(types.includes("icp4") || types.includes("icp5")).toBe(false);
    expect(lead.type).toBe("ic13");
    expect(pngWidth(lead)).toBe(256);
    expect(chunks.some((chunk) => chunk.type === "ic10" && pngWidth(chunk) === 1024)).toBe(true);
  });
});
