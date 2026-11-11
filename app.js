import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import mqtt from 'https://cdn.jsdelivr.net/npm/mqtt@5.10.3/+esm';

const DEVICE_TOPIC = '3dviewer/mallorca3d-50884ff84bb3/orientation';
const BROKER_URL = 'wss://broker.emqx.io:8084/mqtt';

const viewport = document.getElementById('viewport');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x111b2c);
const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 10000);
camera.position.set(3.4, 2.6, 4.2);
const renderer = new THREE.WebGLRenderer({antialias:true, alpha:false});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
viewport.appendChild(renderer.domElement);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
// Aumenta la velocidad del zoom con rueda y gesto de pellizco táctil.
controls.zoomSpeed = 2.2;
controls.minDistance = 0.15;
controls.maxDistance = 1000;

scene.add(new THREE.HemisphereLight(0xdcecff, 0x263247, 2.0));
const key = new THREE.DirectionalLight(0xffffff, 2.2);
key.position.set(4, 7, 5); scene.add(key);
const fill = new THREE.DirectionalLight(0x75baff, 1.1);
fill.position.set(-5, 2, -4); scene.add(fill);
const grid = new THREE.GridHelper(10, 20, 0x426080, 0x263c55);
grid.position.y = -1.2;
scene.add(grid); // La cuadrícula del suelo permanece siempre visible.
const axes = new THREE.AxesHelper(1.5);
scene.add(axes);
const toggleGuidesBtn = document.getElementById('toggleGuidesBtn');

function setAxesVisible(visible) {
  // Al cargar un modelo se ocultan los tres ejes, pero nunca la cuadrícula del suelo.
  axes.visible = model ? visible : true;
  toggleGuidesBtn.disabled = !model;
  toggleGuidesBtn.textContent = model
    ? (axes.visible ? 'Ocultar ejes' : 'Mostrar ejes')
    : 'Ejes visibles';
}

let model = null;
let mqttClient = null;
let lastMessageAt = 0;
let sensorAngles = {roll:0,pitch:0,yaw:0};
let rawAngles = {roll:0,pitch:0,yaw:0};
let zeroOffset = {roll:0,pitch:0,yaw:0};
let modelBaseRotation = new THREE.Euler(0,0,0);
const sensorToggle = document.getElementById('sensorControl');

function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message; el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2600);
}
function setStatus(online, label) {
  const el = document.getElementById('connection');
  el.classList.toggle('online', online); el.classList.toggle('offline', !online);
  el.innerHTML = `<i></i> ${label}`;
}
function fitRenderer() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}
new ResizeObserver(fitRenderer).observe(viewport);
fitRenderer();

function disposeModel(object) {
  object.traverse(child => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach(m => {
        for (const value of Object.values(m)) if (value && value.isTexture) value.dispose();
        m.dispose();
      });
    }
  });
}
function installModel(object, label) {
  if (model) { scene.remove(model); disposeModel(model); }
  model = object;
  const box = new THREE.Box3().setFromObject(model);
  if (box.isEmpty()) { toast('El archivo no contiene geometría visible.'); return; }
  const center = box.getCenter(new THREE.Vector3());
  model.position.sub(center);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x,size.y,size.z) || 1;
  const scale = 3.2 / maxDim;
  model.scale.multiplyScalar(scale);
  modelBaseRotation.copy(model.rotation);
  scene.add(model);
  setAxesVisible(false);
  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('modelName').textContent = label;
  document.getElementById('modelInfo').textContent = `${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)} unidades originales`;
  controls.target.set(0,0,0);
  camera.position.set(3.4,2.6,4.2);
  controls.update();
}
document.getElementById('modelFile').addEventListener('change', async event => {
  const file = event.target.files?.[0]; if (!file) return;
  const ext = file.name.split('.').pop().toLowerCase();
  try {
    if (ext === 'glb' || ext === 'gltf') {
      const buffer = await file.arrayBuffer();
      const loader = new GLTFLoader();
      loader.parse(buffer, '', gltf => {
        installModel(gltf.scene, file.name);
        toast('Modelo cargado.');
      }, error => { console.error(error); toast('No se pudo interpretar el modelo.'); });
    } else if (ext === 'stl') {
      const geometry = new STLLoader().parse(await file.arrayBuffer());
      geometry.computeVertexNormals();
      const material = new THREE.MeshStandardMaterial({color:0x83bdf0, metalness:0.25, roughness:0.48});
      const mesh = new THREE.Mesh(geometry, material);
      installModel(mesh, file.name);
      toast('STL cargado.');
    } else toast('Formato no compatible.');
  } catch (err) { console.error(err); toast('Error al cargar el archivo.'); }
  event.target.value = '';
});

