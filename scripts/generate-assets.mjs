/**
 * Belfast Commando — fal.ai asset generation pipeline (OFFLINE / build-time).
 *
 * Pipeline per asset:
 *   1. text -> image   via  openai/gpt-image-2
 *   2. image -> 3D GLB via  fal-ai/hunyuan-3d/v3.1/pro/image-to-3d   (3D assets only)
 *
 * Outputs:
 *   assets/images/<slug>.png        every prompt
 *   assets/models/<slug>.glb        3D assets (+ _thumb.png)
 *   assets/manifest.json            full record (prompts, fal urls, local paths)
 *
 * Run (key via env, NEVER hardcoded):
 *   FAL_AI_API_KEY=xxxx node scripts/generate-assets.mjs
 *
 * Env controls:
 *   SMOKE=1        only the first asset, image-only (cheap API sanity check)
 *   LIMIT=n        only the first n assets
 *   ONLY=a,b,c     only these slugs
 *   FORCE=1        regenerate even if output files already exist
 *   NO3D=1         images only, skip every 3D step
 */
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

const KEY = process.env.FAL_AI_API_KEY;
if (!KEY) {
  console.error("ERROR: set FAL_AI_API_KEY in the environment.");
  process.exit(1);
}
if (typeof fetch !== "function") {
  console.error("ERROR: global fetch missing — needs Node 18+.");
  process.exit(1);
}

const QUEUE = "https://queue.fal.run";
const HEADERS = { Authorization: `Key ${KEY}`, "Content-Type": "application/json" };
const IMG_MODEL = "openai/gpt-image-2";
const TD_MODEL = "fal-ai/hunyuan-3d/v3.1/pro/image-to-3d";

const ROOT = path.resolve(process.cwd(), "assets");
const IMG_DIR = path.join(ROOT, "images");
const MODEL_DIR = path.join(ROOT, "models");
const MANIFEST = path.join(ROOT, "manifest.json");

const FORCE = !!process.env.FORCE;
const NO3D = !!process.env.NO3D || !!process.env.SMOKE;

// --- Prompt suffixes per category (steer gpt-image toward usable output) -----
const SUFFIX = {
  model: ", single centered object, entire object visible in frame, plain solid white background, low-poly stylised game asset, clean topology, soft even studio lighting, no text, no watermark",
  character: ", single full-body character, T-pose-ish neutral standing pose, entire body visible, plain solid white background, low-poly stylised game character, clean topology, soft studio lighting, no text",
  vfx: ", centered effect on pure black background, glowing, stylised game VFX, no text",
  decal: ", flat top-down view, isolated on plain white background, game decal texture, no text",
  ui: ", flat vector game UI element, plain dark background, crisp, no photographic detail",
  env: ", environment concept art, wide establishing shot, stylised low-poly, atmospheric",
  sky: ", wide panoramic sky, overcast, atmospheric, no foreground objects, no text",
};

