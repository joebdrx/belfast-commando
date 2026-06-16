// Standalone rig test: load a rigged GLB at its NATURAL scale, play its embedded
// clip, and report the animated bounding box — isolated from game code.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x556677);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.001, 5000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2));
const dl = new THREE.DirectionalLight(0xffffff, 1.2);
dl.position.set(3, 8, 5);
scene.add(dl);
scene.add(new THREE.AxesHelper(2));
scene.add(new THREE.GridHelper(20, 20, 0x88aabb, 0x445566));

const params = new URLSearchParams(location.search);
const file = params.get("f") || "enemy_rigged";
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const info = document.getElementById("info");

const gltf = await loader.loadAsync(`/models/${file}.glb`);
scene.add(gltf.scene);

let mixer = null;
if (gltf.animations[0]) {
  mixer = new THREE.AnimationMixer(gltf.scene);
  mixer.clipAction(gltf.animations[0]).play();
  mixer.update(0.3); // advance into the clip
}

const box = new THREE.Box3().setFromObject(gltf.scene);
const size = box.getSize(new THREE.Vector3());
const center = box.getCenter(new THREE.Vector3());

// Frame the camera on whatever size the model actually is.
const maxDim = Math.max(size.x, size.y, size.z) || 1;
camera.position.set(center.x + maxDim * 1.4, center.y + maxDim * 0.3, center.z + maxDim * 1.6);
camera.lookAt(center);

info.textContent = `${file} | bindBBox(after anim) ${size.x.toFixed(3)} x ${size.y.toFixed(3)} x ${size.z.toFixed(3)} | center ${center.x.toFixed(2)},${center.y.toFixed(2)},${center.z.toFixed(2)} | anims: ${gltf.animations.map((a) => a.name).join(", ") || "none"}`;

const clock = new THREE.Clock();
function tick() {
  requestAnimationFrame(tick);
  if (mixer) mixer.update(clock.getDelta());
  renderer.render(scene, camera);
}
tick();
