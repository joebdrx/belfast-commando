// Dev-only model viewer: lays every loaded GLB on a grid using the SAME
// AssetManager normalisation/MODEL_DEFS the game uses, so I can eyeball and
// tune orientation/scale. Camera presets via ?view=front|side|top.
import * as THREE from "three";
import { AssetManager } from "./game/AssetManager.js";

const params = new URLSearchParams(location.search);
const view = params.get("view") || "front";

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9aa3a8);

const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 200);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);

scene.add(new THREE.HemisphereLight(0xbcc6cc, 0x4a4036, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 0.8);
sun.position.set(6, 12, 8);
scene.add(sun);
scene.add(new THREE.AmbientLight(0x404548, 0.5));

// Reference: ground grid + world axes (X red, Y green, Z blue).
scene.add(new THREE.GridHelper(40, 40, 0x556, 0x445));
scene.add(new THREE.AxesHelper(2));

const assets = new AssetManager(renderer);
const labels = [];
const labelLayer = document.getElementById("labels");

await assets.load(scene);

// Single-model close-up: ?only=weapon_ak
const only = params.get("only");
if (only && assets.hasModel(only)) {
  const m = assets.getModel(only);
  scene.add(m);
  const div = document.createElement("div");
  div.className = "lbl";
  div.textContent = only;
  div.style.left = "8px";
  div.style.top = "30px";
  div.style.transform = "none";
  labelLayer.appendChild(div);
  // Frame it. Characters face -Z (rotY=pi), so view their FRONT from -Z.
  if (view === "side") camera.position.set(2.2, 0.9, 0);
  else if (view === "top") camera.position.set(0, 2.5, 0.01);
  else if (view === "back") camera.position.set(1.4, 1.1, 2.4);
  else camera.position.set(1.4, 1.1, -2.6); // front (face)
  camera.lookAt(0, 0.95, 0);
  startLoop();
} else {
  buildGrid();
}

function buildGrid() {
const slugs = Object.keys(assets.models);
const COLS = 4;
const SP = 3.2;

slugs.forEach((slug, i) => {
  const m = assets.getModel(slug);
  if (!m) return;
  const col = i % COLS;
  const row = Math.floor(i / COLS);
  const x = (col - (COLS - 1) / 2) * SP;
  const z = -row * SP;
  m.position.set(x, 0, z);
  scene.add(m);

  // small pedestal so feet/anchor is obvious
  const ped = new THREE.Mesh(
    new THREE.CylinderGeometry(1.0, 1.0, 0.05, 24),
    new THREE.MeshStandardMaterial({ color: 0x2c2f33 }),
  );
  ped.position.set(x, -0.025, z);
  scene.add(ped);

  const div = document.createElement("div");
  div.className = "lbl";
  div.textContent = slug;
  labelLayer.appendChild(div);
  labels.push({ div, pos: new THREE.Vector3(x, 2.4, z) });
});

// Camera presets. "front" sits on +Z looking toward -Z (the player's view of a
// model that faces +Z); side looks down +X; top looks straight down.
const rows = Math.ceil(slugs.length / COLS);
const cz = -((rows - 1) * SP) / 2;
if (view === "side") {
  camera.position.set(14, 4, cz);
  camera.lookAt(0, 1, cz);
} else if (view === "top") {
  camera.position.set(0, 16, cz);
  camera.lookAt(0, 0, cz);
} else {
  camera.position.set(0, 4.5, 11);
  camera.lookAt(0, 1, cz);
}

  startLoop();
}

const v = new THREE.Vector3();
function startLoop() {
  requestAnimationFrame(startLoop);
  for (const l of labels) {
    v.copy(l.pos).project(camera);
    const sx = (v.x * 0.5 + 0.5) * innerWidth;
    const sy = (-v.y * 0.5 + 0.5) * innerHeight;
    l.div.style.transform = `translate(-50%,-50%) translate(${sx}px,${sy}px)`;
    l.div.style.display = v.z < 1 ? "block" : "none";
  }
  renderer.render(scene, camera);
}

window.addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