// --- Asset manifest (smart split: 3D for real objects, image-only for 2D) ----
// model3d: true  -> image + hunyuan 3D
// model3d: false -> image only
const ASSETS = [
  // ---- Weapons (3D) ----
  { slug: "weapon_ak", cat: "model", model3d: true, size: "square_hd",
    prompt: "Low-poly AK-47 style assault rifle with green tape wraps on the stock, red wooden handguard, modern iron sights, side profile view" },
  { slug: "weapon_pistol", cat: "model", model3d: true, size: "square_hd",
    prompt: "Low-poly Glock-style pistol with a suppressor and green grip tape, side profile view" },
  { slug: "kick_boot", cat: "model", model3d: true, size: "square_hd",
    prompt: "Single heavy black combat boot, rugged sole, worn leather, side profile, game prop" },
  // ---- Characters / hands (3D) ----
  { slug: "enemy_soldier", cat: "character", model3d: true, size: "square_hd",
    prompt: "Modern foreign soldier invader, black tactical gear, helmet with dark visor, body armour, standing neutral pose" },
  { slug: "enemy_variant", cat: "character", model3d: true, size: "square_hd",
    prompt: "Foreign mercenary soldier in urban grey camo with a dark blue helmet and body armour, standing neutral pose" },
  { slug: "player_fighter", cat: "character", model3d: true, size: "square_hd",
    prompt: "Modern Belfast insurgent fighter, black balaclava, green beret, tactical vest over a grey hoodie, jeans, combat boots, standing neutral pose" },
  { slug: "viewmodel_hands", cat: "model", model3d: true, size: "square_hd",
    prompt: "Pair of rugged male forearms and hands wearing black tactical gloves with a green armband, palms forward, isolated" },
  // ---- Props / interactables (3D) ----
  { slug: "door_kickable", cat: "model", model3d: true, size: "square_hd",
    prompt: "Heavy wooden reinforced door with a riveted metal frame, chipped green and orange paint, slightly damaged, front view" },
  { slug: "barrel_explosive", cat: "model", model3d: true, size: "square_hd",
    prompt: "Red explosive barrel with yellow danger markings and a rusty rim" },
  { slug: "crate_supply", cat: "model", model3d: true, size: "square_hd",
    prompt: "Wooden military supply crate with rope handles and stencilled markings" },
  { slug: "sandbag_barricade", cat: "model", model3d: true, size: "square_hd",
    prompt: "Stacked military sandbag barricade topped with coiled barbed wire" },
  { slug: "prop_wheelie_bin", cat: "model", model3d: true, size: "square_hd",
    prompt: "Old grimy black wheelie bin with a dented lid, Belfast street rubbish bin" },
  { slug: "prop_traffic_cone", cat: "model", model3d: true, size: "square_hd",
    prompt: "Weathered orange traffic cone with scuffed reflective stripe" },
  { slug: "prop_phone_booth", cat: "model", model3d: true, size: "square_hd",
    prompt: "Old weathered British telephone box, faded paint, glass panels" },
  { slug: "prop_bicycle", cat: "model", model3d: true, size: "square_hd",
    prompt: "Old rusty city bicycle leaning, worn tyres, game prop" },
  { slug: "prop_car", cat: "model", model3d: true, size: "square_hd",
    prompt: "Old small parked hatchback car, slightly burnt and dented, urban wreck" },

  // ---- Environment concepts (image only) ----
  { slug: "env_street", cat: "env", model3d: false, size: "landscape_4_3",
    prompt: "Belfast street scene, red brick terraced houses, graffiti walls, wet asphalt, overcast rainy sky, Northern Ireland architecture, game level" },
  { slug: "env_alley", cat: "env", model3d: false, size: "landscape_4_3",
    prompt: "Narrow Belfast alley between brick buildings, trash bins, puddles, dim moody lighting, game level" },
  { slug: "env_warehouse", cat: "env", model3d: false, size: "landscape_4_3",
    prompt: "Abandoned industrial warehouse interior in the Belfast docks, metal beams, stacked crates, shafts of grey light, game level" },
  // ---- VFX / decals (image only) ----
  { slug: "vfx_muzzle_flash", cat: "vfx", model3d: false, size: "square_hd",
    prompt: "Bright orange and yellow assault rifle muzzle flash burst, star-shaped" },
  { slug: "vfx_kick_impact", cat: "vfx", model3d: false, size: "square_hd",
    prompt: "Stylised dust-and-shockwave kick impact burst, radial cartoon shockwave ring" },
  { slug: "decal_blood", cat: "decal", model3d: false, size: "square_hd",
    prompt: "Blood splatter decal, dark red, irregular splatter shape" },
  { slug: "decal_bullet_hole", cat: "decal", model3d: false, size: "square_hd",
    prompt: "Bullet impact hole with cracks and scorch ring on a wall surface" },
  // ---- UI / HUD (image only) ----
  { slug: "ui_crosshair", cat: "ui", model3d: false, size: "square_hd",
    prompt: "Minimalist green tactical crosshair with a small centre dot and four ticks" },
  { slug: "ui_menu_bg", cat: "ui", model3d: false, size: "landscape_4_3",
    prompt: "Dramatic Belfast skyline at dusk with rising smoke and subtle Irish tricolour accents, stylised, main menu background" },
  { slug: "ui_achievements", cat: "ui", model3d: false, size: "square_hd",
    prompt: "Set of four flat game achievement icons on a dark background: a clenched fist kicking a door, a liberated city skyline, a green beret with a rifle, a boot print" },
  // ---- Sky (image only) ----
  { slug: "sky_overcast", cat: "sky", model3d: false, size: "landscape_4_3",
    prompt: "Heavy grey overcast clouds with light rain over a faint Belfast city silhouette on the horizon" },
];