toggleGuidesBtn.addEventListener('click', () => {
  if (!model) return;
  setAxesVisible(!axes.visible);
});

document.getElementById('resetViewBtn').addEventListener('click', () => {
  camera.position.set(3.4,2.6,4.2); controls.target.set(0,0,0); controls.update();
});
document.getElementById('resetModelBtn').addEventListener('click', () => {
  zeroOffset = {...rawAngles};
  sensorAngles = {roll:0,pitch:0,yaw:0};
  if (model) model.rotation.set(modelBaseRotation.x,modelBaseRotation.y,modelBaseRotation.z);
  toast('Orientación actual establecida como cero.');
});
document.getElementById('fullscreenBtn').addEventListener('click', async () => {
  try {
    if (!document.fullscreenElement) await document.querySelector('.viewer-card').requestFullscreen();
    else await document.exitFullscreen();
  } catch { toast('Pantalla completa no disponible en este navegador.'); }
});
document.getElementById('connectBtn').addEventListener('click', connectMqtt);
document.getElementById('topicInput').value = DEVICE_TOPIC;

function connectMqtt() {
  const topic = document.getElementById('topicInput').value.trim();
  if (!topic) { toast('Escribe el canal MQTT.'); return; }
  if (mqttClient) { mqttClient.end(true); mqttClient = null; }
  setStatus(false, 'Conectando…');
  mqttClient = mqtt.connect(BROKER_URL, {
    clean:true, connectTimeout:10000, reconnectPeriod:3000,
    clientId:'webviewer_'+Math.random().toString(16).slice(2,10)
  });
  mqttClient.on('connect', () => {
    mqttClient.subscribe(topic, err => {
      if (err) { setStatus(false,'Error de suscripción'); return; }
      setStatus(true,'Esperando sensor');
      toast('Conectado al broker. Enciende el ESP32.');
    });
  });
  mqttClient.on('message', (_topic, payload) => {
    try {
      const data = JSON.parse(payload.toString());
      lastMessageAt = Date.now();
      rawAngles.roll = Number(data.roll) || 0;
      rawAngles.pitch = Number(data.pitch) || 0;
      rawAngles.yaw = Number(data.yaw) || 0;
      sensorAngles.roll = rawAngles.roll - zeroOffset.roll;
      sensorAngles.pitch = rawAngles.pitch - zeroOffset.pitch;
      sensorAngles.yaw = rawAngles.yaw - zeroOffset.yaw;
      updateReadings(data);
      setStatus(true,'Sensor conectado');
    } catch (e) { console.warn('Mensaje MQTT no válido',e); }
  });
  mqttClient.on('error', err => { console.error(err); setStatus(false,'Error MQTT'); });
  mqttClient.on('offline', () => setStatus(false,'Sin conexión'));
}
function setText(id,value) { document.getElementById(id).textContent = Number(value ?? 0).toFixed(2); }
function updateReadings(d) {
  setText('roll',sensorAngles.roll); setText('pitch',sensorAngles.pitch); setText('yaw',sensorAngles.yaw);
  ['gx','gy','gz','ax','ay','az'].forEach(k => setText(k,d[k]));
}

function animate() {
  requestAnimationFrame(animate);
  if (model && sensorToggle.checked) {
    const rad = Math.PI / 180;
    const target = new THREE.Euler(sensorAngles.roll*rad, sensorAngles.pitch*rad, sensorAngles.yaw*rad, 'XYZ');
    model.rotation.x += (target.x-model.rotation.x)*0.16;
    model.rotation.y += (target.y-model.rotation.y)*0.16;
    model.rotation.z += (target.z-model.rotation.z)*0.16;
  }
  controls.update();
  renderer.render(scene,camera);
}
animate();
setInterval(() => {
  if (mqttClient?.connected && lastMessageAt && Date.now()-lastMessageAt > 3000) setStatus(false,'Sin datos del sensor');
},1000);
