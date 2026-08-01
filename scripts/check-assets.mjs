#!/usr/bin/env node
/**
 * Verify the compress-assets.sh output against the pre-compression originals in
 * git. Exists because a bad output path once turned every model into a 3.6KB
 * JSON stub and the byte counts alone looked like a fantastic win.
 *
 * Two things it will not let slide:
 *   1. Geometry must survive intact. KTX2 + Draco re-encode vertices, they never
 *      remove them — a changed triangle count means something exploded.
 *   2. Textures must stay recognisable. Decodes each .ktx2 back to PNG and
 *      compares PSNR against the original. Faces are the historically fragile
 *      surface here (webp once baked them into black boxes), so they get a
 *      higher bar than props.
 *
 * Usage: node scripts/check-assets.mjs [gitRef]   (default HEAD)
 * Requires: ktx, ImageMagick, and a git ref holding the uncompressed assets.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";
import draco3d from "draco3dgltf";

const REF = process.argv[2] || "HEAD";
// Thresholds calibrated against the actual failure mode, not picked round:
// the "face becomes a black box" corruption this project hit with webp measures
// 12dB. Worst-case ETC1S on a face (qlevel 1) still holds 37dB, and the tiling
// environment maps sit at 25-50dB — ETC1S is simply weak on high-frequency noise
// like tarmac, which at this game's 240p NearestFilter render is not visible.
// So the gate is set to catch corruption, not to enforce transparency the art
// style doesn't ask for.
const PSNR_MIN = 24; // props / environment (ETC1S)
const PSNR_MIN_FACE = 34; // faces and hands (UASTC) — measured 43dB, real headroom
const FACES = /non-1|enemy_|player2_|menu_actor|viewmodel_|fp_arms_|invader/;
// Draco's encoder welds duplicate vertices and drops the degenerate faces that
// fall out — 4% on city_map, and identical at every quantization level, so it's
// mesh cleanup rather than precision loss. A model written as a JSON stub (the
// bug that motivated this script) reports 0 triangles and fails regardless.
const TRI_TOLERANCE = 0.1;

// ImageMagick 7 is `magick`; 6 is `convert`/`compare`. Support both.
const has = (bin) => {
  try {
    execFileSync("command", ["-v", bin], { shell: true, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const IM7 = has("magick");
if (!IM7 && !has("compare")) {
  console.error("error: ImageMagick not found (need `magick`, or `convert`+`compare`)");
  process.exit(1);
}
const toPng = (src) => (IM7 ? `magick "${src}"` : `convert "${src}"`);
const compareCmd = IM7 ? "magick compare" : "compare";

const tmp = mkdtempSync(join(tmpdir(), "bc-check-"));
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "meshopt.decoder": MeshoptDecoder,
  "draco3d.decoder": await draco3d.createDecoderModule(),
});
const fails = [];
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "buffer", maxBuffer: 1 << 30 });

/** Run a bash line and return its output even when it exits non-zero. */
const runIgnoringStatus = (line) => {
  try {
    return execFileSync("bash", ["-c", line], { encoding: "utf8" }).trim();
  } catch (e) {
    return `${e.stdout || ""}${e.stderr || ""}`.trim();
  }
};

/** git blob → temp file, or null if the path didn't exist at that ref. */
function fromGit(path) {
  try {
    const buf = sh("git", ["show", `${REF}:${path}`]);
    const out = join(tmp, path.replace(/\//g, "_"));
    writeFileSync(out, buf);
    return out;
  } catch {
    return null;
  }
}

const stats = async (file) => {
  const root = (await io.read(file)).getRoot();
  let tris = 0;
  for (const m of root.listMeshes())
    for (const p of m.listPrimitives()) {
      const i = p.getIndices();
      tris += (i ? i.getCount() : p.getAttribute("POSITION").getCount()) / 3;
    }
  return { tris: Math.round(tris), meshes: root.listMeshes().length, anims: root.listAnimations().length };
};

console.log("== geometry preserved ==");
for (const name of readdirSync("public/models").filter((f) => f.endsWith(".glb"))) {
  const path = `public/models/${name}`;
  const before = fromGit(path);
  if (!before) continue;
  let now, was;
  try {
    [now, was] = [await stats(path), await stats(before)];
  } catch (e) {
    fails.push(`${name}: unreadable after compression (${e.message})`);
    continue;
  }
  // Animations are the whole point of half these files and Draco never touches
  // them — losing one means the clip silently stopped playing.
  const lost = was.tris ? (was.tris - now.tris) / was.tris : now.tris ? -1 : 0;
  if (now.anims !== was.anims)
    fails.push(`${name}: ${was.anims} animations -> ${now.anims}`);
  else if (now.meshes !== was.meshes)
    fails.push(`${name}: ${was.meshes} meshes -> ${now.meshes}`);
  else if (lost > TRI_TOLERANCE || lost < 0)
    fails.push(`${name}: ${was.tris} tris -> ${now.tris} (${(lost * 100).toFixed(1)}% lost)`);
  else
    console.log(
      `  ok  ${name.padEnd(26)} ${now.tris.toLocaleString().padStart(9)} tris` +
        (lost > 0.001 ? `  (-${(lost * 100).toFixed(1)}% degenerate)` : ""),
    );
}

console.log("== texture fidelity (PSNR vs original) ==");
const ktx2s = sh("git", ["ls-files", "public"])
  .toString()
  .split("\n")
  .filter((p) => /\.(jpg|jpeg|png)$/i.test(p) && existsSync(p.replace(/\.[^.]+$/, ".ktx2")));

for (const orig of ktx2s) {
  const path = orig.replace(/\.[^.]+$/, ".ktx2");
  const before = fromGit(orig);
  if (!before) continue;
  const decoded = join(tmp, "d.png");
  try {
    sh("ktx", ["extract", "--level", "0", path, decoded]);
    // Compare at the original's dimensions; ImageMagick prints PSNR to stderr.
    // ImageMagick's `compare` exits 1 whenever the images differ at all, which
    // is always true for a lossy codec — read the metric, ignore the status.
    const out = runIgnoringStatus(
      `${compareCmd} -metric PSNR <(${toPng(before)} -alpha off png:-) ` +
        `<(${toPng(decoded)} -alpha off -resize "$(identify -format '%wx%h!' "${before}")" png:-) null: 2>&1`,
    );
    const psnr = parseFloat(out);
    const min = FACES.test(orig) ? PSNR_MIN_FACE : PSNR_MIN;
    if (!isFinite(psnr)) fails.push(`${orig}: could not measure PSNR (${out.slice(0, 80)})`);
    else if (psnr < min) fails.push(`${orig}: PSNR ${psnr.toFixed(1)}dB < ${min}dB`);
    else console.log(`  ok  ${orig.replace("public/", "").padEnd(40)} ${psnr.toFixed(1)}dB`);
  } catch (e) {
    fails.push(`${orig}: decode failed (${e.message.slice(0, 80)})`);
  }
}

rmSync(tmp, { recursive: true, force: true });
if (fails.length) {
  console.error(`\n${fails.length} FAILED:`);
  for (const f of fails) console.error(`  ${f}`);
  process.exit(1);
}
console.log("\nall assets verified");