// --- fal.ai queue helpers ----------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch with retry/backoff. Node's fetch throws "fetch failed" on transient
 * network blips (DNS/TCP/TLS resets) with NO built-in retry — which previously
 * wiped out a whole batch. Retries network errors and 429/5xx responses.
 */
async function safeFetch(url, opts = {}, { retries = 5, base = 1500 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, opts);
      if ((r.status === 429 || r.status >= 500) && i < retries) {
        lastErr = new Error(`HTTP ${r.status}`);
        await sleep(base * 2 ** i);
        continue;
      }
      return r;
    } catch (e) {
      lastErr = e;
      if (i < retries) {
        await sleep(base * 2 ** i);
        continue;
      }
    }
  }
  throw lastErr;
}

async function submit(model, input) {
  const r = await safeFetch(`${QUEUE}/${model}`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(input),
  });
  if (!r.ok) throw new Error(`submit ${model} -> ${r.status}: ${await r.text()}`);
  return r.json();
}

async function poll(statusUrl, resultUrl, { timeout = 900000, interval = 6000 } = {}) {
  const start = Date.now();
  for (;;) {
    const r = await safeFetch(statusUrl, { headers: HEADERS });
    if (!r.ok) throw new Error(`status -> ${r.status}: ${await r.text()}`);
    const s = await r.json();
    if (s.status === "COMPLETED") break;
    if (s.status === "FAILED" || s.status === "ERROR") throw new Error(`request ${s.status}: ${JSON.stringify(s).slice(0, 300)}`);
    if (Date.now() - start > timeout) throw new Error(`timeout after ${Math.round((Date.now() - start) / 1000)}s`);
    await sleep(interval);
  }
  const r = await safeFetch(resultUrl, { headers: HEADERS });
  if (!r.ok) throw new Error(`result -> ${r.status}: ${await r.text()}`);
  return r.json();
}

async function runModel(model, input, opts) {
  const sub = await submit(model, input);
  // fal returns the correct status/result URLs — REQUIRED for multi-segment
  // model ids (e.g. fal-ai/hunyuan-3d/v3.1/pro/image-to-3d) which can't be
  // reconstructed by hand. Fall back to the simple pattern just in case.
  const statusUrl = sub.status_url || `${QUEUE}/${model}/requests/${sub.request_id}/status`;
  const resultUrl = sub.response_url || `${QUEUE}/${model}/requests/${sub.request_id}`;
  return poll(statusUrl, resultUrl, opts);
}

async function download(url, dest) {
  const r = await safeFetch(url);
  if (!r.ok) throw new Error(`download ${r.status} ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, buf);
  return buf.length;
}

const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);

async function loadManifest() {
  try {
    return JSON.parse(await fs.readFile(MANIFEST, "utf8"));
  } catch {
    return {};
  }
}
async function saveManifest(m) {
  await fs.mkdir(ROOT, { recursive: true });
  await fs.writeFile(MANIFEST, JSON.stringify(m, null, 2));
}

// Process one asset end-to-end (image, then 3D if applicable).
async function processAsset(a, manifest) {
  const rec = manifest[a.slug] || { slug: a.slug, cat: a.cat };
  rec.prompt = a.prompt;
  const fullPrompt = a.prompt + (SUFFIX[a.cat] || "");
  rec.fullPrompt = fullPrompt;
  const imgDest = path.join(IMG_DIR, `${a.slug}.png`);
  manifest[a.slug] = rec;

  try {
    // 1) image
    if (FORCE || !existsSync(imgDest) || !rec.imageUrl) {
      log(`IMAGE  ${a.slug} …`);
      const out = await runModel(IMG_MODEL, {
        prompt: fullPrompt,
        image_size: a.size,
        quality: "high",
        num_images: 1,
        output_format: "png",
      }, { timeout: 300000, interval: 4000 });
      const url = out?.images?.[0]?.url;
      if (!url) throw new Error("no image url in response");
      rec.imageUrl = url;
      const bytes = await download(url, imgDest);
      rec.imagePath = path.relative(process.cwd(), imgDest);
      log(`  ↳ image ${a.slug} saved (${(bytes / 1024).toFixed(0)} KB)`);
      await saveManifest(manifest);
    } else {
      log(`IMAGE  ${a.slug} — skip (exists)`);
    }

    // 2) 3D
    if (a.model3d && !NO3D) {
      const glbDest = path.join(MODEL_DIR, `${a.slug}.glb`);
      if (FORCE || !existsSync(glbDest)) {
        log(`3D     ${a.slug} … (a few minutes)`);
        const out = await runModel(TD_MODEL, {
          input_image_url: rec.imageUrl,
          generate_type: "Normal",
          enable_pbr: true,
          face_count: 60000,
        }, { timeout: 1200000, interval: 8000 });
        const glbUrl = out?.model_glb?.url || out?.model_urls?.glb;
        if (!glbUrl) throw new Error("no glb url in response");
        rec.modelUrl = glbUrl;
        const bytes = await download(glbUrl, glbDest);
        rec.modelPath = path.relative(process.cwd(), glbDest);
        if (out?.thumbnail?.url) {
          await download(out.thumbnail.url, path.join(MODEL_DIR, `${a.slug}_thumb.png`)).catch(() => {});
        }
        log(`  ↳ model ${a.slug} saved (${(bytes / 1024 / 1024).toFixed(2)} MB)`);
      } else {
        log(`3D     ${a.slug} — skip (exists)`);
      }
    }

    rec.status = "ok";
    rec.updatedAt = new Date().toISOString();
    return true;
  } catch (e) {
    rec.status = "error";
    rec.error = String(e.message || e);
    log(`  ✗ ${a.slug} FAILED: ${rec.error}`);
    return false;
  } finally {
    await saveManifest(manifest); // incremental — partial progress is never lost
  }
}

// --- Main --------------------------------------------------------------------
async function main() {
  let list = ASSETS;
  if (process.env.ONLY) {
    const only = new Set(process.env.ONLY.split(",").map((s) => s.trim()));
    list = list.filter((a) => only.has(a.slug));
  }
  if (process.env.SMOKE) list = list.slice(0, 1);
  else if (process.env.LIMIT) list = list.slice(0, Number(process.env.LIMIT));

  await fs.mkdir(IMG_DIR, { recursive: true });
  await fs.mkdir(MODEL_DIR, { recursive: true });
  const manifest = await loadManifest();

  const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 3));
  const models = list.filter((a) => a.model3d && !NO3D).length;
  log(`Generating ${list.length} assets (${models} with 3D)  concurrency=${CONCURRENCY} FORCE=${FORCE} NO3D=${NO3D}`);

  // Simple async pool: workers pull from a shared queue index.
  let next = 0, ok = 0, fail = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= list.length) return;
      const success = await processAsset(list[i], manifest);
      if (success) ok++; else fail++;
      log(`progress: ${ok + fail}/${list.length} (ok=${ok} fail=${fail})`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker));

  log(`DONE. ok=${ok} fail=${fail}. Manifest: ${path.relative(process.cwd(), MANIFEST)}`);
  if (fail) process.exitCode = 1;
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
